// Harness-only capture-quality data recorder. Pure state/encoding logic (no React) so
// it is also importable from the offline scripts/calibrate/ CLI via the same code the
// on-device HUD uses to build an export string - one encoder, one decoder, no drift.
//
// EXPORT FORMAT (v4, "CQ4"): the recording device is a phone with no file system access
// the user can reach - the only path off the device is copy -> paste into a chat
// message. That forces a single-line, character-budgeted format. The parser
// (scripts/calibrate/parse.ts) still accepts CQ1, CQ2 and CQ3 lines, since the committed
// calibration recordings are in those formats, so CQ4 is a new prefix, not a rewrite.
//
//   CQ4|<tag>|n=<count>|stride=<stride>|fps=<meanFps>|res=<W>x<H>|sc=<a>,<d>,<r>|<samples>|lg=<cols>x<rows>|ln=<lightCount>|lsc=<lumaExp>,<contrastExp>,<roiExp>|<lightSamples>|pn=<personCount>|psc=<posExp>,<areaExp>|<personSamples>
//
// <personSamples> is `;`-joined tokens of 8 fields:
//   <tickIndex>:<personCount>:<cx>:<cy>:<areaNorm>:<boardCx>:<boardCy>:<boardLenNorm>
// recorded ONLY on ticks where person detection actually ran (it is round-robined - see
// sampling.personDetectEveryNTicks), which is why each token carries its own tickIndex:
// the gaps are uneven relative to the marker samples, and replay needs the real elapsed
// time between two detections to reconstruct a per-second speed. Positions are normalized
// to the frame (cx/cy by width/height, boardLenNorm by width) so a recording stays valid
// across a detector-resolution change, the way the marker metrics already are. Fields are
// RAW INPUTS, not derived metrics: replay feeds them back through the real
// subjectPositionCheck code rather than re-deriving distance or speed, matching how the
// marker and lighting sections already work. "-" encodes an unavailable field (no subject,
// or no measurable board).
//
// <samples> is `;`-joined `<bitmask>:<area>:<diag>:<rot>:<detArea>` tokens, oldest first,
// unchanged from CQ2.
//
// <lightSamples> is `;`-joined tokens of 17 integers: six summary stats (min, p25,
// median, p75, max, mean) of the per-cell MEAN LUMA distribution, the same six of the
// per-cell luma STANDARD DEVIATION, then the ROI (x/y/width/height, quantized by the 3rd
// lsc= exponent) and a roiSourceCode (0=detected, 1=last-known, 2=default). The ROI
// fields are why CQ3 is not backward-compatible with CQ2: CQ2's distributions were
// measured over the whole frame, a materially different measurement, so the two must
// never be pooled (see parse.ts's lightingScope).
//
// The distribution stats are deliberately RAW, not threshold-derived - the thresholds are
// exactly what calibration is trying to fit. Six quantile points rather than every cell
// is a size tradeoff: enough for lightingReplay.ts to interpolate an approximate
// "fraction of cells below X" when sweeping candidates, which is this recorder's only
// job. Lighting is sampled every LIGHTING_SAMPLE_EVERY_N-th marker sample because it
// varies slowly, and per-tick samples would blow the size budget.

import { MARKER_BOARD, LIGHTING_GRID } from "../CaptureQuality/captureQualityConfig";
import type { LightingRoiRect } from "../CaptureQuality/captureQualityConfig";
import type { MarkerBoardFrameMetrics } from "../CaptureQuality/markerBoardCheck";
import type { LowLightFrameMetrics, LowLightRoiSource } from "../CaptureQuality/lowLightCheck";
import type { SubjectPositionFrameMetrics } from "../CaptureQuality/subjectPositionCheck";

const EXPECTED_MARKER_IDS = MARKER_BOARD.expectedMarkerIds;

// Powers of ten. area gets one more digit of headroom than diag/rot because a
// close-up marker's bbox can occupy a large fraction of the frame while diag/rot are
// bounded ratios/angles.
const AREA_SCALE_EXP = 6;
const DIAG_SCALE_EXP = 4;
const ROT_SCALE_EXP = 4;
const AREA_SCALE = 10 ** AREA_SCALE_EXP;
const DIAG_SCALE = 10 ** DIAG_SCALE_EXP;
const ROT_SCALE = 10 ** ROT_SCALE_EXP;

// Luma/contrast are already small numbers (0-255) unlike area/diag/rot, but their
// per-sample SUMMARY STATS (mean of 64 cell means, etc.) are not integers - one decimal
// digit of precision is enough for an offline "fraction below X" reconstruction, so exp=1
// (not 0, which would round to the nearest whole luma unit, nor a larger exponent, which
// would spend digits precision the 8x8/64-cell sample size cannot actually support).
const LUMA_SCALE_EXP = 1;
const CONTRAST_SCALE_EXP = 1;
const LUMA_SCALE = 10 ** LUMA_SCALE_EXP;
const CONTRAST_SCALE = 10 ** CONTRAST_SCALE_EXP;

// ROI fields are normalized [0,1] fractions - 3 decimal digits (1000ths, ~0.5px on the
// ~128px-long-edge lighting canvas) is more precision than the canvas itself carries, so
// this is not spending digits the source data can't support the way a larger exponent
// would.
const ROI_SCALE_EXP = 3;
const ROI_SCALE = 10 ** ROI_SCALE_EXP;

const ROI_SOURCE_CODE: Record<LowLightRoiSource, number> = { detected: 0, "last-known": 1, default: 2 };

// Normalized [0,1] positions, 4 digits - roughly 0.1px on a 1024-wide detector canvas, so
// this does not spend precision the source data lacks. Subject area is a small fraction of
// the frame like the marker areas, so it reuses their 6-digit convention.
const POS_SCALE_EXP = 4;
const SUBJECT_AREA_SCALE_EXP = 6;
const POS_SCALE = 10 ** POS_SCALE_EXP;
const SUBJECT_AREA_SCALE = 10 ** SUBJECT_AREA_SCALE_EXP;

// Person samples arrive at ~1/personDetectEveryNTicks the marker rate and each is small,
// so this cap is generous relative to MAX_SAMPLES rather than proportional to it.
const MAX_PERSON_SAMPLES = 150;

// Keeps a realistic worst-case export (long tag, every sample fully populated) safely
// under MAX_EXPORT_CHARS without relying on the truncation safety net below.
const MAX_SAMPLES = 300;
// Lighting samples are recorded at ~1/LIGHTING_SAMPLE_EVERY_N the marker rate, so under
// steady state this is rarely hit - it exists to bound a very long recording, where many
// marker-buffer halvings (see recordCaptureFrame) would otherwise let the lighting
// buffer, which has no equivalent halving tied to it, grow without bound.
const MAX_LIGHTING_SAMPLES = 40;
// Every 10th marker SAMPLE (not raw tick) gets a paired lighting capture - lighting
// varies slowly, so this is a deliberate under-sample relative to marker geometry.
const LIGHTING_SAMPLE_EVERY_N = 10;
const MAX_TAG_CHARS = 60;
// Hard cap so a pathological recording still pastes cleanly into a chat window.
export const MAX_EXPORT_CHARS = 8192;

export interface CaptureRecorderRawSample {
	bitmask: number;
	area: number | null;
	diag: number | null;
	rot: number | null;
	detArea: number | null;
	fps: number;
}

export interface DistributionSummary {
	min: number;
	p25: number;
	median: number;
	p75: number;
	max: number;
	mean: number;
}

export interface CaptureRecorderLightingSample {
	luma: DistributionSummary;
	contrast: DistributionSummary;
	roi: LightingRoiRect;
	roiSource: LowLightRoiSource;
}

/**
 * One tick on which person detection actually ran. Everything is normalized to the frame
 * and stored raw - see the CQ4 note in the module header for why these are inputs rather
 * than derived metrics.
 */
export interface CaptureRecorderPersonSample {
	/** Raw tick index (not sample index), so replay can recover the real gap between two detections. */
	tickIndex: number;
	personCount: number;
	subjectCentroidXNorm: number | null;
	subjectCentroidYNorm: number | null;
	subjectAreaNorm: number | null;
	boardCentroidXNorm: number | null;
	boardCentroidYNorm: number | null;
	/** Board forward-axis length / frameWidth. The unit every subject distance is expressed in. */
	boardLengthNorm: number | null;
}

export interface CaptureRecorderState {
	scenarioTag: string;
	recording: boolean;
	/** performance.now() when start() was called; used only for the live elapsed-time readout, never exported. */
	startedAtMs: number | null;
	samples: CaptureRecorderRawSample[];
	lightingSamples: CaptureRecorderLightingSample[];
	personSamples: CaptureRecorderPersonSample[];
	stride: number;
	tickCount: number;
	frameWidth: number | null;
	frameHeight: number | null;
}

export function createCaptureRecorderState(): CaptureRecorderState {
	return {
		scenarioTag: "",
		recording: false,
		startedAtMs: null,
		samples: [],
		lightingSamples: [],
		personSamples: [],
		stride: 1,
		tickCount: 0,
		frameWidth: null,
		frameHeight: null,
	};
}

/** Starts a run, keeping scenarioTag so consecutive runs can share a label without retyping it. */
export function startCaptureRecording(state: CaptureRecorderState, nowMs: number): void {
	state.recording = true;
	state.startedAtMs = nowMs;
	state.samples = [];
	state.lightingSamples = [];
	state.personSamples = [];
	state.stride = 1;
	state.tickCount = 0;
	state.frameWidth = null;
	state.frameHeight = null;
}

export function stopCaptureRecording(state: CaptureRecorderState): void {
	state.recording = false;
}

export function clearCaptureRecording(state: CaptureRecorderState): void {
	state.recording = false;
	state.startedAtMs = null;
	state.samples = [];
	state.lightingSamples = [];
	state.personSamples = [];
	state.stride = 1;
	state.tickCount = 0;
	state.frameWidth = null;
	state.frameHeight = null;
}

function computeBitmask(visibleIds: readonly number[]): number {
	let mask = 0;
	for (const id of EXPECTED_MARKER_IDS) {
		if (visibleIds.includes(id)) mask |= 1 << id;
	}
	return mask;
}

function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 1) return sorted[0];
	const idx = p * (sorted.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	const frac = idx - lo;
	return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Summarizes a per-cell metric (mean luma, or luma std) into the six quantile markers
 * the CQ2 lighting section stores. Nulls (uncomputable cells) are dropped, not zeroed -
 * a degenerate tiny frame should shrink the sample, not pull the distribution toward 0.
 * Returns null if every cell was uncomputable.
 */
function summarizeCellValues(values: readonly (number | null)[]): DistributionSummary | null {
	const present = values.filter((v): v is number => v !== null);
	if (present.length === 0) return null;
	const sorted = [...present].sort((a, b) => a - b);
	const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
	return {
		min: sorted[0],
		p25: percentile(sorted, 0.25),
		median: percentile(sorted, 0.5),
		p75: percentile(sorted, 0.75),
		max: sorted[sorted.length - 1],
		mean,
	};
}

export interface CaptureRecorderLightingInput {
	metrics: LowLightFrameMetrics;
	roi: LightingRoiRect;
	roiSource: LowLightRoiSource;
}

export interface CaptureRecorderFrameInput {
	fps: number;
	frameWidth: number;
	frameHeight: number;
	/** Raw single-frame metrics from evaluateMarkerBoardFrame - reused, not recomputed, so the recorder never diverges from the real check's notion of "computable". */
	metrics: MarkerBoardFrameMetrics;
	/**
	 * Result of evaluateLatestLowLightFrame (metrics + the ROI it was measured against +
	 * which selection path produced that ROI), for the SAME tick, from the separate small
	 * unfiltered lighting canvas (see RealTimeProcessor.tsx). Optional/nullable because
	 * the aruco tick loop always has marker metrics but may not always have a fresh
	 * lighting frame ready (e.g. lighting canvas not yet sized).
	 */
	lighting?: CaptureRecorderLightingInput | null;
	/**
	 * Result of evaluateSubjectPositionFrame for the SAME tick. Null/omitted on the ticks
	 * where person detection was skipped by the round robin - those must not be stored,
	 * since a stored "no subject" would be indistinguishable from a real miss during
	 * replay and would fit the detection thresholds against the round robin itself.
	 */
	subject?: SubjectPositionFrameMetrics | null;
}

/**
 * Called once per processed detector tick while recording. Internally decimates: only
 * every `stride`-th tick is actually stored, and the stride doubles (halving the
 * existing buffer) once MAX_SAMPLES is reached, so recording never grows unbounded
 * and never drops the start of a long run to keep the end.
 */
export function recordCaptureFrame(state: CaptureRecorderState, input: CaptureRecorderFrameInput): void {
	if (!state.recording) return;
	state.tickCount += 1;

	// Person samples are recorded BEFORE the stride gate. Person detection is already
	// decimated by its own round robin, so applying the marker stride on top would compound
	// the two and could leave a long recording with too few detections to fit anything.
	if (input.subject && input.subject.personCount !== null && input.frameWidth > 0 && input.frameHeight > 0) {
		recordPersonSample(state, input.subject, input.frameWidth, input.frameHeight);
	}

	if (state.tickCount % state.stride !== 0) return;

	if (state.frameWidth === null) {
		state.frameWidth = input.frameWidth;
		state.frameHeight = input.frameHeight;
	}

	state.samples.push({
		bitmask: computeBitmask(input.metrics.visibleIds),
		area: input.metrics.normalizedArea,
		diag: input.metrics.diagonalRatio,
		rot: input.metrics.orientationAngleRad,
		detArea: input.metrics.detectedMarkerAreaNorm,
		fps: input.fps,
	});

	if (state.samples.length > MAX_SAMPLES) {
		state.samples = state.samples.filter((_, i) => i % 2 === 0);
		state.stride *= 2;
	}

	// Ties lighting decimation to marker SAMPLES already recorded (state.samples.length,
	// after the push above), not raw ticks - "every 10th sampled frame" per the module
	// header, so this automatically stays proportional even after `stride` doubles.
	if (input.lighting && state.samples.length % LIGHTING_SAMPLE_EVERY_N === 0) {
		const luma = summarizeCellValues(input.lighting.metrics.cellMeans);
		const contrast = summarizeCellValues(input.lighting.metrics.cellContrasts);
		if (luma && contrast) {
			state.lightingSamples.push({ luma, contrast, roi: input.lighting.roi, roiSource: input.lighting.roiSource });
			if (state.lightingSamples.length > MAX_LIGHTING_SAMPLES) {
				state.lightingSamples = state.lightingSamples.filter((_, i) => i % 2 === 0);
			}
		}
	}
}

function recordPersonSample(
	state: CaptureRecorderState,
	subject: SubjectPositionFrameMetrics,
	frameWidth: number,
	frameHeight: number
): void {
	state.personSamples.push({
		tickIndex: state.tickCount,
		personCount: subject.personCount ?? 0,
		subjectCentroidXNorm: subject.subjectCentroid === null ? null : subject.subjectCentroid.x / frameWidth,
		subjectCentroidYNorm: subject.subjectCentroid === null ? null : subject.subjectCentroid.y / frameHeight,
		subjectAreaNorm: subject.subjectAreaNorm,
		boardCentroidXNorm: subject.boardCentroid === null ? null : subject.boardCentroid.x / frameWidth,
		boardCentroidYNorm: subject.boardCentroid === null ? null : subject.boardCentroid.y / frameHeight,
		boardLengthNorm: subject.boardLengthPx === null ? null : subject.boardLengthPx / frameWidth,
	});
	if (state.personSamples.length > MAX_PERSON_SAMPLES) {
		state.personSamples = state.personSamples.filter((_, i) => i % 2 === 0);
	}
}

export function getElapsedMs(state: CaptureRecorderState, nowMs: number): number {
	if (state.startedAtMs === null) return 0;
	return Math.max(0, nowMs - state.startedAtMs);
}

function sanitizeTag(raw: string): string {
	const cleaned = raw
		.replace(/[|:;]/g, " ")
		.replace(/[\r\n\t]+/g, " ")
		.trim();
	const capped = cleaned.slice(0, MAX_TAG_CHARS);
	return capped.length > 0 ? capped : "untagged";
}

function encodeMetric(value: number | null, scale: number): string {
	return value === null ? "-" : String(Math.round(value * scale));
}

function meanFps(samples: readonly CaptureRecorderRawSample[]): number {
	if (samples.length === 0) return 0;
	return samples.reduce((sum, s) => sum + s.fps, 0) / samples.length;
}

function encodeDistribution(d: DistributionSummary, scale: number): string {
	return [d.min, d.p25, d.median, d.p75, d.max, d.mean].map((v) => Math.round(v * scale)).join(":");
}

function encodePersonSample(s: CaptureRecorderPersonSample): string {
	return [
		String(s.tickIndex),
		String(s.personCount),
		encodeMetric(s.subjectCentroidXNorm, POS_SCALE),
		encodeMetric(s.subjectCentroidYNorm, POS_SCALE),
		encodeMetric(s.subjectAreaNorm, SUBJECT_AREA_SCALE),
		encodeMetric(s.boardCentroidXNorm, POS_SCALE),
		encodeMetric(s.boardCentroidYNorm, POS_SCALE),
		encodeMetric(s.boardLengthNorm, POS_SCALE),
	].join(":");
}

function buildLine(
	state: CaptureRecorderState,
	samples: readonly CaptureRecorderRawSample[],
	lightingSamples: readonly CaptureRecorderLightingSample[],
	personSamples: readonly CaptureRecorderPersonSample[]
): string {
	const tag = sanitizeTag(state.scenarioTag);
	const res =
		state.frameWidth !== null && state.frameHeight !== null ? `${state.frameWidth}x${state.frameHeight}` : "0x0";
	const payload = samples
		.map(
			(s) =>
				`${s.bitmask}:${encodeMetric(s.area, AREA_SCALE)}:${encodeMetric(s.diag, DIAG_SCALE)}:${encodeMetric(s.rot, ROT_SCALE)}:${encodeMetric(s.detArea, AREA_SCALE)}`
		)
		.join(";");
	const lightingPayload = lightingSamples
		.map((s) => {
			const roi = s.roi;
			const roiTokens = [roi.xNorm, roi.yNorm, roi.widthNorm, roi.heightNorm].map((v) => Math.round(v * ROI_SCALE));
			return `${encodeDistribution(s.luma, LUMA_SCALE)}:${encodeDistribution(s.contrast, CONTRAST_SCALE)}:${roiTokens.join(":")}:${ROI_SOURCE_CODE[s.roiSource]}`;
		})
		.join(";");
	const personPayload = personSamples.map(encodePersonSample).join(";");
	return [
		"CQ4",
		tag,
		`n=${samples.length}`,
		`stride=${state.stride}`,
		`fps=${Math.round(meanFps(samples))}`,
		`res=${res}`,
		`sc=${AREA_SCALE_EXP},${DIAG_SCALE_EXP},${ROT_SCALE_EXP}`,
		payload,
		`lg=${LIGHTING_GRID.cols}x${LIGHTING_GRID.rows}`,
		`ln=${lightingSamples.length}`,
		`lsc=${LUMA_SCALE_EXP},${CONTRAST_SCALE_EXP},${ROI_SCALE_EXP}`,
		lightingPayload,
		`pn=${personSamples.length}`,
		`psc=${POS_SCALE_EXP},${SUBJECT_AREA_SCALE_EXP}`,
		personPayload,
	].join("|");
}

/**
 * Builds the exportable single-line string. Guards MAX_EXPORT_CHARS independently of
 * MAX_SAMPLES/MAX_LIGHTING_SAMPLES (belt-and-suspenders): if an unusually large recording
 * still overflows the hard cap, trailing samples are dropped from both sections in
 * lockstep (oldest-first data is more valuable than newest for seeing a degradation curve
 * start-to-finish, but a still-too-long line is useless to anyone, so this only triggers
 * as a last resort).
 */
export function buildCompactExport(state: CaptureRecorderState): string {
	let keep = state.samples.length;
	let lightKeep = state.lightingSamples.length;
	let personKeep = state.personSamples.length;
	let line = buildLine(state, state.samples, state.lightingSamples, state.personSamples);
	while (line.length > MAX_EXPORT_CHARS && keep > 0) {
		keep = Math.floor(keep * 0.9);
		lightKeep = Math.min(lightKeep, keep);
		personKeep = Math.min(personKeep, keep);
		line = buildLine(
			state,
			state.samples.slice(0, keep),
			state.lightingSamples.slice(0, lightKeep),
			state.personSamples.slice(0, personKeep)
		);
	}
	return line;
}

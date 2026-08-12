// Harness-only capture-quality data recorder. Pure state/encoding logic (no React) so
// it is also importable from the offline scripts/calibrate/ CLI via the same code the
// on-device HUD uses to build an export string - one encoder, one decoder, no drift.
//
// EXPORT FORMAT (v1, "CQ1"): the recording device is a phone with no file system
// access the user can reach - the only path off the device is copy -> paste into a
// chat message. That forces a single-line, character-budgeted format:
//
//   CQ1|<tag>|n=<count>|stride=<stride>|fps=<meanFps>|res=<W>x<H>|sc=<a>,<d>,<r>|<samples>
//
// <samples> is `;`-joined `<bitmask>:<area>:<diag>:<rot>` tokens, oldest first.
// - bitmask: bit N set means MARKER_BOARD.expectedMarkerIds member N was detected that
//   frame (bit position == marker ID, not an ordinal index - both sides import the same
//   MARKER_BOARD, so no separate ID list needs to travel in the string).
// - area/diag/rot: normalizedArea/diagonalRatio/orientationAngleRad quantized to
//   integers by the power-of-ten exponents in `sc=` (e.g. sc=6,4,4 means the encoded
//   area is round(value * 10^6), diag and rot round(value * 10^4)) so no decimal points
//   are ever stored. A bare `-` means "not computable this frame", never a fabricated 0.
// - Per-frame timestamps are not stored - time is reconstructed as index * stride / fps.
//   `stride` starts at 1 and doubles (with the buffer halved) whenever the sample cap is
//   hit, so a long recording keeps full time coverage at falling resolution instead of
//   losing its tail.

import { MARKER_BOARD } from "../CaptureQuality/captureQualityConfig";
import type { MarkerBoardFrameMetrics } from "../CaptureQuality/markerBoardCheck";

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

// Keeps a realistic worst-case export (long tag, every sample fully populated) safely
// under MAX_EXPORT_CHARS without relying on the truncation safety net below.
const MAX_SAMPLES = 300;
const MAX_TAG_CHARS = 60;
// Hard cap so a pathological recording still pastes cleanly into a chat window.
export const MAX_EXPORT_CHARS = 8192;

export interface CaptureRecorderRawSample {
	bitmask: number;
	area: number | null;
	diag: number | null;
	rot: number | null;
	fps: number;
}

export interface CaptureRecorderState {
	scenarioTag: string;
	recording: boolean;
	/** performance.now() when start() was called; used only for the live elapsed-time readout, never exported. */
	startedAtMs: number | null;
	samples: CaptureRecorderRawSample[];
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

export interface CaptureRecorderFrameInput {
	fps: number;
	frameWidth: number;
	frameHeight: number;
	/** Raw single-frame metrics from evaluateMarkerBoardFrame - reused, not recomputed, so the recorder never diverges from the real check's notion of "computable". */
	metrics: MarkerBoardFrameMetrics;
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
		fps: input.fps,
	});

	if (state.samples.length > MAX_SAMPLES) {
		state.samples = state.samples.filter((_, i) => i % 2 === 0);
		state.stride *= 2;
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

function buildLine(state: CaptureRecorderState, samples: readonly CaptureRecorderRawSample[]): string {
	const tag = sanitizeTag(state.scenarioTag);
	const res =
		state.frameWidth !== null && state.frameHeight !== null ? `${state.frameWidth}x${state.frameHeight}` : "0x0";
	const payload = samples
		.map((s) => `${s.bitmask}:${encodeMetric(s.area, AREA_SCALE)}:${encodeMetric(s.diag, DIAG_SCALE)}:${encodeMetric(s.rot, ROT_SCALE)}`)
		.join(";");
	return [
		"CQ1",
		tag,
		`n=${samples.length}`,
		`stride=${state.stride}`,
		`fps=${Math.round(meanFps(samples))}`,
		`res=${res}`,
		`sc=${AREA_SCALE_EXP},${DIAG_SCALE_EXP},${ROT_SCALE_EXP}`,
		payload,
	].join("|");
}

/**
 * Builds the exportable single-line string. Guards MAX_EXPORT_CHARS independently of
 * MAX_SAMPLES (belt-and-suspenders): if an unusually large recording still overflows
 * the hard cap, trailing samples are dropped (oldest-first data is more valuable than
 * newest for seeing a degradation curve start-to-finish, but a still-too-long line is
 * useless to anyone, so this only triggers as a last resort).
 */
export function buildCompactExport(state: CaptureRecorderState): string {
	let keep = state.samples.length;
	let line = buildLine(state, state.samples);
	while (line.length > MAX_EXPORT_CHARS && keep > 0) {
		keep = Math.floor(keep * 0.9);
		line = buildLine(state, state.samples.slice(0, keep));
	}
	return line;
}

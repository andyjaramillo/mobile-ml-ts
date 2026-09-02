// [Feature: Capture Quality Warnings]
//
// Low-light / low-contrast pre-check (spec Issue 4). Same shape as markerBoardCheck.ts:
// pure per-frame evaluation (evaluateLowLightFrame) plus recency-weighted window
// aggregation (aggregateLowLightMetrics / evaluateLowLightWindow) over a caller-owned,
// caller-resettable window (LowLightFrameWindow) - required so a multi-trial recording
// flow (FDA gait's three trials through one camera component) does not let trial 2
// inherit trial 1's frames, same as MarkerBoardFrameWindow.
//
// ROI SCOPING: luminance and contrast are measured over a region around the marker
// board, not the whole frame. A whole-frame grid produced false LOW_CONTRAST warnings on
// well-lit setups, because blank wall, plain carpet and ceiling have near-zero local
// contrast in any ordinary room - those cells say nothing about whether the camera can
// read the board. resolveLowLightRoi picks the region in priority order: (1) this frame's
// own detected-marker bounding box, padded; (2) the most recent such box still in the
// rolling window, since detection is intermittent and falling straight to a default would
// make the reading jitter frame to frame; (3) a configured default region
// (LIGHTING_ROI.defaultRoi). Path 3 is not a lesser fallback - it is the case that
// matters most, since a room too dark to detect the board at all is exactly the scenario
// with no markers to derive an ROI from, and the check must keep running there.
//
// PIXEL SOURCE CONTRACT, enforced by callers since this module only sees pixels:
// frame.imageData must come from an UNFILTERED draw of the video, because the ArUco path
// draws through a contrast/brightness filter that would report a room far brighter than
// it is. frame.markers must already be in THIS frame's pixel space, so a caller feeding a
// smaller lighting canvas must rescale detector-space corners into it first.
//
// LUMA CHOICE: BT.601 (0.299R + 0.587G + 0.114B), not LAB lightness. The spec floats LAB
// as perceptually closer to human vision, but human perception is not what this check
// answers for - it answers "can the ArUco detector still resolve markers", and the
// detector's own grayscale step (src/cv.js CV.grayscale, called from src/aruco.ts) uses
// these exact BT.601 weights on the same contrast-boosted frame. Matching what the
// detector sees, not what a person sees, is the correct target. cv.js's grayscale is
// deliberately NOT imported to compute it: (1) this folder must stay portable by plain
// copy (see types.ts header) and cv.js lives outside src/CaptureQuality/, and (2) it
// operates in-place on a pre-sized cv.js Image/dst pair built for the ArUco pipeline,
// not a plain ImageData grid walk - reimplementing the three-term weighted sum inline is
// simpler than adapting to that shape for a handful of lines of arithmetic.

import type {
	CaptureQualityDetectedMarker,
	CaptureQualityFrameSample,
	CaptureQualityIssueCode,
	CaptureQualityIssueDetails,
	CaptureQualityLiveIndicatorState,
	CaptureQualityPreCheckResult,
	CaptureQualitySeverity,
} from "./types";
import { DEFAULTS, LIGHTING_GRID, LIGHTING_ROI } from "./captureQualityConfig";
import type { CaptureQualityConfig, LightingGrid, LightingRoiConfig, LightingRoiRect, LightingThresholds } from "./captureQualityConfig";

export interface LowLightCheckConfig {
	grid: LightingGrid;
	roi: LightingRoiConfig;
	thresholds: LightingThresholds;
	/** Same field as CaptureQualityConfig.sampling.liveWindowRecencyWeight - see markerBoardCheck.ts's MarkerBoardCheckConfig for the identical convention. */
	liveWindowRecencyWeight: number;
	/** Same field as CaptureQualityConfig.sampling.ewmaReferenceTickHz - the rate at which liveWindowRecencyWeight is the effective alpha. */
	ewmaReferenceTickHz: number;
}

export function defaultLowLightCheckConfig(config: CaptureQualityConfig = DEFAULTS): LowLightCheckConfig {
	return {
		grid: LIGHTING_GRID,
		roi: LIGHTING_ROI,
		thresholds: config.lighting,
		liveWindowRecencyWeight: config.sampling.liveWindowRecencyWeight,
		ewmaReferenceTickHz: config.sampling.ewmaReferenceTickHz,
	};
}

/** Rescales the per-tick EWMA weight to an arbitrary inter-frame gap. Duplicated from markerBoardCheck.ts rather than imported - each check module stays independently portable by plain copy; see that copy for the derivation. */
function resolveEwmaAlpha(deltaMs: number, referenceTickHz: number, referenceAlpha: number): number {
	if (!(referenceTickHz > 0) || !Number.isFinite(deltaMs) || deltaMs <= 0) return referenceAlpha;
	if (referenceAlpha <= 0) return 0;
	if (referenceAlpha >= 1) return 1;
	return 1 - (1 - referenceAlpha) ** (deltaMs / (1000 / referenceTickHz));
}

/** Which of the three ROI selection paths (see module header) produced a given reading. */
export type LowLightRoiSource = "detected" | "last-known" | "default";

export interface LowLightRoiResult {
	roi: LightingRoiRect;
	source: LowLightRoiSource;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/** Padded bounding box of every detected marker corner, normalized. Returns null when there is nothing to compute a bbox from, rather than a fabricated zero-size rect. */
function computeDetectedRoi(
	markers: readonly CaptureQualityDetectedMarker[] | null,
	frameWidth: number,
	frameHeight: number,
	config: LowLightCheckConfig
): LightingRoiRect | null {
	if (!markers || markers.length === 0 || !(frameWidth > 0) || !(frameHeight > 0)) return null;
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	let any = false;
	for (const marker of markers) {
		for (const corner of marker.corners) {
			any = true;
			if (corner.x < minX) minX = corner.x;
			if (corner.x > maxX) maxX = corner.x;
			if (corner.y < minY) minY = corner.y;
			if (corner.y > maxY) maxY = corner.y;
		}
	}
	if (!any) return null;

	const bboxWidthNorm = (maxX - minX) / frameWidth;
	const bboxHeightNorm = (maxY - minY) / frameHeight;
	const padX = Math.max(bboxWidthNorm * config.roi.marginFrac, config.roi.minMarginNorm);
	const padY = Math.max(bboxHeightNorm * config.roi.marginFrac, config.roi.minMarginNorm);
	const x0 = clamp01(minX / frameWidth - padX);
	const y0 = clamp01(minY / frameHeight - padY);
	const x1 = clamp01(maxX / frameWidth + padX);
	const y1 = clamp01(maxY / frameHeight + padY);
	return { xNorm: x0, yNorm: y0, widthNorm: Math.max(0, x1 - x0), heightNorm: Math.max(0, y1 - y0) };
}

/**
 * Resolves the ROI for the NEWEST frame in `frames` (oldest first), per the three-path
 * order in the module header. Path 2 scans backward through the same bounded window
 * rather than tracking a separate value, so it decays to path 3 on its own once every
 * frame in the window has gone marker-less.
 */
export function resolveLowLightRoi(frames: readonly CaptureQualityFrameSample[], config: LowLightCheckConfig): LowLightRoiResult {
	if (frames.length > 0) {
		const current = frames[frames.length - 1];
		const detected = computeDetectedRoi(current.markers, current.frameWidth, current.frameHeight, config);
		if (detected) return { roi: detected, source: "detected" };
		for (let i = frames.length - 2; i >= 0; i--) {
			const past = frames[i];
			const roi = computeDetectedRoi(past.markers, past.frameWidth, past.frameHeight, config);
			if (roi) return { roi, source: "last-known" };
		}
	}
	return { roi: config.roi.defaultRoi, source: "default" };
}

export interface LowLightFrameMetrics {
	/** Same clock as CaptureQualityFrameSample.timestampMs, carried through so aggregateLowLightMetrics can rescale the EWMA to real elapsed time rather than assuming a fixed tick rate - mirrors MarkerBoardFrameMetrics.timestampMs. */
	timestampMs: number;
	cellCount: number;
	/** Cells with at least one sampled pixel; can be less than cellCount for a degenerate (near-zero) frame size. */
	computableCellCount: number;
	/** Mean of per-cell mean luma, over computable cells. Null if computableCellCount is 0. */
	meanLuma: number | null;
	/** Fraction of computable cells at/below thresholds.cellDarkLumaMax. Null if computableCellCount is 0. */
	darkCellFraction: number | null;
	/** Mean of per-cell luma standard deviation, over computable cells. Null if computableCellCount is 0. */
	meanContrastStd: number | null;
	/** Fraction of computable cells at/above thresholds.cellBrightLumaMin - the GLARE signal, mirror of darkCellFraction. Null if computableCellCount is 0, or if this frame's ROI was not the detected board (see evaluateLowLightWindowAggregate). */
	brightCellFraction: number | null;
	/** Brightest computable cell mean minus the darkest - how UNEVEN the roi is, the other half of GLARE. Null under the same conditions as brightCellFraction. */
	lumaSpread: number | null;
	/** Fraction of computable cells at/below thresholds.cellFlatContrastMax. Null if computableCellCount is 0. */
	flatCellFraction: number | null;
	/**
	 * Per-cell mean luma / luma std, row-major, length cellCount, null at any uncomputable
	 * cell index. Exposed (not just the frame-level aggregates above) so a recorder can
	 * summarize the underlying distribution for offline calibration (see
	 * CaptureQualityHud/captureRecorder.ts) without this module needing to know anything
	 * about export formats or byte budgets - that stays the recorder's concern.
	 */
	cellMeans: readonly (number | null)[];
	cellContrasts: readonly (number | null)[];
}

const EMPTY_METRICS: LowLightFrameMetrics = {
	timestampMs: 0,
	cellCount: 0,
	computableCellCount: 0,
	meanLuma: null,
	darkCellFraction: null,
	brightCellFraction: null,
	lumaSpread: null,
	meanContrastStd: null,
	flatCellFraction: null,
	cellMeans: [],
	cellContrasts: [],
};

function luma(data: Uint8ClampedArray, pixelIndex: number): number {
	// BT.601 - see module header for why this (and not LAB) is the correct target.
	return 0.299 * data[pixelIndex] + 0.587 * data[pixelIndex + 1] + 0.114 * data[pixelIndex + 2];
}

/**
 * Divides the ROI into a cols x rows grid and computes mean luma / luma standard
 * deviation per cell. Never throws; a cell below config.grid.minPixelsPerCell is left
 * null rather than fabricated as an unstably-noisy estimate, matching
 * evaluateMarkerBoardFrame's convention.
 */
export function evaluateLowLightFrame(
	frame: CaptureQualityFrameSample,
	config: LowLightCheckConfig,
	roi: LightingRoiRect = config.roi.defaultRoi
): LowLightFrameMetrics {
	const image = frame.imageData;
	const { cols, rows, cellSampleStride, minPixelsPerCell } = config.grid;
	const cellCount = cols * rows;
	if (!image || image.width <= 0 || image.height <= 0 || cols <= 0 || rows <= 0) {
		return { ...EMPTY_METRICS, timestampMs: frame.timestampMs, cellCount };
	}

	// The ROI may have been resolved from a different frame (last-known/default paths), so
	// clamp to THIS frame's pixel bounds rather than trusting resolution-time clamping.
	const roiX = clamp01(roi.xNorm) * image.width;
	const roiY = clamp01(roi.yNorm) * image.height;
	const roiW = Math.max(0, Math.min(clamp01(roi.widthNorm) * image.width, image.width - roiX));
	const roiH = Math.max(0, Math.min(clamp01(roi.heightNorm) * image.height, image.height - roiY));
	if (roiW <= 0 || roiH <= 0) {
		return { ...EMPTY_METRICS, timestampMs: frame.timestampMs, cellCount };
	}

	const cellW = roiW / cols;
	const cellH = roiH / rows;
	const stride = Math.max(1, Math.floor(cellSampleStride));
	const data = image.data;

	const cellMeans: (number | null)[] = new Array(cellCount).fill(null);
	const cellContrasts: (number | null)[] = new Array(cellCount).fill(null);

	let darkCells = 0;
	let brightCells = 0;
	let minCellMean = Infinity;
	let maxCellMean = -Infinity;
	let flatCells = 0;
	let computableCellCount = 0;
	let lumaSum = 0;
	let contrastSum = 0;

	for (let row = 0; row < rows; row++) {
		const yStart = Math.floor(roiY + row * cellH);
		const yEnd = Math.max(yStart + 1, Math.floor(roiY + (row + 1) * cellH));
		for (let col = 0; col < cols; col++) {
			const xStart = Math.floor(roiX + col * cellW);
			const xEnd = Math.max(xStart + 1, Math.floor(roiX + (col + 1) * cellW));

			let sum = 0;
			let sumSq = 0;
			let n = 0;
			for (let y = yStart; y < yEnd && y < image.height; y += stride) {
				const rowOffset = y * image.width * 4;
				for (let x = xStart; x < xEnd && x < image.width; x += stride) {
					const l = luma(data, rowOffset + x * 4);
					sum += l;
					sumSq += l * l;
					n++;
				}
			}

			const cellIndex = row * cols + col;
			if (n < minPixelsPerCell) continue;

			const mean = sum / n;
			// Population variance from sum/sumSq is fine here: n is >= minPixelsPerCell and
			// luma is bounded [0,255], so cancellation error is negligible.
			const variance = Math.max(0, sumSq / n - mean * mean);
			const std = Math.sqrt(variance);

			cellMeans[cellIndex] = mean;
			cellContrasts[cellIndex] = std;
			computableCellCount++;
			lumaSum += mean;
			contrastSum += std;
			if (mean < minCellMean) minCellMean = mean;
			if (mean > maxCellMean) maxCellMean = mean;
			if (mean <= config.thresholds.cellDarkLumaMax) darkCells++;
			if (mean >= config.thresholds.cellBrightLumaMin) brightCells++;
			if (std <= config.thresholds.cellFlatContrastMax) flatCells++;
		}
	}

	if (computableCellCount === 0) {
		return { ...EMPTY_METRICS, timestampMs: frame.timestampMs, cellCount };
	}

	return {
		timestampMs: frame.timestampMs,
		cellCount,
		computableCellCount,
		meanLuma: lumaSum / computableCellCount,
		darkCellFraction: darkCells / computableCellCount,
		brightCellFraction: brightCells / computableCellCount,
		lumaSpread: maxCellMean - minCellMean,
		meanContrastStd: contrastSum / computableCellCount,
		flatCellFraction: flatCells / computableCellCount,
		cellMeans,
		cellContrasts,
	};
}

/** Per-signal "is this currently firing" memory, mirroring MarkerBoardHysteresisState: a fraction sitting near a single fixed threshold oscillates with ordinary noise, which window smoothing alone does not remove. */
export interface LowLightHysteresisState {
	lowLightBad: boolean;
	glareBad: boolean;
	lowContrastBad: boolean;
}

export function createLowLightHysteresisState(): LowLightHysteresisState {
	return { lowLightBad: false, glareBad: false, lowContrastBad: false };
}

export function resetLowLightHysteresisState(state: LowLightHysteresisState): void {
	state.lowLightBad = false;
	state.glareBad = false;
	state.lowContrastBad = false;
}

/**
 * One hysteresis step. Duplicated from markerBoardCheck.ts rather than imported - each
 * check module stays independently portable by plain copy. Both lighting signals run
 * "above" direction: a higher fraction is worse, so `clearLevel` sits below `warnLevel`.
 */
function applyHysteresis(state: boolean, value: number | null, warnLevel: number, clearLevel: number): boolean {
	if (value === null) return state;
	return state ? value >= clearLevel : value > warnLevel;
}

/**
 * Caller-owned bounded ring buffer. Separate from the marker-board window because this
 * one carries ImageData, from the small lighting canvas rather than the full-resolution
 * detector one, so a window's worth stays well under a megabyte. Also doubles as the
 * buffer resolveLowLightRoi's path 2 scans.
 */
export interface LowLightFrameWindow {
	readonly maxFrames: number;
	frames: CaptureQualityFrameSample[];
	hysteresis: LowLightHysteresisState;
}

export function createLowLightFrameWindow(maxFrames: number): LowLightFrameWindow {
	return { maxFrames: Math.max(1, Math.floor(maxFrames)), frames: [], hysteresis: createLowLightHysteresisState() };
}

export function pushLowLightFrame(window: LowLightFrameWindow, frame: CaptureQualityFrameSample): void {
	window.frames.push(frame);
	if (window.frames.length > window.maxFrames) {
		window.frames.splice(0, window.frames.length - window.maxFrames);
	}
}

export function resetLowLightFrameWindow(window: LowLightFrameWindow): void {
	window.frames.length = 0;
	resetLowLightHysteresisState(window.hysteresis);
}

export interface LowLightWindowAggregate {
	frameCount: number;
	weightedMeanLuma: number | null;
	weightedDarkCellFraction: number | null;
	weightedBrightCellFraction: number | null;
	weightedLumaSpread: number | null;
	weightedMeanContrastStd: number | null;
	weightedFlatCellFraction: number | null;
	/** Metrics for the newest frame in the window, for a responsive (non-averaged) readout. */
	latest: LowLightFrameMetrics | null;
	/** ROI resolved for the newest frame - see resolveLowLightRoi. Null only for an empty window (no frames evaluated yet). */
	latestRoi: LightingRoiRect | null;
	/** Which of the three selection paths produced latestRoi. Null only for an empty window. */
	latestRoiSource: LowLightRoiSource | null;
	/** Codes currently firing. LOW_LIGHT and LOW_CONTRAST are independent (a covered lens is both at once), unlike the marker-board codes, so both may be present. */
	activeCodes: readonly CaptureQualityIssueCode[];
}

const EMPTY_AGGREGATE: LowLightWindowAggregate = {
	frameCount: 0,
	weightedMeanLuma: null,
	weightedDarkCellFraction: null,
	weightedBrightCellFraction: null,
	weightedLumaSpread: null,
	weightedMeanContrastStd: null,
	weightedFlatCellFraction: null,
	latest: null,
	latestRoi: null,
	latestRoiSource: null,
	activeCodes: [],
};

/**
 * EWMA over already-computed per-frame metrics (oldest to newest). Split from
 * evaluateLowLightWindowAggregate so the offline replay tool can drive it from a
 * recording's derived scalars without raw pixels. `hysteresis` defaults to a fresh state
 * for ad hoc callers; a live caller passes its window's own for cross-call memory.
 */
export function aggregateLowLightMetrics(
	metricsSequence: readonly LowLightFrameMetrics[],
	config: LowLightCheckConfig,
	hysteresis: LowLightHysteresisState = createLowLightHysteresisState()
): LowLightWindowAggregate {
	if (metricsSequence.length === 0) {
		return EMPTY_AGGREGATE;
	}

	let meanLuma: number | null = null;
	let darkCellFraction: number | null = null;
	let brightCellFraction: number | null = null;
	let lumaSpread: number | null = null;
	let meanContrastStd: number | null = null;
	let flatCellFraction: number | null = null;
	let latest: LowLightFrameMetrics | null = null;

	// Per-signal last-advance timestamps, same reasoning as aggregateMarkerBoardMetrics: a
	// frame whose metric is null leaves that signal untouched, so its decay must span the
	// time it actually sat unchanged, not the gap to the previous frame in the window.
	let meanLumaAtMs: number | null = null;
	let darkAtMs: number | null = null;
	let brightAtMs: number | null = null;
	let spreadAtMs: number | null = null;
	let contrastAtMs: number | null = null;
	let flatAtMs: number | null = null;

	function blend(prev: number | null, next: number | null, sinceMs: number | null, nowMs: number): number | null {
		if (next === null) return prev;
		if (prev === null) return next;
		const alpha = resolveEwmaAlpha(
			sinceMs === null ? NaN : nowMs - sinceMs,
			config.ewmaReferenceTickHz,
			config.liveWindowRecencyWeight
		);
		return alpha * next + (1 - alpha) * prev;
	}

	for (const metrics of metricsSequence) {
		latest = metrics;
		const nowMs = metrics.timestampMs;
		meanLuma = blend(meanLuma, metrics.meanLuma, meanLumaAtMs, nowMs);
		if (metrics.meanLuma !== null) meanLumaAtMs = nowMs;
		darkCellFraction = blend(darkCellFraction, metrics.darkCellFraction, darkAtMs, nowMs);
		if (metrics.darkCellFraction !== null) darkAtMs = nowMs;
		brightCellFraction = blend(brightCellFraction, metrics.brightCellFraction, brightAtMs, nowMs);
		if (metrics.brightCellFraction !== null) brightAtMs = nowMs;
		lumaSpread = blend(lumaSpread, metrics.lumaSpread, spreadAtMs, nowMs);
		if (metrics.lumaSpread !== null) spreadAtMs = nowMs;
		meanContrastStd = blend(meanContrastStd, metrics.meanContrastStd, contrastAtMs, nowMs);
		if (metrics.meanContrastStd !== null) contrastAtMs = nowMs;
		flatCellFraction = blend(flatCellFraction, metrics.flatCellFraction, flatAtMs, nowMs);
		if (metrics.flatCellFraction !== null) flatAtMs = nowMs;
	}

	const activeCodes: CaptureQualityIssueCode[] = [];
	hysteresis.lowLightBad = applyHysteresis(
		hysteresis.lowLightBad,
		darkCellFraction,
		config.thresholds.darkCellFractionThreshold,
		config.thresholds.darkCellFractionClearThreshold
	);
	if (hysteresis.lowLightBad) activeCodes.push("LOW_LIGHT");
	// Glare is a bright patch on an otherwise ordinary board, so it needs BOTH a blown-out
	// share of cells and an uneven ROI. Either condition failing clears the verdict outright
	// rather than feeding the hysteresis: an evenly bright ROI is a well-lit room (this is
	// what the first shipped pass got wrong - see captureQualityConfig), and a patch that
	// grows to fill the frame has stopped being a patch.
	const glarePattern =
		brightCellFraction === null ||
		(brightCellFraction <= config.thresholds.brightCellFractionPatchMax &&
			lumaSpread !== null &&
			lumaSpread >= config.thresholds.cellLumaSpreadMin);
	hysteresis.glareBad = glarePattern
		? applyHysteresis(
				hysteresis.glareBad,
				brightCellFraction,
				config.thresholds.brightCellFractionThreshold,
				config.thresholds.brightCellFractionClearThreshold
			)
		: false;
	if (hysteresis.glareBad) activeCodes.push("GLARE");
	hysteresis.lowContrastBad = applyHysteresis(
		hysteresis.lowContrastBad,
		flatCellFraction,
		config.thresholds.flatCellFractionThreshold,
		config.thresholds.flatCellFractionClearThreshold
	);
	// RETIRED as a warning 2026-09-02: the verdict is still computed, and both it and
	// weightedFlatCellFraction are still reported for the debug HUD, but nothing is pushed.
	//
	// It measured board GEOMETRY more than lighting. A 4x4 grid over a 3x3 marker board puts
	// cells on the blank gaps between markers, and a gap cell is flat by construction - which
	// cells land in gaps shifts with sub-pixel camera movement. On top of that the grid runs
	// over a 72x128 canvas (the video downsampled ~14x, so the board is ~33x30px and each
	// marker's 5x5 pattern is averaged away entirely), and 16 cells quantize the fraction into
	// 6.25-point steps. Replaying 1024-viable-range-sweep, the flat-cell count sits at 0.6-2.9
	// for the whole recording and spikes to 4.2 on ONE sample - enough to fire, from nothing
	// the operator did. A tester reported it as "feels buggy".
	//
	// Nothing is lost by dropping it. Whether the camera can resolve the board is answered
	// directly by whether ArUco resolves it (MARKER_INCOMPLETE / MARKER_OBSTRUCTED), and the
	// two lighting causes it stood in for have their own calibrated codes: GLARE for a
	// blown-out board, LOW_LIGHT for a dark room. The thresholds below were never fitted -
	// they are still marked UNCALIBRATED - so there was no calibration to preserve either.
	void hysteresis.lowContrastBad;

	return {
		frameCount: metricsSequence.length,
		weightedMeanLuma: meanLuma,
		weightedDarkCellFraction: darkCellFraction,
		weightedBrightCellFraction: brightCellFraction,
		weightedLumaSpread: lumaSpread,
		weightedMeanContrastStd: meanContrastStd,
		weightedFlatCellFraction: flatCellFraction,
		latest,
		latestRoi: null,
		latestRoiSource: null,
		activeCodes,
	};
}

/**
 * Live entry point. Resolves the ROI for each frame separately, not just the newest,
 * since path 2 looks back from wherever it is evaluated and an older frame's correct ROI
 * can differ. The resulting O(n^2) scan is trivial at the window's bounded size.
 */
export function evaluateLowLightWindowAggregate(
	frames: readonly CaptureQualityFrameSample[],
	config: LowLightCheckConfig,
	hysteresis?: LowLightHysteresisState
): LowLightWindowAggregate {
	if (frames.length === 0) return EMPTY_AGGREGATE;

	// The two halves of this check do not survive an undetected ROI equally. LUMA keeps
	// every path, as the module header requires: a room too dark to detect a marker is the
	// case LOW_LIGHT exists for. CONTRAST does not - on the fallback paths the grid sits
	// where the board is not (the default rect lands on floor and wall), and blank wall is
	// flat by nature, so it reports glare on a board the check is not looking at. Nulled
	// rather than zeroed, this module's "did not run", so the EWMA below skips it.
	const metricsSequence: LowLightFrameMetrics[] = [];
	let latestRoi: LightingRoiRect = config.roi.defaultRoi;
	let latestRoiSource: LowLightRoiSource = "default";
	let anyDetectedRoi = false;
	for (let i = 0; i < frames.length; i++) {
		const resolved = resolveLowLightRoi(frames.slice(0, i + 1), config);
		const metrics = evaluateLowLightFrame(frames[i], config, resolved.roi);
		if (resolved.source === "detected") {
			anyDetectedRoi = true;
			metricsSequence.push(metrics);
		} else {
			metricsSequence.push({ ...metrics, brightCellFraction: null, lumaSpread: null, meanContrastStd: null, flatCellFraction: null });
		}
		latestRoi = resolved.roi;
		latestRoiSource = resolved.source;
	}

	// Not one frame in the whole window found the board, so no contrast reading in the
	// window is about the board. Same sustained-absence case as markerBoardCheck's
	// orientation gate and the same answer: unmeasurable is not bad, so drop the verdict
	// instead of letting applyHysteresis's null-hold carry it indefinitely. The missing
	// board is already MARKER_INCOMPLETE's to report.
	if (!anyDetectedRoi && hysteresis) {
		hysteresis.lowContrastBad = false;
		hysteresis.glareBad = false;
	}

	const aggregate = aggregateLowLightMetrics(metricsSequence, config, hysteresis);
	return { ...aggregate, latestRoi, latestRoiSource };
}

export interface LowLightFrameEvaluation {
	metrics: LowLightFrameMetrics;
	roi: LightingRoiRect;
	roiSource: LowLightRoiSource;
}

/**
 * Single-tick entry point: evaluates only the newest frame, using the rest of the window
 * for the last-known fallback path. Cheaper than evaluateLowLightWindowAggregate when a
 * caller needs this tick's reading rather than the whole window's EWMA.
 */
export function evaluateLatestLowLightFrame(
	frames: readonly CaptureQualityFrameSample[],
	config: LowLightCheckConfig
): LowLightFrameEvaluation | null {
	if (frames.length === 0) return null;
	const { roi, source } = resolveLowLightRoi(frames, config);
	return { metrics: evaluateLowLightFrame(frames[frames.length - 1], config, roi), roi, roiSource: source };
}

const INDICATOR_BY_CODE: Record<"LOW_LIGHT" | "GLARE" | "LOW_CONTRAST", { severity: CaptureQualitySeverity; state: CaptureQualityLiveIndicatorState }> = {
	// Non-critical/warning: degraded lighting makes marker detection less reliable but
	// does not itself mean nothing was detected (that is MARKER_INCOMPLETE's job).
	LOW_LIGHT: { severity: "non-critical", state: "warning" },
	GLARE: { severity: "non-critical", state: "warning" },
	LOW_CONTRAST: { severity: "non-critical", state: "warning" },
};

/** The CaptureQualityPreCheckFn-shaped entry point: last-N-frames + config in, issue results out. */
export function evaluateLowLightWindow(
	frames: readonly CaptureQualityFrameSample[],
	config: LowLightCheckConfig
): CaptureQualityPreCheckResult[] {
	const aggregate = evaluateLowLightWindowAggregate(frames, config);

	const details: CaptureQualityIssueDetails = { frameCount: aggregate.frameCount };
	if (aggregate.weightedMeanLuma !== null) details.weightedMeanLuma = aggregate.weightedMeanLuma;
	if (aggregate.weightedDarkCellFraction !== null) details.weightedDarkCellFraction = aggregate.weightedDarkCellFraction;
	if (aggregate.weightedBrightCellFraction !== null) details.weightedBrightCellFraction = aggregate.weightedBrightCellFraction;
	if (aggregate.weightedLumaSpread !== null) details.weightedLumaSpread = aggregate.weightedLumaSpread;
	if (aggregate.weightedMeanContrastStd !== null) details.weightedMeanContrastStd = aggregate.weightedMeanContrastStd;
	if (aggregate.weightedFlatCellFraction !== null) details.weightedFlatCellFraction = aggregate.weightedFlatCellFraction;
	if (aggregate.latest) {
		if (aggregate.latest.meanLuma !== null) details.latestMeanLuma = aggregate.latest.meanLuma;
		if (aggregate.latest.darkCellFraction !== null) details.latestDarkCellFraction = aggregate.latest.darkCellFraction;
		if (aggregate.latest.meanContrastStd !== null) details.latestMeanContrastStd = aggregate.latest.meanContrastStd;
		if (aggregate.latest.flatCellFraction !== null) details.latestFlatCellFraction = aggregate.latest.flatCellFraction;
	}
	if (aggregate.latestRoi) {
		details.latestRoiXNorm = aggregate.latestRoi.xNorm;
		details.latestRoiYNorm = aggregate.latestRoi.yNorm;
		details.latestRoiWidthNorm = aggregate.latestRoi.widthNorm;
		details.latestRoiHeightNorm = aggregate.latestRoi.heightNorm;
	}
	if (aggregate.latestRoiSource) {
		details.latestRoiDetected = aggregate.latestRoiSource === "detected";
		details.latestRoiLastKnown = aggregate.latestRoiSource === "last-known";
		details.latestRoiDefault = aggregate.latestRoiSource === "default";
	}

	return aggregate.activeCodes.map((code) => {
		const indicator = INDICATOR_BY_CODE[code as keyof typeof INDICATOR_BY_CODE] ?? {
			severity: "non-critical" as const,
			state: "warning" as const,
		};
		return { code, state: indicator.state, severity: indicator.severity, details };
	});
}

// [Feature: Capture Quality Warnings]
//
// Low-light / low-contrast pre-check (spec Issue 4). Same shape as markerBoardCheck.ts:
// pure per-frame evaluation (evaluateLowLightFrame) plus recency-weighted window
// aggregation (aggregateLowLightMetrics / evaluateLowLightWindow) over a caller-owned,
// caller-resettable window (LowLightFrameWindow) - required so a multi-trial recording
// flow (FDA gait's three trials through one camera component) does not let trial 2
// inherit trial 1's frames, same as MarkerBoardFrameWindow.
//
// PIXEL SOURCE CONTRACT: frame.imageData here MUST come from an UNFILTERED draw of the
// video (no contrast/brightness CSS filter). The caller (RealTimeProcessor.tsx) draws
// the ArUco path through `offCtx.filter = "contrast(2) brightness(1.1)"` to help marker
// detection - measuring lighting on that would report a room considerably brighter and
// higher-contrast than it actually is, defeating the point of this check. This module
// has no way to verify that contract (it only sees pixels), so it is the caller's job -
// see the offscreen-canvas comment in RealTimeProcessor.tsx.
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
	CaptureQualityFrameSample,
	CaptureQualityIssueCode,
	CaptureQualityIssueDetails,
	CaptureQualityLiveIndicatorState,
	CaptureQualityPreCheckResult,
	CaptureQualitySeverity,
} from "./types";
import { DEFAULTS, LIGHTING_GRID } from "./captureQualityConfig";
import type { CaptureQualityConfig, LightingGrid, LightingThresholds } from "./captureQualityConfig";

export interface LowLightCheckConfig {
	grid: LightingGrid;
	thresholds: LightingThresholds;
	/** Same field as CaptureQualityConfig.sampling.liveWindowRecencyWeight - see markerBoardCheck.ts's MarkerBoardCheckConfig for the identical convention. */
	liveWindowRecencyWeight: number;
}

export function defaultLowLightCheckConfig(config: CaptureQualityConfig = DEFAULTS): LowLightCheckConfig {
	return {
		grid: LIGHTING_GRID,
		thresholds: config.lighting,
		liveWindowRecencyWeight: config.sampling.liveWindowRecencyWeight,
	};
}

export interface LowLightFrameMetrics {
	cellCount: number;
	/** Cells with at least one sampled pixel; can be less than cellCount for a degenerate (near-zero) frame size. */
	computableCellCount: number;
	/** Mean of per-cell mean luma, over computable cells. Null if computableCellCount is 0. */
	meanLuma: number | null;
	/** Fraction of computable cells at/below thresholds.cellDarkLumaMax. Null if computableCellCount is 0. */
	darkCellFraction: number | null;
	/** Mean of per-cell luma standard deviation, over computable cells. Null if computableCellCount is 0. */
	meanContrastStd: number | null;
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
	cellCount: 0,
	computableCellCount: 0,
	meanLuma: null,
	darkCellFraction: null,
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
 * Per-frame evaluation: divides frame.imageData into config.grid.cols x config.grid.rows
 * cells and computes mean luma / luma standard deviation (the simple, cheap local-contrast
 * measure - see module header for why std rather than Michelson contrast) per cell. Never
 * throws; a cell with no sampled pixels (degenerate frame size) is left null rather than
 * fabricated as 0, matching evaluateMarkerBoardFrame's convention.
 */
export function evaluateLowLightFrame(frame: CaptureQualityFrameSample, config: LowLightCheckConfig): LowLightFrameMetrics {
	const image = frame.imageData;
	const { cols, rows, cellSampleStride } = config.grid;
	const cellCount = cols * rows;
	if (!image || image.width <= 0 || image.height <= 0 || cols <= 0 || rows <= 0) {
		return { ...EMPTY_METRICS, cellCount };
	}

	const cellW = image.width / cols;
	const cellH = image.height / rows;
	const stride = Math.max(1, Math.floor(cellSampleStride));
	const data = image.data;

	const cellMeans: (number | null)[] = new Array(cellCount).fill(null);
	const cellContrasts: (number | null)[] = new Array(cellCount).fill(null);

	let darkCells = 0;
	let flatCells = 0;
	let computableCellCount = 0;
	let lumaSum = 0;
	let contrastSum = 0;

	for (let row = 0; row < rows; row++) {
		const yStart = Math.floor(row * cellH);
		const yEnd = Math.max(yStart + 1, Math.floor((row + 1) * cellH));
		for (let col = 0; col < cols; col++) {
			const xStart = Math.floor(col * cellW);
			const xEnd = Math.max(xStart + 1, Math.floor((col + 1) * cellW));

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
			if (n === 0) continue;

			const mean = sum / n;
			// Population variance from sum/sumSq is numerically fine here: at the caller's
			// ~128x72 lighting canvas (RealTimeProcessor.tsx) an 8x8 grid gives n on the
			// order of 100-150 samples per cell, and luma is bounded [0,255], so
			// cancellation error is negligible - a Welford pass would be overkill.
			const variance = Math.max(0, sumSq / n - mean * mean);
			const std = Math.sqrt(variance);

			cellMeans[cellIndex] = mean;
			cellContrasts[cellIndex] = std;
			computableCellCount++;
			lumaSum += mean;
			contrastSum += std;
			if (mean <= config.thresholds.cellDarkLumaMax) darkCells++;
			if (std <= config.thresholds.cellFlatContrastMax) flatCells++;
		}
	}

	if (computableCellCount === 0) {
		return { ...EMPTY_METRICS, cellCount };
	}

	return {
		cellCount,
		computableCellCount,
		meanLuma: lumaSum / computableCellCount,
		darkCellFraction: darkCells / computableCellCount,
		meanContrastStd: contrastSum / computableCellCount,
		flatCellFraction: flatCells / computableCellCount,
		cellMeans,
		cellContrasts,
	};
}

/**
 * Caller-owned bounded ring buffer of raw frame samples, mirroring
 * MarkerBoardFrameWindow. Deliberately a SEPARATE window from the marker-board one (not
 * a shared CaptureQualityFrameSample stream) because this one DOES carry ImageData - the
 * small dedicated lighting canvas (~128x72, see RealTimeProcessor.tsx), not the
 * full-resolution detector canvas, so a live-window's worth of frames (default 15) stays
 * well under a megabyte rather than reproducing the sampler.ts unbounded full-res buffer
 * problem this whole design already fixed once for markers.
 */
export interface LowLightFrameWindow {
	readonly maxFrames: number;
	frames: CaptureQualityFrameSample[];
}

export function createLowLightFrameWindow(maxFrames: number): LowLightFrameWindow {
	return { maxFrames: Math.max(1, Math.floor(maxFrames)), frames: [] };
}

export function pushLowLightFrame(window: LowLightFrameWindow, frame: CaptureQualityFrameSample): void {
	window.frames.push(frame);
	if (window.frames.length > window.maxFrames) {
		window.frames.splice(0, window.frames.length - window.maxFrames);
	}
}

export function resetLowLightFrameWindow(window: LowLightFrameWindow): void {
	window.frames.length = 0;
}

export interface LowLightWindowAggregate {
	frameCount: number;
	weightedMeanLuma: number | null;
	weightedDarkCellFraction: number | null;
	weightedMeanContrastStd: number | null;
	weightedFlatCellFraction: number | null;
	/** Metrics for the newest frame in the window, for a responsive (non-averaged) readout. */
	latest: LowLightFrameMetrics | null;
	/** Codes currently firing. LOW_LIGHT and LOW_CONTRAST are independent (a covered lens is both at once), unlike the marker-board codes, so both may be present. */
	activeCodes: readonly CaptureQualityIssueCode[];
}

/**
 * Aggregates a sequence of already-computed per-frame metrics (oldest to newest) with an
 * EWMA, alpha = liveWindowRecencyWeight - identical convention to
 * aggregateMarkerBoardMetrics in markerBoardCheck.ts. Factored out from
 * evaluateLowLightWindowAggregate for the same reason that function is factored out
 * there: an offline replay tool (scripts/calibrate) can drive this exact aggregation
 * without needing raw pixels, only the derived per-frame scalars a recording carries.
 */
export function aggregateLowLightMetrics(
	metricsSequence: readonly LowLightFrameMetrics[],
	config: LowLightCheckConfig
): LowLightWindowAggregate {
	if (metricsSequence.length === 0) {
		return {
			frameCount: 0,
			weightedMeanLuma: null,
			weightedDarkCellFraction: null,
			weightedMeanContrastStd: null,
			weightedFlatCellFraction: null,
			latest: null,
			activeCodes: [],
		};
	}

	const alpha = config.liveWindowRecencyWeight;
	let meanLuma: number | null = null;
	let darkCellFraction: number | null = null;
	let meanContrastStd: number | null = null;
	let flatCellFraction: number | null = null;
	let latest: LowLightFrameMetrics | null = null;

	function blend(prev: number | null, next: number | null): number | null {
		if (next === null) return prev;
		return prev === null ? next : alpha * next + (1 - alpha) * prev;
	}

	for (const metrics of metricsSequence) {
		latest = metrics;
		meanLuma = blend(meanLuma, metrics.meanLuma);
		darkCellFraction = blend(darkCellFraction, metrics.darkCellFraction);
		meanContrastStd = blend(meanContrastStd, metrics.meanContrastStd);
		flatCellFraction = blend(flatCellFraction, metrics.flatCellFraction);
	}

	const activeCodes: CaptureQualityIssueCode[] = [];
	if (darkCellFraction !== null && darkCellFraction >= config.thresholds.darkCellFractionThreshold) {
		activeCodes.push("LOW_LIGHT");
	}
	if (flatCellFraction !== null && flatCellFraction >= config.thresholds.flatCellFractionThreshold) {
		activeCodes.push("LOW_CONTRAST");
	}

	return {
		frameCount: metricsSequence.length,
		weightedMeanLuma: meanLuma,
		weightedDarkCellFraction: darkCellFraction,
		weightedMeanContrastStd: meanContrastStd,
		weightedFlatCellFraction: flatCellFraction,
		latest,
		activeCodes,
	};
}

/** The live/on-device entry point: computes per-frame metrics from raw frame samples, then delegates to aggregateLowLightMetrics. */
export function evaluateLowLightWindowAggregate(
	frames: readonly CaptureQualityFrameSample[],
	config: LowLightCheckConfig
): LowLightWindowAggregate {
	return aggregateLowLightMetrics(
		frames.map((frame) => evaluateLowLightFrame(frame, config)),
		config
	);
}

const INDICATOR_BY_CODE: Record<"LOW_LIGHT" | "LOW_CONTRAST", { severity: CaptureQualitySeverity; state: CaptureQualityLiveIndicatorState }> = {
	// Non-critical/warning: degraded lighting makes marker detection less reliable but
	// does not itself mean nothing was detected (that is MARKER_INCOMPLETE's job).
	LOW_LIGHT: { severity: "non-critical", state: "warning" },
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
	if (aggregate.weightedMeanContrastStd !== null) details.weightedMeanContrastStd = aggregate.weightedMeanContrastStd;
	if (aggregate.weightedFlatCellFraction !== null) details.weightedFlatCellFraction = aggregate.weightedFlatCellFraction;
	if (aggregate.latest) {
		if (aggregate.latest.meanLuma !== null) details.latestMeanLuma = aggregate.latest.meanLuma;
		if (aggregate.latest.darkCellFraction !== null) details.latestDarkCellFraction = aggregate.latest.darkCellFraction;
		if (aggregate.latest.meanContrastStd !== null) details.latestMeanContrastStd = aggregate.latest.meanContrastStd;
		if (aggregate.latest.flatCellFraction !== null) details.latestFlatCellFraction = aggregate.latest.flatCellFraction;
	}

	return aggregate.activeCodes.map((code) => {
		const indicator = INDICATOR_BY_CODE[code as keyof typeof INDICATOR_BY_CODE] ?? {
			severity: "non-critical" as const,
			state: "warning" as const,
		};
		return { code, state: indicator.state, severity: indicator.severity, details };
	});
}

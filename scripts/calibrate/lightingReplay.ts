// Drives the REAL aggregation code (aggregateLowLightMetrics, from
// src/CaptureQuality/lowLightCheck.ts) over lighting samples reconstructed from a parsed
// CQ2 recording - the lighting-section counterpart to replay.ts's sampleToMetrics/
// replayRecording for marker samples.
//
// RECONSTRUCTION GAP (unlike the marker replay): a CQ2 lighting sample stores only six
// quantile markers (min/p25/median/p75/max/mean) per distribution, not the 64 raw
// per-cell values (see captureRecorder.ts for why - byte budget). aggregateLowLightMetrics
// itself needs darkCellFraction/flatCellFraction, which are exact-count-based
// (fraction of 64 cells at/below a threshold) - not directly recoverable from six
// quantile points. estimateFractionBelow below approximates it by linearly interpolating
// the piecewise inverse-CDF the five markers (min/p25/median/p75/max) define. This is a
// genuine approximation, appropriate for SWEEPING candidate thresholds (relative
// comparisons across combos), not for asserting an exact classification the way
// replayRecording's marker-board replay can. Everything downstream of the estimate -
// the EWMA, the threshold comparison, which code fires - runs through the real
// aggregateLowLightMetrics, unmodified.
import { LIGHTING_GRID } from "../../src/CaptureQuality/captureQualityConfig";
import type { LightingThresholds } from "../../src/CaptureQuality/captureQualityConfig";
import { aggregateLowLightMetrics } from "../../src/CaptureQuality/lowLightCheck";
import type { LowLightCheckConfig, LowLightFrameMetrics } from "../../src/CaptureQuality/lowLightCheck";
import type { CaptureQualityIssueCode } from "../../src/CaptureQuality/types";
import type { ParsedCaptureRecording, ParsedLightingDistribution, ParsedLightingSample } from "./parse";

/**
 * Piecewise-linear estimate of the fraction of the distribution at or below `x`, given
 * only the five quantile markers (0/25/50/75/100th percentile). Monotonic and exact AT
 * the five markers; linear (and therefore approximate) between them.
 */
export function estimateFractionBelow(dist: ParsedLightingDistribution, x: number): number {
	const points: readonly [value: number, quantile: number][] = [
		[dist.min, 0],
		[dist.p25, 0.25],
		[dist.median, 0.5],
		[dist.p75, 0.75],
		[dist.max, 1],
	];
	if (x <= points[0][0]) return 0;
	if (x >= points[points.length - 1][0]) return 1;
	for (let i = 1; i < points.length; i++) {
		const [v0, q0] = points[i - 1];
		const [v1, q1] = points[i];
		if (x <= v1) {
			if (v1 === v0) return q1; // degenerate flat segment - every value in it equals v0
			return q0 + ((x - v0) / (v1 - v0)) * (q1 - q0);
		}
	}
	return 1;
}

export function lightingSampleToMetrics(
	sample: ParsedLightingSample,
	grid: { cols: number; rows: number },
	thresholds: LightingThresholds
): LowLightFrameMetrics {
	const cellCount = grid.cols * grid.rows;
	return {
		cellCount,
		computableCellCount: cellCount,
		meanLuma: sample.luma.mean,
		darkCellFraction: estimateFractionBelow(sample.luma, thresholds.cellDarkLumaMax),
		meanContrastStd: sample.contrast.mean,
		flatCellFraction: estimateFractionBelow(sample.contrast, thresholds.cellFlatContrastMax),
		cellMeans: [],
		cellContrasts: [],
	};
}

export interface LightingReplayStep {
	index: number;
	activeCodes: readonly CaptureQualityIssueCode[];
}

/** Replays a CQ2 recording's lighting samples through a sliding window, mirroring replayRecording's marker-board replay. Empty for a CQ1 recording (no lighting samples). */
export function replayLighting(
	recording: ParsedCaptureRecording,
	config: LowLightCheckConfig,
	windowSize: number
): LightingReplayStep[] {
	const grid = recording.lightingGrid ?? { cols: LIGHTING_GRID.cols, rows: LIGHTING_GRID.rows };
	const metrics = recording.lightingSamples.map((s) => lightingSampleToMetrics(s, grid, config.thresholds));
	const steps: LightingReplayStep[] = new Array(metrics.length);
	for (let i = 0; i < metrics.length; i++) {
		const start = Math.max(0, i - windowSize + 1);
		const aggregate = aggregateLowLightMetrics(metrics.slice(start, i + 1), config);
		steps[i] = { index: i, activeCodes: aggregate.activeCodes };
	}
	return steps;
}

// Drives the REAL aggregation code (aggregateMarkerBoardMetrics, extracted from
// src/CaptureQuality/markerBoardCheck.ts specifically so this file can call it) over
// samples reconstructed from a parsed CQ1 recording. This is the one and only place
// that turns a recording back into a time series of indicator states - no maths is
// re-derived here beyond decoding the compact integer encoding back to floats and
// re-deriving the sliding window aggregateMarkerBoardMetrics itself does not own.
import { MARKER_BOARD } from "../../src/CaptureQuality/captureQualityConfig";
import { aggregateMarkerBoardMetrics } from "../../src/CaptureQuality/markerBoardCheck";
import type { MarkerBoardCheckConfig, MarkerBoardFrameMetrics } from "../../src/CaptureQuality/markerBoardCheck";
import type { CaptureQualityIssueCode } from "../../src/CaptureQuality/types";
import type { ParsedCaptureRecording, ParsedCaptureSample } from "./parse";

function decode(raw: number | null, exponent: number): number | null {
	return raw === null ? null : raw / 10 ** exponent;
}

/**
 * Reconstructs a MarkerBoardFrameMetrics from one stored sample. geometryOk/
 * orientationOk are left null: they aren't recoverable from a single stored snapshot
 * against arbitrary swept thresholds (that comparison is exactly what evaluateCombo is
 * sweeping), and aggregateMarkerBoardMetrics never reads either field - they exist on
 * the type for other (live) consumers, not this replay path.
 *
 * Known gap: the original per-frame isFullSet also required "no duplicate marker IDs" -
 * duplicates aren't representable in the bitmask, so isFullSet here is just "every
 * expected ID's bit is set". A recording where the detector briefly double-reported an
 * ID would have looked slightly worse live than it replays here.
 *
 * detectedMarkerAreaNorm is always null here: the CQ1 v1 format only ever encoded `area`
 * when the frame was a full set (see captureRecorder.ts, which sources it from
 * evaluateMarkerBoardFrame's isFullSet-gated normalizedArea), so no committed recording
 * carries a size reading for an incomplete-set frame - MARKER_TOO_CLOSE can never fire
 * on replay of an existing .cq1.txt file, only on live capture. A future recorder
 * version would need to encode this separately to make that calibratable.
 */
export function sampleToMetrics(sample: ParsedCaptureSample, scaleExponents: readonly [number, number, number]): MarkerBoardFrameMetrics {
	const visibleIds = MARKER_BOARD.expectedMarkerIds.filter((id) => (sample.bitmask & (1 << id)) !== 0);
	const isFullSet = visibleIds.length === MARKER_BOARD.expectedMarkerIds.length;
	return {
		visibleCount: visibleIds.length,
		visibleIds,
		isFullSet,
		normalizedArea: isFullSet ? decode(sample.area, scaleExponents[0]) : null,
		diagonalRatio: isFullSet ? decode(sample.diag, scaleExponents[1]) : null,
		orientationAngleRad: isFullSet ? decode(sample.rot, scaleExponents[2]) : null,
		geometryOk: null,
		orientationOk: null,
		detectedMarkerAreaNorm: null,
	};
}

export interface ReplayStep {
	index: number;
	/** Reconstructed from index * stride / fps - the export carries no per-frame timestamp, only ordering and rate. */
	timestampMs: number;
	activeCodes: readonly CaptureQualityIssueCode[];
}

/** Replays a recording through a sliding window of `windowSize` samples, mirroring how RealTimeProcessor feeds MarkerBoardFrameWindow live. */
export function replayRecording(
	recording: ParsedCaptureRecording,
	config: MarkerBoardCheckConfig,
	windowSize: number
): ReplayStep[] {
	const metrics = recording.samples.map((s) => sampleToMetrics(s, recording.scaleExponents));
	const stepMs = recording.fpsMean > 0 ? (1000 * recording.stride) / recording.fpsMean : 0;
	const steps: ReplayStep[] = new Array(metrics.length);
	for (let i = 0; i < metrics.length; i++) {
		const start = Math.max(0, i - windowSize + 1);
		const aggregate = aggregateMarkerBoardMetrics(metrics.slice(start, i + 1), config);
		steps[i] = { index: i, timestampMs: i * stepMs, activeCodes: aggregate.activeCodes };
	}
	return steps;
}

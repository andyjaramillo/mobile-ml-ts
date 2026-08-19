// Drives the REAL aggregation code (aggregateMarkerBoardMetrics, extracted from
// src/CaptureQuality/markerBoardCheck.ts specifically so this file can call it) over
// samples reconstructed from a parsed CQ1 recording. This is the one and only place
// that turns a recording back into a time series of indicator states - no maths is
// re-derived here beyond decoding the compact integer encoding back to floats and
// re-deriving the sliding window aggregateMarkerBoardMetrics itself does not own.
import { MARKER_BOARD } from "../../src/CaptureQuality/captureQualityConfig";
import {
	aggregateMarkerBoardMetrics,
	createMarkerBoardHysteresisState,
	createMarkerPersistenceTracker,
	evaluateMarkerPersistence,
	updateMarkerPersistenceTracker,
} from "../../src/CaptureQuality/markerBoardCheck";
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
 * detectedMarkerAreaNorm is decoded from sample.detArea when present - only CQ2
 * recordings carry it (see captureRecorder.ts CQ2 format header); a CQ1-parsed sample's
 * detArea is always null (parse.ts), so this stays null for every existing
 * calibration/*.cq1.txt recording exactly as before - MARKER_TOO_CLOSE still cannot fire
 * on replay of those files, only on a fresh CQ2 recording or live capture.
 */
export function sampleToMetrics(
	sample: ParsedCaptureSample,
	scaleExponents: readonly [number, number, number],
	timestampMs: number
): MarkerBoardFrameMetrics {
	const visibleIds = MARKER_BOARD.expectedMarkerIds.filter((id) => (sample.bitmask & (1 << id)) !== 0);
	const isFullSet = visibleIds.length === MARKER_BOARD.expectedMarkerIds.length;
	return {
		timestampMs,
		visibleCount: visibleIds.length,
		visibleIds,
		isFullSet,
		normalizedArea: isFullSet ? decode(sample.area, scaleExponents[0]) : null,
		diagonalRatio: isFullSet ? decode(sample.diag, scaleExponents[1]) : null,
		orientationAngleRad: isFullSet ? decode(sample.rot, scaleExponents[2]) : null,
		geometryOk: null,
		orientationOk: null,
		// CQ1/CQ2/CQ3 recordings carry no board centroid - the field postdates them - so
		// alignment simply cannot be replayed from those formats. Null means "not measured",
		// and aggregateMarkerBoardMetrics skips it rather than treating it as misaligned.
		boardCentroidNorm: null,
		detectedMarkerAreaNorm: decode(sample.detArea, scaleExponents[0]),
	};
}

export interface ReplayStep {
	index: number;
	/** Reconstructed from index * stride / fps - the export carries no per-frame timestamp, only ordering and rate. */
	timestampMs: number;
	activeCodes: readonly CaptureQualityIssueCode[];
}

/**
 * Replays a recording through a sliding window of `windowSize` samples, mirroring how
 * RealTimeProcessor feeds MarkerBoardFrameWindow live. The per-marker persistence signal
 * (see MarkerPersistenceResult) deliberately does NOT use the same sliding window - it is
 * tracked incrementally over the FULL recording to date (i=0..i), exactly mirroring
 * MarkerBoardFrameWindow.persistence's unbounded-lookback behavior on the live path (see
 * markerBoardCheck.ts for why the ~15-frame recency window is too short to see a
 * structural miss at the fps real recordings measure). The hysteresis state (see
 * MarkerBoardHysteresisState) is likewise created ONCE per recording and mutated step by
 * step, not per-window - exactly mirroring MarkerBoardFrameWindow.hysteresis on the live
 * path, and required for the flap-count numbers this tool reports to reflect real
 * hysteresis behavior rather than a fresh (non-hysteresis) verdict every step.
 */
export function replayRecording(
	recording: ParsedCaptureRecording,
	config: MarkerBoardCheckConfig,
	windowSize: number
): ReplayStep[] {
	const stepMs = recording.fpsMean > 0 ? (1000 * recording.stride) / recording.fpsMean : 0;
	const metrics = recording.samples.map((s, i) => sampleToMetrics(s, recording.scaleExponents, i * stepMs));
	const tracker = createMarkerPersistenceTracker();
	const hysteresis = createMarkerBoardHysteresisState();
	const steps: ReplayStep[] = new Array(metrics.length);
	for (let i = 0; i < metrics.length; i++) {
		updateMarkerPersistenceTracker(tracker, metrics[i].timestampMs, metrics[i].visibleIds);
		const persistence = evaluateMarkerPersistence(
			tracker,
			MARKER_BOARD.expectedMarkerIds,
			metrics[i].timestampMs,
			config.thresholds.persistentMissThresholdMs
		);
		const start = Math.max(0, i - windowSize + 1);
		const aggregate = aggregateMarkerBoardMetrics(metrics.slice(start, i + 1), config, persistence, hysteresis);
		steps[i] = { index: i, timestampMs: metrics[i].timestampMs, activeCodes: aggregate.activeCodes };
	}
	return steps;
}

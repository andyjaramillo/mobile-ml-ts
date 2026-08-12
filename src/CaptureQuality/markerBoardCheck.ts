// [Feature: Capture Quality Warnings]
//
// Marker-board visibility/geometry check. Ports 1NonVisibleMarkers.tsx's algorithm
// onto the CaptureQuality contract (types.ts) with three bugs fixed along the way:
//
// 1. COORDINATE-SPACE CONTRACT: every geometry computation in this file assumes
//    CaptureQualityFrameSample.frameWidth/frameHeight are in the SAME coordinate
//    space as CaptureQualityDetectedMarker.corners for that frame — i.e. whatever
//    resolution the detector actually ran at (e.g. the ~640-wide downscaled hidden
//    canvas), NOT the video element's CSS display size. The prototype mixed these
//    (corners in detector space, frame dimensions in CSS display space), which made
//    every area/ratio meaningless and CSS-layout-dependent. The caller building the
//    CaptureQualityFrameSample owns this contract; get it wrong and every threshold
//    here is silently wrong again.
// 2. UNCHECKED INDEXING: the prototype crashed (or silently used garbage) whenever
//    the detected marker set had duplicate IDs, unexpected IDs, or fewer than 4
//    corners on a marker it needed. Every lookup here is guarded; anything
//    unavailable resolves to null rather than throwing or guessing.
// 3. MODULE-LEVEL STATE: the prototype held notification IDs in module `let`s, which
//    can't support two camera instances. This file is pure — no notifications, no
//    module state. The rolling window is an explicit object the caller creates,
//    pushes frames into, and resets (see MarkerBoardFrameWindow below) — required so
//    a multi-trial recording flow can start trial 2 without trial 1's frames.

import type {
	CaptureQualityDetectedMarker,
	CaptureQualityFrameSample,
	CaptureQualityIssueCode,
	CaptureQualityIssueDetails,
	CaptureQualityLiveIndicatorState,
	CaptureQualityPoint,
	CaptureQualityPreCheckResult,
	CaptureQualitySeverity,
} from "./types";
import { DEFAULTS, MARKER_BOARD } from "./captureQualityConfig";
import type { CaptureQualityConfig, MarkerBoardLayout, MarkerBoardThresholds } from "./captureQualityConfig";

export interface MarkerBoardCheckConfig {
	layout: MarkerBoardLayout;
	thresholds: MarkerBoardThresholds;
	/** Same field as CaptureQualityConfig.sampling.liveWindowRecencyWeight — the EWMA weight given to the newest frame each update. */
	liveWindowRecencyWeight: number;
}

/** Convenience: build a MarkerBoardCheckConfig from a resolved CaptureQualityConfig (defaults to the top-level DEFAULTS/MARKER_BOARD). */
export function defaultMarkerBoardCheckConfig(config: CaptureQualityConfig = DEFAULTS): MarkerBoardCheckConfig {
	return {
		layout: MARKER_BOARD,
		thresholds: config.markerBoard,
		liveWindowRecencyWeight: config.sampling.liveWindowRecencyWeight,
	};
}

export interface MarkerBoardFrameMetrics {
	visibleCount: number;
	/** Sorted ascending, for display/debugging only. */
	visibleIds: readonly number[];
	/** Every layout.expectedMarkerIds member present, and no duplicate IDs anywhere in the frame. */
	isFullSet: boolean;
	/** Mean per-marker corner-bbox area / (frameWidth * frameHeight), in detector-input space. Null unless isFullSet. */
	normalizedArea: number | null;
	diagonalRatio: number | null;
	orientationAngleRad: number | null;
	geometryOk: boolean | null;
	orientationOk: boolean | null;
	/**
	 * Mean per-marker corner-bbox area / (frameWidth * frameHeight) over whatever
	 * markers WERE detected this frame, regardless of isFullSet. Distinct from
	 * normalizedArea (which requires the complete expected set so its calibrated
	 * threshold keeps meaning "the whole board, at this size") - this is the signal
	 * that lets an incomplete set be read as "too close to fit the frame" instead of
	 * "too far away / occluded" (see MARKER_TOO_CLOSE in aggregateMarkerBoardMetrics).
	 * Null when there were no markers with usable corners at all.
	 */
	detectedMarkerAreaNorm: number | null;
}

const EMPTY_METRICS: Omit<MarkerBoardFrameMetrics, "visibleCount" | "visibleIds"> = {
	isFullSet: false,
	normalizedArea: null,
	diagonalRatio: null,
	orientationAngleRad: null,
	geometryOk: null,
	orientationOk: null,
	detectedMarkerAreaNorm: null,
};

function buildMarkerIndex(markers: readonly CaptureQualityDetectedMarker[]): {
	byId: Map<number, CaptureQualityDetectedMarker>;
	hasDuplicates: boolean;
} {
	const byId = new Map<number, CaptureQualityDetectedMarker>();
	const duplicateIds = new Set<number>();
	for (const marker of markers) {
		if (duplicateIds.has(marker.id)) continue;
		if (byId.has(marker.id)) {
			byId.delete(marker.id); // no longer a trustworthy unique position on the board
			duplicateIds.add(marker.id);
			continue;
		}
		byId.set(marker.id, marker);
	}
	return { byId, hasDuplicates: duplicateIds.size > 0 };
}

function markerBBoxArea(corners: readonly CaptureQualityPoint[]): number | null {
	if (corners.length < 2) return null;
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const c of corners) {
		if (c.x < minX) minX = c.x;
		if (c.x > maxX) maxX = c.x;
		if (c.y < minY) minY = c.y;
		if (c.y > maxY) maxY = c.y;
	}
	return (maxX - minX) * (maxY - minY);
}

function computeNormalizedArea(
	byId: Map<number, CaptureQualityDetectedMarker>,
	layout: MarkerBoardLayout,
	frameWidth: number,
	frameHeight: number
): number | null {
	if (!(frameWidth > 0) || !(frameHeight > 0)) return null;
	let sum = 0;
	let count = 0;
	for (const id of layout.expectedMarkerIds) {
		const marker = byId.get(id);
		if (!marker) return null;
		const area = markerBBoxArea(marker.corners);
		if (area === null) return null;
		sum += area;
		count++;
	}
	if (count === 0) return null;
	return sum / count / (frameWidth * frameHeight);
}

/** Same as computeNormalizedArea's per-marker averaging, but over whatever markers are present in byId rather than requiring every layout.expectedMarkerIds member - see MarkerBoardFrameMetrics.detectedMarkerAreaNorm. */
function computeDetectedMarkerAreaNorm(
	byId: Map<number, CaptureQualityDetectedMarker>,
	frameWidth: number,
	frameHeight: number
): number | null {
	if (!(frameWidth > 0) || !(frameHeight > 0)) return null;
	let sum = 0;
	let count = 0;
	for (const marker of byId.values()) {
		const area = markerBBoxArea(marker.corners);
		if (area === null) continue;
		sum += area;
		count++;
	}
	if (count === 0) return null;
	return sum / count / (frameWidth * frameHeight);
}

function selectCorner(
	corners: readonly CaptureQualityPoint[],
	compare: (a: CaptureQualityPoint, b: CaptureQualityPoint) => number
): CaptureQualityPoint | null {
	if (corners.length === 0) return null;
	return [...corners].sort(compare)[0];
}

function distance(a: CaptureQualityPoint, b: CaptureQualityPoint): number {
	return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function computeDiagonalRatio(
	byId: Map<number, CaptureQualityDetectedMarker>,
	layout: MarkerBoardLayout,
	frameWidth: number,
	frameHeight: number
): number | null {
	if (!(frameWidth > 0) || !(frameHeight > 0)) return null;
	const { top, right, bottom, left } = layout.diamondCornerIds;
	const topMarker = byId.get(top);
	const rightMarker = byId.get(right);
	const bottomMarker = byId.get(bottom);
	const leftMarker = byId.get(left);
	if (!topMarker || !rightMarker || !bottomMarker || !leftMarker) return null;

	// Corner-selection rules preserved as-is from the ported prototype
	// (1NonVisibleMarkers.tsx diagonal_ratio): each picks one specific extreme corner
	// of its own marker, not a symmetric edge midpoint — including the "right" marker
	// reusing the same max-y rule as "top" rather than a mirrored max-x rule. That
	// asymmetry looks like a bug but is unverified either way; it is not one of the
	// two bugs this port was asked to fix, so it is carried forward unchanged.
	const leftPoint = selectCorner(leftMarker.corners, (a, b) => a.x - b.x);
	const bottomTopPoint = selectCorner(bottomMarker.corners, (a, b) => a.y - b.y);
	const topBottomPoint = selectCorner(topMarker.corners, (a, b) => b.y - a.y);
	const rightBottomPoint = selectCorner(rightMarker.corners, (a, b) => b.y - a.y);
	if (!leftPoint || !bottomTopPoint || !topBottomPoint || !rightBottomPoint) return null;

	const verticalDiagNorm = distance(topBottomPoint, bottomTopPoint) / frameHeight;
	const horizontalDiagNorm = distance(rightBottomPoint, leftPoint) / frameWidth;
	if (verticalDiagNorm === 0 || horizontalDiagNorm === 0) return null;
	return Math.min(verticalDiagNorm, horizontalDiagNorm) / Math.max(verticalDiagNorm, horizontalDiagNorm);
}

function markerCenter(marker: CaptureQualityDetectedMarker): CaptureQualityPoint | null {
	// Matches the prototype's convention: midpoint of corners[1] and corners[3], not
	// an average of all four corners — preserved so orientation behavior does not
	// change, only the crash-on-short-corners case is fixed.
	if (marker.corners.length < 4) return null;
	return {
		x: (marker.corners[1].x + marker.corners[3].x) / 2,
		y: (marker.corners[1].y + marker.corners[3].y) / 2,
	};
}

function computeOrientationAngleRad(
	byId: Map<number, CaptureQualityDetectedMarker>,
	layout: MarkerBoardLayout
): number | null {
	const [tailId, headId] = layout.forwardAxisMarkerIds;
	const tail = byId.get(tailId);
	const head = byId.get(headId);
	if (!tail || !head) return null;
	const tailCenter = markerCenter(tail);
	const headCenter = markerCenter(head);
	if (!tailCenter || !headCenter) return null;
	// atan2 is invariant to positive uniform scaling of both arguments, so — unlike
	// area/diagonal, which mix magnitudes across axes — this needs no frame-space
	// normalization at all; dividing both components by the same frame dimension
	// (as the prototype did) would not have changed the result.
	return Math.abs(Math.atan2(tailCenter.x - headCenter.x, tailCenter.y - headCenter.y));
}

/** Per-frame evaluation: raw geometry metrics for one sampled frame. Never throws; unavailable metrics are null. */
export function evaluateMarkerBoardFrame(
	frame: CaptureQualityFrameSample,
	config: MarkerBoardCheckConfig
): MarkerBoardFrameMetrics {
	const markers = frame.markers;
	const visibleCount = markers ? markers.length : 0;
	const visibleIds = markers ? [...new Set(markers.map((m) => m.id))].sort((a, b) => a - b) : [];
	if (!markers || markers.length === 0) {
		return { visibleCount, visibleIds, ...EMPTY_METRICS };
	}

	const { byId, hasDuplicates } = buildMarkerIndex(markers);
	// Computed regardless of full-set-ness (unlike normalizedArea below) so an
	// incomplete frame still carries a usable "how big are the markers we DID see"
	// signal - see MARKER_TOO_CLOSE in aggregateMarkerBoardMetrics.
	const detectedMarkerAreaNorm = computeDetectedMarkerAreaNorm(byId, frame.frameWidth, frame.frameHeight);
	const isFullSet = !hasDuplicates && config.layout.expectedMarkerIds.every((id) => byId.has(id));
	if (!isFullSet) {
		return { visibleCount, visibleIds, ...EMPTY_METRICS, detectedMarkerAreaNorm };
	}

	const normalizedArea = computeNormalizedArea(byId, config.layout, frame.frameWidth, frame.frameHeight);
	const diagonalRatio = computeDiagonalRatio(byId, config.layout, frame.frameWidth, frame.frameHeight);
	const orientationAngleRad = computeOrientationAngleRad(byId, config.layout);

	const geometryOk =
		normalizedArea !== null && diagonalRatio !== null
			? normalizedArea >= config.thresholds.minimumMarkerAreaNorm &&
				diagonalRatio >= config.thresholds.diagonalRatioMin &&
				diagonalRatio <= config.thresholds.diagonalRatioMax
			: null;
	const orientationOk =
		orientationAngleRad !== null ? orientationAngleRad <= config.thresholds.orientationMarginRad : null;

	return {
		visibleCount,
		visibleIds,
		isFullSet: true,
		normalizedArea,
		diagonalRatio,
		orientationAngleRad,
		geometryOk,
		orientationOk,
		detectedMarkerAreaNorm,
	};
}

/**
 * Explicit, caller-owned rolling window of raw frame samples (bounded ring buffer).
 * Deliberately holds no ImageData — this check only needs marker geometry — so it
 * cannot reproduce the sampler.ts unbounded-buffer memory problem. Must be reset
 * between trials (see resetMarkerBoardFrameWindow): a multi-trial recording flow
 * (e.g. FDA gait's three trials) must not let trial 2 start with trial 1's frames.
 */
export interface MarkerBoardFrameWindow {
	readonly maxFrames: number;
	frames: CaptureQualityFrameSample[];
}

export function createMarkerBoardFrameWindow(maxFrames: number): MarkerBoardFrameWindow {
	return { maxFrames: Math.max(1, Math.floor(maxFrames)), frames: [] };
}

export function pushMarkerBoardFrame(window: MarkerBoardFrameWindow, frame: CaptureQualityFrameSample): void {
	window.frames.push(frame);
	if (window.frames.length > window.maxFrames) {
		window.frames.splice(0, window.frames.length - window.maxFrames);
	}
}

export function resetMarkerBoardFrameWindow(window: MarkerBoardFrameWindow): void {
	window.frames.length = 0;
}

export interface MarkerBoardWindowAggregate {
	frameCount: number;
	/** Exponential-moving-average fraction of the window showing the full marker set; 0 for an empty window. */
	weightedFullSetScore: number;
	weightedNormalizedArea: number | null;
	weightedDiagonalRatio: number | null;
	weightedOrientationAngleRad: number | null;
	/** EWMA of MarkerBoardFrameMetrics.detectedMarkerAreaNorm, updated on every frame with a computable value regardless of isFullSet - see that field's doc. */
	weightedDetectedMarkerAreaNorm: number | null;
	/** Metrics for the newest frame in the window, for a responsive (non-averaged) readout. */
	latest: MarkerBoardFrameMetrics | null;
	/** Codes currently firing, in priority order. Empty means the board looks fine right now. */
	activeCodes: readonly CaptureQualityIssueCode[];
}

/**
 * Recency-weighted aggregation over a caller-supplied window of frames (oldest to
 * newest). Uses an exponential moving average with alpha = liveWindowRecencyWeight,
 * which is exactly what that config field's doc ("weight given to the most recent
 * frame") describes: the newest sample gets weight alpha directly, and each older
 * frame's influence decays by (1 - alpha) per step back. Geometry/orientation EWMAs
 * only advance on full-set frames — a partial-board frame leaves them unchanged
 * rather than pulling them toward a meaningless value, per the "partial-board
 * geometry is misleading" rule.
 */
/**
 * Aggregates a sequence of already-computed per-frame metrics (oldest to newest).
 * Factored out of evaluateMarkerBoardWindowAggregate below so an offline replay tool
 * (see scripts/calibrate) can drive this exact recency-weighted aggregation from
 * MarkerBoardFrameMetrics reconstructed out of a recorded export, without needing the
 * original marker corner geometry — a recording only carries the already-derived
 * per-frame scalars (see CaptureQualityHud/captureRecorder.ts), not raw corners.
 * evaluateMarkerBoardWindowAggregate is a thin wrapper around this for the live path.
 */
export function aggregateMarkerBoardMetrics(
	metricsSequence: readonly MarkerBoardFrameMetrics[],
	config: MarkerBoardCheckConfig
): MarkerBoardWindowAggregate {
	if (metricsSequence.length === 0) {
		return {
			frameCount: 0,
			weightedFullSetScore: 0,
			weightedNormalizedArea: null,
			weightedDiagonalRatio: null,
			weightedOrientationAngleRad: null,
			weightedDetectedMarkerAreaNorm: null,
			latest: null,
			activeCodes: [],
		};
	}

	const alpha = config.liveWindowRecencyWeight;
	let fullSetScore: number | null = null;
	let normalizedArea: number | null = null;
	let diagonalRatio: number | null = null;
	let orientationAngleRad: number | null = null;
	let detectedMarkerAreaNorm: number | null = null;
	let latest: MarkerBoardFrameMetrics | null = null;

	for (const metrics of metricsSequence) {
		latest = metrics;

		const fullSetSample = metrics.isFullSet ? 1 : 0;
		fullSetScore = fullSetScore === null ? fullSetSample : alpha * fullSetSample + (1 - alpha) * fullSetScore;

		if (metrics.detectedMarkerAreaNorm !== null) {
			detectedMarkerAreaNorm =
				detectedMarkerAreaNorm === null
					? metrics.detectedMarkerAreaNorm
					: alpha * metrics.detectedMarkerAreaNorm + (1 - alpha) * detectedMarkerAreaNorm;
		}

		if (metrics.isFullSet) {
			if (metrics.normalizedArea !== null) {
				normalizedArea =
					normalizedArea === null ? metrics.normalizedArea : alpha * metrics.normalizedArea + (1 - alpha) * normalizedArea;
			}
			if (metrics.diagonalRatio !== null) {
				diagonalRatio =
					diagonalRatio === null ? metrics.diagonalRatio : alpha * metrics.diagonalRatio + (1 - alpha) * diagonalRatio;
			}
			if (metrics.orientationAngleRad !== null) {
				orientationAngleRad =
					orientationAngleRad === null
						? metrics.orientationAngleRad
						: alpha * metrics.orientationAngleRad + (1 - alpha) * orientationAngleRad;
			}
		}
	}

	const weightedFullSetScore = fullSetScore ?? 0;
	const activeCodes: CaptureQualityIssueCode[] = [];
	// Priority order: completeness first — if the board isn't reliably fully visible,
	// geometry/orientation numbers from the sliver that is visible are not meaningful,
	// so every other code is suppressed rather than fired alongside it. Which of the two
	// incompleteness codes fires depends on why: a large mean size for the markers that
	// ARE visible means the board doesn't fit the frame (MARKER_TOO_CLOSE, remedy: move
	// back); anything else defaults to MARKER_INCOMPLETE (remedy: move closer / clear
	// occlusion) since that has been the safe, always-correct-for-"too far" behavior.
	// tooCloseDetectedAreaNorm is null (uncalibrated - see captureQualityConfig.ts) until
	// real close-range data exists, so this branch is a no-op in DEFAULTS today.
	if (weightedFullSetScore < config.thresholds.minimumFullSetWeight) {
		if (
			config.thresholds.tooCloseDetectedAreaNorm !== null &&
			detectedMarkerAreaNorm !== null &&
			detectedMarkerAreaNorm >= config.thresholds.tooCloseDetectedAreaNorm
		) {
			activeCodes.push("MARKER_TOO_CLOSE");
		} else {
			activeCodes.push("MARKER_INCOMPLETE");
		}
	} else if (orientationAngleRad !== null && orientationAngleRad > config.thresholds.orientationMarginRad) {
		// Orientation next, and gating (not just ordered before) the two metrics below: a
		// heavily rotated board corrupts normalizedArea/diagonalRatio because both assume
		// the diamond corner-role mapping (top/right/bottom/left) still matches reality
		// (rot-90 measured area 0.00414 vs 0.00316 aligned, diagonal 0.639 vs 0.238 - see
		// captureQualityConfig.ts diagonalRatio comment). Reporting MARKER_TOO_SMALL or
		// MARKER_SKEWED off a rotation-corrupted reading would point the user at the wrong
		// fix, so they're suppressed until orientation is back in range.
		activeCodes.push("MARKER_WRONG_ORIENTATION");
	} else {
		if (normalizedArea !== null && normalizedArea < config.thresholds.minimumMarkerAreaNorm) {
			activeCodes.push("MARKER_TOO_SMALL");
		}
		if (
			diagonalRatio !== null &&
			(diagonalRatio < config.thresholds.diagonalRatioMin || diagonalRatio > config.thresholds.diagonalRatioMax)
		) {
			activeCodes.push("MARKER_SKEWED");
		}
	}

	return {
		frameCount: metricsSequence.length,
		weightedFullSetScore,
		weightedNormalizedArea: normalizedArea,
		weightedDiagonalRatio: diagonalRatio,
		weightedOrientationAngleRad: orientationAngleRad,
		weightedDetectedMarkerAreaNorm: detectedMarkerAreaNorm,
		latest,
		activeCodes,
	};
}

/** The live/on-device entry point: computes per-frame metrics from raw frame samples, then delegates to aggregateMarkerBoardMetrics. */
export function evaluateMarkerBoardWindowAggregate(
	frames: readonly CaptureQualityFrameSample[],
	config: MarkerBoardCheckConfig
): MarkerBoardWindowAggregate {
	return aggregateMarkerBoardMetrics(
		frames.map((frame) => evaluateMarkerBoardFrame(frame, config)),
		config
	);
}

const INDICATOR_BY_CODE: Record<
	"MARKER_INCOMPLETE" | "MARKER_TOO_CLOSE" | "MARKER_TOO_SMALL" | "MARKER_SKEWED" | "MARKER_WRONG_ORIENTATION",
	{ severity: CaptureQualitySeverity; state: CaptureQualityLiveIndicatorState }
> = {
	MARKER_INCOMPLETE: { severity: "critical", state: "critical" },
	MARKER_TOO_CLOSE: { severity: "critical", state: "critical" },
	MARKER_TOO_SMALL: { severity: "non-critical", state: "warning" },
	MARKER_SKEWED: { severity: "non-critical", state: "warning" },
	MARKER_WRONG_ORIENTATION: { severity: "non-critical", state: "warning" },
};

/** The CaptureQualityPreCheckFn-shaped entry point: last-N-frames + config in, issue results out. */
export function evaluateMarkerBoardWindow(
	frames: readonly CaptureQualityFrameSample[],
	config: MarkerBoardCheckConfig
): CaptureQualityPreCheckResult[] {
	const aggregate = evaluateMarkerBoardWindowAggregate(frames, config);

	// Shared by every code returned from this call: both the stable weighted-window
	// aggregate (drives indicator colour) and the latest single frame (responsive).
	// CaptureQualityIssueDetails can't hold null, so unavailable metrics are omitted
	// rather than included as a fake number.
	const details: CaptureQualityIssueDetails = {
		frameCount: aggregate.frameCount,
		weightedFullSetScore: aggregate.weightedFullSetScore,
	};
	if (aggregate.weightedNormalizedArea !== null) details.weightedNormalizedArea = aggregate.weightedNormalizedArea;
	if (aggregate.weightedDiagonalRatio !== null) details.weightedDiagonalRatio = aggregate.weightedDiagonalRatio;
	if (aggregate.weightedOrientationAngleRad !== null) {
		details.weightedOrientationAngleRad = aggregate.weightedOrientationAngleRad;
	}
	if (aggregate.weightedDetectedMarkerAreaNorm !== null) {
		details.weightedDetectedMarkerAreaNorm = aggregate.weightedDetectedMarkerAreaNorm;
	}
	if (aggregate.latest) {
		details.latestVisibleCount = aggregate.latest.visibleCount;
		details.latestIsFullSet = aggregate.latest.isFullSet;
		if (aggregate.latest.normalizedArea !== null) details.latestNormalizedArea = aggregate.latest.normalizedArea;
		if (aggregate.latest.diagonalRatio !== null) details.latestDiagonalRatio = aggregate.latest.diagonalRatio;
		if (aggregate.latest.orientationAngleRad !== null) {
			details.latestOrientationAngleRad = aggregate.latest.orientationAngleRad;
		}
		if (aggregate.latest.detectedMarkerAreaNorm !== null) {
			details.latestDetectedMarkerAreaNorm = aggregate.latest.detectedMarkerAreaNorm;
		}
	}

	return aggregate.activeCodes.map((code) => {
		const indicator = INDICATOR_BY_CODE[code as keyof typeof INDICATOR_BY_CODE] ?? {
			severity: "non-critical" as const,
			state: "warning" as const,
		};
		return { code, state: indicator.state, severity: indicator.severity, details };
	});
}

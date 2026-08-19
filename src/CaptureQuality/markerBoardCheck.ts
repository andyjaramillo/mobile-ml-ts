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
import { MARKER_ALIGNMENT } from "./captureQualityConfig";
import type { CaptureQualityConfig, MarkerAlignmentTarget, MarkerBoardLayout, MarkerBoardThresholds } from "./captureQualityConfig";

export interface MarkerBoardCheckConfig {
	layout: MarkerBoardLayout;
	thresholds: MarkerBoardThresholds;
	/** Where the board is supposed to sit in frame - see MARKER_ALIGNMENT. */
	alignment: MarkerAlignmentTarget;
	/** Same field as CaptureQualityConfig.sampling.liveWindowRecencyWeight — the EWMA weight given to the newest frame, at ewmaReferenceTickHz. */
	liveWindowRecencyWeight: number;
	/** Same field as CaptureQualityConfig.sampling.ewmaReferenceTickHz - the rate at which liveWindowRecencyWeight is the effective alpha. */
	ewmaReferenceTickHz: number;
}

/** Convenience: build a MarkerBoardCheckConfig from a resolved CaptureQualityConfig (defaults to the top-level DEFAULTS/MARKER_BOARD). */
export function defaultMarkerBoardCheckConfig(config: CaptureQualityConfig = DEFAULTS): MarkerBoardCheckConfig {
	return {
		layout: MARKER_BOARD,
		thresholds: config.markerBoard,
		alignment: MARKER_ALIGNMENT,
		liveWindowRecencyWeight: config.sampling.liveWindowRecencyWeight,
		ewmaReferenceTickHz: config.sampling.ewmaReferenceTickHz,
	};
}

/**
 * Rescales the per-tick EWMA weight to an arbitrary inter-frame gap, so smoothing spans a
 * fixed wall-clock time rather than a fixed number of ticks. `1 - (1 - a)^(dt / dtRef)` is
 * the exact resampling of a geometric decay - N steps of dtRef/N compose to one step of
 * dtRef - so the result is independent of how finely the interval is subdivided. A
 * non-positive or non-finite gap (first frame, repeated timestamp, clock jump) falls back
 * to alphaRef rather than returning 0 or NaN and freezing the average.
 */
export function resolveEwmaAlpha(deltaMs: number, referenceTickHz: number, referenceAlpha: number): number {
	if (!(referenceTickHz > 0) || !Number.isFinite(deltaMs) || deltaMs <= 0) return referenceAlpha;
	if (referenceAlpha <= 0) return 0;
	if (referenceAlpha >= 1) return 1;
	const referenceDeltaMs = 1000 / referenceTickHz;
	return 1 - (1 - referenceAlpha) ** (deltaMs / referenceDeltaMs);
}

export interface MarkerBoardFrameMetrics {
	/** Same clock as CaptureQualityFrameSample.timestampMs for this frame - carried through so aggregateMarkerBoardMetrics can measure REAL elapsed time for the per-marker persistence signal (see MarkerPersistenceResult) instead of assuming a fixed frame rate. */
	timestampMs: number;
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
	/**
	 * Centroid of every detected marker, as a fraction of frame width/height. Drives the
	 * MARKER_NOT_ALIGNED check - every other marker metric is satisfied by a board sitting
	 * anywhere in view, so without this a perfectly-sized board in the wrong corner reads as
	 * good. Null when no marker had usable corners.
	 */
	boardCentroidNorm: { x: number; y: number } | null;
}

const EMPTY_METRICS: Omit<MarkerBoardFrameMetrics, "timestampMs" | "visibleCount" | "visibleIds"> = {
	isFullSet: false,
	normalizedArea: null,
	diagonalRatio: null,
	orientationAngleRad: null,
	geometryOk: null,
	orientationOk: null,
	detectedMarkerAreaNorm: null,
	boardCentroidNorm: null,
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

function computeBoardCentroidNorm(
	markers: readonly CaptureQualityDetectedMarker[],
	frameWidth: number,
	frameHeight: number
): { x: number; y: number } | null {
	if (!(frameWidth > 0) || !(frameHeight > 0)) return null;
	const centers = markers.map(markerCenter).filter((c): c is CaptureQualityPoint => c !== null);
	if (centers.length === 0) return null;
	const sumX = centers.reduce((sum, c) => sum + c.x, 0);
	const sumY = centers.reduce((sum, c) => sum + c.y, 0);
	return { x: sumX / centers.length / frameWidth, y: sumY / centers.length / frameHeight };
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
		return { timestampMs: frame.timestampMs, visibleCount, visibleIds, ...EMPTY_METRICS };
	}

	const { byId, hasDuplicates } = buildMarkerIndex(markers);
	// Computed from whatever markers were seen, full set or not: the alignment check answers
	// "is the camera pointed at the right place", which is worth knowing even on a frame where
	// one marker dropped out.
	const boardCentroidNorm = computeBoardCentroidNorm(markers, frame.frameWidth, frame.frameHeight);
	// Computed regardless of full-set-ness (unlike normalizedArea below) so an
	// incomplete frame still carries a usable "how big are the markers we DID see"
	// signal - see MARKER_TOO_CLOSE in aggregateMarkerBoardMetrics.
	const detectedMarkerAreaNorm = computeDetectedMarkerAreaNorm(byId, frame.frameWidth, frame.frameHeight);
	const isFullSet = !hasDuplicates && config.layout.expectedMarkerIds.every((id) => byId.has(id));
	if (!isFullSet) {
		return {
			timestampMs: frame.timestampMs,
			visibleCount,
			visibleIds,
			...EMPTY_METRICS,
			detectedMarkerAreaNorm,
			boardCentroidNorm,
		};
	}

	const normalizedArea = computeNormalizedArea(byId, config.layout, frame.frameWidth, frame.frameHeight);
	const diagonalRatio = computeDiagonalRatio(byId, config.layout, frame.frameWidth, frame.frameHeight);
	const orientationAngleRad = computeOrientationAngleRad(byId, config.layout);

	const geometryOk =
		normalizedArea !== null && diagonalRatio !== null
			? normalizedArea >= config.thresholds.sizeWarnLowerNorm &&
				diagonalRatio >= config.thresholds.diagonalRatioMin &&
				diagonalRatio <= config.thresholds.diagonalRatioMax
			: null;
	const orientationOk =
		orientationAngleRad !== null ? orientationAngleRad <= config.thresholds.orientationMarginRad : null;

	return {
		timestampMs: frame.timestampMs,
		visibleCount,
		visibleIds,
		isFullSet: true,
		normalizedArea,
		diagonalRatio,
		orientationAngleRad,
		geometryOk,
		orientationOk,
		detectedMarkerAreaNorm,
		boardCentroidNorm,
	};
}

/**
 * Per-marker "how long has this ID been continuously absent" tracker. Deliberately NOT
 * bounded by MarkerBoardFrameWindow.maxFrames (the ~15-frame EWMA recency window): a
 * structural miss (something covering the board) needs a longer lookback than that
 * window can hold. At the fps actually measured on real hardware (28-43fps), a 15-frame
 * window only spans 0.35-0.54s - straddling the 0.5s persistence threshold - so bounding
 * this to the same window would sometimes fail to register a genuinely permanent miss
 * for no reason other than the window being too short to see it. Cost is O(1) state per
 * marker (a handful of numbers), so there is no memory-growth reason to bound it either.
 */
export interface MarkerPersistenceTracker {
	lastSeenMs: Map<number, number>;
	/** Timestamp of the first frame pushed since the last reset - the "missing since" baseline for a marker never yet seen this trial. */
	firstFrameTimestampMs: number | null;
}

export function createMarkerPersistenceTracker(): MarkerPersistenceTracker {
	return { lastSeenMs: new Map(), firstFrameTimestampMs: null };
}

export function updateMarkerPersistenceTracker(
	tracker: MarkerPersistenceTracker,
	timestampMs: number,
	visibleIds: readonly number[]
): void {
	if (tracker.firstFrameTimestampMs === null) tracker.firstFrameTimestampMs = timestampMs;
	for (const id of visibleIds) tracker.lastSeenMs.set(id, timestampMs);
}

export function resetMarkerPersistenceTracker(tracker: MarkerPersistenceTracker): void {
	tracker.lastSeenMs.clear();
	tracker.firstFrameTimestampMs = null;
}

export interface MarkerPersistenceResult {
	/** Every expected marker ID currently missing for >= the configured threshold, as of the tracker's most recent update. */
	persistentMissingIds: readonly number[];
	/** Longest current per-marker absence across all expected markers, in ms. Null if the tracker has never been updated. */
	longestCurrentMissMs: number | null;
}

const NO_PERSISTENT_MISS: MarkerPersistenceResult = { persistentMissingIds: [], longestCurrentMissMs: null };

/** Reads the tracker's CURRENT state as of `nowMs` - does not itself advance the tracker (see updateMarkerPersistenceTracker). */
export function evaluateMarkerPersistence(
	tracker: MarkerPersistenceTracker,
	expectedMarkerIds: readonly number[],
	nowMs: number,
	thresholdMs: number
): MarkerPersistenceResult {
	if (tracker.firstFrameTimestampMs === null) return NO_PERSISTENT_MISS;
	const persistentMissingIds: number[] = [];
	let longestCurrentMissMs = 0;
	for (const id of expectedMarkerIds) {
		const lastSeenMs = tracker.lastSeenMs.get(id) ?? tracker.firstFrameTimestampMs;
		const missingMs = nowMs - lastSeenMs;
		if (missingMs > longestCurrentMissMs) longestCurrentMissMs = missingMs;
		if (missingMs >= thresholdMs) persistentMissingIds.push(id);
	}
	return { persistentMissingIds, longestCurrentMissMs: longestCurrentMissMs > 0 ? longestCurrentMissMs : null };
}

/**
 * Per-signal "is this currently firing" memory for the three continuous thresholds that
 * get hysteresis (orientation, the full-set visibility gate, and the size-too-small
 * nudge - see applyHysteresis below and captureQualityConfig.ts's *ClearNorm/*ClearWeight/
 * *ClearMarginRad field docs for the gap derivations). Same reasoning as
 * MarkerPersistenceTracker for why this is caller-owned mutable state rather than derived
 * fresh each call: a signal sitting near a single fixed threshold oscillates with any
 * amount of measurement noise, and no amount of window smoothing removes that - the fix
 * requires remembering which side of the threshold the check was already on, across calls,
 * which a pure per-window-snapshot function cannot do on its own.
 */
export interface MarkerBoardHysteresisState {
	alignmentBad: boolean;
	orientationBad: boolean;
	fullSetBad: boolean;
	tooSmallBad: boolean;
	tooLargeBad: boolean;
}

export function createMarkerBoardHysteresisState(): MarkerBoardHysteresisState {
	return { alignmentBad: false, orientationBad: false, fullSetBad: false, tooSmallBad: false, tooLargeBad: false };
}

export function resetMarkerBoardHysteresisState(state: MarkerBoardHysteresisState): void {
	state.alignmentBad = false;
	state.orientationBad = false;
	state.fullSetBad = false;
	state.tooSmallBad = false;
	state.tooLargeBad = false;
}

/**
 * One hysteresis step: `state` is the previous call's verdict, `value` the freshly
 * computed signal. `direction` says which side of the threshold counts as bad -
 * "above" (e.g. orientation angle) needs `clearLevel < warnLevel` to mean anything;
 * "below" (e.g. full-set score, size) needs `clearLevel > warnLevel`. Not yet bad, the
 * signal must cross `warnLevel` to become bad (unchanged from a plain single-threshold
 * comparison); already bad, it must cross the more forgiving `clearLevel`, not merely
 * back over `warnLevel`, to clear - that gap is what a same-magnitude noise excursion
 * can no longer bridge. `value === null` (signal not computable this call) holds the
 * previous verdict rather than guessing.
 */
function applyHysteresis(
	state: boolean,
	value: number | null,
	warnLevel: number,
	clearLevel: number,
	direction: "above" | "below"
): boolean {
	if (value === null) return state;
	if (direction === "above") {
		return state ? value >= clearLevel : value > warnLevel;
	}
	return state ? value <= clearLevel : value < warnLevel;
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
	/** Unbounded-lookback companion to `frames` - see MarkerPersistenceTracker. */
	persistence: MarkerPersistenceTracker;
	/** Cross-call hysteresis memory companion to `frames` - see MarkerBoardHysteresisState. */
	hysteresis: MarkerBoardHysteresisState;
}

export function createMarkerBoardFrameWindow(maxFrames: number): MarkerBoardFrameWindow {
	return {
		maxFrames: Math.max(1, Math.floor(maxFrames)),
		frames: [],
		persistence: createMarkerPersistenceTracker(),
		hysteresis: createMarkerBoardHysteresisState(),
	};
}

export function pushMarkerBoardFrame(window: MarkerBoardFrameWindow, frame: CaptureQualityFrameSample): void {
	window.frames.push(frame);
	if (window.frames.length > window.maxFrames) {
		window.frames.splice(0, window.frames.length - window.maxFrames);
	}
	const visibleIds = frame.markers ? [...new Set(frame.markers.map((m) => m.id))] : [];
	updateMarkerPersistenceTracker(window.persistence, frame.timestampMs, visibleIds);
}

export function resetMarkerBoardFrameWindow(window: MarkerBoardFrameWindow): void {
	window.frames.length = 0;
	resetMarkerPersistenceTracker(window.persistence);
	resetMarkerBoardHysteresisState(window.hysteresis);
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
	/** EWMA board centroid, as a fraction of frame width/height. Null when no frame in the window saw a marker. */
	weightedBoardCentroidNorm: { x: number; y: number } | null;
	/** Distance of weightedBoardCentroidNorm from the overlay's target, per axis, in the same normalized units. Null with no centroid. */
	alignmentOffsetNorm: { x: number; y: number } | null;
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
	config: MarkerBoardCheckConfig,
	persistence: MarkerPersistenceResult = NO_PERSISTENT_MISS,
	hysteresis: MarkerBoardHysteresisState = createMarkerBoardHysteresisState()
): MarkerBoardWindowAggregate {
	if (metricsSequence.length === 0) {
		return {
			frameCount: 0,
			weightedFullSetScore: 0,
			weightedNormalizedArea: null,
			weightedDiagonalRatio: null,
			weightedOrientationAngleRad: null,
			weightedDetectedMarkerAreaNorm: null,
			weightedBoardCentroidNorm: null,
			alignmentOffsetNorm: null,
			latest: null,
			activeCodes: [],
		};
	}

	let fullSetScore: number | null = null;
	let normalizedArea: number | null = null;
	let diagonalRatio: number | null = null;
	let orientationAngleRad: number | null = null;
	let detectedMarkerAreaNorm: number | null = null;
	let boardCentroidNorm: { x: number; y: number } | null = null;
	let latest: MarkerBoardFrameMetrics | null = null;

	// Each signal decays over the time since IT last advanced, not since the last frame in
	// the window - the geometry EWMAs below skip partial-board frames entirely, so a shared
	// frame-to-frame gap would under-weight a full-set frame that arrives after a long run
	// of partial ones. Tracked per signal so the decay always spans the interval the value
	// actually sat unchanged. Null until that signal has seeded.
	let fullSetAtMs: number | null = null;
	let normalizedAreaAtMs: number | null = null;
	let diagonalRatioAtMs: number | null = null;
	let orientationAtMs: number | null = null;
	let detectedAreaAtMs: number | null = null;
	let boardCentroidAtMs: number | null = null;

	// One-entry memo on the gap: a steady loop (and every offline replay, whose gap is a
	// constant reconstructed from the recording's mean fps) repeats the same delta on
	// almost every step, and the exponentiation is otherwise the most expensive thing in
	// this loop - it more than doubled the calibration sweep's runtime without this.
	let memoDelta = NaN;
	let memoAlpha = config.liveWindowRecencyWeight;
	const alphaSince = (sinceMs: number | null, nowMs: number): number => {
		const delta = sinceMs === null ? NaN : nowMs - sinceMs;
		if (delta !== memoDelta) {
			memoDelta = delta;
			memoAlpha = resolveEwmaAlpha(delta, config.ewmaReferenceTickHz, config.liveWindowRecencyWeight);
		}
		return memoAlpha;
	};

	for (const metrics of metricsSequence) {
		latest = metrics;
		const nowMs = metrics.timestampMs;

		const fullSetSample = metrics.isFullSet ? 1 : 0;
		const fullSetAlpha = alphaSince(fullSetAtMs, nowMs);
		fullSetScore = fullSetScore === null ? fullSetSample : fullSetAlpha * fullSetSample + (1 - fullSetAlpha) * fullSetScore;
		fullSetAtMs = nowMs;

		if (metrics.detectedMarkerAreaNorm !== null) {
			const a = alphaSince(detectedAreaAtMs, nowMs);
			detectedMarkerAreaNorm =
				detectedMarkerAreaNorm === null ? metrics.detectedMarkerAreaNorm : a * metrics.detectedMarkerAreaNorm + (1 - a) * detectedMarkerAreaNorm;
			detectedAreaAtMs = nowMs;
		}

		// Truthiness, not `!== null`: a caller that predates this field (an older replay path,
		// a hand-built metrics literal) supplies `undefined`, which a null-check would let
		// through and then dereference. This module's contract is that it never throws.
		if (metrics.boardCentroidNorm) {
			const a = alphaSince(boardCentroidAtMs, nowMs);
			boardCentroidNorm =
				boardCentroidNorm === null
					? metrics.boardCentroidNorm
					: {
							x: a * metrics.boardCentroidNorm.x + (1 - a) * boardCentroidNorm.x,
							y: a * metrics.boardCentroidNorm.y + (1 - a) * boardCentroidNorm.y,
						};
			boardCentroidAtMs = nowMs;
		}

		if (metrics.isFullSet) {
			if (metrics.normalizedArea !== null) {
				const a = alphaSince(normalizedAreaAtMs, nowMs);
				normalizedArea = normalizedArea === null ? metrics.normalizedArea : a * metrics.normalizedArea + (1 - a) * normalizedArea;
				normalizedAreaAtMs = nowMs;
			}
			if (metrics.diagonalRatio !== null) {
				const a = alphaSince(diagonalRatioAtMs, nowMs);
				diagonalRatio = diagonalRatio === null ? metrics.diagonalRatio : a * metrics.diagonalRatio + (1 - a) * diagonalRatio;
				diagonalRatioAtMs = nowMs;
			}
			if (metrics.orientationAngleRad !== null) {
				const a = alphaSince(orientationAtMs, nowMs);
				orientationAngleRad =
					orientationAngleRad === null ? metrics.orientationAngleRad : a * metrics.orientationAngleRad + (1 - a) * orientationAngleRad;
				orientationAtMs = nowMs;
			}
		}
	}

	const weightedFullSetScore = fullSetScore ?? 0;
	const activeCodes: CaptureQualityIssueCode[] = [];
	// "Widened ideal band" model (2026-08-13). Full-set rate still owns whether the board
	// is visible at all; size (normalizedArea/detectedMarkerAreaNorm) never blocks by
	// itself - see captureQualityConfig.ts's MarkerBoardThresholds doc for the full
	// decision table. All three of the checks below (orientation, full-set gate, size
	// floor) go through applyHysteresis rather than a bare threshold comparison: `hysteresis`
	// is caller-owned mutable state (see MarkerBoardFrameWindow.hysteresis for the
	// production caller), so the verdict below depends on the PREVIOUS call's state, not
	// just this call's numbers - that is what lets a signal sitting right at a threshold
	// stop flapping instead of just filtering the noise (which doesn't work - see
	// applyHysteresis's doc). A caller that never threads a state through (the default
	// parameter creates a fresh one) gets the old single-threshold behavior back, since a
	// fresh state has nothing to remember.
	//
	// Priority order: ORIENTATION FIRST, independent of the full-set gate (2026-08-13
	// reorder - previously gated behind it). orientationAngleRad's own EWMA above only
	// ever advances on full-set frames (see the `if (metrics.isFullSet)` block), so it is
	// already a full-set-only signal on its own merits and does not need the full-set
	// gate to be trustworthy - a real regression this reorder fixes: at the previous
	// minimumFullSetWeight=0.90, rot-90 (80.0% raw full-set rate) failed the visibility
	// gate before orientation was ever evaluated, so a genuinely rotated board reported as
	// a visibility problem (MARKER_INCOMPLETE) instead of the actionable
	// MARKER_WRONG_ORIENTATION - the wrong instruction, since straightening the board is
	// what actually fixes it (rotation is very likely WHY full-set rate is depressed in
	// the first place, not a coincidence). Completeness is checked next: if the board
	// isn't reliably fully visible, the size numbers from the sliver that is visible are
	// not meaningful, so every other code is suppressed rather than fired alongside it.
	// Which incompleteness code fires depends on whether the miss is STRUCTURAL (see
	// MarkerPersistenceResult - the same marker gone for >= persistentMissThresholdMs, not
	// scattered noise): a scattered incomplete set always reports MARKER_INCOMPLETE
	// regardless of size, since there is no single persistent culprit to reason about size
	// from. A persistent miss splits further by detected marker size, which is the only
	// case where size distinguishes "board doesn't fit the frame" (large ->
	// MARKER_TOO_CLOSE, remedy: step back/tilt down) from "something is covering it"
	// (mid-range -> MARKER_OBSTRUCTED) from "too far to resolve" (small ->
	// MARKER_INCOMPLETE, remedy: move closer). The TOO_CLOSE/OBSTRUCTED/INCOMPLETE split
	// itself is NOT hysteresis-controlled (out of this revision's scope) - only whether the
	// gate that leads into that branch is open or closed.
	const hasPersistentMiss = persistence.persistentMissingIds.length > 0;

	// ALIGNMENT: is the board in the right PART of the frame. Every other marker signal is
	// satisfied by a board that is anywhere in view, so without this a correctly-sized,
	// correctly-oriented board sitting in the wrong corner reads as good. Evaluated per axis
	// against the overlay's own target (see MARKER_ALIGNMENT) rather than as a single radius,
	// because x is normalized by frame width and y by frame height - a shared radius would
	// mean different physical distances on the two axes.
	const alignmentOffsetNorm =
		boardCentroidNorm === null
			? null
			: {
					x: Math.abs(boardCentroidNorm.x - config.alignment.targetXNorm),
					y: Math.abs(boardCentroidNorm.y - config.alignment.targetYNorm),
				};
	if (alignmentOffsetNorm !== null) {
		const outsideWarn =
			alignmentOffsetNorm.x > config.alignment.toleranceXNorm || alignmentOffsetNorm.y > config.alignment.toleranceYNorm;
		const insideClear =
			alignmentOffsetNorm.x <= config.alignment.clearXNorm && alignmentOffsetNorm.y <= config.alignment.clearYNorm;
		hysteresis.alignmentBad = hysteresis.alignmentBad ? !insideClear : outsideWarn;
	}

	hysteresis.orientationBad = applyHysteresis(
		hysteresis.orientationBad,
		orientationAngleRad,
		config.thresholds.orientationMarginRad,
		config.thresholds.orientationClearMarginRad,
		"above"
	);
	hysteresis.fullSetBad = applyHysteresis(
		hysteresis.fullSetBad,
		weightedFullSetScore,
		config.thresholds.minimumFullSetWeight,
		config.thresholds.minimumFullSetClearWeight,
		"below"
	);

	if (hysteresis.orientationBad) {
		// Also still gates (not just precedes) the two metrics below: a heavily rotated
		// board corrupts normalizedArea/diagonalRatio because both assume the diamond
		// corner-role mapping (top/right/bottom/left) still matches reality (rot-90
		// measured area 0.00414 vs 0.00316 aligned, diagonal 0.639 vs 0.238 - see
		// captureQualityConfig.ts diagonalRatio comment). Reporting MARKER_TOO_SMALL/
		// MARKER_TOO_LARGE/MARKER_SKEWED off a rotation-corrupted reading would point the
		// user at the wrong fix, so they're suppressed until orientation is back in range.
		// tooSmallBad/tooLargeBad are deliberately left un-updated here (not evaluated
		// while orientation-gated) so each resumes from its last real reading, not a
		// corrupted one, once orientation clears.
		activeCodes.push("MARKER_WRONG_ORIENTATION");
	} else if (hysteresis.fullSetBad) {
		const ceiling = config.thresholds.tooCloseDetectedAreaNorm;
		if (hasPersistentMiss && detectedMarkerAreaNorm !== null && ceiling !== null && detectedMarkerAreaNorm > ceiling) {
			activeCodes.push("MARKER_TOO_CLOSE");
		} else if (
			hasPersistentMiss &&
			detectedMarkerAreaNorm !== null &&
			ceiling !== null &&
			detectedMarkerAreaNorm >= config.thresholds.sizeWarnLowerNorm &&
			detectedMarkerAreaNorm <= ceiling
		) {
			activeCodes.push("MARKER_OBSTRUCTED");
		} else {
			activeCodes.push("MARKER_INCOMPLETE");
		}
	} else {
		// Full set reliably present, orientation fine: size is a NUDGE only
		// (non-critical/warning - see INDICATOR_BY_CODE), never a hard fail. Four-boundary
		// band (see captureQualityConfig.ts) - below sizeWarnLowerNorm or at/above
		// sizeWarnUpperNorm nudges; everything between is silent at this layer (the HUD
		// surfaces the ideal band's positive confirmation - see
		// CaptureQualityHud/captureQualityGuidance.ts). The two boundaries can never both
		// fire on the same reading (sizeWarnLowerNorm < sizeWarnUpperNorm by construction),
		// so evaluating both independently rather than if/else-if is safe and keeps each
		// one's hysteresis state accurate even while the other is inactive.
		hysteresis.tooSmallBad = applyHysteresis(
			hysteresis.tooSmallBad,
			normalizedArea,
			config.thresholds.sizeWarnLowerNorm,
			config.thresholds.sizeWarnLowerClearNorm,
			"below"
		);
		if (hysteresis.tooSmallBad) {
			activeCodes.push("MARKER_TOO_SMALL");
		}
		hysteresis.tooLargeBad = applyHysteresis(
			hysteresis.tooLargeBad,
			normalizedArea,
			config.thresholds.sizeWarnUpperNorm,
			config.thresholds.sizeWarnUpperClearNorm,
			"above"
		);
		if (hysteresis.tooLargeBad) {
			activeCodes.push("MARKER_TOO_LARGE");
		}
		if (
			diagonalRatio !== null &&
			(diagonalRatio < config.thresholds.diagonalRatioMin || diagonalRatio > config.thresholds.diagonalRatioMax)
		) {
			activeCodes.push("MARKER_SKEWED");
		}
		// Evaluated in the same branch as the size nudges, and for the same reason: "the board
		// is in the wrong part of the frame" is only meaningful advice once the board is
		// actually resolvable and correctly oriented. While it is not, the codes above already
		// tell the user to fix something more fundamental.
		if (hysteresis.alignmentBad) {
			activeCodes.push("MARKER_NOT_ALIGNED");
		}
	}

	return {
		frameCount: metricsSequence.length,
		weightedFullSetScore,
		weightedNormalizedArea: normalizedArea,
		weightedDiagonalRatio: diagonalRatio,
		weightedOrientationAngleRad: orientationAngleRad,
		weightedDetectedMarkerAreaNorm: detectedMarkerAreaNorm,
		weightedBoardCentroidNorm: boardCentroidNorm,
		alignmentOffsetNorm,
		latest,
		activeCodes,
	};
}

/**
 * The live/on-device entry point: computes per-frame metrics from raw frame samples,
 * then delegates to aggregateMarkerBoardMetrics. `persistenceTracker` and `hysteresis`
 * are both optional and default to "no memory" (matching pre-persistence/pre-hysteresis
 * behavior) so ad hoc callers (tests, evaluateMarkerBoardWindow below) that only have a
 * bare frame array can still call this - production callers pass the frame window's own
 * `.persistence`/`.hysteresis` (see MarkerBoardFrameWindow), which is what gives both
 * signals their cross-call memory.
 */
export function evaluateMarkerBoardWindowAggregate(
	frames: readonly CaptureQualityFrameSample[],
	config: MarkerBoardCheckConfig,
	persistenceTracker?: MarkerPersistenceTracker,
	hysteresis?: MarkerBoardHysteresisState
): MarkerBoardWindowAggregate {
	const metricsSequence = frames.map((frame) => evaluateMarkerBoardFrame(frame, config));
	const persistence =
		persistenceTracker && frames.length > 0
			? evaluateMarkerPersistence(
					persistenceTracker,
					config.layout.expectedMarkerIds,
					frames[frames.length - 1].timestampMs,
					config.thresholds.persistentMissThresholdMs
				)
			: NO_PERSISTENT_MISS;
	return aggregateMarkerBoardMetrics(metricsSequence, config, persistence, hysteresis);
}

const INDICATOR_BY_CODE: Record<
	"MARKER_INCOMPLETE" | "MARKER_TOO_CLOSE" | "MARKER_OBSTRUCTED" | "MARKER_TOO_SMALL" | "MARKER_TOO_LARGE" | "MARKER_SKEWED" | "MARKER_WRONG_ORIENTATION" | "MARKER_NOT_ALIGNED",
	{ severity: CaptureQualitySeverity; state: CaptureQualityLiveIndicatorState }
> = {
	MARKER_INCOMPLETE: { severity: "critical", state: "critical" },
	MARKER_TOO_CLOSE: { severity: "critical", state: "critical" },
	MARKER_OBSTRUCTED: { severity: "critical", state: "critical" },
	MARKER_TOO_SMALL: { severity: "non-critical", state: "warning" },
	MARKER_TOO_LARGE: { severity: "non-critical", state: "warning" },
	MARKER_SKEWED: { severity: "non-critical", state: "warning" },
	MARKER_WRONG_ORIENTATION: { severity: "non-critical", state: "warning" },
	MARKER_NOT_ALIGNED: { severity: "non-critical", state: "warning" },
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

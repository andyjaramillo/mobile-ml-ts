// [Feature: Capture Quality Warnings]
//
// Pre-recording check for the subject: are they detected, are they alone, are they
// standing still, and are they at the start line. Same shape as markerBoardCheck.ts and
// lowLightCheck.ts - a pure per-frame evaluation plus a recency-weighted window
// aggregation over a caller-owned, resettable window - so the orchestrator drives all
// three identically.
//
// WHAT THIS GATES, AND WHAT IT DELIBERATELY DOES NOT. It emits three codes that block the
// pre-record green light: SUBJECT_NOT_DETECTED, MULTIPLE_PEOPLE, SUBJECT_NOT_AT_START_LINE.
// It does NOT gate on stillness - a stationarity warning is not one of the things this
// feature is being built to surface, so speed and area-CV are computed for the debug HUD and
// nothing else. See captureQualityConfig.ts's SubjectPositionThresholds.
//
// THE POSITION SIGNAL IS BBOX AREA, NOT DISTANCE FROM THE BOARD. Measured 2026-08-17:
// standing at the start line and standing too far back both read ~2.8 board lengths from the
// board centroid, because the camera looks down the walk path - stepping back moves the
// subject toward the camera, so the centroid barely moves while the box doubles. Area
// separates the two cleanly (0.16 vs 0.30) where distance cannot separate them at all.
// startLineDistanceBoardLengths is still computed and reported; it is just not a gate.
//
// IT RUNS ON A FRACTION OF THE TICKS. Person detection is round-robined (see
// sampling.personDetectEveryNTicks), so most frames in the window carry people=null. Null
// means "detector did not run", NOT "found nobody" - every function here skips those frames
// rather than counting them as a miss. Getting this wrong turns the round-robin itself into
// a permanent SUBJECT_NOT_DETECTED.
//
// CALIBRATED 2026-08-17 against calibration/2026-08-17-gait-subject-*.cq4.txt - six
// recordings with a real subject on the real board. Those recordings are the specification:
// tests/CaptureQuality/subjectPositionReplay.test.ts replays each one through this exact
// code and pins its classification.

import { DEFAULTS } from "./captureQualityConfig";
import { MARKER_BOARD } from "./captureQualityConfig";
import { resolveEwmaAlpha } from "./markerBoardCheck";
import type { CaptureQualityConfig, MarkerBoardLayout, SubjectPositionThresholds } from "./captureQualityConfig";
import type {
	CaptureQualityBBox,
	CaptureQualityDetectedMarker,
	CaptureQualityFrameSample,
	CaptureQualityIssueCode,
	CaptureQualityPoint,
} from "./types";

export interface SubjectPositionCheckConfig {
	layout: MarkerBoardLayout;
	thresholds: SubjectPositionThresholds;
	/** Same field as CaptureQualityConfig.sampling.liveWindowRecencyWeight. */
	liveWindowRecencyWeight: number;
	/** Same field as CaptureQualityConfig.sampling.ewmaReferenceTickHz. */
	ewmaReferenceTickHz: number;
}

/**
 * The two sampling fields deliberately do NOT mirror the other checks: this check's samples
 * arrive at the person-detect cadence, an order of magnitude slower than the display tick,
 * so it takes its own weight stated at its own rate.
 */
export function defaultSubjectPositionCheckConfig(config: CaptureQualityConfig = DEFAULTS): SubjectPositionCheckConfig {
	const detectHz = config.sampling.liveTickHz / Math.max(1, config.sampling.personDetectEveryNTicks);
	return {
		layout: MARKER_BOARD,
		thresholds: config.subjectPosition,
		liveWindowRecencyWeight: config.sampling.subjectWindowRecencyWeight,
		ewmaReferenceTickHz: detectHz > 0 ? detectHz : config.sampling.ewmaReferenceTickHz,
	};
}

export interface SubjectPositionFrameMetrics {
	/** Same clock as CaptureQualityFrameSample.timestampMs - carried so the aggregation can measure real elapsed time between the sparse frames person detection actually ran on. */
	timestampMs: number;
	/** Null when person detection did not run on this frame. 0 means it ran and found nobody. */
	personCount: number | null;
	/** The box taken to be the patient - see selectSubject. Null if detection did not run or found nobody. */
	subjectBBox: CaptureQualityBBox | null;
	subjectCentroid: CaptureQualityPoint | null;
	/** Subject bbox area / frame area. Dimensionless, so it needs no board normalization. */
	subjectAreaNorm: number | null;
	/** Centroid of every detected marker. Null when no marker was detected. */
	boardCentroid: CaptureQualityPoint | null;
	/** Distance between the two forward-axis marker centers, in frame pixels. Null unless BOTH are visible - this is the unit every distance here is expressed in, so a guess would silently rescale every threshold. */
	boardLengthPx: number | null;
	/** Subject-centroid-to-board-centroid distance, in board lengths. NOT A GATE - reported only. Null when either endpoint or the unit is unavailable. */
	startLineDistanceBoardLengths: number | null;
	/**
	 * THE position signal: (boardCentroidY - subjectCentroidY) / frameHeight. Positive when
	 * the subject stands beyond the board (higher in frame). Null without both a subject and
	 * a board. See captureQualityConfig.ts's SubjectPositionThresholds for why this and not
	 * bbox area or centroid distance.
	 */
	boardToSubjectGapNorm: number | null;
}

function centroidOf(bbox: CaptureQualityBBox): CaptureQualityPoint {
	return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
}

function distance(a: CaptureQualityPoint, b: CaptureQualityPoint): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function markerCenter(marker: CaptureQualityDetectedMarker): CaptureQualityPoint | null {
	if (!marker.corners || marker.corners.length === 0) return null;
	let sumX = 0;
	let sumY = 0;
	for (const corner of marker.corners) {
		sumX += corner.x;
		sumY += corner.y;
	}
	return { x: sumX / marker.corners.length, y: sumY / marker.corners.length };
}

function computeBoardCentroid(markers: readonly CaptureQualityDetectedMarker[]): CaptureQualityPoint | null {
	const centers = markers.map(markerCenter).filter((c): c is CaptureQualityPoint => c !== null);
	if (centers.length === 0) return null;
	const sumX = centers.reduce((sum, c) => sum + c.x, 0);
	const sumY = centers.reduce((sum, c) => sum + c.y, 0);
	return { x: sumX / centers.length, y: sumY / centers.length };
}

/**
 * The board's on-screen scale, taken from the forward-axis diagonal rather than a marker
 * size or the board's bounding box: the board lies flat under heavy perspective
 * foreshortening (see the physical-setup notes), so its bbox height shrinks with viewing
 * angle while the diagonal between two known markers is a real, identifiable segment. Null
 * unless both endpoints are visible - an interpolated unit would rescale every threshold
 * downstream without saying so.
 */
function computeBoardLengthPx(
	markers: readonly CaptureQualityDetectedMarker[],
	layout: MarkerBoardLayout
): number | null {
	const [tailId, headId] = layout.forwardAxisMarkerIds;
	// A DUPLICATE of either axis marker makes the length ambiguous, and picking the first
	// occurrence silently returns whichever the detector happened to emit first - measured
	// at up to 4x the true length on the two-person recording, where 48% of otherwise
	// complete frames carried duplicate IDs. Bail instead: START_LINE_UNKNOWN is a truthful
	// answer, a board length off by 4x poisons every distance derived from it. Mirrors the
	// marker check's own isFullSet rule, which rejects duplicates for the same reason.
	let tail: CaptureQualityDetectedMarker | null = null;
	let head: CaptureQualityDetectedMarker | null = null;
	for (const marker of markers) {
		if (marker.id === tailId) {
			if (tail) return null;
			tail = marker;
		} else if (marker.id === headId) {
			if (head) return null;
			head = marker;
		}
	}
	if (!tail || !head) return null;
	const tailCenter = markerCenter(tail);
	const headCenter = markerCenter(head);
	if (!tailCenter || !headCenter) return null;
	const length = distance(tailCenter, headCenter);
	return length > 0 ? length : null;
}

/**
 * Which detected box is the patient. Nearest-to-board when the board is visible, largest
 * otherwise.
 *
 * Nearest-to-board rather than largest-box because "the subject" is defined by the check
 * itself as the person at the start line: a bystander standing nearer the camera images
 * LARGER than the patient several metres downrange, so largest-box picks the wrong person
 * in exactly the situation that matters. Largest-box is only the fallback for when there is
 * no board to be near.
 *
 * Note this deliberately still returns a subject when several people are present -
 * MULTIPLE_PEOPLE is reported separately (see aggregateSubjectPositionMetrics) rather than
 * suppressing the geometry, so the user gets both facts at once.
 */
export function selectSubject(
	people: readonly CaptureQualityBBox[],
	boardCentroid: CaptureQualityPoint | null
): CaptureQualityBBox | null {
	if (people.length === 0) return null;
	if (people.length === 1) return people[0];
	if (boardCentroid) {
		return people.reduce((best, candidate) =>
			distance(centroidOf(candidate), boardCentroid) < distance(centroidOf(best), boardCentroid) ? candidate : best
		);
	}
	return people.reduce((best, candidate) =>
		candidate.width * candidate.height > best.width * best.height ? candidate : best
	);
}

export function evaluateSubjectPositionFrame(
	frame: CaptureQualityFrameSample,
	config: SubjectPositionCheckConfig
): SubjectPositionFrameMetrics {
	const markers = frame.markers ?? [];
	const boardCentroid = computeBoardCentroid(markers);
	const boardLengthPx = computeBoardLengthPx(markers, config.layout);

	// people === null means the detector was skipped this tick. Everything subject-derived
	// stays null so the aggregation can skip the frame outright rather than average it in.
	if (frame.people === null) {
		return {
			timestampMs: frame.timestampMs,
			personCount: null,
			subjectBBox: null,
			subjectCentroid: null,
			subjectAreaNorm: null,
			boardCentroid,
			boardLengthPx,
			startLineDistanceBoardLengths: null,
			boardToSubjectGapNorm: null,
		};
	}

	const subjectBBox = selectSubject(frame.people, boardCentroid);
	const subjectCentroid = subjectBBox ? centroidOf(subjectBBox) : null;
	const frameArea = frame.frameWidth * frame.frameHeight;
	const subjectAreaNorm =
		subjectBBox && frameArea > 0 ? (subjectBBox.width * subjectBBox.height) / frameArea : null;
	const startLineDistanceBoardLengths =
		subjectCentroid && boardCentroid && boardLengthPx !== null
			? distance(subjectCentroid, boardCentroid) / boardLengthPx
			: null;

	const boardToSubjectGapNorm =
		subjectCentroid && boardCentroid && frame.frameHeight > 0
			? (boardCentroid.y - subjectCentroid.y) / frame.frameHeight
			: null;

	return {
		timestampMs: frame.timestampMs,
		personCount: frame.people.length,
		subjectBBox,
		subjectCentroid,
		subjectAreaNorm,
		boardCentroid,
		boardLengthPx,
		startLineDistanceBoardLengths,
		boardToSubjectGapNorm,
	};
}

/**
 * The two DISCRETE signals - is anyone there, is there more than one - carry a committed
 * verdict plus the candidate the EWMA drives and a run of consecutive detection samples
 * agreeing with that candidate. Smoothing alone cannot steady them: resolveEwmaAlpha scales
 * the weight by elapsed wall-clock, so a slow device gets a HIGHER alpha (0.76 at the 1.5s
 * detect gap two 2026-09-01 recordings actually ran at) - less smoothing exactly where the
 * detector is noisiest. Counting samples is immune to that, and a dropped person is a
 * per-sample event rather than a per-second one. The position signals below need no run
 * counter: board-to-subject gap is continuous, and EWMA smoothing suits it.
 */
export interface SubjectPositionHysteresisState {
	tooFarBackBad: boolean;
	tooFarForwardBad: boolean;
	notDetectedBad: boolean;
	notDetectedCandidate: boolean;
	notDetectedRun: number;
	multiplePeopleBad: boolean;
	multiplePeopleCandidate: boolean;
	multiplePeopleRun: number;
	/** Timestamp of the newest detection sample already counted, so a tick that ran no detection cannot advance a run. */
	lastDetectionAtMs: number | null;
}

export function createSubjectPositionHysteresisState(): SubjectPositionHysteresisState {
	return {
		tooFarBackBad: false,
		tooFarForwardBad: false,
		notDetectedBad: false,
		notDetectedCandidate: false,
		notDetectedRun: 0,
		multiplePeopleBad: false,
		multiplePeopleCandidate: false,
		multiplePeopleRun: 0,
		lastDetectionAtMs: null,
	};
}

export function resetSubjectPositionHysteresisState(state: SubjectPositionHysteresisState): void {
	state.tooFarBackBad = false;
	state.tooFarForwardBad = false;
	state.notDetectedBad = false;
	state.notDetectedCandidate = false;
	state.notDetectedRun = 0;
	state.multiplePeopleBad = false;
	state.multiplePeopleCandidate = false;
	state.multiplePeopleRun = 0;
	state.lastDetectionAtMs = null;
}

/** Same semantics as markerBoardCheck's applyHysteresis - duplicated rather than exported across checks so neither module owns the other's flapping behavior. */
/**
 * Commits `candidate` into the returned verdict once `run` consecutive NEW detection samples
 * have agreed with it, so a single-sample detector blip never reaches the banner. Returns the
 * updated [verdict, run] pair; `sawNewSample` is false on a tick where detection did not run,
 * which must neither advance nor reset the run.
 */
function commitAfterConsecutive(
	verdict: boolean,
	candidate: boolean,
	run: number,
	sawNewSample: boolean,
	samplesRequired: number
): [boolean, number] {
	// A tick with no new sample leaves the run UNTOUCHED - resetting it there would wipe the
	// progress made on the last real sample, and since detection runs 1-in-N ticks the run
	// could never reach the threshold at all (both codes silently dead).
	if (!sawNewSample) return [verdict, run];
	if (candidate === verdict) return [verdict, 0];
	const next = run + 1;
	return next >= samplesRequired ? [candidate, 0] : [verdict, next];
}

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
 * Caller-owned rolling window. Holds no ImageData (this check needs only boxes and marker
 * geometry) and must be reset between trials - FDA gait re-enters the camera three times
 * and trial 2 must not inherit trial 1's subject track.
 */
export interface SubjectPositionFrameWindow {
	readonly maxFrames: number;
	frames: CaptureQualityFrameSample[];
	hysteresis: SubjectPositionHysteresisState;
}

export function createSubjectPositionFrameWindow(maxFrames: number): SubjectPositionFrameWindow {
	return {
		maxFrames: Math.max(1, Math.floor(maxFrames)),
		frames: [],
		hysteresis: createSubjectPositionHysteresisState(),
	};
}

export function pushSubjectPositionFrame(window: SubjectPositionFrameWindow, frame: CaptureQualityFrameSample): void {
	window.frames.push(frame);
	if (window.frames.length > window.maxFrames) {
		window.frames.splice(0, window.frames.length - window.maxFrames);
	}
}

export function resetSubjectPositionFrameWindow(window: SubjectPositionFrameWindow): void {
	window.frames.length = 0;
	resetSubjectPositionHysteresisState(window.hysteresis);
}

export interface SubjectPositionWindowAggregate {
	frameCount: number;
	/** Frames on which person detection actually ran. The rest are skipped, not counted as misses. */
	detectionFrameCount: number;
	/** EWMA fraction of DETECTION frames containing at least one person. Null when detection never ran. */
	weightedDetectionScore: number | null;
	/** EWMA fraction of DETECTION frames containing more than one person. Null when detection never ran. */
	weightedMultiPersonScore: number | null;
	/** EWMA of the board-to-subject vertical gap. THE position signal - see the module header. */
	weightedBoardToSubjectGapNorm: number | null;
	/** NOT A GATE. EWMA of the subject's bbox area - reported for the debug HUD only; it is corrupted by frame-edge clipping (see the config doc). */
	weightedSubjectAreaNorm: number | null;
	/** NOT A GATE. EWMA subject centroid speed, in board lengths per second - reported for the debug HUD only. */
	weightedSpeedBoardLengthsPerSec: number | null;
	/** NOT A GATE. Coefficient of variation of subjectAreaNorm across the window's detection frames. Null with fewer than two samples. */
	subjectAreaCv: number | null;
	weightedStartLineDistanceBoardLengths: number | null;
	latest: SubjectPositionFrameMetrics | null;
	activeCodes: readonly CaptureQualityIssueCode[];
}

const EMPTY_AGGREGATE: SubjectPositionWindowAggregate = {
	frameCount: 0,
	detectionFrameCount: 0,
	weightedDetectionScore: null,
	weightedMultiPersonScore: null,
	weightedBoardToSubjectGapNorm: null,
	weightedSubjectAreaNorm: null,
	weightedSpeedBoardLengthsPerSec: null,
	subjectAreaCv: null,
	weightedStartLineDistanceBoardLengths: null,
	latest: null,
	activeCodes: [],
};

function coefficientOfVariation(values: readonly number[]): number | null {
	if (values.length < 2) return null;
	const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
	if (mean === 0) return null;
	const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
	return Math.sqrt(Math.max(0, variance)) / mean;
}

/**
 * Recency-weighted aggregation over already-computed per-frame metrics (oldest to newest),
 * factored out of evaluateSubjectPositionWindow the same way aggregateMarkerBoardMetrics is,
 * so an offline replay can drive this exact code from a recording.
 *
 * EVERY EWMA HERE ADVANCES ONLY ON FRAMES THAT CARRY THE SIGNAL. A skipped detection tick
 * leaves the detection/multi-person scores untouched rather than pulling them toward zero,
 * and the elapsed time used for the time-based alpha is measured between consecutive
 * DETECTION frames, not consecutive ticks - at a 1-in-3 round robin those differ by 3x, and
 * using the wrong one silently triples the smoothing window.
 */
export function aggregateSubjectPositionMetrics(
	metricsSequence: readonly SubjectPositionFrameMetrics[],
	config: SubjectPositionCheckConfig,
	hysteresis: SubjectPositionHysteresisState = createSubjectPositionHysteresisState()
): SubjectPositionWindowAggregate {
	if (metricsSequence.length === 0) return { ...EMPTY_AGGREGATE, activeCodes: [] };

	const { thresholds, liveWindowRecencyWeight, ewmaReferenceTickHz } = config;

	let detectionFrameCount = 0;
	let weightedDetectionScore: number | null = null;
	let weightedMultiPersonScore: number | null = null;
	let weightedSpeed: number | null = null;
	let weightedStartLine: number | null = null;
	let weightedArea: number | null = null;
	let weightedGap: number | null = null;
	const areaSamples: number[] = [];

	let previousDetection: SubjectPositionFrameMetrics | null = null;

	for (const metrics of metricsSequence) {
		if (metrics.personCount === null) continue;
		detectionFrameCount += 1;

		const deltaMs = previousDetection === null ? 0 : metrics.timestampMs - previousDetection.timestampMs;
		const alpha = resolveEwmaAlpha(deltaMs, ewmaReferenceTickHz, liveWindowRecencyWeight);

		const detected = metrics.personCount > 0 ? 1 : 0;
		weightedDetectionScore =
			weightedDetectionScore === null ? detected : weightedDetectionScore + alpha * (detected - weightedDetectionScore);

		const multi = metrics.personCount > 1 ? 1 : 0;
		weightedMultiPersonScore =
			weightedMultiPersonScore === null ? multi : weightedMultiPersonScore + alpha * (multi - weightedMultiPersonScore);

		if (metrics.boardToSubjectGapNorm !== null) {
			weightedGap =
				weightedGap === null
					? metrics.boardToSubjectGapNorm
					: weightedGap + alpha * (metrics.boardToSubjectGapNorm - weightedGap);
		}

		if (metrics.subjectAreaNorm !== null) {
			areaSamples.push(metrics.subjectAreaNorm);
			weightedArea =
				weightedArea === null ? metrics.subjectAreaNorm : weightedArea + alpha * (metrics.subjectAreaNorm - weightedArea);
		}

		if (metrics.startLineDistanceBoardLengths !== null) {
			weightedStartLine =
				weightedStartLine === null
					? metrics.startLineDistanceBoardLengths
					: weightedStartLine + alpha * (metrics.startLineDistanceBoardLengths - weightedStartLine);
		}

		// Speed needs a pair of consecutive detection frames that share a measurable board
		// unit. The board length is read from the CURRENT frame: if the camera moved between
		// the two, the previous frame's unit no longer describes this displacement.
		if (
			previousDetection &&
			previousDetection.subjectCentroid &&
			metrics.subjectCentroid &&
			metrics.boardLengthPx !== null &&
			deltaMs > 0
		) {
			const movedBoardLengths = distance(previousDetection.subjectCentroid, metrics.subjectCentroid) / metrics.boardLengthPx;
			const speed = movedBoardLengths / (deltaMs / 1000);
			weightedSpeed = weightedSpeed === null ? speed : weightedSpeed + alpha * (speed - weightedSpeed);
		}

		previousDetection = metrics;
	}

	const latest = metricsSequence[metricsSequence.length - 1];
	const subjectAreaCv = coefficientOfVariation(areaSamples);

	// Detection never ran anywhere in this window: the check has nothing to say. Report
	// silence rather than a warning - a round-robin that has not come around yet, or a
	// person detector that failed to load, must look exactly like the check not existing.
	if (detectionFrameCount === 0) {
		return {
			frameCount: metricsSequence.length,
			detectionFrameCount: 0,
			weightedDetectionScore: null,
			weightedMultiPersonScore: null,
			weightedBoardToSubjectGapNorm: null,
			weightedSubjectAreaNorm: null,
			weightedSpeedBoardLengthsPerSec: null,
			subjectAreaCv: null,
			weightedStartLineDistanceBoardLengths: null,
			latest,
			activeCodes: [],
		};
	}

	// A tick where person detection did not run must not advance either run counter - it
	// carries no new evidence, and counting it would let idle ticks flip a verdict.
	let newestDetectionAtMs: number | null = null;
	let newestPersonCount: number | null = null;
	for (let i = metricsSequence.length - 1; i >= 0; i--) {
		if (metricsSequence[i].personCount !== null) {
			newestDetectionAtMs = metricsSequence[i].timestampMs;
			newestPersonCount = metricsSequence[i].personCount;
			break;
		}
	}
	const sawNewSample = newestDetectionAtMs !== null && newestDetectionAtMs !== hysteresis.lastDetectionAtMs;
	// The FIRST sample of a trial commits immediately. Debouncing it would mean opening on
	// the default verdict (someone is there, alone) for one sample, which shows a green
	// "ready to begin" before correcting itself - worse than a moment of latency.
	const samplesRequired = hysteresis.lastDetectionAtMs === null ? 1 : thresholds.consecutiveSamplesToFlip;
	if (sawNewSample) hysteresis.lastDetectionAtMs = newestDetectionAtMs;

	// Candidates come from the RAW newest sample, not the EWMA. "Is anyone there" is a binary
	// observation and N-consecutive-samples is the smoothing for one; passing it through an
	// EWMA threshold first stacks two lags, which made a real absence take three misses
	// instead of two. The weighted scores stay computed for the HUD but gate nothing.
	if (newestPersonCount !== null) {
		hysteresis.notDetectedCandidate = newestPersonCount === 0;
		hysteresis.multiplePeopleCandidate = newestPersonCount > 1;
	}
	[hysteresis.notDetectedBad, hysteresis.notDetectedRun] = commitAfterConsecutive(
		hysteresis.notDetectedBad,
		hysteresis.notDetectedCandidate,
		hysteresis.notDetectedRun,
		sawNewSample,
		samplesRequired
	);
	// Two bounds on the same signal, in opposite directions. A LARGER box means NEARER THE
	// CAMERA, which means FURTHER BACK from the board; a SMALLER box means further forward,
	// down the walk path. Both read backwards until that geometry clicks.
	// A SMALLER gap means the subject sits lower in frame, i.e. nearer the camera, i.e.
	// further BACK from the board - hence "below". The larger-gap direction is the opposite:
	// higher in frame, further down the walk path.
	hysteresis.tooFarBackBad = applyHysteresis(
		hysteresis.tooFarBackBad,
		weightedGap,
		thresholds.tooFarBackGapNorm,
		thresholds.tooFarBackClearGapNorm,
		"below"
	);
	hysteresis.tooFarForwardBad = applyHysteresis(
		hysteresis.tooFarForwardBad,
		weightedGap,
		thresholds.tooFarForwardGapNorm,
		thresholds.tooFarForwardClearGapNorm,
		"above"
	);

	// PRIORITY ORDER, most-fundamental first. Each code's remedy assumes everything above it
	// is already true, so emitting a lower one while a higher one holds gives advice the user
	// cannot act on ("stand at the line" is useless while the camera cannot see them).
	const activeCodes: CaptureQualityIssueCode[] = [];

	// 1. More than one person: reported first because it makes "the subject" ambiguous, and
	//    the geometry below describes whichever box selectSubject picked. Hysteresis, like
	//    the gates below it - this was a bare threshold compare until 2026-09-01, so one
	//    spurious second person raised it and one clean frame dropped it again.
	[hysteresis.multiplePeopleBad, hysteresis.multiplePeopleRun] = commitAfterConsecutive(
		hysteresis.multiplePeopleBad,
		hysteresis.multiplePeopleCandidate,
		hysteresis.multiplePeopleRun,
		sawNewSample,
		samplesRequired
	);
	if (hysteresis.multiplePeopleBad) {
		activeCodes.push("MULTIPLE_PEOPLE");
	}

	// 2. Nobody reliably detected. Nothing below this is measurable.
	if (hysteresis.notDetectedBad) {
		activeCodes.push("SUBJECT_NOT_DETECTED");
		return {
			frameCount: metricsSequence.length,
			detectionFrameCount,
			weightedDetectionScore,
			weightedMultiPersonScore,
			weightedBoardToSubjectGapNorm: weightedGap,
			weightedSubjectAreaNorm: weightedArea,
			weightedSpeedBoardLengthsPerSec: weightedSpeed,
			subjectAreaCv,
			weightedStartLineDistanceBoardLengths: weightedStartLine,
			latest,
			activeCodes,
		};
	}

	// 3. Detected, but not standing at the start line - in either direction. Both report the
	//    same code: the remedy ("move to the marker") is identical, and the banner layer is
	//    what turns it into direction-specific copy if that is ever wanted.
	//    NOTE there is deliberately no stillness branch here - see the module header.
	if (hysteresis.tooFarBackBad || hysteresis.tooFarForwardBad) {
		activeCodes.push("SUBJECT_NOT_AT_START_LINE");
	}

	return {
		frameCount: metricsSequence.length,
		detectionFrameCount,
		weightedDetectionScore,
		weightedMultiPersonScore,
		weightedBoardToSubjectGapNorm: weightedGap,
		weightedSubjectAreaNorm: weightedArea,
		weightedSpeedBoardLengthsPerSec: weightedSpeed,
		subjectAreaCv,
		weightedStartLineDistanceBoardLengths: weightedStartLine,
		latest,
		activeCodes,
	};
}

export function evaluateSubjectPositionWindowAggregate(
	frames: readonly CaptureQualityFrameSample[],
	config: SubjectPositionCheckConfig,
	hysteresis: SubjectPositionHysteresisState = createSubjectPositionHysteresisState()
): SubjectPositionWindowAggregate {
	const metricsSequence = frames.map((frame) => evaluateSubjectPositionFrame(frame, config));
	return aggregateSubjectPositionMetrics(metricsSequence, config, hysteresis);
}

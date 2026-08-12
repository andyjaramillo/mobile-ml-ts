// [Feature: Capture Quality Warnings]
//
// Tunable thresholds for every capture-quality check, with per-assessment overrides.
// Modeled on Website's DEVICE_COMPATIBILITY_REQUIREMENTS constant style
// (src/pages/MobilePage/MobileComponents/CameraUtils/deviceCompatibilityService.ts):
// one flat, readonly defaults object plus small helpers, no class.
//
// UNIT CONVENTION: prefer normalized units (fraction of frame width/height, or of the
// frame diagonal) over raw pixels, so a threshold means the same thing on a phone and
// a tablet. Any value below marked "UNCALIBRATED" is a placeholder guess pending
// calibration against a real ArUco marker board, not a tuned figure — do not treat
// these as ground truth. Any value marked "PIXEL UNIT BUG" is a known-wrong carryover
// from the prototype that must be converted to a normalized unit during calibration.
//
// MARKER_BOARD below is the one exception to "everything here is a guess": its LAYOUT
// (which IDs exist, which corner each sits at, which pair is the forward axis) is
// VERIFIED AGAINST HARDWARE from a live phone capture of the real board (2026-08-12).
// That is a different claim from "calibrated" — MarkerBoardThresholds (the numeric
// pass/fail values) are still UNCALIBRATED guesses even though the layout they're
// measured against is now known-correct. Don't conflate the two.

import type { CaptureQualityIssueCode } from "./types";

/**
 * Describes marker IDENTITY and ROLE on a physical board — which IDs exist and which
 * physical corner/axis each one occupies — as opposed to MarkerBoardThresholds, which
 * says what counts as pass/fail once you know where the markers are. Kept as an
 * interface (rather than inlining hardware assumptions into the check) so a future
 * board with a different layout is a new value of this type, not a rewrite.
 */
export interface MarkerBoardLayout {
	boardDictionary: string;
	boardSize: number;
	expectedMarkerCount: number;
	/** Every ID that must be present, and distinct, for a frame to count as a complete board. */
	expectedMarkerIds: readonly number[];
	/** The four outer-corner marker IDs, keyed by their role in-frame when the board is laid corner-forward (diamond). */
	diamondCornerIds: {
		readonly top: number;
		readonly right: number;
		readonly bottom: number;
		readonly left: number;
	};
	/** [tail, head] marker IDs whose center-to-center line is the forward walk axis. */
	forwardAxisMarkerIds: readonly [tail: number, head: number];
}

/**
 * VERIFIED AGAINST HARDWARE (2026-08-12, live phone capture of the real board): a 3x3
 * DICT_5X5_50 grid, IDs 0-8 laid out row-major descending (id = row*3 + (2 - col)),
 * flat on the floor, used CORNER-FORWARD. The printed forward arrow points out of the
 * corner where marker 2 sits, and the walk direction runs along the 6->2 grid
 * DIAGONAL — not an edge — so forwardAxisMarkerIds is intentionally a diagonal pair,
 * not two adjacent corners. Do not "fix" this into an edge without re-checking the
 * hardware.
 *
 * This diverges from the Notion marker spec (corner IDs 0/1/2/3 plus five interior
 * design-ID markers): that board does not exist. MarkerBoardLayout stays generic so
 * the spec board is reachable as a second layout value later; this one is the default
 * because it's the board that exists today.
 */
export const MARKER_BOARD: MarkerBoardLayout = {
	boardDictionary: "DICT_5X5_50",
	boardSize: 3,
	expectedMarkerCount: 9,
	expectedMarkerIds: [0, 1, 2, 3, 4, 5, 6, 7, 8],
	diamondCornerIds: { top: 2, right: 0, bottom: 6, left: 8 },
	forwardAxisMarkerIds: [6, 2],
};

export interface MarkerBoardThresholds {
	minimumMarkerAreaNorm: number;
	diagonalRatioMin: number;
	diagonalRatioMax: number;
	orientationMarginRad: number;
	/** Minimum recency-weighted fraction of the live window that must show the complete board before geometry/orientation are considered trustworthy; below this only MARKER_INCOMPLETE/MARKER_TOO_CLOSE fire. */
	minimumFullSetWeight: number;
	/**
	 * Recency-weighted mean normalized area of whatever markers ARE detected (see
	 * MarkerBoardFrameMetrics.detectedMarkerAreaNorm) at or above which an incomplete
	 * set is read as "board doesn't fit the frame" (MARKER_TOO_CLOSE) rather than
	 * "board too far away / occluded" (MARKER_INCOMPLETE) - the two failures need
	 * opposite user remedies (step back vs move closer), so conflating them is worse
	 * than not distinguishing them at all. null disables the split: every incomplete
	 * set reports MARKER_INCOMPLETE, matching pre-MARKER_TOO_CLOSE behavior. See the
	 * DEFAULTS comment for why this ships null rather than a guessed number.
	 */
	tooCloseDetectedAreaNorm: number | null;
}

export interface SubjectPositionThresholds {
	displacementNormThreshold: number;
	driftThresholdNorm: number;
	areaChangeMaxPct: number;
	areaCoefficientOfVariationMax: number;
	startLineDistanceNorm: number;
}

export interface MultiPersonThresholds {
	proximatePeopleMinGapNorm: number;
}

export interface LightingThresholds {
	lowLuminanceCellPctThreshold: number;
	lowContrastThreshold: number;
}

export interface DurationThresholds {
	minimumDurationSec: number;
	maximumDurationSec: number;
}

export interface SamplingConfig {
	liveWindowFrameCount: number;
	liveWindowRecencyWeight: number;
	postRecordingSampleFraction: number;
	postRecordingSampleWindow: "middle" | "start" | "end";
}

export interface CaptureQualityConfig {
	markerBoard: MarkerBoardThresholds;
	subjectPosition: SubjectPositionThresholds;
	multiPerson: MultiPersonThresholds;
	lighting: LightingThresholds;
	duration: DurationThresholds;
	sampling: SamplingConfig;
}

// Every numeric value below is a starting point, not a tuned figure, unless the
// comment says otherwise. Values carried over from the prototype (1NonVisibleMarkers.tsx,
// 2SubjectNotAtStart.tsx) are "currently in use" there but were never validated against
// a real marker board either — carrying a value forward is not the same as calibrating it.
export const DEFAULTS: CaptureQualityConfig = {
	markerBoard: {
		// CALIBRATED 2026-08-12 (was 0.009 UNCALIBRATED, carried from 1NonVisibleMarkers.tsx
		// HYPERPARAMETERS.minimum_marker_area). Six real iPhone recordings against the
		// physical board, full-set frames only: d-mid 1.5m (GOOD, 93% full-set rate) has
		// normalizedArea p5=0.00312 / median=0.00316; baseline (marginal, 79% full-set) has
		// median=0.00229. 0.0028 sits strictly between the two - clears the good setup's
		// worst 5%, fails the marginal one on essentially every frame.
		minimumMarkerAreaNorm: 0.0028,
		// WIDENED (2026-08-12) so this check can never fire. NOT calibrated - diagonalRatio
		// is confounded by three things at once in the six recordings, none isolated:
		// distance (0.238 at 1.5m -> 0.178 at 6ft), rotation (0.238 aligned -> 0.639 at
		// rot-90), and frame aspect ratio (it divides a height-normalized diagonal by a
		// width-normalized one, so it scales with frameWidth/frameHeight, not just skew - see
		// computeDiagonalRatio). A valid skew metric would need to be measured perpendicular
		// to the board's own forward axis (not raw image height/width), and normalized by a
		// distance-invariant reference (e.g. the two diagonals corrected by the known scale
		// from normalizedArea) before it means anything. The metric stays computed and
		// reported (weightedDiagonalRatio/latestDiagonalRatio in details) for future work -
		// only the pass/fail check is disabled. Max is a large finite sentinel rather than
		// Infinity so this config round-trips through JSON (used by callers/tests) - the
		// ratio is mathematically bounded to (0, 1] by construction (min/max of two
		// distances), so anything above 1 already can never fire. Do not tighten these two
		// without building that corrected metric first.
		diagonalRatioMin: 0,
		diagonalRatioMax: 1000,
		// CALIBRATED 2026-08-12 (was 0.3 UNCALIBRATED). Three-point yaw curve, orientationRad
		// median: aligned board 0.152 (max seen across all aligned recordings: 0.160),
		// rot-slight (~43 deg intentional yaw) 0.822 (min seen: 0.774), rot-90 (90 deg yaw)
		// 1.566. 0.45 clears the aligned ceiling and stays well under the misaligned floor.
		// The >0.6 rad gap between aligned and misaligned means most of this margin is
		// headroom for handheld PHONE ROLL, not board tolerance: orientationAngleRad is
		// measured against image up, not the board's own frame (see
		// computeOrientationAngleRad), so a board that IS placed dead-on reads 0.152 rad
		// (8.7 deg) in every single recording - almost certainly the phone being held
		// slightly tilted, not the board. Do not tighten this margin without separating
		// phone roll from board yaw first (e.g. a device-orientation/gravity reading).
		orientationMarginRad: 0.45,
		// CALIBRATED 2026-08-12 (was 0.5 UNCALIBRATED GUESS), paired with
		// sampling.liveWindowRecencyWeight below - see that field's comment for the joint
		// derivation and calibrate-script evidence.
		minimumFullSetWeight: 0.4,
		// NOT CALIBRATED, intentionally disabled (2026-08-12) - see the MARKER_TOO_CLOSE
		// branch in aggregateMarkerBoardMetrics (markerBoardCheck.ts) for how this is used.
		// The six committed recordings cannot supply this number: d-near/2ft never reaches a
		// full marker set (0/236 frames), and the recorder version that captured all six runs
		// only computed/stored normalizedArea when isFullSet was true - so no per-marker size
		// was ever recorded for ANY of d-near's 236 incomplete-set frames, nor d-far's 206
		// incomplete-set frames. There is no real data in this repo to derive a boundary from
		// - see MarkerBoardFrameMetrics.detectedMarkerAreaNorm, which now computes this
		// live/going forward. Leaving this null keeps every incomplete set reporting
		// MARKER_INCOMPLETE (unchanged behavior) until a re-capture with an updated recorder
		// records detectedMarkerAreaNorm on partial-set frames too.
		tooCloseDetectedAreaNorm: null,
	},
	subjectPosition: {
		displacementNormThreshold: 0.01, // UNCALIBRATED - carried from T_disp_norm (fraction of frame diagonal)
		driftThresholdNorm: 5.0, // UNCALIBRATED, PIXEL UNIT BUG - prototype's T_drift_norm is named as if normalized but is compared directly against raw pixel displacement in 2SubjectNotAtStart.tsx; the value 5.0 is meaningless as a [0,1] fraction. Carried as-is so the bug is visible here rather than silently "fixed" with a guessed conversion; must be re-derived in normalized units during calibration.
		areaChangeMaxPct: 0.5, // UNCALIBRATED - carried from T_area
		areaCoefficientOfVariationMax: 0.12, // UNCALIBRATED - carried from T_area_cv
		startLineDistanceNorm: 500, // UNCALIBRATED, PIXEL UNIT BUG - prototype's distance_from_start (500) is raw pixels, not normalized; needs conversion (e.g. divide by frame diagonal) during calibration, not a resolution-independent value as-is
	},
	multiPerson: {
		proximatePeopleMinGapNorm: 0.05, // UNCALIBRATED GUESS - no prototype precedent; minimum gap between two person bboxes (fraction of frame width) before flagging PROXIMATE_PEOPLE instead of MULTIPLE_PEOPLE
	},
	lighting: {
		lowLuminanceCellPctThreshold: 0.2, // UNCALIBRATED GUESS - no prototype precedent; fraction of frame grid cells below a low-luminance threshold before flagging LOW_LIGHT
		lowContrastThreshold: 0.15, // UNCALIBRATED GUESS - no prototype precedent; normalized contrast measure below which LOW_CONTRAST fires
	},
	duration: {
		minimumDurationSec: 1.0, // UNCALIBRATED GUESS - no prototype precedent; see per-assessment overrides below for why this needs to vary by assessment
		maximumDurationSec: 120, // UNCALIBRATED GUESS - no prototype precedent
	},
	sampling: {
		liveWindowFrameCount: 15, // UNCALIBRATED GUESS - rolling recency-weighted window size for pre-recording (live preview) checks
		// CALIBRATED 2026-08-12 (was 0.7 UNCALIBRATED GUESS). Verified with
		// `npm run calibrate` replaying all six real recordings through the actual
		// aggregateMarkerBoardMetrics (markerBoardCheck.ts) at the calibrated thresholds
		// above (area 0.0028, orientation 0.45, diagonal disabled) paired with
		// markerBoard.minimumFullSetWeight=0.4: alpha=0.15 is the lowest-total-flap
		// combination (26 indicator-state flaps summed over baseline/d-far/d-near/
		// rot-slight/rot-90's full replays) found by sweeping alpha in [0.03..0.7] x
		// minimumFullSetWeight in [0.3..0.6] that still leaves d-mid (GOOD, 1.5m) at
		// EXACTLY zero fired codes and zero flaps across its full 171-step replay, while
		// d-far (bad, 26% full-set rate) fires a warning on 100% of its 279 steps. The
		// task's own arithmetic starting point (alpha~0.1, weight 0.5) also keeps d-mid
		// clean but flaps more (baseline+d-far+d-near+rot-slight+rot-90 sum to 60 flaps
		// vs 26) - 0.15/0.4 was chosen over it for lower live-indicator flicker, not
		// because 0.1/0.5 was wrong. Do not change either value without re-running the
		// sweep against calibration/*.cq1.txt.
		liveWindowRecencyWeight: 0.15,
		postRecordingSampleFraction: 0.5, // spec-given: sample the middle 50% of the recorded video for most post-recording checks
		postRecordingSampleWindow: "middle", // spec-given positioning convention; not every check will use it (e.g. VIDEO_TOO_SHORT/VIDEO_TOO_LONG need the full timeline, not a sampled window)
	},
};

/**
 * Which check codes VIDEO_TOO_SHORT/VIDEO_TOO_LONG apply duration.* thresholds to is
 * assessment-dependent (a TUG trial and a 4M gait trial have different expected
 * lengths). Listed here only for documentation; the orchestrator decides which codes
 * a given assessment runs.
 */
export const DURATION_SENSITIVE_CODES: readonly CaptureQualityIssueCode[] = [
	"VIDEO_TOO_SHORT",
	"VIDEO_TOO_LONG",
];

type ConfigOverride = {
	[K in keyof CaptureQualityConfig]?: Partial<CaptureQualityConfig[K]>;
};

/**
 * Per-assessment threshold overrides, keyed by the exact backend ASSESSMENTS key from
 * WebsiteCode/Website/src/components/Common/Globals.ts (not invented names). Only the
 * marker/start-line assessments (gait, TUG, sit-to-stand) are listed: those are the
 * ones that record against the floor ArUco board and a start line. Hand/grip
 * assessments don't use a floor marker board, so they're left on DEFAULTS entirely
 * until a use case for overriding them shows up.
 *
 * The duration overrides below are illustrative of the mechanism, not measured
 * numbers - flagged the same as everything else in DEFAULTS.
 */
export const ASSESSMENT_CONFIG_OVERRIDES: Partial<Record<string, ConfigOverride>> = {
	"Gait: 4M (home)": {
		duration: { minimumDurationSec: 2.0, maximumDurationSec: 30 }, // UNCALIBRATED GUESS
	},
	"Gait: 4M (clinic)": {
		duration: { minimumDurationSec: 2.0, maximumDurationSec: 30 }, // UNCALIBRATED GUESS
	},
	"Gait: 4M One-Way (clinic)": {
		duration: { minimumDurationSec: 1.5, maximumDurationSec: 20 }, // UNCALIBRATED GUESS
	},
	"TUG (home)": {
		duration: { minimumDurationSec: 5.0, maximumDurationSec: 60 }, // UNCALIBRATED GUESS
	},
	"TUG (clinic)": {
		duration: { minimumDurationSec: 5.0, maximumDurationSec: 60 }, // UNCALIBRATED GUESS
	},
	"Sit-to-Stand: 5x (home)": {
		duration: { minimumDurationSec: 5.0, maximumDurationSec: 60 }, // UNCALIBRATED GUESS
	},
	"Sit-to-Stand: 5x (clinic)": {
		duration: { minimumDurationSec: 5.0, maximumDurationSec: 60 }, // UNCALIBRATED GUESS
	},
	"Sit-to-Stand: 30s (clinic)": {
		duration: { minimumDurationSec: 25.0, maximumDurationSec: 40 }, // UNCALIBRATED GUESS
	},
	"Sit-to-Stand: 10x (clinic)": {
		duration: { minimumDurationSec: 8.0, maximumDurationSec: 90 }, // UNCALIBRATED GUESS
	},
};

function mergeCategory<T extends object>(base: T, override: Partial<T> | undefined): T {
	if (!override) return base;
	return { ...base, ...override };
}

/** Resolves the effective config for an assessment: DEFAULTS with that assessment's overrides applied, one category at a time. */
export function resolveCaptureQualityConfig(assessmentKey: string): CaptureQualityConfig {
	const override = ASSESSMENT_CONFIG_OVERRIDES[assessmentKey];
	return {
		markerBoard: mergeCategory(DEFAULTS.markerBoard, override?.markerBoard),
		subjectPosition: mergeCategory(DEFAULTS.subjectPosition, override?.subjectPosition),
		multiPerson: mergeCategory(DEFAULTS.multiPerson, override?.multiPerson),
		lighting: mergeCategory(DEFAULTS.lighting, override?.lighting),
		duration: mergeCategory(DEFAULTS.duration, override?.duration),
		sampling: mergeCategory(DEFAULTS.sampling, override?.sampling),
	};
}

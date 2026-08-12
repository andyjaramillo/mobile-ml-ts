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

import type { CaptureQualityIssueCode } from "./types";

/** Real, spec-confirmed marker board geometry — not a guess. */
export const MARKER_BOARD = {
	boardDictionary: "DICT_5X5_50",
	boardSize: 3, // 3x3 board
	expectedMarkerCount: 9,
	cornerMarkerIds: [0, 1, 2, 3] as const, // fixed corner IDs
	interiorMarkerCount: 5, // interior positions encode a design ID, not fixed IDs
} as const;

export interface MarkerBoardThresholds {
	minimumMarkerAreaNorm: number;
	diagonalRatioMin: number;
	diagonalRatioMax: number;
	orientationMarginRad: number;
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
		minimumMarkerAreaNorm: 0.009, // UNCALIBRATED - carried from 1NonVisibleMarkers.tsx HYPERPARAMETERS.minimum_marker_area
		diagonalRatioMin: 0.2, // UNCALIBRATED - carried from minimum_diagonal_ratio_min
		diagonalRatioMax: 0.5, // UNCALIBRATED - carried from minimum_diagonal_ratio_max
		orientationMarginRad: 0.3, // UNCALIBRATED - carried from orientation_margin; unit assumed radians (atan2 output), unconfirmed
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
		liveWindowRecencyWeight: 0.7, // UNCALIBRATED GUESS - weight given to the most recent frame in the rolling window, 0..1
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

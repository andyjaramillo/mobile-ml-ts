// [Feature: Capture Quality Warnings]
//
// Shared contract for all capture-quality checks (marker board, subject position,
// multi-person, lighting, duration). Ported verbatim into
// WebsiteCode/Website/src/pages/MobilePage/MobileComponents/CaptureQuality/, so this
// file must not import anything from outside its own folder.
//
// NO USER-FACING ENGLISH STRINGS IN THIS MODULE. Website localizes through i18next;
// user-visible copy lives in src/i18n/locales/en/en.json under the
// "MobileAssessment.CaptureQuality.*" keys. Checks emit codes only — the UI layer is
// responsible for resolving a code to localized text. See captureQualityI18nKey below.
//
// Severity naming intentionally mirrors the backend vocabulary already defined in
// Website's src/services/assessments/assessmentStatusService.ts
// (AssessmentStatusWarning / AssessmentWarningSeverity), so client-side capture
// warnings and backend-emitted assessment-status warnings read consistently in the UI.

/** Canonical issue codes every check can emit. Keep in sync with the i18n key set. */
export const CAPTURE_QUALITY_ISSUE_CODES = [
	"MARKER_INCOMPLETE",
	"MARKER_TOO_CLOSE",
	"MARKER_TOO_SMALL",
	// REINTRODUCED 2026-08-13 behind a measured boundary (sizeWarnUpperNorm=0.0038 - see
	// captureQualityConfig.ts's DEFAULTS.markerBoard comment). Important distinction: this
	// is the human's own stated FRAMING limit ("any closer and the board or the person
	// would be out of frame"), not a re-measured detection limit - marker detection keeps
	// improving well past this value. It remains a proxy for a walk-path/subject-framing
	// check this codebase cannot yet perform directly (no person detection); supersede it
	// with that real check rather than tightening this number further.
	"MARKER_TOO_LARGE",
	"MARKER_SKEWED",
	// The board is fully visible, correctly sized and correctly oriented, but sitting in the
	// wrong PART of the frame - the camera is pointed off to one side or too high/low. Distinct
	// from every other marker code, all of which are satisfied by a board that is anywhere in
	// view. The target is taken from the product's own alignment overlay - see
	// captureQualityConfig.ts's MARKER_ALIGNMENT.
	"MARKER_NOT_ALIGNED",
	"MARKER_WRONG_ORIENTATION",
	// Fires when a single marker (any of the nine - see markerBoardCheck.ts's
	// persistence tracker) has been continuously absent past the "structural" time
	// threshold at a marker size that is neither too-close-cropped nor too-far-to-resolve
	// - i.e. something is physically covering it. Distinct from MARKER_INCOMPLETE, which
	// covers scattered/noisy dropout with no sustained single-marker pattern.
	"MARKER_OBSTRUCTED",
	"SUBJECT_NOT_DETECTED",
	"SUBJECT_NOT_STATIONARY",
	"SUBJECT_NOT_AT_START_LINE",
	"START_LINE_UNKNOWN",
	"MULTIPLE_PEOPLE",
	"PROXIMATE_PEOPLE",
	"LOW_LIGHT",
	"LOW_CONTRAST",
	// A blown-out patch on the board. Invisible to LOW_CONTRAST, and not a threshold away
	// from it: glare RAISES local contrast, so the flat-cell metric reads a glared board as
	// healthier than a good one (measured on the 2026-09-01 pair).
	"GLARE",
	"VIDEO_TOO_SHORT",
	"VIDEO_TOO_LONG",
] as const;

export type CaptureQualityIssueCode = typeof CAPTURE_QUALITY_ISSUE_CODES[number];

/**
 * Aligned with WebsiteCode/Website's AssessmentWarningSeverity ("critical" | "non-critical").
 * Redeclared locally (rather than imported) because this module must be portable by
 * plain copy and must not depend on anything outside src/CaptureQuality/.
 */
export type CaptureQualitySeverity = "critical" | "non-critical";

/**
 * Numeric/boolean metrics a check attaches to its result, e.g. pct_frames_full_set,
 * min_edge_gap_norm, low_luminance_cell_pct, longest_gap_below_full_set. Deliberately
 * permissive rather than enumerated per-code: the metric set per check is still being
 * finalized against real calibration data (see captureQualityConfig.ts).
 */
export type CaptureQualityIssueDetails = Record<string, number | boolean>;

/** The i18n key convention a code resolves to. No English copy lives here or anywhere in this module. */
export type CaptureQualityI18nKey = `MobileAssessment.CaptureQuality.${CaptureQualityIssueCode}`;

export function captureQualityI18nKey(code: CaptureQualityIssueCode): CaptureQualityI18nKey {
	return `MobileAssessment.CaptureQuality.${code}`;
}

/** One corner of a detected ArUco marker, in the frame's own pixel space (see CaptureQualityFrameSample). */
export interface CaptureQualityPoint {
	x: number;
	y: number;
}

/**
 * Pixel-space bounding box in the sampled frame's own width/height. Config thresholds
 * are normalized (fraction of frame width/height or frame diagonal) — divide by
 * frameWidth/frameHeight/diagonal before comparing against captureQualityConfig values.
 */
export interface CaptureQualityBBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A single detected ArUco marker. Corner order follows the underlying detector's convention. */
export interface CaptureQualityDetectedMarker {
	id: number;
	corners: CaptureQualityPoint[];
}

/**
 * One sampled frame as it reaches a check. Supersedes the rough FrameSample/BBox pair
 * in src/detections/setupChecks.ts (not edited here — that file is owned by another
 * agent and will be retired separately).
 *
 * Every detection field is nullable, and null means "this detector did not run on this
 * frame" — distinct from an empty array, which means "ran and found nothing". Detectors
 * are round-robined across frames to stay inside the per-frame time budget, so a check
 * that treats a skipped frame as a negative detection will emit false warnings.
 */
export interface CaptureQualityFrameSample {
	imageData: ImageData | null;
	timestampMs: number;
	frameWidth: number;
	frameHeight: number;
	people: CaptureQualityBBox[] | null;
	markers: CaptureQualityDetectedMarker[] | null;
}

/**
 * Pre-recording checks run against a rolling recency-weighted window of live preview
 * frames and drive a live readiness indicator in the UI before the user hits record.
 * `state` is the live indicator; `severity` is what the issue would be scored as if it
 * persisted into the recording (kept distinct so the UI can show a soft "warning" state
 * live while still knowing whether it would be a hard blocker post-recording).
 */
export type CaptureQualityLiveIndicatorState = "ok" | "warning" | "critical";

export interface CaptureQualityPreCheckResult {
	code: CaptureQualityIssueCode;
	state: CaptureQualityLiveIndicatorState;
	severity: CaptureQualitySeverity;
	details: CaptureQualityIssueDetails;
}

/**
 * Post-recording checks run against a sampled window of the recorded video (the
 * middle 50% of frames for most checks — see captureQualityConfig.ts sampling
 * defaults) and produce warning codes plus aggregate metrics for the assessment's
 * status JSON. `triggered` distinguishes "check ran and was clean" from an omitted
 * result, so callers can tell a passing check apart from one that never ran.
 */
export interface CaptureQualityPostCheckResult {
	code: CaptureQualityIssueCode;
	severity: CaptureQualitySeverity;
	details: CaptureQualityIssueDetails;
	sampledFrameCount: number;
	triggered: boolean;
}

/**
 * Uniform shape every check function implements, so the orchestrator can run a list of
 * checks the same way regardless of phase. Phase-specific behavior comes from the
 * result type parameter (Pre vs Post), not from a different call signature.
 * TConfig is left generic here rather than importing CaptureQualityConfig, so this file
 * has no dependency on captureQualityConfig.ts (config depends on types, not vice versa).
 */
export type CaptureQualityCheckFn<TResult, TConfig = unknown> = (
	frames: readonly CaptureQualityFrameSample[],
	config: TConfig
) => TResult[];

export type CaptureQualityPreCheckFn<TConfig = unknown> = CaptureQualityCheckFn<
	CaptureQualityPreCheckResult,
	TConfig
>;

export type CaptureQualityPostCheckFn<TConfig = unknown> = CaptureQualityCheckFn<
	CaptureQualityPostCheckResult,
	TConfig
>;

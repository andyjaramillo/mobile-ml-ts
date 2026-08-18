// [Feature: Capture Quality Warnings - guidance banner]
//
// English copy + single-message picker for the patient-facing guidance banner
// (GuidanceBanner.tsx). Deliberately kept OUT of src/CaptureQuality/, same reasoning as
// MarkerBoardHud.tsx: that module emits codes only (see its header) so Website can
// resolve them through i18next under "MobileAssessment.CaptureQuality.*" - this is the
// harness's own placeholder resolution of those same codes, English-only, and not what
// ships to Website.
//
// COPY STATUS: every string below is a first draft for a Class II medical device patient
// flow and has NOT had clinical/UX/legal review - do not treat this as final wording.
import { DEFAULTS } from "../CaptureQuality/captureQualityConfig";
import type { MarkerBoardThresholds } from "../CaptureQuality/captureQualityConfig";
import type { LowLightWindowAggregate } from "../CaptureQuality/lowLightCheck";
import type { MarkerBoardWindowAggregate } from "../CaptureQuality/markerBoardCheck";
import type { SubjectPositionWindowAggregate } from "../CaptureQuality/subjectPositionCheck";
import type { CaptureQualityIssueCode } from "../CaptureQuality/types";

/**
 * Codes this banner can explain. Narrower than CAPTURE_QUALITY_ISSUE_CODES on purpose: only
 * the ones the product set out to warn about - too many people, subject too far back from
 * the start line, board not fully visible, board too far or too close - plus lighting.
 * SUBJECT_NOT_STATIONARY and START_LINE_UNKNOWN are deliberately absent: neither is a thing
 * this feature reports, and the check no longer emits them as gates.
 */
type GuidanceCode = Extract<
	CaptureQualityIssueCode,
	"MARKER_INCOMPLETE" | "MARKER_TOO_CLOSE" | "MARKER_OBSTRUCTED" | "MARKER_WRONG_ORIENTATION" | "MARKER_SKEWED" | "MARKER_TOO_SMALL" | "MARKER_TOO_LARGE" | "LOW_LIGHT" | "LOW_CONTRAST" | "MULTIPLE_PEOPLE" | "SUBJECT_NOT_DETECTED" | "SUBJECT_NOT_AT_START_LINE"
>;

/**
 * Selection outcomes beyond a single issue code: nothing measured yet, size is in the
 * ideal band (a positive confirmation, distinct from the silent-acceptable band either
 * side of it - see captureQualityConfig.ts's MarkerBoardThresholds doc), or plain OK
 * (clean, but either no size reading yet or sitting in the acceptable-not-ideal band).
 */
export type GuidanceSelectionCode = GuidanceCode | "OK" | "IDEAL" | "PENDING";

// Phrased as an instruction ("do this"), never a diagnosis ("this measurement failed") -
// a patient reads this, not a developer. Kept short and plain per the task brief.
export const CAPTURE_QUALITY_GUIDANCE_MESSAGES: Record<GuidanceSelectionCode, string> = {
	MARKER_INCOMPLETE: "Move closer to the floor marker so the whole board is visible.",
	MARKER_TOO_CLOSE: "Step back so the whole floor marker fits in view.",
	MARKER_OBSTRUCTED: "Make sure nothing is covering the floor marker.",
	MARKER_WRONG_ORIENTATION: "Turn the camera to face the floor marker directly.",
	MARKER_SKEWED: "Straighten the camera angle toward the floor marker.",
	MARKER_TOO_SMALL: "Move a little closer to the floor marker.",
	MARKER_TOO_LARGE: "Step back a little so there's room for the whole walk path in view.",
	LOW_LIGHT: "Add more light to the room.",
	LOW_CONTRAST: "Reduce glare or backlight on the floor marker.",
	MULTIPLE_PEOPLE: "Only the patient should be in view - ask others to step out of frame.",
	SUBJECT_NOT_DETECTED: "Make sure the patient is standing in view of the camera.",
	SUBJECT_NOT_AT_START_LINE: "Ask the patient to move up to the floor marker to start.",
	OK: "Setup looks good.",
	IDEAL: "Setup looks good - you're at the ideal distance.",
	PENDING: "Checking your setup...",
};

export interface GuidanceSelection {
	code: GuidanceSelectionCode;
	message: string;
}

// A marker-board issue other than the TOO_SMALL/TOO_LARGE size nudges blocks the
// full-set gate or the orientation check (see markerBoardCheck.ts's
// aggregateMarkerBoardMetrics) and always outranks a lighting nudge - fix the board
// first, since lighting guidance is moot if the board itself isn't resolvable.
// TOO_SMALL/TOO_LARGE are the opposite: both fire only once the board is already good
// enough to pass the full-set/orientation gates, so they are deliberately the LOWEST
// priority live issue, below lighting.
const BLOCKING_MARKER_CODES = new Set<CaptureQualityIssueCode>([
	"MARKER_INCOMPLETE",
	"MARKER_TOO_CLOSE",
	"MARKER_OBSTRUCTED",
	"MARKER_WRONG_ORIENTATION",
	"MARKER_SKEWED",
]);

function isGuidanceCode(code: CaptureQualityIssueCode): code is GuidanceCode {
	return code in CAPTURE_QUALITY_GUIDANCE_MESSAGES;
}

/** Whether a weighted normalized area reading falls inside the ideal band - see captureQualityConfig.ts's sizeIdealLowerNorm/sizeIdealUpperNorm doc. Only the HUD layer cares about this split; the check itself treats ideal and acceptable identically (silent, no code). */
function isInIdealBand(area: number | null, thresholds: Pick<MarkerBoardThresholds, "sizeIdealLowerNorm" | "sizeIdealUpperNorm">): boolean {
	return area !== null && area >= thresholds.sizeIdealLowerNorm && area <= thresholds.sizeIdealUpperNorm;
}

/**
 * Picks the SINGLE highest-priority action, never more than one at a time (per the task
 * brief: "shows ONE action at a time"). markerBoardAggregate's own activeCodes is already
 * at most one marker-board code (see aggregateMarkerBoardMetrics), so `[0]` is safe here,
 * not an arbitrary truncation. `markerBoardThresholds` defaults to DEFAULTS.markerBoard so
 * existing callers with no per-assessment override keep working unchanged; pass the
 * actual resolved config's thresholds when one is in effect.
 */
export function pickGuidanceMessage(
	markerBoardAggregate: MarkerBoardWindowAggregate | null,
	lowLightAggregate: LowLightWindowAggregate | null,
	markerBoardThresholds: Pick<MarkerBoardThresholds, "sizeIdealLowerNorm" | "sizeIdealUpperNorm"> = DEFAULTS.markerBoard,
	subjectAggregate: SubjectPositionWindowAggregate | null = null
): GuidanceSelection {
	if (markerBoardAggregate === null) {
		return { code: "PENDING", message: CAPTURE_QUALITY_GUIDANCE_MESSAGES.PENDING };
	}

	const markerCode = markerBoardAggregate.activeCodes[0];
	const subjectCode = subjectAggregate?.activeCodes[0] ?? null;

	// A board the camera genuinely cannot resolve outranks everything: there is no point
	// telling someone where to stand while the board itself is unusable.
	//
	// "Genuinely" is the operative word, and getting it wrong made the subject codes
	// unreachable. Ranking ANY blocking marker code above the subject meant a single-frame
	// marker blip masked a sustained subject problem - replaying subject-too-far-back, the
	// board reads OK on 44 of 47 steps, yet one MARKER_OBSTRUCTED step won the banner and the
	// operator never saw "move up to the floor marker". So the board only outranks the
	// subject when its own SMOOTHED visibility score says the board is actually not
	// resolvable, rather than when a momentary code happens to be active.
	const boardUnresolvable =
		markerBoardAggregate.weightedFullSetScore < DEFAULTS.markerBoard.minimumFullSetWeight;
	if (markerCode && boardUnresolvable && BLOCKING_MARKER_CODES.has(markerCode) && isGuidanceCode(markerCode)) {
		return { code: markerCode, message: CAPTURE_QUALITY_GUIDANCE_MESSAGES[markerCode] };
	}

	// Subject next: a person in the wrong place, or too many of them, is more actionable than
	// a board nudge once the board is basically visible. A subject aggregate that is null, or
	// that has no codes because person detection never ran, contributes nothing and cannot
	// block the green light - that is the fail-open path.
	if (subjectCode && isGuidanceCode(subjectCode)) {
		return { code: subjectCode, message: CAPTURE_QUALITY_GUIDANCE_MESSAGES[subjectCode] };
	}

	// A blocking marker code that did NOT clear the "unresolvable" bar above still outranks
	// lighting and the size nudges - it just no longer outranks the subject.
	if (markerCode && BLOCKING_MARKER_CODES.has(markerCode) && isGuidanceCode(markerCode)) {
		return { code: markerCode, message: CAPTURE_QUALITY_GUIDANCE_MESSAGES[markerCode] };
	}

	const lightCode = lowLightAggregate?.activeCodes[0] ?? null;
	if (lightCode && isGuidanceCode(lightCode)) {
		return { code: lightCode, message: CAPTURE_QUALITY_GUIDANCE_MESSAGES[lightCode] };
	}

	if (markerCode === "MARKER_TOO_SMALL" || markerCode === "MARKER_TOO_LARGE") {
		return { code: markerCode, message: CAPTURE_QUALITY_GUIDANCE_MESSAGES[markerCode] };
	}

	if (isInIdealBand(markerBoardAggregate.weightedNormalizedArea, markerBoardThresholds)) {
		return { code: "IDEAL", message: CAPTURE_QUALITY_GUIDANCE_MESSAGES.IDEAL };
	}

	return { code: "OK", message: CAPTURE_QUALITY_GUIDANCE_MESSAGES.OK };
}

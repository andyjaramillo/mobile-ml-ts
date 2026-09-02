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
import type { LowLightWindowAggregate } from "../CaptureQuality/lowLightCheck";
import type { MarkerBoardWindowAggregate } from "../CaptureQuality/markerBoardCheck";
import type { SubjectPositionWindowAggregate } from "../CaptureQuality/subjectPositionCheck";
import type { CaptureQualityIssueCode } from "../CaptureQuality/types";

/**
 * Codes this banner can explain. Narrower than CAPTURE_QUALITY_ISSUE_CODES on purpose: only
 * the ones the product set out to warn about - too many people, subject too far back from
 * the start line, board not fully visible, board too far or too close - plus lighting.
 * SUBJECT_NOT_STATIONARY and START_LINE_UNKNOWN are deliberately absent: neither is a thing
 * this feature reports, and the check no longer emits them as gates. LOW_CONTRAST is absent
 * because lowLightCheck no longer emits it either - see its retirement note. SUBJECT_NOT_DETECTED
 * is absent for a different reason - it is not a warning at all in this flow, it is the
 * expected state right after the room passes, and pickGuidanceMessage turns it into
 * SETUP_VERIFIED.
 */
type GuidanceCode = Extract<
	CaptureQualityIssueCode,
	"MARKER_INCOMPLETE" | "MARKER_TOO_CLOSE" | "MARKER_OBSTRUCTED" | "MARKER_WRONG_ORIENTATION" | "MARKER_SKEWED" | "MARKER_NOT_ALIGNED" | "MARKER_TOO_SMALL" | "MARKER_TOO_LARGE" | "LOW_LIGHT" | "GLARE" | "MULTIPLE_PEOPLE" | "SUBJECT_NOT_AT_START_LINE"
>;

/**
 * Selection outcomes beyond a single issue code: nothing measured yet (PENDING), the room
 * itself passes and the flow now waits on the patient (SETUP_VERIFIED), or everything
 * including the patient is in place (READY).
 */
export type GuidanceSelectionCode = GuidanceCode | "PENDING" | "SETUP_VERIFIED" | "READY";

// Phrased as an instruction ("do this"), never a diagnosis ("this measurement failed") -
// a patient reads this, not a developer. Kept short and plain per the task brief.
export const CAPTURE_QUALITY_GUIDANCE_MESSAGES: Record<GuidanceSelectionCode, string> = {
	MARKER_INCOMPLETE: "Move closer to the floor marker so the whole board is visible.",
	MARKER_TOO_CLOSE: "Step back so the whole floor marker fits in view.",
	MARKER_OBSTRUCTED: "Make sure nothing is covering the floor marker.",
	MARKER_WRONG_ORIENTATION: "Turn the camera to face the floor marker directly.",
	MARKER_SKEWED: "Straighten the camera angle toward the floor marker.",
	MARKER_NOT_ALIGNED: "Move the camera so the floor marker sits inside the guide.",
	MARKER_TOO_SMALL: "Move a little closer to the floor marker.",
	MARKER_TOO_LARGE: "Step back a little so there's room for the whole walk path in view.",
	LOW_LIGHT: "Add more light to the room.",
	GLARE: "Move the light or the board so the glare is off the floor marker.",
	MULTIPLE_PEOPLE: "Only the patient should be in view - ask others to step out of frame.",
	SUBJECT_NOT_AT_START_LINE: "Ask the patient to move up to the floor marker to start.",
	PENDING: "Checking your setup...",
	SETUP_VERIFIED: "Setup verified - the patient may now stand at the start line.",
	READY: "Ready to begin the assessment.",
};

export interface GuidanceSelection {
	code: GuidanceSelectionCode;
	message: string;
}

function isGuidanceCode(code: CaptureQualityIssueCode): code is GuidanceCode {
	return code in CAPTURE_QUALITY_GUIDANCE_MESSAGES;
}

/**
 * Picks the SINGLE highest-priority action, never more than one at a time (per the task
 * brief: "shows ONE action at a time").
 *
 * PRIORITY ORDER, and the reason for it: the camera setup is fixed first, with nobody in
 * frame, and only then is the patient brought in. So every camera-side issue - board, then
 * lighting - outranks every subject-side one, and the subject tier is unreachable until
 * the room passes. Ranking them the other way round asks an operator to position a patient
 * against a view that is about to be moved. GLARE is the one exception and sits above the
 * board too - see its own comment below.
 *
 * markerBoardAggregate's own activeCodes is already at most one marker-board code (see
 * aggregateMarkerBoardMetrics), so `[0]` is safe here, not an arbitrary truncation.
 */
export function pickGuidanceMessage(
	markerBoardAggregate: MarkerBoardWindowAggregate | null,
	lowLightAggregate: LowLightWindowAggregate | null,
	subjectAggregate: SubjectPositionWindowAggregate | null = null
): GuidanceSelection {
	if (markerBoardAggregate === null) {
		return select("PENDING");
	}

	// GLARE outranks the board, alone among the lighting codes: a blown-out patch is what
	// CAUSES the marker dropout under it, so the board codes are downstream symptoms of it.
	// The glare recording reports MARKER_OBSTRUCTED on 97% of its steps, and "make sure
	// nothing is covering the floor marker" is the wrong instruction when nothing is.
	if (lowLightAggregate?.activeCodes.includes("GLARE")) {
		return select("GLARE");
	}

	const markerCode = markerBoardAggregate.activeCodes[0];
	if (markerCode && isGuidanceCode(markerCode)) {
		return select(markerCode);
	}

	const lightCode = lowLightAggregate?.activeCodes[0] ?? null;
	if (lightCode && isGuidanceCode(lightCode)) {
		return select(lightCode);
	}

	// Nobody reliably in frame is the EXPECTED state at this point, not a fault: the room
	// just passed and the patient has not walked in yet. Reported as the positive cue to
	// bring them in.
	const subjectCode = subjectAggregate?.activeCodes[0] ?? null;
	if (subjectCode === "SUBJECT_NOT_DETECTED") {
		return select("SETUP_VERIFIED");
	}

	if (subjectCode && isGuidanceCode(subjectCode)) {
		return select(subjectCode);
	}

	// A subject aggregate that is null, or that has no codes because person detection never
	// ran, contributes nothing and cannot hold back the green light - that is the fail-open
	// path, and it is why READY does not require positive proof of a patient.
	return select("READY");
}

function select(code: GuidanceSelectionCode): GuidanceSelection {
	return { code, message: CAPTURE_QUALITY_GUIDANCE_MESSAGES[code] };
}

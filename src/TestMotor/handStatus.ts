// [Feature: Test Motor]
//
// The check: given the landmarked hands for one frame, decide whether the patient is set
// up correctly, and smooth that decision so the banner does not flicker.
//
// It never gates recording - see the repo's fail-open rule. The worst a wrong answer
// here can do is show unhelpful text.
//
// Pure: no React, no DOM, no MediaPipe. Everything it needs about the frame is passed in.
import {
	boundsGapNorm,
	handBounds,
	fingerSpreadRatio,
	minFingerExtension,
	minFingerSeparation,
	palmCenter,
	palmFacingScore,
	pointingRadians,
	thumbOutScore,
} from "./handGeometry";
import type { Point2D } from "./handGeometry";
import type { LandmarkedHand } from "./handLandmarker";
import {
	FINGER_EXTENSION_MIN,
	FINGER_SPREAD_RATIO_MIN,
	FRAME_EDGE_MARGIN,
	HAND_ALIGNMENT_RADIANS,
	HAND_GAP_MIN,
	HAND_GUIDE_BOX,
	MIRROR_PREVIEW,
	PALM_FACING_MIN_SCORE,
	STATUS_HOLD_RATIO,
	STATUS_WINDOW_TICKS,
	SWAP_MEDIAPIPE_HANDEDNESS,
	THUMB_OUT_MIN_SCORE,
} from "./motorConfig";

export const MOTOR_ISSUE_CODES = [
	// Every per-hand check reports one of three codes: name the hand when only one is
	// wrong, say "both" only when neither is right. A patient who is told "move your
	// hands" while one is already correct has to work out which one themselves.
	"BOTH_HANDS_MISSING",
	/**
	 * A hand is MISSING only when nothing was detected on its side of the guide. A hand
	 * that is detected but sitting outside the box is a different problem with a different
	 * remedy, and reports the OUTSIDE_GUIDE codes instead.
	 */
	"LEFT_HAND_MISSING",
	"RIGHT_HAND_MISSING",
	/**
	 * Detected, but the hand's landmark bounds run off the edge of the frame. Reported
	 * ahead of the guide-box codes because a clipped hand usually also sits outside the
	 * box, and "part of your hand is cut off" is the more specific instruction.
	 *
	 * Now measured over all 21 landmarks, so unlike the palm-box version this does catch
	 * fingertips clipped at the top of frame while the palm is fully visible.
	 */
	"BOTH_HANDS_NOT_FULLY_IN_FRAME",
	"LEFT_HAND_NOT_FULLY_IN_FRAME",
	"RIGHT_HAND_NOT_FULLY_IN_FRAME",
	"BOTH_HANDS_OUTSIDE_GUIDE",
	"LEFT_HAND_OUTSIDE_GUIDE",
	"RIGHT_HAND_OUTSIDE_GUIDE",
	/**
	 * The hands' landmark bounds overlap - fingers of one hand are among the other's.
	 * A pair property, so it has no left/right form: neither hand is individually wrong.
	 *
	 * Checked before palm facing and openness because overlapping hands degrade the
	 * landmark estimates those two read, so a wrong verdict there is likely to be a
	 * CONSEQUENCE of the overlap rather than a second independent problem.
	 */
	"HANDS_TOO_CLOSE",
	/** The back of the hand is toward the camera, or it is turned too far edge-on to tell. */
	"BOTH_PALMS_NOT_FACING_CAMERA",
	"LEFT_PALM_NOT_FACING_CAMERA",
	"RIGHT_PALM_NOT_FACING_CAMERA",
	/**
	 * Fingers curled, or pressed together / overlapping. One code rather than two: a
	 * patient asked to open their hand fixes both at once, and splitting them would mean
	 * calibrating two thresholds to tell apart states that share a remedy.
	 */
	"BOTH_HANDS_NOT_OPEN",
	"LEFT_HAND_NOT_OPEN",
	"RIGHT_HAND_NOT_OPEN",
	/**
	 * The thumb is folded across the palm. Reported after the openness codes so a closed
	 * fist - which also puts the thumb over the palm - is still answered with "open your
	 * hand", the instruction that fixes both at once.
	 */
	"BOTH_THUMBS_OVER_PALM",
	"LEFT_THUMB_OVER_PALM",
	"RIGHT_THUMB_OVER_PALM",
	"BOTH_HANDS_NOT_UPRIGHT",
	"LEFT_HAND_NOT_UPRIGHT",
	"RIGHT_HAND_NOT_UPRIGHT",
	/** Someone else's hands are in shot, or one hand was detected twice on one side. */
	"TOO_MANY_HANDS",
	"HANDS_READY",
	/** The window has not filled yet, or the detector has not run. Never a warning. */
	"PENDING",
] as const;

export type MotorIssueCode = typeof MOTOR_ISSUE_CODES[number];

/** Which of the PATIENT's hands this is, not which side of the image it landed on. */
export type HandSide = "left" | "right";

export interface EvaluatedHand {
	side: HandSide;
	/** Side as MediaPipe's handedness implies it, independent of where the hand sits. */
	handednessSide: HandSide;
	/**
	 * False when handedness and the guide-half disagree. Expected when the patient crosses
	 * their hands - and also what a wrong SWAP_MEDIAPIPE_HANDEDNESS would look like, which
	 * is why it is recorded rather than resolved silently.
	 */
	sidesAgree: boolean;
	/** Palm centre in displayed-frame pixels. */
	x: number;
	y: number;
	landmarks: Point2D[];
	pointingRadians: number;
	palmFacingScore: number;
	minFingerExtension: number;
	minFingerSeparation: number;
	fingerSpreadRatio: number;
	thumbOutScore: number;
	insideGuide: boolean;
	fullyInFrame: boolean;
	palmFacing: boolean;
	open: boolean;
	thumbClear: boolean;
	upright: boolean;
}

export interface HandFrameEvaluation {
	handCount: number;
	hands: EvaluatedHand[];
	/** Null unless exactly two hands were found - see boundsGapNorm. */
	handGap: number | null;
	code: MotorIssueCode;
}

export interface HandStatusWindow {
	codes: MotorIssueCode[];
	maxTicks: number;
	/** Last code that met the hold ratio. What the UI should render. */
	reported: MotorIssueCode;
}

/** The guide box in displayed-frame pixels. */
export function guideBoxPixels(frameWidth: number, frameHeight: number): { minX: number; minY: number; maxX: number; maxY: number } {
	const minX = HAND_GUIDE_BOX.x * frameWidth;
	const minY = HAND_GUIDE_BOX.y * frameHeight;
	return {
		minX,
		minY,
		maxX: minX + HAND_GUIDE_BOX.width * frameWidth,
		maxY: minY + HAND_GUIDE_BOX.height * frameHeight,
	};
}

/**
 * Detections arrive in the video's own pixel space, but the patient sees a mirrored
 * preview with an unmirrored guide drawn on top. Every landmark is flipped once, here,
 * so nothing downstream has to think about it - signed areas and angles both invert
 * under a mirror, and mixing the two spaces is what made the palm-detector version wrong.
 */
function toDisplaySpace(landmarks: readonly Point2D[], frameWidth: number): Point2D[] {
	if (!MIRROR_PREVIEW) return landmarks.map((point) => ({ ...point }));
	return landmarks.map((point) => ({ x: frameWidth - point.x, y: point.y }));
}

function sideFromGuideHalf(displayX: number, boxCenterX: number): HandSide {
	const onDisplayLeft = displayX < boxCenterX;
	return onDisplayLeft === MIRROR_PREVIEW ? "left" : "right";
}

function sideFromHandedness(hand: LandmarkedHand): HandSide {
	const reported: HandSide = hand.rawHandedness === "Left" ? "left" : "right";
	if (!SWAP_MEDIAPIPE_HANDEDNESS) return reported;
	return reported === "left" ? "right" : "left";
}

export function evaluateHandFrame(
	hands: readonly LandmarkedHand[],
	frameWidth: number,
	frameHeight: number
): HandFrameEvaluation {
	const box = guideBoxPixels(frameWidth, frameHeight);
	const boxCenterX = (box.minX + box.maxX) / 2;
	const marginX = FRAME_EDGE_MARGIN * frameWidth;
	const marginY = FRAME_EDGE_MARGIN * frameHeight;

	const evaluated: EvaluatedHand[] = hands.map((hand) => {
		const landmarks = toDisplaySpace(hand.landmarks, frameWidth);
		const center = palmCenter(landmarks);
		const bounds = handBounds(landmarks);

		// The guide half is the authority for WHICH hand this is: it is what the patient is
		// looking at, and it stays right when handedness is uncertain on a turned hand.
		// Handedness is kept alongside it rather than instead of it.
		const guideSide = sideFromGuideHalf(center.x, boxCenterX);
		const handednessSide = sideFromHandedness(hand);

		const facing = palmFacingScore(landmarks, guideSide === "right");
		const extension = minFingerExtension(landmarks);
		const separation = minFingerSeparation(landmarks);
		const spread = fingerSpreadRatio(landmarks);
		const thumbOut = thumbOutScore(landmarks, guideSide === "right");
		const pointing = pointingRadians(landmarks);

		return {
			side: guideSide,
			handednessSide,
			sidesAgree: guideSide === handednessSide,
			x: center.x,
			y: center.y,
			landmarks,
			pointingRadians: pointing,
			palmFacingScore: facing,
			minFingerExtension: extension,
			minFingerSeparation: separation,
			fingerSpreadRatio: spread,
			thumbOutScore: thumbOut,
			insideGuide: center.x >= box.minX && center.x <= box.maxX && center.y >= box.minY && center.y <= box.maxY,
			fullyInFrame:
				bounds.minX >= marginX &&
				bounds.maxX <= frameWidth - marginX &&
				bounds.minY >= marginY &&
				bounds.maxY <= frameHeight - marginY,
			palmFacing: facing >= PALM_FACING_MIN_SCORE,
			// Two conditions because they catch different failures: extension rejects a
			// closed fist, spread rejects fingers held straight but together. Neither
			// catches the other - across the takes a fist's spread RATIO reads high (a
			// small gap over a very small length), which is why it is not used alone.
			open: extension >= FINGER_EXTENSION_MIN && spread >= FINGER_SPREAD_RATIO_MIN,
			thumbClear: thumbOut >= THUMB_OUT_MIN_SCORE,
			upright: pointing > HAND_ALIGNMENT_RADIANS.min && pointing < HAND_ALIGNMENT_RADIANS.max,
		};
	});

	const handGap =
		evaluated.length === 2 ? boundsGapNorm(evaluated[0].landmarks, evaluated[1].landmarks) : null;

	return { handCount: evaluated.length, hands: evaluated, handGap, code: codeFor(evaluated, handGap) };
}

/** The three codes a per-hand check reports, picked by how many hands are failing it. */
interface SideCodes {
	both: MotorIssueCode;
	left: MotorIssueCode;
	right: MotorIssueCode;
}

const NOT_FULLY_IN_FRAME: SideCodes = {
	both: "BOTH_HANDS_NOT_FULLY_IN_FRAME",
	left: "LEFT_HAND_NOT_FULLY_IN_FRAME",
	right: "RIGHT_HAND_NOT_FULLY_IN_FRAME",
};
const OUTSIDE_GUIDE: SideCodes = {
	both: "BOTH_HANDS_OUTSIDE_GUIDE",
	left: "LEFT_HAND_OUTSIDE_GUIDE",
	right: "RIGHT_HAND_OUTSIDE_GUIDE",
};
const PALM_NOT_FACING: SideCodes = {
	both: "BOTH_PALMS_NOT_FACING_CAMERA",
	left: "LEFT_PALM_NOT_FACING_CAMERA",
	right: "RIGHT_PALM_NOT_FACING_CAMERA",
};
const NOT_OPEN: SideCodes = {
	both: "BOTH_HANDS_NOT_OPEN",
	left: "LEFT_HAND_NOT_OPEN",
	right: "RIGHT_HAND_NOT_OPEN",
};
const THUMB_OVER_PALM: SideCodes = {
	both: "BOTH_THUMBS_OVER_PALM",
	left: "LEFT_THUMB_OVER_PALM",
	right: "RIGHT_THUMB_OVER_PALM",
};
const NOT_UPRIGHT: SideCodes = {
	both: "BOTH_HANDS_NOT_UPRIGHT",
	left: "LEFT_HAND_NOT_UPRIGHT",
	right: "RIGHT_HAND_NOT_UPRIGHT",
};

// Reached only with exactly one hand per side, so two failures means both of them.
function codeForFailing(failing: readonly EvaluatedHand[], codes: SideCodes): MotorIssueCode | null {
	if (failing.length === 0) return null;
	if (failing.length > 1) return codes.both;
	return failing[0].side === "left" ? codes.left : codes.right;
}

// Ordered by what the patient should fix first: a hand that is not in shot has to be
// found before anything can be said about how it is turned. Palm-facing precedes
// openness because a hand seen from the back reads as closed whether it is or not.
function codeFor(hands: EvaluatedHand[], handGap: number | null): MotorIssueCode {
	const left = hands.filter((hand) => hand.side === "left").length;
	const right = hands.filter((hand) => hand.side === "right").length;

	if (left === 0 && right === 0) return "BOTH_HANDS_MISSING";
	// Checked before the missing cases: two hands on one side and none on the other means
	// something was detected twice or someone else is in shot, and telling the patient to
	// raise a hand they are already holding up would be actively misleading.
	if (left > 1 || right > 1) return "TOO_MANY_HANDS";
	if (left === 0) return "LEFT_HAND_MISSING";
	if (right === 0) return "RIGHT_HAND_MISSING";

	const clipped = codeForFailing(hands.filter((hand) => !hand.fullyInFrame), NOT_FULLY_IN_FRAME);
	if (clipped) return clipped;
	const outside = codeForFailing(hands.filter((hand) => !hand.insideGuide), OUTSIDE_GUIDE);
	if (outside) return outside;
	if (handGap !== null && handGap < HAND_GAP_MIN) return "HANDS_TOO_CLOSE";

	return (
		codeForFailing(hands.filter((hand) => !hand.palmFacing), PALM_NOT_FACING) ??
		codeForFailing(hands.filter((hand) => !hand.open), NOT_OPEN) ??
		codeForFailing(hands.filter((hand) => !hand.thumbClear), THUMB_OVER_PALM) ??
		codeForFailing(hands.filter((hand) => !hand.upright), NOT_UPRIGHT) ??
		"HANDS_READY"
	);
}

export function createHandStatusWindow(maxTicks: number = STATUS_WINDOW_TICKS): HandStatusWindow {
	return { codes: [], maxTicks, reported: "PENDING" };
}

export function resetHandStatusWindow(window: HandStatusWindow): void {
	window.codes.length = 0;
	window.reported = "PENDING";
}

/**
 * Pushes one tick and returns what should be displayed. A new code has to hold for
 * STATUS_HOLD_RATIO of the window before it replaces the last one; below that the
 * previous answer stands. Carried over from the palm detector's 70%-of-buffer rule,
 * which was only ever applied to cancelling its countdown - here it governs every
 * transition, so a single dropped detection cannot make the banner jump.
 */
export function pushHandStatus(window: HandStatusWindow, code: MotorIssueCode): MotorIssueCode {
	window.codes.push(code);
	if (window.codes.length > window.maxTicks) window.codes.shift();

	const threshold = window.codes.length * STATUS_HOLD_RATIO;
	const counts = new Map<MotorIssueCode, number>();
	for (const seen of window.codes) counts.set(seen, (counts.get(seen) ?? 0) + 1);

	for (const [candidate, count] of counts) {
		if (count >= threshold) {
			window.reported = candidate;
			break;
		}
	}
	return window.reported;
}

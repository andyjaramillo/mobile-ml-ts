// [Feature: Test Motor]
//
// The actual error detection: given the palm detections for one frame, decide whether
// the hands are correctly in frame, and smooth that decision over a short window so the
// banner does not flicker.
//
// This is Website's canStartTimer/shouldStopTimer logic, with two changes. It reports a
// REASON instead of a boolean, because a patient who is told "move your hands into the
// box" can act and a patient watching a countdown refuse to start cannot. And it never
// gates recording - see the repo's fail-open rule; the worst a wrong answer here can do
// is show unhelpful text.
//
// Pure: no React, no DOM. Everything it needs about the frame is passed in.
import { handOrientation } from "./handOnnxUtil";
import type { HandDetection, HandPoint } from "./handModel";
import {
	FRAME_EDGE_MARGIN,
	HAND_ALIGNMENT_RADIANS,
	HAND_GUIDE_BOX,
	MIRROR_PREVIEW,
	STATUS_HOLD_RATIO,
	STATUS_WINDOW_TICKS,
} from "./motorConfig";

export const MOTOR_ISSUE_CODES = [
	"BOTH_HANDS_MISSING",
	/**
	 * A hand is MISSING only when nothing was detected on its side of the guide. A hand
	 * that is detected but sitting outside the box is a different problem with a different
	 * remedy, and reports HANDS_OUTSIDE_GUIDE instead.
	 */
	"LEFT_HAND_MISSING",
	"RIGHT_HAND_MISSING",
	/**
	 * Detected, but its bounding box runs off the edge of the frame. Reported ahead of the
	 * guide-box codes because a clipped hand usually also sits outside the box, and "part
	 * of your hand is cut off" is the more specific instruction of the two.
	 *
	 * CAVEAT: this model returns a PALM box, not a whole-hand box, so a hand whose fingers
	 * are cut off while the palm is fully visible does NOT trigger this. Catching that
	 * needs the 21-landmark hand model.
	 */
	"LEFT_HAND_NOT_FULLY_IN_FRAME",
	"RIGHT_HAND_NOT_FULLY_IN_FRAME",
	/** Someone else's hands are in shot, or one hand was detected twice on one side. */
	"TOO_MANY_HANDS",
	"HANDS_OUTSIDE_GUIDE",
	"HANDS_MISALIGNED",
	"HANDS_READY",
	/** The window has not filled yet, or the detector has not run. Never a warning. */
	"PENDING",
] as const;

export type MotorIssueCode = typeof MOTOR_ISSUE_CODES[number];

/** Which of the PATIENT's hands this is, not which side of the image it landed on. */
export type HandSide = "left" | "right";

export interface EvaluatedHand {
	side: HandSide;
	/** Palm centre in displayed-frame pixels, already mirrored if the preview is. */
	x: number;
	y: number;
	/** [x1, y1, x2, y2], same space as x/y. x1 stays the left edge after mirroring. */
	bbox: [number, number, number, number];
	/** Same space as x/y, so the overlay never has to mirror anything itself. */
	landmarks: HandPoint[];
	score: number;
	/** Palm orientation in radians (atan2, y down). -PI/2 points straight up the frame. */
	radians: number;
	insideGuide: boolean;
	aligned: boolean;
	/** The whole palm box is inside the frame - see LEFT_HAND_NOT_FULLY_IN_FRAME. */
	fullyInFrame: boolean;
}

export interface HandFrameEvaluation {
	handCount: number;
	hands: EvaluatedHand[];
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
 * Detections come out of the model in the video's own pixel space, but the patient sees
 * a mirrored preview with an unmirrored guide drawn on top. Comparing the two without
 * flipping compares a hand on the left of the sensor against a box drawn for the right
 * of the screen, which is only invisible because the box is nearly centred.
 */
function toDisplayX(x: number, frameWidth: number): number {
	return MIRROR_PREVIEW ? frameWidth - x : x;
}

/**
 * The preview is mirrored, so it behaves like a mirror: the patient's own left hand
 * appears on the LEFT of the screen. Without the mirror the camera sees them the way a
 * person facing them would and the sides swap, so this reads MIRROR_PREVIEW rather than
 * assuming either convention - getting it backwards would tell a patient to move the
 * wrong hand, which is worse than saying nothing.
 */
function sideFor(displayX: number, boxCenterX: number): HandSide {
	const onDisplayLeft = displayX < boxCenterX;
	return onDisplayLeft === MIRROR_PREVIEW ? "left" : "right";
}

export function evaluateHandFrame(
	detections: HandDetection[],
	frameWidth: number,
	frameHeight: number
): HandFrameEvaluation {
	const box = guideBoxPixels(frameWidth, frameHeight);
	const boxCenterX = (box.minX + box.maxX) / 2;
	const marginX = FRAME_EDGE_MARGIN * frameWidth;
	const marginY = FRAME_EDGE_MARGIN * frameHeight;

	const hands: EvaluatedHand[] = detections.map((detection) => {
		const x = toDisplayX(detection.x, frameWidth);
		const y = detection.y;
		// Mirroring negates the horizontal component, so the angle reflects about the
		// vertical axis. Reflecting keeps the alignment window meaningful on the image the
		// patient is actually looking at.
		const rawRadians = handOrientation(detection);
		const radians = MIRROR_PREVIEW ? Math.atan2(Math.sin(rawRadians), -Math.cos(rawRadians)) : rawRadians;
		const [x1, , x2] = detection.bbox;
		const displayX1 = toDisplayX(MIRROR_PREVIEW ? x2 : x1, frameWidth);
		const displayX2 = toDisplayX(MIRROR_PREVIEW ? x1 : x2, frameWidth);

		return {
			side: sideFor(x, boxCenterX),
			x,
			y,
			bbox: [displayX1, detection.bbox[1], displayX2, detection.bbox[3]],
			landmarks: detection.landmarks.map((point) => ({ x: toDisplayX(point.x, frameWidth), y: point.y })),
			score: detection.score,
			radians,
			insideGuide: x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY,
			aligned: radians > HAND_ALIGNMENT_RADIANS.min && radians < HAND_ALIGNMENT_RADIANS.max,
			// The model regresses box coordinates rather than clipping them to the image, so
			// a partly out-of-frame palm really does come back with a box outside the bounds.
			fullyInFrame:
				displayX1 >= marginX &&
				displayX2 <= frameWidth - marginX &&
				detection.bbox[1] >= marginY &&
				detection.bbox[3] <= frameHeight - marginY,
		};
	});

	return { handCount: hands.length, hands, code: codeFor(hands) };
}

// Ordered by what the patient should fix first: a hand that is not in shot has to be
// found before anything can be said about where it is pointing.
function codeFor(hands: EvaluatedHand[]): MotorIssueCode {
	const left = hands.filter((hand) => hand.side === "left").length;
	const right = hands.filter((hand) => hand.side === "right").length;

	if (left === 0 && right === 0) return "BOTH_HANDS_MISSING";
	// Checked before the missing cases: two palms on one side and none on the other means
	// something was detected twice or someone else is in shot, and telling the patient to
	// raise a hand they are already holding up would be actively misleading.
	if (left > 1 || right > 1) return "TOO_MANY_HANDS";
	if (left === 0) return "LEFT_HAND_MISSING";
	if (right === 0) return "RIGHT_HAND_MISSING";

	// One hand per side from here on. When both are clipped only the left is named; the
	// right surfaces on the next tick once the left is fixed, which reads better than a
	// combined message the patient has to act on twice anyway.
	const clipped = hands.find((hand) => !hand.fullyInFrame);
	if (clipped) return clipped.side === "left" ? "LEFT_HAND_NOT_FULLY_IN_FRAME" : "RIGHT_HAND_NOT_FULLY_IN_FRAME";

	if (!hands.every((hand) => hand.insideGuide)) return "HANDS_OUTSIDE_GUIDE";
	if (!hands.every((hand) => hand.aligned)) return "HANDS_MISALIGNED";
	return "HANDS_READY";
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
 * previous answer stands. Carried over from Website's 70%-of-buffer rule, which was
 * only ever applied to cancelling the countdown - here it governs every transition, so
 * a single dropped detection cannot make the banner jump.
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

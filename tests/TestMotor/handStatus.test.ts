import { describe, expect, it } from "vitest";
import {
	createHandStatusWindow,
	evaluateHandFrame,
	guideBoxPixels,
	pushHandStatus,
	resetHandStatusWindow,
} from "../../src/TestMotor/handStatus";
import { HAND_GUIDE_BOX, MIRROR_PREVIEW, STATUS_WINDOW_TICKS } from "../../src/TestMotor/motorConfig";
import { agreeingHandedness, landmarkedHand } from "./handFixtures";
import type { HandOptions } from "./handFixtures";

const FRAME_W = 1620;
const FRAME_H = 911;

const BOX = guideBoxPixels(FRAME_W, FRAME_H);
const SPAN = BOX.maxX - BOX.minX;
const MID_Y = (BOX.minY + BOX.maxY) / 2;

/**
 * Places a hand so it LANDS at `displayX` after evaluateHandFrame's mirror, and gives it
 * the handedness MediaPipe would report for the patient's hand on that side.
 */
function handAt(displayX: number, displayY = MID_Y, options: HandOptions = {}) {
	const side = (displayX < (BOX.minX + BOX.maxX) / 2) === MIRROR_PREVIEW ? "left" : "right";
	return landmarkedHand({
		...options,
		side,
		frameWidth: FRAME_W,
		// The palm centre sits above the wrist, so the wrist is placed below the target.
		at: { x: displayX, y: displayY + 55 },
	});
}

const PATIENT_LEFT_X = BOX.minX + SPAN * 0.25;
const PATIENT_RIGHT_X = BOX.minX + SPAN * 0.75;

function evaluate(hands: ReturnType<typeof handAt>[]) {
	return evaluateHandFrame(hands, FRAME_W, FRAME_H);
}

describe("evaluateHandFrame", () => {
	it("reports HANDS_READY for two open palms inside the guide", () => {
		const result = evaluate([handAt(PATIENT_LEFT_X), handAt(PATIENT_RIGHT_X)]);
		expect(result.code).toBe("HANDS_READY");
		expect(new Set(result.hands.map((hand) => hand.side))).toEqual(new Set(["left", "right"]));
	});

	it("reports BOTH_HANDS_MISSING for an empty frame", () => {
		expect(evaluate([]).code).toBe("BOTH_HANDS_MISSING");
	});

	it("names the missing hand when only the other one is up", () => {
		expect(evaluate([handAt(PATIENT_LEFT_X)]).code).toBe("RIGHT_HAND_MISSING");
		expect(evaluate([handAt(PATIENT_RIGHT_X)]).code).toBe("LEFT_HAND_MISSING");
	});

	it("reports TOO_MANY_HANDS when both land on the same side", () => {
		expect(evaluate([handAt(BOX.minX + SPAN * 0.2), handAt(BOX.minX + SPAN * 0.3)]).code).toBe("TOO_MANY_HANDS");
	});

	it("names the hand whose palm is turned away", () => {
		expect(evaluate([handAt(PATIENT_LEFT_X, MID_Y, { palmAway: true }), handAt(PATIENT_RIGHT_X)]).code).toBe(
			"LEFT_PALM_NOT_FACING_CAMERA"
		);
		expect(evaluate([handAt(PATIENT_LEFT_X), handAt(PATIENT_RIGHT_X, MID_Y, { palmAway: true })]).code).toBe(
			"RIGHT_PALM_NOT_FACING_CAMERA"
		);
		expect(
			evaluate([handAt(PATIENT_LEFT_X, MID_Y, { palmAway: true }), handAt(PATIENT_RIGHT_X, MID_Y, { palmAway: true })]).code
		).toBe("BOTH_PALMS_NOT_FACING_CAMERA");
	});

	it("names the hand that is not open, whether curled or pinched", () => {
		expect(evaluate([handAt(PATIENT_LEFT_X, MID_Y, { curl: 0.8 }), handAt(PATIENT_RIGHT_X)]).code).toBe(
			"LEFT_HAND_NOT_OPEN"
		);
		// pinch draws the fingertips together without straightening them, which is the
		// posture the raw fingertip gap used to miss.
		expect(evaluate([handAt(PATIENT_LEFT_X), handAt(PATIENT_RIGHT_X, MID_Y, { pinch: 1 })]).code).toBe(
			"RIGHT_HAND_NOT_OPEN"
		);
		expect(
			evaluate([handAt(PATIENT_LEFT_X, MID_Y, { curl: 0.8 }), handAt(PATIENT_RIGHT_X, MID_Y, { curl: 0.8 })]).code
		).toBe("BOTH_HANDS_NOT_OPEN");
	});

	it("names the hand whose thumb is folded over the palm", () => {
		expect(evaluate([handAt(PATIENT_LEFT_X, MID_Y, { thumbTuck: 1 }), handAt(PATIENT_RIGHT_X)]).code).toBe(
			"LEFT_THUMB_OVER_PALM"
		);
		expect(evaluate([handAt(PATIENT_LEFT_X), handAt(PATIENT_RIGHT_X, MID_Y, { thumbTuck: 1 })]).code).toBe(
			"RIGHT_THUMB_OVER_PALM"
		);
		expect(
			evaluate([handAt(PATIENT_LEFT_X, MID_Y, { thumbTuck: 1 }), handAt(PATIENT_RIGHT_X, MID_Y, { thumbTuck: 1 })]).code
		).toBe("BOTH_THUMBS_OVER_PALM");
	});

	it("accepts a thumb held up alongside the index finger", () => {
		// The requirement is that the thumb not cover the palm, not that it be splayed, so
		// a thumb resting against the index finger has to stay green.
		const result = evaluate([handAt(PATIENT_LEFT_X, MID_Y, { thumbTuck: 0.25 }), handAt(PATIENT_RIGHT_X)]);
		expect(result.code).toBe("HANDS_READY");
	});

	it("tells a closed fist to open rather than to move its thumb", () => {
		// A fist puts the thumb over the palm too; "open your hand" fixes both, so the
		// openness codes have to win.
		const result = evaluate([handAt(PATIENT_LEFT_X, MID_Y, { curl: 1, thumbTuck: 1 }), handAt(PATIENT_RIGHT_X)]);
		expect(result.code).toBe("LEFT_HAND_NOT_OPEN");
	});

	it("names the hand that is not pointing up", () => {
		expect(evaluate([handAt(PATIENT_LEFT_X, MID_Y, { rotation: 1.4 }), handAt(PATIENT_RIGHT_X)]).code).toBe(
			"LEFT_HAND_NOT_UPRIGHT"
		);
	});

	it("reports a palm turned away before it reports the hand closed", () => {
		// A hand seen from the back reads as closed whether or not it is, so the facing
		// instruction has to come first or the patient is told to fix the wrong thing.
		const result = evaluate([handAt(PATIENT_LEFT_X, MID_Y, { palmAway: true, curl: 0.8 }), handAt(PATIENT_RIGHT_X)]);
		expect(result.code).toBe("LEFT_PALM_NOT_FACING_CAMERA");
	});

	it("names the hand outside the guide box", () => {
		expect(evaluate([handAt(PATIENT_LEFT_X, BOX.minY - 120), handAt(PATIENT_RIGHT_X)]).code).toBe(
			"LEFT_HAND_OUTSIDE_GUIDE"
		);
	});

	it("reports a clipped hand ahead of a guide-box miss", () => {
		const clipped = evaluate([handAt(FRAME_W - 5, MID_Y), handAt(PATIENT_LEFT_X)]);
		expect(clipped.code).toMatch(/NOT_FULLY_IN_FRAME$/);
	});

	it("catches fingertips clipped at the top while the palm is fully visible", () => {
		// The palm-box version could not see this: the palm sits well inside the frame and
		// only the extended fingers cross the edge.
		const result = evaluate([handAt(PATIENT_LEFT_X, 150), handAt(PATIENT_RIGHT_X)]);
		const clippedHand = result.hands.find((hand) => !hand.fullyInFrame);
		expect(clippedHand).toBeDefined();
		expect(clippedHand!.y).toBeGreaterThan(0);
	});

	it("keeps MediaPipe handedness as a cross-check, not as the answer", () => {
		// Guide half says left; handedness is deliberately fed the opposite of whatever
		// would agree, which is what a wrong SWAP constant looks like in the data.
		const disagreeing = agreeingHandedness("left") === "Left" ? "Right" : "Left";
		const [hand] = evaluate([landmarkedHand({
			side: "left",
			frameWidth: FRAME_W,
			at: { x: PATIENT_LEFT_X, y: MID_Y + 55 },
			rawHandedness: disagreeing,
		})]).hands;
		expect(hand.side).toBe("left");
		expect(hand.handednessSide).toBe("right");
		expect(hand.sidesAgree).toBe(false);
	});

	it("agrees with handedness for a normally placed hand", () => {
		const [hand] = evaluate([handAt(PATIENT_LEFT_X)]).hands;
		expect(hand.sidesAgree).toBe(true);
	});

	it("splits sides on the guide box centre", () => {
		const boxCenterNorm = HAND_GUIDE_BOX.x + HAND_GUIDE_BOX.width / 2;
		expect((BOX.minX + BOX.maxX) / 2).toBeCloseTo(boxCenterNorm * FRAME_W, 5);
	});
});

describe("pushHandStatus", () => {
	it("commits the first sample, which is all of the window so far", () => {
		const window = createHandStatusWindow(STATUS_WINDOW_TICKS);
		expect(pushHandStatus(window, "HANDS_READY")).toBe("HANDS_READY");
	});

	it("ignores a single dissenting tick", () => {
		const window = createHandStatusWindow(STATUS_WINDOW_TICKS);
		for (let i = 0; i < STATUS_WINDOW_TICKS; i++) pushHandStatus(window, "HANDS_READY");
		expect(pushHandStatus(window, "BOTH_HANDS_MISSING")).toBe("HANDS_READY");
	});

	it("switches once the new code holds the window", () => {
		const window = createHandStatusWindow(STATUS_WINDOW_TICKS);
		for (let i = 0; i < STATUS_WINDOW_TICKS; i++) pushHandStatus(window, "HANDS_READY");
		let reported = window.reported;
		for (let i = 0; i < STATUS_WINDOW_TICKS; i++) reported = pushHandStatus(window, "BOTH_HANDS_MISSING");
		expect(reported).toBe("BOTH_HANDS_MISSING");
	});

	it("is bounded by maxTicks", () => {
		const window = createHandStatusWindow(4);
		for (let i = 0; i < 50; i++) pushHandStatus(window, "HANDS_READY");
		expect(window.codes.length).toBe(4);
	});

	it("resets back to PENDING for a new take", () => {
		const window = createHandStatusWindow(STATUS_WINDOW_TICKS);
		pushHandStatus(window, "HANDS_READY");
		resetHandStatusWindow(window);
		expect(window.reported).toBe("PENDING");
		expect(window.codes.length).toBe(0);
	});
});

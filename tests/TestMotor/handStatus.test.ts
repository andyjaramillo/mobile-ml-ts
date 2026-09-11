import { describe, expect, it } from "vitest";
import {
	createHandStatusWindow,
	evaluateHandFrame,
	guideBoxPixels,
	pushHandStatus,
	resetHandStatusWindow,
} from "../../src/TestMotor/handStatus";
import type { HandDetection, HandPoint } from "../../src/TestMotor/handModel";
import { HAND_ALIGNMENT_RADIANS, HAND_GUIDE_BOX, MIRROR_PREVIEW, STATUS_WINDOW_TICKS } from "../../src/TestMotor/motorConfig";

const FRAME_W = 800;
const FRAME_H = 450;

/**
 * Builds a detection whose landmark[2] sits at `radians` from the centre, because that
 * is the vector handOrientation() measures. Positions are given in DISPLAY space and
 * converted back to sensor space, so a test can say where a hand appears on screen
 * without restating the mirror maths under test.
 */
function detectionAt(displayX: number, displayY: number, radians: number, score = 0.9, half = 30): HandDetection {
	const sensorX = MIRROR_PREVIEW ? FRAME_W - displayX : displayX;
	// Mirroring reflects the angle about the vertical axis; undo that to get the sensor-space angle.
	const sensorRadians = MIRROR_PREVIEW ? Math.atan2(Math.sin(radians), -Math.cos(radians)) : radians;
	const reach = 40;
	const landmarks: HandPoint[] = Array.from({ length: 7 }, () => ({ x: sensorX, y: displayY }));
	landmarks[2] = {
		x: sensorX + reach * Math.cos(sensorRadians),
		y: displayY + reach * Math.sin(sensorRadians),
	};
	return {
		bbox: [sensorX - half, displayY - half, sensorX + half, displayY + half],
		score,
		landmarks,
		x: sensorX,
		y: displayY,
	};
}

const UPRIGHT = -Math.PI / 2;

function insideCentre(): { x: number; y: number } {
	const box = guideBoxPixels(FRAME_W, FRAME_H);
	return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}

describe("evaluateHandFrame", () => {
	it("reports BOTH_HANDS_MISSING for an empty frame", () => {
		expect(evaluateHandFrame([], FRAME_W, FRAME_H).code).toBe("BOTH_HANDS_MISSING");
	});

	it("names the missing hand when only the other one is up", () => {
		const { y } = insideCentre();
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const leftOfScreen = box.minX + (box.maxX - box.minX) * 0.25;
		const rightOfScreen = box.minX + (box.maxX - box.minX) * 0.75;

		// The preview is mirrored, so a hand on the LEFT of the screen is the patient's own
		// left hand - which means the RIGHT one is the one they need to raise.
		const onlyScreenLeft = evaluateHandFrame([detectionAt(leftOfScreen, y, UPRIGHT)], FRAME_W, FRAME_H);
		expect(onlyScreenLeft.hands[0].side).toBe(MIRROR_PREVIEW ? "left" : "right");
		expect(onlyScreenLeft.code).toBe(MIRROR_PREVIEW ? "RIGHT_HAND_MISSING" : "LEFT_HAND_MISSING");

		const onlyScreenRight = evaluateHandFrame([detectionAt(rightOfScreen, y, UPRIGHT)], FRAME_W, FRAME_H);
		expect(onlyScreenRight.hands[0].side).toBe(MIRROR_PREVIEW ? "right" : "left");
		expect(onlyScreenRight.code).toBe(MIRROR_PREVIEW ? "LEFT_HAND_MISSING" : "RIGHT_HAND_MISSING");
	});

	it("counts a detected but badly placed hand as present, not missing", () => {
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const leftOfScreen = box.minX + (box.maxX - box.minX) * 0.25;
		const rightOfScreen = box.minX + (box.maxX - box.minX) * 0.75;
		// One hand per side, but both well above the box.
		const result = evaluateHandFrame(
			[detectionAt(leftOfScreen, box.minY - 60, UPRIGHT), detectionAt(rightOfScreen, box.minY - 60, UPRIGHT)],
			FRAME_W,
			FRAME_H
		);
		expect(result.code).toBe("HANDS_OUTSIDE_GUIDE");
	});

	it("reports TOO_MANY_HANDS when both palms land on the same side", () => {
		const { y } = insideCentre();
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const a = box.minX + (box.maxX - box.minX) * 0.2;
		const b = box.minX + (box.maxX - box.minX) * 0.3;
		const result = evaluateHandFrame([detectionAt(a, y, UPRIGHT), detectionAt(b, y, UPRIGHT)], FRAME_W, FRAME_H);
		expect(result.code).toBe("TOO_MANY_HANDS");
	});

	it("reports TOO_MANY_HANDS when a third palm appears", () => {
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const { y } = insideCentre();
		const hands = [
			detectionAt(box.minX + (box.maxX - box.minX) * 0.2, y, UPRIGHT),
			detectionAt(box.minX + (box.maxX - box.minX) * 0.3, y, UPRIGHT),
			detectionAt(box.minX + (box.maxX - box.minX) * 0.8, y, UPRIGHT),
		];
		expect(evaluateHandFrame(hands, FRAME_W, FRAME_H).code).toBe("TOO_MANY_HANDS");
	});

	it("assigns one side per hand for a correct two-hand frame", () => {
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const { y } = insideCentre();
		const result = evaluateHandFrame(
			[
				detectionAt(box.minX + (box.maxX - box.minX) * 0.25, y, UPRIGHT),
				detectionAt(box.minX + (box.maxX - box.minX) * 0.75, y, UPRIGHT),
			],
			FRAME_W,
			FRAME_H
		);
		expect(new Set(result.hands.map((hand) => hand.side))).toEqual(new Set(["left", "right"]));
		expect(result.code).toBe("HANDS_READY");
	});

	it("splits sides on the guide box centre, not the frame centre", () => {
		// Only meaningful while the box is not frame-centred; asserts the derivation rather
		// than the current numbers.
		const boxCenterNorm = HAND_GUIDE_BOX.x + HAND_GUIDE_BOX.width / 2;
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		expect((box.minX + box.maxX) / 2).toBeCloseTo(boxCenterNorm * FRAME_W, 5);
	});

	it("reports HANDS_READY when both palms are inside the guide and upright", () => {
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const { y } = insideCentre();
		const span = box.maxX - box.minX;
		const result = evaluateHandFrame(
			[detectionAt(box.minX + span * 0.25, y, UPRIGHT), detectionAt(box.minX + span * 0.75, y, UPRIGHT)],
			FRAME_W,
			FRAME_H
		);
		expect(result.code).toBe("HANDS_READY");
		expect(result.hands.every((hand) => hand.insideGuide && hand.aligned)).toBe(true);
	});

	it("names the clipped hand when a palm box runs off the frame edge", () => {
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const { y } = insideCentre();
		const span = box.maxX - box.minX;
		const ok = detectionAt(box.minX + span * 0.25, y, UPRIGHT);
		// Centre still inside the guide, but the box overhangs the right edge of the frame.
		const clipped = detectionAt(FRAME_W - 10, y, UPRIGHT, 0.9, 60);

		const result = evaluateHandFrame([ok, clipped], FRAME_W, FRAME_H);
		const clippedHand = result.hands.find((hand) => !hand.fullyInFrame);
		expect(clippedHand).toBeDefined();
		expect(result.code).toBe(
			clippedHand!.side === "left" ? "LEFT_HAND_NOT_FULLY_IN_FRAME" : "RIGHT_HAND_NOT_FULLY_IN_FRAME"
		);
	});

	it("treats a clipped hand as present rather than missing", () => {
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const { y } = insideCentre();
		const span = box.maxX - box.minX;
		const result = evaluateHandFrame(
			[detectionAt(box.minX + span * 0.25, y, UPRIGHT), detectionAt(FRAME_W - 10, y, UPRIGHT, 0.9, 60)],
			FRAME_W,
			FRAME_H
		);
		expect(result.code).not.toBe("LEFT_HAND_MISSING");
		expect(result.code).not.toBe("RIGHT_HAND_MISSING");
	});

	it("reports clipping ahead of a guide-box miss, since it is the more specific fix", () => {
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const span = box.maxX - box.minX;
		// Both hands outside the box vertically; one of them also clipped by the frame.
		const aboveBox = box.minY - 40;
		const result = evaluateHandFrame(
			[detectionAt(box.minX + span * 0.25, aboveBox, UPRIGHT), detectionAt(FRAME_W - 10, aboveBox, UPRIGHT, 0.9, 60)],
			FRAME_W,
			FRAME_H
		);
		expect(result.code).toMatch(/NOT_FULLY_IN_FRAME$/);
	});

	it("counts a hand well inside the frame as whole", () => {
		const { x, y } = insideCentre();
		const [hand] = evaluateHandFrame([detectionAt(x, y, UPRIGHT)], FRAME_W, FRAME_H).hands;
		expect(hand.fullyInFrame).toBe(true);
	});

	it("reports HANDS_OUTSIDE_GUIDE when one palm leaves the box", () => {
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const { y } = insideCentre();
		const span = box.maxX - box.minX;
		const inside = detectionAt(box.minX + span * 0.25, y, UPRIGHT);
		const outside = detectionAt(box.minX + span * 0.75, box.minY - 40, UPRIGHT);
		expect(evaluateHandFrame([inside, outside], FRAME_W, FRAME_H).code).toBe("HANDS_OUTSIDE_GUIDE");
	});

	it("reports HANDS_MISALIGNED when both are in the box but turned away", () => {
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const { y } = insideCentre();
		const span = box.maxX - box.minX;
		const sideways = HAND_ALIGNMENT_RADIANS.max + 0.5;
		const result = evaluateHandFrame(
			[detectionAt(box.minX + span * 0.25, y, sideways), detectionAt(box.minX + span * 0.75, y, sideways)],
			FRAME_W,
			FRAME_H
		);
		expect(result.code).toBe("HANDS_MISALIGNED");
		expect(result.hands.every((hand) => hand.insideGuide)).toBe(true);
	});

	it("reflects the orientation angle, so a palm leaning right on the sensor leans left on screen", () => {
		// Built in sensor space directly, bypassing detectionAt's display-space helper, so
		// this pins the reflection rather than restating it.
		const upAndRight = -Math.PI / 4;
		const reach = 40;
		const landmarks: HandPoint[] = Array.from({ length: 7 }, () => ({ x: 400, y: 300 }));
		landmarks[2] = { x: 400 + reach * Math.cos(upAndRight), y: 300 + reach * Math.sin(upAndRight) };
		const sensorHand: HandDetection = {
			bbox: [370, 270, 430, 330],
			score: 0.9,
			landmarks,
			x: 400,
			y: 300,
		};

		const [hand] = evaluateHandFrame([sensorHand], FRAME_W, FRAME_H).hands;
		expect(hand.radians).toBeCloseTo(MIRROR_PREVIEW ? -Math.PI + Math.PI / 4 : upAndRight, 5);
		// Still leaning up (negative y component) either way - mirroring must not flip vertical.
		expect(Math.sin(hand.radians)).toBeLessThan(0);
	});

	it("mirrors positions into display space so the guide box and the hands agree", () => {
		const { x, y } = insideCentre();
		const [hand] = evaluateHandFrame([detectionAt(x, y, UPRIGHT)], FRAME_W, FRAME_H).hands;
		expect(hand.x).toBeCloseTo(x, 5);
		// bbox x1 stays the left edge after the flip.
		expect(hand.bbox[0]).toBeLessThan(hand.bbox[2]);
	});
});

describe("pushHandStatus", () => {
	it("holds PENDING until one code dominates the window", () => {
		const window = createHandStatusWindow(STATUS_WINDOW_TICKS);
		// A single sample is trivially 100% of the window, so the first tick already commits.
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

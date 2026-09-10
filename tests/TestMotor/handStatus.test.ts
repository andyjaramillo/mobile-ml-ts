import { describe, expect, it } from "vitest";
import {
	createHandStatusWindow,
	evaluateHandFrame,
	guideBoxPixels,
	pushHandStatus,
	resetHandStatusWindow,
} from "../../src/TestMotor/handStatus";
import type { HandDetection, HandPoint } from "../../src/TestMotor/handModel";
import { HAND_ALIGNMENT_RADIANS, MIRROR_PREVIEW, STATUS_WINDOW_TICKS } from "../../src/TestMotor/motorConfig";

const FRAME_W = 800;
const FRAME_H = 450;

/**
 * Builds a detection whose landmark[2] sits at `radians` from the centre, because that
 * is the vector handOrientation() measures. Positions are given in DISPLAY space and
 * converted back to sensor space, so a test can say where a hand appears on screen
 * without restating the mirror maths under test.
 */
function detectionAt(displayX: number, displayY: number, radians: number, score = 0.9): HandDetection {
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
		bbox: [sensorX - 30, displayY - 30, sensorX + 30, displayY + 30],
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
	it("reports NO_HANDS_DETECTED for an empty frame", () => {
		expect(evaluateHandFrame([], FRAME_W, FRAME_H).code).toBe("NO_HANDS_DETECTED");
	});

	it("reports ONE_HAND_ONLY when only one palm is found", () => {
		const { x, y } = insideCentre();
		const result = evaluateHandFrame([detectionAt(x, y, UPRIGHT)], FRAME_W, FRAME_H);
		expect(result.code).toBe("ONE_HAND_ONLY");
		expect(result.handCount).toBe(1);
	});

	it("reports TOO_MANY_HANDS when a third palm appears", () => {
		const { x, y } = insideCentre();
		const hands = [detectionAt(x - 60, y, UPRIGHT), detectionAt(x, y, UPRIGHT), detectionAt(x + 60, y, UPRIGHT)];
		expect(evaluateHandFrame(hands, FRAME_W, FRAME_H).code).toBe("TOO_MANY_HANDS");
	});

	it("reports HANDS_READY when both palms are inside the guide and upright", () => {
		const { x, y } = insideCentre();
		const result = evaluateHandFrame([detectionAt(x - 60, y, UPRIGHT), detectionAt(x + 60, y, UPRIGHT)], FRAME_W, FRAME_H);
		expect(result.code).toBe("HANDS_READY");
		expect(result.hands.every((hand) => hand.insideGuide && hand.aligned)).toBe(true);
	});

	it("reports HANDS_OUTSIDE_GUIDE when one palm leaves the box", () => {
		const { x, y } = insideCentre();
		const box = guideBoxPixels(FRAME_W, FRAME_H);
		const outside = detectionAt(x, box.minY - 40, UPRIGHT);
		expect(evaluateHandFrame([detectionAt(x, y, UPRIGHT), outside], FRAME_W, FRAME_H).code).toBe("HANDS_OUTSIDE_GUIDE");
	});

	it("reports HANDS_MISALIGNED when both are in the box but turned away", () => {
		const { x, y } = insideCentre();
		const sideways = HAND_ALIGNMENT_RADIANS.max + 0.5;
		const result = evaluateHandFrame([detectionAt(x - 60, y, sideways), detectionAt(x + 60, y, sideways)], FRAME_W, FRAME_H);
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
		expect(pushHandStatus(window, "NO_HANDS_DETECTED")).toBe("HANDS_READY");
	});

	it("switches once the new code holds the window", () => {
		const window = createHandStatusWindow(STATUS_WINDOW_TICKS);
		for (let i = 0; i < STATUS_WINDOW_TICKS; i++) pushHandStatus(window, "HANDS_READY");
		let reported = window.reported;
		for (let i = 0; i < STATUS_WINDOW_TICKS; i++) reported = pushHandStatus(window, "NO_HANDS_DETECTED");
		expect(reported).toBe("NO_HANDS_DETECTED");
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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMotorExport } from "../../src/TestMotor/motorRecorder";
import { FINGER_EXTENSION_MIN, FINGER_SPREAD_RATIO_MIN } from "../../src/TestMotor/motorConfig";

// Second on-device take, recorded to fit the LOWER bound of the open-hand check: the
// first fixture only covered postures that should pass.
//
// Phases, as performed and reported by the operator. Indices are into the two-hand ticks
// after the leading no-hand samples are dropped, and are part of the fixture's meaning -
// the recording alone cannot say which posture was intended.
const FIXTURE = "palms-forward-fists-and-together.mh4.txt";
const take = parseMotorExport(readFileSync(join(__dirname, "fixtures", FIXTURE), "utf8"));
const ticks = take.samples.filter((sample) => sample.hands.length === 2);

const NATURAL = [...ticks.slice(0, 10), ...ticks.slice(29, 34)];
const FINGERS_TOGETHER = ticks.slice(10, 20);
const FISTS = ticks.slice(20, 29);

function spread(hand: { minFingerExtension: number; minFingerSeparation: number }): number {
	return hand.minFingerSeparation / hand.minFingerExtension;
}

function isOpen(hand: { minFingerExtension: number; minFingerSeparation: number }): boolean {
	return hand.minFingerExtension >= FINGER_EXTENSION_MIN && spread(hand) >= FINGER_SPREAD_RATIO_MIN;
}

describe(`replay: ${FIXTURE}`, () => {
	it("is an MH4 take with the phases it claims", () => {
		expect(take.version).toBe("MH4");
		expect(ticks.length).toBe(62);
		expect(NATURAL.length).toBe(15);
		expect(FINGERS_TOGETHER.length).toBe(10);
		expect(FISTS.length).toBe(9);
	});

	it("accepts every relaxed hand with the fingers apart", () => {
		expect(NATURAL.flatMap((tick) => tick.hands).filter((hand) => !isOpen(hand))).toEqual([]);
	});

	it("rejects every closed fist", () => {
		expect(FISTS.flatMap((tick) => tick.hands).filter(isOpen)).toEqual([]);
	});

	it("rejects fingers held together, which the 0.12 separation threshold accepted", () => {
		// The regression this fixture exists for: extension is HIGH in this phase (straight
		// fingers, 0.68-0.75), so only separation can tell it from a good hand.
		expect(FINGERS_TOGETHER.flatMap((tick) => tick.hands).filter(isOpen)).toEqual([]);
		expect(Math.min(...FINGERS_TOGETHER.flatMap((tick) => tick.hands.map((hand) => hand.minFingerExtension)))).toBeGreaterThan(
			FINGER_EXTENSION_MIN
		);
	});

	it("separates fists from relaxed hands on extension alone, with room to spare", () => {
		const worstNatural = Math.min(...NATURAL.flatMap((tick) => tick.hands.map((hand) => hand.minFingerExtension)));
		const bestFist = Math.max(...FISTS.flatMap((tick) => tick.hands.map((hand) => hand.minFingerExtension)));
		expect(bestFist).toBeLessThan(FINGER_EXTENSION_MIN);
		expect(worstNatural).toBeGreaterThan(FINGER_EXTENSION_MIN);
		// 0.45 sits between 0.35 and 0.60 - the margin the first fixture could not measure.
		expect(worstNatural - bestFist).toBeGreaterThan(0.2);
	});

	it("separates fingers-together from relaxed on spread, which the raw gap could not", () => {
		const worstNatural = Math.min(...NATURAL.flatMap((tick) => tick.hands.map(spread)));
		const bestTogether = Math.max(...FINGERS_TOGETHER.flatMap((tick) => tick.hands.map(spread)));
		expect(bestTogether).toBeLessThan(FINGER_SPREAD_RATIO_MIN);
		expect(worstNatural).toBeGreaterThan(FINGER_SPREAD_RATIO_MIN);

		// Asserts the ratio is materially better than the raw fingertip gap on the same
		// hands, not merely different. Across BOTH committed takes the raw gap shrinks to
		// 0.005 - see the cross-take assertion in motorReplay.test.ts - so a future change
		// that narrows this back toward the raw gap's margin is a regression.
		const rawGap =
			Math.min(...NATURAL.flatMap((tick) => tick.hands.map((hand) => hand.minFingerSeparation))) -
			Math.max(...FINGERS_TOGETHER.flatMap((tick) => tick.hands.map((hand) => hand.minFingerSeparation)));
		expect(worstNatural - bestTogether).toBeGreaterThan(2 * rawGap);
	});

	it("has no inter-hand gap recorded, which is why the overlap phase went unflagged", () => {
		// The take ends with the hands moved together until fingers overlapped, and every
		// one of those ticks read HANDS_READY. MH4 carries no measure that could have
		// caught it; HANDS_TOO_CLOSE and the MH5 gap field exist because of this take.
		expect(ticks.every((tick) => tick.handGap === null)).toBe(true);
		expect(ticks.slice(-10).every((tick) => tick.code === "HANDS_READY" || tick.code === "RIGHT_HAND_NOT_UPRIGHT")).toBe(true);
	});
});

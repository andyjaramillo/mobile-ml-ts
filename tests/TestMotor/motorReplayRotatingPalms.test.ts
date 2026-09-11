import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMotorExport } from "../../src/TestMotor/motorRecorder";
import {
	FINGER_EXTENSION_MIN,
	FINGER_SPREAD_RATIO_MIN,
	PALM_FACING_MIN_SCORE,
} from "../../src/TestMotor/motorConfig";

// Third on-device take: both palms rotate slowly inward from correct to edge-on, then
// back. Recorded because the flow produced the WRONG instruction on the way round - the
// patient was told to spread fingers that were already spread.
const FIXTURE = "palms-rotating-inward.mh5.txt";
const take = parseMotorExport(readFileSync(join(__dirname, "fixtures", FIXTURE), "utf8"));
const hands = take.samples.flatMap((sample) => sample.hands);

function spread(hand: { minFingerExtension: number; minFingerSeparation: number }): number {
	return hand.minFingerSeparation / hand.minFingerExtension;
}

describe(`replay: ${FIXTURE}`, () => {
	it("is an MH5 take carrying the inter-hand gap", () => {
		expect(take.version).toBe("MH5");
		expect(hands.length).toBe(92);
		expect(take.samples.some((sample) => sample.handGap !== null)).toBe(true);
	});

	it("tells the patient to turn their palm before it tells them to spread their fingers", () => {
		// THE invariant this fixture exists for. Rotating a palm away foreshortens the
		// fingers, so spread collapses on its own - if any hand can fail spread while still
		// counting as facing, the patient gets told to fix something that is not wrong.
		const misleading = hands.filter(
			(hand) => spread(hand) < FINGER_SPREAD_RATIO_MIN && hand.palmFacingScore >= PALM_FACING_MIN_SCORE
		);
		expect(misleading).toEqual([]);
	});

	it("still lets a fist with a forward palm report as closed, not turned away", () => {
		// The ordering above must not swallow the genuine case: extension, unlike spread,
		// is not an artefact of rotation, so a fist held palm-out is still "open your hand".
		const fistFacingForward = hands.filter(
			(hand) => hand.minFingerExtension < FINGER_EXTENSION_MIN && hand.palmFacingScore >= PALM_FACING_MIN_SCORE
		);
		expect(fistFacingForward.length).toBeGreaterThan(0);
	});

	it("accepts the hands that were square to the camera", () => {
		const squareOn = hands.filter((hand) => hand.palmFacingScore >= PALM_FACING_MIN_SCORE);
		expect(squareOn.length).toBeGreaterThan(30);
		// Every one of them also passes spread, so raising the facing threshold did not
		// simply move the false warning somewhere else.
		expect(squareOn.filter((hand) => spread(hand) < FINGER_SPREAD_RATIO_MIN)).toEqual([]);
	});

	it("catches the rotation far earlier than the old threshold did", () => {
		// At 0.15 the warning arrived only once the hands were nearly edge-on. Counting the
		// hands that are now caught but would not have been is the size of the fix.
		const caughtNow = hands.filter((hand) => hand.palmFacingScore < PALM_FACING_MIN_SCORE);
		const caughtBefore = hands.filter((hand) => hand.palmFacingScore < 0.15);
		expect(caughtBefore.length).toBeLessThan(caughtNow.length / 3);
	});

	it("records how little room this threshold has", () => {
		const worstAccepted = Math.min(...hands.filter((hand) => spread(hand) >= FINGER_SPREAD_RATIO_MIN).map((hand) => hand.palmFacingScore));
		const bestRejected = Math.max(...hands.filter((hand) => spread(hand) < FINGER_SPREAD_RATIO_MIN).map((hand) => hand.palmFacingScore));
		expect(bestRejected).toBeLessThan(PALM_FACING_MIN_SCORE);
		expect(worstAccepted).toBeGreaterThanOrEqual(PALM_FACING_MIN_SCORE);
		// Under 0.02 of daylight. Documented so a future edit knows it is moving a knife
		// edge, not picking from a comfortable range.
		expect(worstAccepted - bestRejected).toBeLessThan(0.02);
	});
});

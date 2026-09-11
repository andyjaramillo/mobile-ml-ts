import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMotorExport } from "../../src/TestMotor/motorRecorder";
import {
	FINGER_EXTENSION_MIN,
	FINGER_SEPARATION_MIN,
	PALM_FACING_MIN_SCORE,
} from "../../src/TestMotor/motorConfig";

// Replays a real on-device take against the live thresholds, the way the gait checks are
// calibrated: the recording is the specification, so a threshold change that would start
// rejecting a setup a human already accepted fails here instead of being rediscovered on
// a phone.
//
// The recorded flags are the verdicts the DEVICE reached under the thresholds of the day;
// these assertions deliberately re-derive from the raw geometry instead, which is the
// only reason the take could be used to move a threshold at all.
const FIXTURE = "palms-forward-spread-then-natural.mh4.txt";
const take = parseMotorExport(readFileSync(join(__dirname, "fixtures", FIXTURE), "utf8"));
const twoHandSamples = take.samples.filter((sample) => sample.hands.length === 2);
const hands = twoHandSamples.flatMap((sample) => sample.hands);

describe(`replay: ${FIXTURE}`, () => {
	it("is the take it claims to be", () => {
		// Palms forward, alternating spread and relaxed, both hands in the box throughout.
		expect(take.backend).toBe("mediapipe-gpu");
		expect(twoHandSamples.length).toBe(46);
		expect(hands.length).toBe(92);
	});

	it("accepts every hand as open - spread AND relaxed", () => {
		// The operator's call on this take: both postures are correct setups.
		const rejected = hands.filter(
			(hand) => hand.minFingerExtension < FINGER_EXTENSION_MIN || hand.minFingerSeparation < FINGER_SEPARATION_MIN
		);
		expect(rejected).toEqual([]);
	});

	it("keeps real margin under the extension threshold rather than scraping past it", () => {
		const worst = Math.min(...hands.map((hand) => hand.minFingerExtension));
		expect(worst).toBeGreaterThan(FINGER_EXTENSION_MIN);
		// Guards against a future edit that "fixes" a false rejection by moving the
		// threshold to exactly the worst observed value, which would leave none.
		expect(worst - FINGER_EXTENSION_MIN).toBeGreaterThan(0.05);
	});

	it("reads every palm as facing the camera, with the sign the right way round", () => {
		// This take is the evidence that palmFacingScore's sign is correct: palms were
		// toward the camera throughout, and every score is positive by a wide margin.
		expect(Math.min(...hands.map((hand) => hand.palmFacingScore))).toBeGreaterThan(PALM_FACING_MIN_SCORE);
	});

	it("has both hands in the guide, in frame and upright throughout", () => {
		// Nothing but openness should have been failing, which is what made this take a
		// clean read on the extension threshold.
		expect(hands.every((hand) => hand.insideGuide)).toBe(true);
		expect(hands.every((hand) => hand.fullyInFrame)).toBe(true);
		expect(hands.every((hand) => hand.upright)).toBe(true);
	});

	it("records one hand per side on every tick", () => {
		for (const sample of twoHandSamples) {
			expect(new Set(sample.hands.map((hand) => hand.side)).size).toBe(2);
		}
	});

	it("shows the systematic handedness disagreement that SWAP_MEDIAPIPE_HANDEDNESS was set from", () => {
		// Recorded with the flag true. Every hand disagreeing - not some, and both hands on
		// the same tick - is what distinguishes a wrong constant from crossed hands.
		expect(hands.every((hand) => !hand.sidesAgree)).toBe(true);
	});

	it("ran fast enough on the device to leave the preview alone", () => {
		expect(take.inferenceMs).toBeLessThan(66);
		expect(take.tickHz).toBeGreaterThan(10);
	});
});

import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/CaptureQuality/captureQualityConfig";
import { CAPTURE_QUALITY_GUIDANCE_MESSAGES, pickGuidanceMessage } from "../../src/CaptureQualityHud/captureQualityGuidance";
import type { CaptureQualityIssueCode } from "../../src/CaptureQuality/types";
import type { MarkerBoardWindowAggregate } from "../../src/CaptureQuality/markerBoardCheck";
import type { LowLightWindowAggregate } from "../../src/CaptureQuality/lowLightCheck";
import type { SubjectPositionWindowAggregate } from "../../src/CaptureQuality/subjectPositionCheck";

function markerAggregate(activeCodes: CaptureQualityIssueCode[], weightedNormalizedArea: number | null = null): MarkerBoardWindowAggregate {
	return {
		frameCount: 10,
		weightedFullSetScore: activeCodes.length === 0 ? 1 : 0,
		weightedNormalizedArea,
		weightedDiagonalRatio: null,
		weightedOrientationAngleRad: null,
		weightedDetectedMarkerAreaNorm: null,
		latest: null,
		activeCodes,
	};
}

function lightAggregate(activeCodes: CaptureQualityIssueCode[]): LowLightWindowAggregate {
	return {
		frameCount: 10,
		weightedMeanLuma: null,
		weightedDarkCellFraction: null,
		weightedMeanContrastStd: null,
		weightedFlatCellFraction: null,
		latest: null,
		latestRoi: null,
		latestRoiSource: null,
		activeCodes,
	};
}

const CLEAN_LIGHT = lightAggregate([]);

describe("pickGuidanceMessage", () => {
	it("returns PENDING before the marker-board check has ever run", () => {
		const selection = pickGuidanceMessage(null, null);
		expect(selection.code).toBe("PENDING");
		expect(selection.message).toBe(CAPTURE_QUALITY_GUIDANCE_MESSAGES.PENDING);
	});

	it("returns OK when both aggregates are clean", () => {
		const selection = pickGuidanceMessage(markerAggregate([]), CLEAN_LIGHT);
		expect(selection.code).toBe("OK");
		expect(selection.message).toBe(CAPTURE_QUALITY_GUIDANCE_MESSAGES.OK);
	});

	it("prioritizes a blocking marker-board code over a clean lighting check", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_INCOMPLETE"]), CLEAN_LIGHT);
		expect(selection.code).toBe("MARKER_INCOMPLETE");
		expect(selection.message).toBe("Move closer to the floor marker so the whole board is visible.");
	});

	it("MARKER_TOO_CLOSE resolves to a step-back instruction", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_TOO_CLOSE"]), CLEAN_LIGHT);
		expect(selection.message).toBe("Step back so the whole floor marker fits in view.");
	});

	it("MARKER_OBSTRUCTED resolves to a covering-object instruction", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_OBSTRUCTED"]), CLEAN_LIGHT);
		expect(selection.message).toBe("Make sure nothing is covering the floor marker.");
	});

	it("a blocking marker-board code outranks an active lighting issue", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_INCOMPLETE"]), lightAggregate(["LOW_LIGHT"]));
		expect(selection.code).toBe("MARKER_INCOMPLETE");
	});

	it("an active lighting issue outranks the MARKER_TOO_SMALL nudge", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_TOO_SMALL"]), lightAggregate(["LOW_LIGHT"]));
		expect(selection.code).toBe("LOW_LIGHT");
	});

	it("MARKER_TOO_SMALL surfaces once the board is otherwise clean", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_TOO_SMALL"]), CLEAN_LIGHT);
		expect(selection.code).toBe("MARKER_TOO_SMALL");
		expect(selection.message).toBe("Move a little closer to the floor marker.");
	});

	it("MARKER_TOO_LARGE surfaces once the board is otherwise clean, same priority tier as MARKER_TOO_SMALL", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_TOO_LARGE"]), CLEAN_LIGHT);
		expect(selection.code).toBe("MARKER_TOO_LARGE");
		expect(selection.message).toBe("Step back a little so there's room for the whole walk path in view.");
	});

	it("an active lighting issue outranks the MARKER_TOO_LARGE nudge", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_TOO_LARGE"]), lightAggregate(["LOW_LIGHT"]));
		expect(selection.code).toBe("LOW_LIGHT");
	});

	it("returns IDEAL when weightedNormalizedArea sits inside the ideal band and nothing else is active", () => {
		const idealArea = (DEFAULTS.markerBoard.sizeIdealLowerNorm + DEFAULTS.markerBoard.sizeIdealUpperNorm) / 2;
		const selection = pickGuidanceMessage(markerAggregate([], idealArea), CLEAN_LIGHT);
		expect(selection.code).toBe("IDEAL");
		expect(selection.message).toBe(CAPTURE_QUALITY_GUIDANCE_MESSAGES.IDEAL);
	});

	it("returns plain OK, not IDEAL, when weightedNormalizedArea sits in the acceptable-but-not-ideal band", () => {
		// Between sizeWarnLowerNorm (0.0014) and sizeIdealLowerNorm (0.0018) - clean at the
		// check layer (no active code), but not within the ideal band the HUD confirms.
		const acceptableArea = DEFAULTS.markerBoard.sizeWarnLowerNorm + 0.0001;
		const selection = pickGuidanceMessage(markerAggregate([], acceptableArea), CLEAN_LIGHT);
		expect(selection.code).toBe("OK");
		expect(selection.message).toBe(CAPTURE_QUALITY_GUIDANCE_MESSAGES.OK);
	});

	it("returns OK, not IDEAL, when no area reading is available yet even though there are no active codes", () => {
		const selection = pickGuidanceMessage(markerAggregate([], null), CLEAN_LIGHT);
		expect(selection.code).toBe("OK");
	});

	it("respects a custom markerBoardThresholds ideal band (per-assessment override support)", () => {
		const customThresholds = { sizeIdealLowerNorm: 0.01, sizeIdealUpperNorm: 0.02 };
		// 0.002 is inside DEFAULTS' ideal band but outside this custom one.
		const selection = pickGuidanceMessage(markerAggregate([], 0.002), CLEAN_LIGHT, customThresholds);
		expect(selection.code).toBe("OK");
	});

	it("always picks exactly one message, never combines codes", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_WRONG_ORIENTATION"]), lightAggregate(["LOW_LIGHT", "LOW_CONTRAST"]));
		expect(typeof selection.message).toBe("string");
		expect(selection.code).toBe("MARKER_WRONG_ORIENTATION");
	});
});

function subjectAggregate(activeCodes: CaptureQualityIssueCode[]): SubjectPositionWindowAggregate {
	return {
		frameCount: 10,
		detectionFrameCount: 10,
		weightedDetectionScore: 1,
		weightedMultiPersonScore: 0,
		weightedSubjectAreaNorm: 0.16,
		weightedSpeedBoardLengthsPerSec: null,
		subjectAreaCv: null,
		weightedStartLineDistanceBoardLengths: null,
		latest: null,
		activeCodes,
	};
}

describe("subject codes in the guidance banner", () => {
	it("surfaces MULTIPLE_PEOPLE", () => {
		const selection = pickGuidanceMessage(markerAggregate([]), null, DEFAULTS.markerBoard, subjectAggregate(["MULTIPLE_PEOPLE"]));
		expect(selection.code).toBe("MULTIPLE_PEOPLE");
		expect(selection.message).toBe(CAPTURE_QUALITY_GUIDANCE_MESSAGES.MULTIPLE_PEOPLE);
	});

	it("surfaces SUBJECT_NOT_AT_START_LINE", () => {
		const selection = pickGuidanceMessage(markerAggregate([]), null, DEFAULTS.markerBoard, subjectAggregate(["SUBJECT_NOT_AT_START_LINE"]));
		expect(selection.code).toBe("SUBJECT_NOT_AT_START_LINE");
	});

	it("keeps an unresolvable board ahead of any subject advice", () => {
		// Telling someone where to stand is useless while the camera cannot resolve the board.
		const selection = pickGuidanceMessage(
			markerAggregate(["MARKER_INCOMPLETE"]),
			null,
			DEFAULTS.markerBoard,
			subjectAggregate(["SUBJECT_NOT_AT_START_LINE"])
		);
		expect(selection.code).toBe("MARKER_INCOMPLETE");
	});

	it("gives the green light when board, lighting and subject are all clean", () => {
		const selection = pickGuidanceMessage(markerAggregate([], 0.0025), null, DEFAULTS.markerBoard, subjectAggregate([]));
		expect(selection.code).toBe("IDEAL");
	});

	it("behaves exactly as before when the subject aggregate is absent - fail open", () => {
		// The person model failing to load must not change the banner at all.
		const withNull = pickGuidanceMessage(markerAggregate([], 0.0025), null, DEFAULTS.markerBoard, null);
		const omitted = pickGuidanceMessage(markerAggregate([], 0.0025), null, DEFAULTS.markerBoard);
		expect(withNull).toEqual(omitted);
		expect(withNull.code).toBe("IDEAL");
	});
});

describe("a momentary board blip must not mask a sustained subject problem", () => {
	// The bug this pins: ranking ANY blocking marker code above the subject meant a single
	// bad frame out of 47 won the banner, and SUBJECT_NOT_AT_START_LINE was never seen on a
	// phone even though the check was firing correctly the whole time.
	function boardVisibleButBlipping(code: CaptureQualityIssueCode): MarkerBoardWindowAggregate {
		const aggregate = markerAggregate([code], 0.0025);
		// Smoothed visibility says the board IS resolvable - the code is a transient.
		return { ...aggregate, weightedFullSetScore: 0.95 };
	}

	it("shows the subject message when the board's smoothed score says it is resolvable", () => {
		const selection = pickGuidanceMessage(
			boardVisibleButBlipping("MARKER_OBSTRUCTED"),
			null,
			DEFAULTS.markerBoard,
			subjectAggregate(["SUBJECT_NOT_AT_START_LINE"])
		);
		expect(selection.code).toBe("SUBJECT_NOT_AT_START_LINE");
	});

	it("still shows the board message when the board is genuinely unresolvable", () => {
		const unresolvable = { ...markerAggregate(["MARKER_INCOMPLETE"], null), weightedFullSetScore: 0.1 };
		const selection = pickGuidanceMessage(
			unresolvable,
			null,
			DEFAULTS.markerBoard,
			subjectAggregate(["SUBJECT_NOT_AT_START_LINE"])
		);
		expect(selection.code).toBe("MARKER_INCOMPLETE");
	});

	it("still shows a transient board code when there is no subject issue to outrank it", () => {
		const selection = pickGuidanceMessage(
			boardVisibleButBlipping("MARKER_OBSTRUCTED"),
			null,
			DEFAULTS.markerBoard,
			subjectAggregate([])
		);
		expect(selection.code).toBe("MARKER_OBSTRUCTED");
	});
});

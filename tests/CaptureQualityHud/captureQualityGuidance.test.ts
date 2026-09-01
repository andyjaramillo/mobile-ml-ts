import { describe, expect, it } from "vitest";
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

function subjectAggregate(activeCodes: CaptureQualityIssueCode[]): SubjectPositionWindowAggregate {
	return {
		frameCount: 10,
		detectionFrameCount: 10,
		weightedDetectionScore: 1,
		weightedMultiPersonScore: 0,
		weightedBoardToSubjectGapNorm: null,
		weightedSubjectAreaNorm: 0.16,
		weightedSpeedBoardLengthsPerSec: null,
		subjectAreaCv: null,
		weightedStartLineDistanceBoardLengths: null,
		latest: null,
		activeCodes,
	};
}

const CLEAN_LIGHT = lightAggregate([]);
const CLEAN_SUBJECT = subjectAggregate([]);

describe("pickGuidanceMessage", () => {
	it("returns PENDING before the marker-board check has ever run", () => {
		const selection = pickGuidanceMessage(null, null);
		expect(selection.code).toBe("PENDING");
		expect(selection.message).toBe(CAPTURE_QUALITY_GUIDANCE_MESSAGES.PENDING);
	});

	it("returns READY when board, lighting and subject are all clean", () => {
		const selection = pickGuidanceMessage(markerAggregate([]), CLEAN_LIGHT, CLEAN_SUBJECT);
		expect(selection.code).toBe("READY");
		expect(selection.message).toBe(CAPTURE_QUALITY_GUIDANCE_MESSAGES.READY);
	});

	it("MARKER_TOO_CLOSE resolves to a step-back instruction", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_TOO_CLOSE"]), CLEAN_LIGHT);
		expect(selection.message).toBe("Step back so the whole floor marker fits in view.");
	});

	it("MARKER_OBSTRUCTED resolves to a covering-object instruction", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_OBSTRUCTED"]), CLEAN_LIGHT);
		expect(selection.message).toBe("Make sure nothing is covering the floor marker.");
	});

	it("always picks exactly one message, never combines codes", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_WRONG_ORIENTATION"]), lightAggregate(["LOW_LIGHT", "LOW_CONTRAST"]));
		expect(typeof selection.message).toBe("string");
		expect(selection.code).toBe("MARKER_WRONG_ORIENTATION");
	});
});

describe("priority order: board, then lighting, then subject", () => {
	it("a blocking marker-board code outranks an active lighting issue", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_INCOMPLETE"]), lightAggregate(["LOW_LIGHT"]));
		expect(selection.code).toBe("MARKER_INCOMPLETE");
	});

	it("the size/alignment nudges also outrank lighting - they are board work too", () => {
		for (const code of ["MARKER_TOO_SMALL", "MARKER_TOO_LARGE", "MARKER_NOT_ALIGNED"] as const) {
			const selection = pickGuidanceMessage(markerAggregate([code]), lightAggregate(["LOW_LIGHT"]));
			expect(selection.code).toBe(code);
		}
	});

	it("GLARE outranks the board - it is what causes the marker dropout under it", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_OBSTRUCTED"]), lightAggregate(["GLARE"]), CLEAN_SUBJECT);
		expect(selection.code).toBe("GLARE");
		expect(selection.message).toBe(CAPTURE_QUALITY_GUIDANCE_MESSAGES.GLARE);
	});

	it("the other lighting codes stay below the board", () => {
		const selection = pickGuidanceMessage(markerAggregate(["MARKER_OBSTRUCTED"]), lightAggregate(["LOW_LIGHT"]), CLEAN_SUBJECT);
		expect(selection.code).toBe("MARKER_OBSTRUCTED");
	});

	it("lighting outranks every subject code", () => {
		for (const code of ["MULTIPLE_PEOPLE", "SUBJECT_NOT_AT_START_LINE", "SUBJECT_NOT_DETECTED"] as const) {
			const selection = pickGuidanceMessage(markerAggregate([]), lightAggregate(["LOW_LIGHT"]), subjectAggregate([code]));
			expect(selection.code).toBe("LOW_LIGHT");
		}
	});

	it("a marker code outranks every subject code, blip or not", () => {
		// Deliberate reversal of the earlier ranking (which let a resolvable board lose to the
		// subject): the room is set up with nobody in frame, so subject advice given while the
		// camera still needs moving is advice against a view that is about to change.
		const resolvableButBlipping = { ...markerAggregate(["MARKER_OBSTRUCTED"], 0.0025), weightedFullSetScore: 0.95 };
		const selection = pickGuidanceMessage(resolvableButBlipping, CLEAN_LIGHT, subjectAggregate(["SUBJECT_NOT_AT_START_LINE"]));
		expect(selection.code).toBe("MARKER_OBSTRUCTED");
	});
});

describe("the subject tier, reachable only once the room passes", () => {
	it("reports SETUP_VERIFIED - not a warning - when nobody is in frame yet", () => {
		const selection = pickGuidanceMessage(markerAggregate([]), CLEAN_LIGHT, subjectAggregate(["SUBJECT_NOT_DETECTED"]));
		expect(selection.code).toBe("SETUP_VERIFIED");
		expect(selection.message).toBe(CAPTURE_QUALITY_GUIDANCE_MESSAGES.SETUP_VERIFIED);
	});

	it("surfaces MULTIPLE_PEOPLE", () => {
		const selection = pickGuidanceMessage(markerAggregate([]), CLEAN_LIGHT, subjectAggregate(["MULTIPLE_PEOPLE"]));
		expect(selection.code).toBe("MULTIPLE_PEOPLE");
		expect(selection.message).toBe(CAPTURE_QUALITY_GUIDANCE_MESSAGES.MULTIPLE_PEOPLE);
	});

	it("surfaces SUBJECT_NOT_AT_START_LINE", () => {
		const selection = pickGuidanceMessage(markerAggregate([]), CLEAN_LIGHT, subjectAggregate(["SUBJECT_NOT_AT_START_LINE"]));
		expect(selection.code).toBe("SUBJECT_NOT_AT_START_LINE");
	});

	it("MULTIPLE_PEOPLE wins over a co-active SUBJECT_NOT_DETECTED, matching the check's own order", () => {
		const selection = pickGuidanceMessage(markerAggregate([]), CLEAN_LIGHT, subjectAggregate(["MULTIPLE_PEOPLE", "SUBJECT_NOT_DETECTED"]));
		expect(selection.code).toBe("MULTIPLE_PEOPLE");
	});

	it("goes straight to READY when the subject aggregate is absent - fail open", () => {
		// The person model failing to load must never hold back the green light.
		const withNull = pickGuidanceMessage(markerAggregate([], 0.0025), CLEAN_LIGHT, null);
		const omitted = pickGuidanceMessage(markerAggregate([], 0.0025), CLEAN_LIGHT);
		expect(withNull).toEqual(omitted);
		expect(withNull.code).toBe("READY");
	});
});

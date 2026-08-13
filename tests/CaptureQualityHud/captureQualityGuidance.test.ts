import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/CaptureQuality/captureQualityConfig";
import { CAPTURE_QUALITY_GUIDANCE_MESSAGES, pickGuidanceMessage } from "../../src/CaptureQualityHud/captureQualityGuidance";
import type { CaptureQualityIssueCode } from "../../src/CaptureQuality/types";
import type { MarkerBoardWindowAggregate } from "../../src/CaptureQuality/markerBoardCheck";
import type { LowLightWindowAggregate } from "../../src/CaptureQuality/lowLightCheck";

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

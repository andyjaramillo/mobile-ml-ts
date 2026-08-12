import { describe, expect, it } from "vitest";
import { CAPTURE_QUALITY_ISSUE_CODES, captureQualityI18nKey } from "../../src/CaptureQuality/types";

describe("captureQualityI18nKey", () => {
	it("maps every issue code to a key prefixed with MobileAssessment.CaptureQuality.", () => {
		for (const code of CAPTURE_QUALITY_ISSUE_CODES) {
			expect(captureQualityI18nKey(code)).toBe(`MobileAssessment.CaptureQuality.${code}`);
		}
	});

	it("maps every issue code to a distinct key", () => {
		const keys = CAPTURE_QUALITY_ISSUE_CODES.map(captureQualityI18nKey);
		expect(new Set(keys).size).toBe(CAPTURE_QUALITY_ISSUE_CODES.length);
	});
});

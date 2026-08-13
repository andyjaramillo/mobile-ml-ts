import { describe, expect, it } from "vitest";
import { ASSESSMENT_CONFIG_OVERRIDES, DEFAULTS, resolveCaptureQualityConfig } from "../../src/CaptureQuality/captureQualityConfig";

describe("resolveCaptureQualityConfig", () => {
	it("returns DEFAULTS for an assessment key with no override entry", () => {
		const config = resolveCaptureQualityConfig("Unknown Assessment Key");
		expect(config).toEqual(DEFAULTS);
	});

	it("applies a per-assessment override on top of DEFAULTS", () => {
		const config = resolveCaptureQualityConfig("TUG (home)");
		expect(config.duration).toEqual({ minimumDurationSec: 5.0, maximumDurationSec: 60 });
	});

	it("merges an override per-category without dropping sibling keys in that category", () => {
		// "Sit-to-Stand: 30s (clinic)" only overrides duration, not the other categories.
		const config = resolveCaptureQualityConfig("Sit-to-Stand: 30s (clinic)");
		expect(config.markerBoard).toEqual(DEFAULTS.markerBoard);
		expect(config.subjectPosition).toEqual(DEFAULTS.subjectPosition);
		expect(config.multiPerson).toEqual(DEFAULTS.multiPerson);
		expect(config.lighting).toEqual(DEFAULTS.lighting);
		expect(config.sampling).toEqual(DEFAULTS.sampling);
		expect(config.duration).toEqual({ minimumDurationSec: 25.0, maximumDurationSec: 40 });
	});

	it("does not mutate DEFAULTS when resolving an override", () => {
		const before = JSON.parse(JSON.stringify(DEFAULTS));
		resolveCaptureQualityConfig("TUG (home)");
		expect(DEFAULTS).toEqual(before);
	});

	it("merging a partial category override keeps that category's other DEFAULTS keys", () => {
		const testKey = "__test_partial_override__";
		(ASSESSMENT_CONFIG_OVERRIDES as Record<string, unknown>)[testKey] = {
			duration: { minimumDurationSec: 42 },
		};
		try {
			const config = resolveCaptureQualityConfig(testKey);
			expect(config.duration.minimumDurationSec).toBe(42);
			expect(config.duration.maximumDurationSec).toBe(DEFAULTS.duration.maximumDurationSec);
		} finally {
			delete (ASSESSMENT_CONFIG_OVERRIDES as Record<string, unknown>)[testKey];
		}
	});
});

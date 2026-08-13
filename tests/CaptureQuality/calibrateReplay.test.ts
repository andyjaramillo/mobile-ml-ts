import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/CaptureQuality/captureQualityConfig";
import { CAPTURE_QUALITY_ISSUE_CODES } from "../../src/CaptureQuality/types";
import { defaultMarkerBoardCheckConfig } from "../../src/CaptureQuality/markerBoardCheck";
import { parseCompactExportFile } from "../../scripts/calibrate/parse";
import { replayRecording } from "../../scripts/calibrate/replay";
import { computeDropoutStats, summarize } from "../../scripts/calibrate/stats";
import { buildCombos, evaluateCombo } from "../../scripts/calibrate/sweep";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures/sample-recording.cq1.txt");

// Asserts the offline replay pipeline (parse -> reconstruct metrics -> real
// aggregateMarkerBoardMetrics -> stats) produces sane structured output end to end.
// Not asserting specific threshold recommendations - that is what calibration is for.
describe("calibrate pipeline against the committed CQ1 fixture", () => {
	const text = readFileSync(FIXTURE_PATH, "utf8");
	const recordings = parseCompactExportFile(FIXTURE_PATH, text);

	it("parses both recordings in the fixture with the declared sample counts", () => {
		expect(recordings).toHaveLength(2);
		expect(recordings[0].scenarioTag).toBe("A baseline 3m");
		expect(recordings[0].samples).toHaveLength(30);
		expect(recordings[1].scenarioTag).toBe("B marker4 flicker");
		expect(recordings[1].samples).toHaveLength(34);
	});

	it("decodes non-computable geometry as null rather than a fabricated number", () => {
		const flickerRecording = recordings[1];
		const droppedSample = flickerRecording.samples[0]; // first token in the fixture is the dropped-marker frame
		expect(droppedSample.area).toBeNull();
		expect(droppedSample.diag).toBeNull();
		expect(droppedSample.rot).toBeNull();
	});

	it("replays each recording through the real aggregation code into one step per sample", () => {
		const config = defaultMarkerBoardCheckConfig(DEFAULTS);
		for (const recording of recordings) {
			const steps = replayRecording(recording, config, DEFAULTS.sampling.liveWindowFrameCount);
			expect(steps).toHaveLength(recording.samples.length);
			for (const step of steps) {
				expect(step.timestampMs).toBeGreaterThanOrEqual(0);
				for (const code of step.activeCodes) {
					expect(CAPTURE_QUALITY_ISSUE_CODES).toContain(code);
				}
			}
			// timestamps are reconstructed from index * stride / fps, so they are monotonic non-decreasing
			for (let i = 1; i < steps.length; i++) {
				expect(steps[i].timestampMs).toBeGreaterThanOrEqual(steps[i - 1].timestampMs);
			}
		}
	});

	it("produces distribution and dropout stats with sane shapes", () => {
		const baseline = recordings[0];
		const areaValues = baseline.samples
			.filter((s) => s.area !== null)
			.map((s) => (s.area as number) / 10 ** baseline.scaleExponents[0]);
		const stats = summarize(areaValues);
		expect(stats).not.toBeNull();
		expect(stats!.count).toBe(areaValues.length);
		expect(stats!.min).toBeLessThanOrEqual(stats!.median);
		expect(stats!.median).toBeLessThanOrEqual(stats!.max);

		const dropout = computeDropoutStats(recordings[1].samples, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(dropout).toHaveLength(9);
		const marker4 = dropout.find((d) => d.markerId === 4);
		expect(marker4).toBeDefined();
		expect(marker4!.missingCount).toBeGreaterThan(0);
		expect(marker4!.longestMissingRun).toBeGreaterThanOrEqual(1);
	});

	it("runs a small parameter sweep end to end without throwing", () => {
		const combos = buildCombos({
			liveWindowRecencyWeight: [0.5],
			sizeWarnLowerNorm: [0.001, 0.005],
			diagonalRatioMin: [0.1],
			diagonalRatioMax: [0.6],
			orientationMarginRad: [0.3],
			minimumFullSetWeight: [0.5],
			tooCloseDetectedAreaNorm: [null],
		});
		expect(combos.length).toBe(2);
		for (const combo of combos) {
			const result = evaluateCombo(combo, recordings, DEFAULTS.sampling.liveWindowFrameCount);
			expect(result.perFile).toHaveLength(2);
			for (const fileResult of result.perFile) {
				expect(fileResult.stepCount).toBeGreaterThan(0);
				expect(fileResult.flapCount).toBeGreaterThanOrEqual(0);
			}
		}
	});
});

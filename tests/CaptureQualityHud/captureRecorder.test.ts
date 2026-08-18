import { describe, expect, it } from "vitest";
import {
	buildCompactExport,
	createCaptureRecorderState,
	MAX_EXPORT_CHARS,
	recordCaptureFrame,
	startCaptureRecording,
} from "../../src/CaptureQualityHud/captureRecorder";
import type { CaptureRecorderFrameInput } from "../../src/CaptureQualityHud/captureRecorder";
import { parseCompactExportFile } from "../../scripts/calibrate/parse";
import type { MarkerBoardFrameMetrics } from "../../src/CaptureQuality/markerBoardCheck";
import type { LowLightFrameMetrics, LowLightRoiSource } from "../../src/CaptureQuality/lowLightCheck";
import type { SubjectPositionFrameMetrics } from "../../src/CaptureQuality/subjectPositionCheck";

function markerMetrics(i: number): MarkerBoardFrameMetrics {
	return {
		timestampMs: i,
		visibleCount: 9,
		visibleIds: [0, 1, 2, 3, 4, 5, 6, 7, 8],
		isFullSet: true,
		normalizedArea: 0.003 + i * 0.00001,
		diagonalRatio: 0.24,
		orientationAngleRad: 0.15,
		geometryOk: true,
		orientationOk: true,
		detectedMarkerAreaNorm: 0.003 + i * 0.00001,
	};
}

// 16 cells (4x4, matching LIGHTING_GRID) with real variation so summarizeCellValues has
// something to summarize.
function lightingMetrics(baseLuma: number): LowLightFrameMetrics {
	const cellMeans = Array.from({ length: 16 }, (_, i) => baseLuma + i);
	const cellContrasts = Array.from({ length: 16 }, (_, i) => 20 + i);
	return {
		cellCount: 16,
		computableCellCount: 16,
		meanLuma: baseLuma + 7.5,
		darkCellFraction: 0,
		meanContrastStd: 27.5,
		flatCellFraction: 0,
		cellMeans,
		cellContrasts,
	};
}

// Subject centred in a 640-wide frame, board 100px across.
function subjectMetrics(i: number): SubjectPositionFrameMetrics {
	return {
		timestampMs: i,
		personCount: 1,
		subjectBBox: { x: 290, y: 500, width: 60, height: 160 },
		subjectCentroid: { x: 320, y: 580 },
		subjectAreaNorm: 0.0132,
		boardCentroid: { x: 320, y: 700 },
		boardLengthPx: 100,
		startLineDistanceBoardLengths: 1.2,
	};
}

function frameInput(i: number, roiSource: LowLightRoiSource): CaptureRecorderFrameInput {
	return {
		fps: 30,
		frameWidth: 640,
		frameHeight: 1138,
		metrics: markerMetrics(i),
		lighting: {
			metrics: lightingMetrics(140),
			roi: { xNorm: 0.2, yNorm: 0.5, widthNorm: 0.6, heightNorm: 0.4 },
			roiSource,
		},
	};
}

describe("CQ4 export format", () => {
	it("round-trips marker + ROI-scoped lighting data through the parser", () => {
		const state = createCaptureRecorderState();
		state.scenarioTag = "cq4 round trip";
		startCaptureRecording(state, 0);
		for (let i = 0; i < 120; i++) {
			recordCaptureFrame(state, frameInput(i, i % 3 === 0 ? "detected" : i % 3 === 1 ? "last-known" : "default"));
		}

		const exported = buildCompactExport(state);
		expect(exported.startsWith("CQ4|")).toBe(true);
		expect(exported.length).toBeLessThanOrEqual(MAX_EXPORT_CHARS);

		const [recording] = parseCompactExportFile("test", exported);
		expect(recording.formatVersion).toBe(4);
		expect(recording.lightingScope).toBe("roi");
		expect(recording.samples.length).toBe(state.samples.length);
		expect(recording.lightingSamples.length).toBe(state.lightingSamples.length);
		expect(recording.lightingSamples.length).toBeGreaterThan(0);

		for (let i = 0; i < recording.lightingSamples.length; i++) {
			const parsed = recording.lightingSamples[i];
			const original = state.lightingSamples[i];
			expect(parsed.roi).not.toBeNull();
			expect(parsed.roiSource).toBe(original.roiSource);
			// ROI_SCALE_EXP=3 (1000ths) - allow the same quantization tolerance the format itself uses.
			expect(parsed.roi!.xNorm).toBeCloseTo(original.roi.xNorm, 3);
			expect(parsed.roi!.yNorm).toBeCloseTo(original.roi.yNorm, 3);
			expect(parsed.roi!.widthNorm).toBeCloseTo(original.roi.widthNorm, 3);
			expect(parsed.roi!.heightNorm).toBeCloseTo(original.roi.heightNorm, 3);
		}
	});

	it("round-trips person samples, keeping their real tick indices", () => {
		const state = createCaptureRecorderState();
		state.scenarioTag = "cq4 person round trip";
		startCaptureRecording(state, 0);
		// A 1-in-3 round robin: only every third tick carries subject metrics.
		for (let i = 0; i < 60; i++) {
			recordCaptureFrame(state, { ...frameInput(i, "detected"), subject: i % 3 === 0 ? subjectMetrics(i) : null });
		}

		const [recording] = parseCompactExportFile("test", buildCompactExport(state));
		expect(recording.personSamples).toBeDefined();
		expect(recording.personSamples!.length).toBe(20);

		// The gaps are what prove a skipped tick was not stored as a zero-person frame.
		const ticks = recording.personSamples!.map((s) => s.tickIndex);
		expect(ticks[1] - ticks[0]).toBe(3);

		const first = recording.personSamples![0];
		expect(first.personCount).toBe(1);
		expect(first.subjectCentroidXNorm).toBeCloseTo(0.5, 4);
		expect(first.boardLengthNorm).toBeCloseTo(100 / 640, 4);
	});

	it("stores no person samples at all for a recording where detection never ran", () => {
		const state = createCaptureRecorderState();
		state.scenarioTag = "cq4 no detector";
		startCaptureRecording(state, 0);
		for (let i = 0; i < 30; i++) recordCaptureFrame(state, frameInput(i, "detected"));

		const [recording] = parseCompactExportFile("test", buildCompactExport(state));
		expect(recording.personSamples).toEqual([]);
	});

	it("stays comfortably under the byte budget at a realistic full-length recording", () => {
		const state = createCaptureRecorderState();
		state.scenarioTag = "long recording byte budget check";
		startCaptureRecording(state, 0);
		// 300 marker ticks (MAX_SAMPLES) x 10 = enough ticks to also max out MAX_LIGHTING_SAMPLES.
		for (let i = 0; i < 400; i++) {
			recordCaptureFrame(state, frameInput(i, "detected"));
		}
		const exported = buildCompactExport(state);
		expect(exported.startsWith("CQ4|")).toBe(true);
		expect(exported.length).toBeLessThanOrEqual(MAX_EXPORT_CHARS);
	});
});

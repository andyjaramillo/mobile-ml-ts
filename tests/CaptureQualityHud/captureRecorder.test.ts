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

describe("CQ3 export format", () => {
	it("round-trips marker + ROI-scoped lighting data through the parser", () => {
		const state = createCaptureRecorderState();
		state.scenarioTag = "cq3 round trip";
		startCaptureRecording(state, 0);
		for (let i = 0; i < 120; i++) {
			recordCaptureFrame(state, frameInput(i, i % 3 === 0 ? "detected" : i % 3 === 1 ? "last-known" : "default"));
		}

		const exported = buildCompactExport(state);
		expect(exported.startsWith("CQ3|")).toBe(true);
		expect(exported.length).toBeLessThanOrEqual(MAX_EXPORT_CHARS);

		const [recording] = parseCompactExportFile("test", exported);
		expect(recording.formatVersion).toBe(3);
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

	it("stays comfortably under the byte budget at a realistic full-length recording", () => {
		const state = createCaptureRecorderState();
		state.scenarioTag = "long recording byte budget check";
		startCaptureRecording(state, 0);
		// 300 marker ticks (MAX_SAMPLES) x 10 = enough ticks to also max out MAX_LIGHTING_SAMPLES.
		for (let i = 0; i < 400; i++) {
			recordCaptureFrame(state, frameInput(i, "detected"));
		}
		const exported = buildCompactExport(state);
		expect(exported.startsWith("CQ3|")).toBe(true);
		expect(exported.length).toBeLessThanOrEqual(MAX_EXPORT_CHARS);
	});
});

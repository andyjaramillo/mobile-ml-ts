import { describe, expect, it } from "vitest";
import {
	buildCompactExport,
	clearMotorRecording,
	createMotorRecorderState,
	recordMotorTick,
	startMotorRecording,
	stopMotorRecording,
	MAX_EXPORT_CHARS,
} from "../../src/TestMotor/motorRecorder";
import type { MotorRecorderSample } from "../../src/TestMotor/motorRecorder";
import type { EvaluatedHand } from "../../src/TestMotor/handStatus";

function hand(overrides: Partial<EvaluatedHand> = {}): EvaluatedHand {
	return {
		x: 400,
		y: 300,
		bbox: [370, 270, 430, 330],
		landmarks: [],
		score: 0.9,
		radians: -Math.PI / 2,
		insideGuide: true,
		aligned: true,
		...overrides,
	};
}

function sample(overrides: Partial<MotorRecorderSample> = {}): MotorRecorderSample {
	return {
		maxScore: 0.92,
		aboveThresholdCount: 5,
		groupedCount: 2,
		code: "HANDS_READY",
		hands: [hand(), hand({ x: 500 })],
		frameWidth: 800,
		frameHeight: 450,
		inferenceMs: 40,
		tickHz: 15,
		...overrides,
	};
}

describe("motorRecorder", () => {
	it("records nothing until started", () => {
		const state = createMotorRecorderState();
		recordMotorTick(state, sample());
		expect(state.samples.length).toBe(0);
	});

	it("records ticks once started and stops on stop", () => {
		const state = createMotorRecorderState();
		startMotorRecording(state, 0);
		recordMotorTick(state, sample());
		recordMotorTick(state, sample());
		stopMotorRecording(state);
		recordMotorTick(state, sample());
		expect(state.samples.length).toBe(2);
	});

	it("halves the buffer and doubles the stride instead of dropping the start of a take", () => {
		const state = createMotorRecorderState();
		startMotorRecording(state, 0);
		for (let i = 0; i < 700; i++) recordMotorTick(state, sample({ maxScore: i / 1000 }));
		expect(state.samples.length).toBeLessThanOrEqual(300);
		expect(state.stride).toBeGreaterThan(1);
		// The first sample of the take survives the halving.
		expect(state.samples[0].maxScore).toBe(0);
	});

	it("encodes the max score, counts and hands in the export", () => {
		const state = createMotorRecorderState();
		state.scenarioTag = "hands in box";
		state.backend = "wasm";
		state.scoreThreshold = 0.65;
		startMotorRecording(state, 0);
		recordMotorTick(state, sample());

		const line = buildCompactExport(state);
		expect(line.startsWith("MH1|hands in box|n=1|")).toBe(true);
		expect(line).toContain("be=wasm");
		expect(line).toContain("thr=650");
		expect(line).toContain("res=800x450");
		// maxScore 0.92 -> 920, 5 over threshold, 2 grouped, HANDS_READY is index 5.
		expect(line).toContain("920:5:2:5:");
		// Two hands, flags 3 (inside + aligned), score 90.
		expect(line).toContain("500,667,-90,3,90/");
	});

	it("records a zero-hand tick without an empty trailing field per hand", () => {
		const state = createMotorRecorderState();
		startMotorRecording(state, 0);
		recordMotorTick(state, sample({ hands: [], groupedCount: 0, aboveThresholdCount: 0, maxScore: 0.02, code: "NO_HANDS_DETECTED" }));
		expect(buildCompactExport(state)).toContain("20:0:0:0:");
	});

	it("stays inside the paste budget", () => {
		const state = createMotorRecorderState();
		startMotorRecording(state, 0);
		for (let i = 0; i < 2000; i++) recordMotorTick(state, sample());
		expect(buildCompactExport(state).length).toBeLessThanOrEqual(MAX_EXPORT_CHARS);
	});

	it("clears back to an empty take", () => {
		const state = createMotorRecorderState();
		startMotorRecording(state, 0);
		recordMotorTick(state, sample());
		clearMotorRecording(state);
		expect(state.samples.length).toBe(0);
		expect(state.recording).toBe(false);
		expect(state.stride).toBe(1);
	});
});

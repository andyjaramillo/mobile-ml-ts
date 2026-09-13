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
		side: "left",
		handednessSide: "left",
		sidesAgree: true,
		x: 400,
		y: 300,
		landmarks: [],
		pointingRadians: -Math.PI / 2,
		palmFacingScore: 0.42,
		minFingerExtension: 0.96,
		minFingerSeparation: 0.34,
		fingerSpreadRatio: 0.354,
		thumbOutScore: 0.71,
		insideGuide: true,
		fullyInFrame: true,
		palmFacing: true,
		open: true,
		thumbClear: true,
		upright: true,
		...overrides,
	};
}

function sample(overrides: Partial<MotorRecorderSample> = {}): MotorRecorderSample {
	return {
		code: "HANDS_READY",
		hands: [hand(), hand({ x: 500, side: "right", handednessSide: "right" })],
		handGap: 0.62,
		frameWidth: 800,
		frameHeight: 450,
		inferenceMs: 12,
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
		for (let i = 0; i < 700; i++) recordMotorTick(state, sample({ tickHz: i }));
		expect(state.samples.length).toBeLessThanOrEqual(300);
		expect(state.stride).toBeGreaterThan(1);
		// The first sample of the take survives the halving.
		expect(state.samples[0].tickHz).toBe(0);
	});

	it("encodes the verdict and the raw geometry behind it", () => {
		const state = createMotorRecorderState();
		state.scenarioTag = "hands in box";
		state.backend = "mediapipe-gpu";
		startMotorRecording(state, 0);
		recordMotorTick(state, sample());

		const line = buildCompactExport(state);
		expect(line.startsWith("MH6|hands in box|n=1|")).toBe(true);
		expect(line).toContain("be=mediapipe-gpu");
		expect(line).toContain("res=800x450");

		// A line carries its own legend, so the index is read against this list rather than
		// against whatever the code happens to export today.
		const codes = line.split("|").find((part) => part.startsWith("codes="))!.slice(6).split(",");
		expect(codes).toContain("HANDS_READY");
		expect(line).toContain(`|${codes.indexOf("HANDS_READY")}:620:`);

		// Left hand: flags 1+2+8+16+32+64+128 = 251. Right hand adds bit2 = 255.
		// Geometry: facing 420, extension 96, separation 340, thumb 710.
		expect(line).toContain("500,667,-90,251,420,96,340,710/625,667,-90,255,420,96,340,710");
	});

	it("records whether MediaPipe handedness agreed, so a wrong swap is visible", () => {
		const state = createMotorRecorderState();
		startMotorRecording(state, 0);
		recordMotorTick(state, sample({ hands: [hand({ sidesAgree: false, handednessSide: "right" })], handGap: null }));
		const encoded = buildCompactExport(state).split("|").pop()!;
		const flags = Number(encoded.split(":")[2].split(",")[3]);
		expect(flags & 64).toBe(0);
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

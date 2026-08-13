import { describe, expect, it } from "vitest";
import {
	createCaptureQualitySessionState,
	resetCaptureQualitySessionForNewTake,
} from "../../src/TestGait/captureQualitySessionState";
import { pushMarkerBoardFrame } from "../../src/CaptureQuality/markerBoardCheck";
import { pushLowLightFrame } from "../../src/CaptureQuality/lowLightCheck";
import type { CaptureQualityFrameSample } from "../../src/CaptureQuality/types";

const FRAME: CaptureQualityFrameSample = {
	imageData: null,
	timestampMs: 0,
	frameWidth: 640,
	frameHeight: 360,
	people: null,
	markers: [],
};

describe("createCaptureQualitySessionState", () => {
	it("starts with empty windows", () => {
		const state = createCaptureQualitySessionState();
		expect(state.markerBoardWindow.frames).toHaveLength(0);
		expect(state.lowLightWindow.frames).toHaveLength(0);
	});
});

describe("resetCaptureQualitySessionForNewTake", () => {
	it("clears frames pushed by a previous trial from both windows", () => {
		const state = createCaptureQualitySessionState();
		pushMarkerBoardFrame(state.markerBoardWindow, FRAME);
		pushMarkerBoardFrame(state.markerBoardWindow, FRAME);
		pushLowLightFrame(state.lowLightWindow, FRAME);

		expect(state.markerBoardWindow.frames.length).toBeGreaterThan(0);
		expect(state.lowLightWindow.frames.length).toBeGreaterThan(0);

		resetCaptureQualitySessionForNewTake(state);

		expect(state.markerBoardWindow.frames).toHaveLength(0);
		expect(state.lowLightWindow.frames).toHaveLength(0);
	});

	it("leaves the window objects usable for the next trial's frames", () => {
		const state = createCaptureQualitySessionState();
		pushMarkerBoardFrame(state.markerBoardWindow, FRAME);
		resetCaptureQualitySessionForNewTake(state);

		pushMarkerBoardFrame(state.markerBoardWindow, FRAME);
		expect(state.markerBoardWindow.frames).toHaveLength(1);
	});
});

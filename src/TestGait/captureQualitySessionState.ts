// [Feature: Test Gait]
//
// Pure, framework-free session bookkeeping for the capture-quality checks running
// inside Test Gait's camera phase. Bundles each check's window + config pair (see
// CaptureQuality/{markerBoardCheck,lowLightCheck}.ts) so the three-trial flow can create
// them once per session and explicitly reset both together at every trial/take boundary,
// rather than relying on a component remount to garbage-collect stale frames. Split from
// its React wrapper (useCaptureQualitySession.ts) the same way captureRecorder.ts (pure)
// is split from RecorderPanel.tsx (React), so the reset behavior is unit-testable without
// rendering anything.
import {
	createMarkerBoardFrameWindow,
	defaultMarkerBoardCheckConfig,
	resetMarkerBoardFrameWindow,
} from "../CaptureQuality/markerBoardCheck";
import type { MarkerBoardCheckConfig, MarkerBoardFrameWindow } from "../CaptureQuality/markerBoardCheck";
import {
	createLowLightFrameWindow,
	defaultLowLightCheckConfig,
	resetLowLightFrameWindow,
} from "../CaptureQuality/lowLightCheck";
import type { LowLightCheckConfig, LowLightFrameWindow } from "../CaptureQuality/lowLightCheck";
import {
	createSubjectPositionFrameWindow,
	defaultSubjectPositionCheckConfig,
	resetSubjectPositionFrameWindow,
} from "../CaptureQuality/subjectPositionCheck";
import type {
	SubjectPositionCheckConfig,
	SubjectPositionFrameWindow,
} from "../CaptureQuality/subjectPositionCheck";
import { DEFAULTS as CAPTURE_QUALITY_DEFAULTS } from "../CaptureQuality/captureQualityConfig";

export interface CaptureQualitySessionState {
	markerBoardWindow: MarkerBoardFrameWindow;
	markerBoardConfig: MarkerBoardCheckConfig;
	lowLightWindow: LowLightFrameWindow;
	lowLightConfig: LowLightCheckConfig;
	subjectPositionWindow: SubjectPositionFrameWindow;
	subjectPositionConfig: SubjectPositionCheckConfig;
}

export function createCaptureQualitySessionState(): CaptureQualitySessionState {
	return {
		markerBoardWindow: createMarkerBoardFrameWindow(CAPTURE_QUALITY_DEFAULTS.sampling.liveWindowFrameCount),
		markerBoardConfig: defaultMarkerBoardCheckConfig(CAPTURE_QUALITY_DEFAULTS),
		lowLightWindow: createLowLightFrameWindow(CAPTURE_QUALITY_DEFAULTS.sampling.liveWindowFrameCount),
		lowLightConfig: defaultLowLightCheckConfig(CAPTURE_QUALITY_DEFAULTS),
		// Sized in TICKS like the others, but person detection only runs on one tick in
		// personDetectEveryNTicks - so this window holds proportionally fewer actual
		// detections than the marker window holds marker samples. It is scaled up to keep a
		// comparable number of DETECTIONS in view; sizing it identically would leave the
		// subject aggregation averaging over ~5 samples.
		subjectPositionWindow: createSubjectPositionFrameWindow(
			CAPTURE_QUALITY_DEFAULTS.sampling.liveWindowFrameCount * CAPTURE_QUALITY_DEFAULTS.sampling.personDetectEveryNTicks
		),
		subjectPositionConfig: defaultSubjectPositionCheckConfig(CAPTURE_QUALITY_DEFAULTS),
	};
}

/**
 * Called at every trial/take boundary (initial entry, rerecord, or advancing to the next
 * trial) — see TestGait.tsx's beginTake. Resets both windows together: a stale
 * marker-board frame from the previous take sitting next to a fresh lighting frame (or
 * vice versa) would let one check "remember" the wrong take even though the other looks
 * clean, which is exactly the bug this pairing exists to prevent.
 */
export function resetCaptureQualitySessionForNewTake(state: CaptureQualitySessionState): void {
	resetMarkerBoardFrameWindow(state.markerBoardWindow);
	resetLowLightFrameWindow(state.lowLightWindow);
	resetSubjectPositionFrameWindow(state.subjectPositionWindow);
}

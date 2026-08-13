// [Feature: Test Gait]
//
// Tunables for the Test Gait harness, mirroring the values Website's FDA gait block
// (SetUpFDAGaitInClinicAssessment / CameraRecordingBlock) actually uses in production,
// so the numbers here are traceable back to a real source rather than invented.

// FDA gait records three trials via addTrialAction (see check_video's
// addTrialAction in FDAGaitInClinicAssessmentJSON.tsx). maxTrials is normally derived
// at runtime from the record's presigned-URL count (MobileViewer.tsx); there is no
// backend here, so it is fixed at the value that assessment is actually configured for.
export const TOTAL_TRIALS = 3;

// CameraRecordingBlock defaults for FDA gait's camera_display block: no autoStopSeconds,
// no preferLandscapeOrientation, no completionMessage — manual stop only, orientation
// unconstrained.
import { DEFAULTS as CAPTURE_QUALITY_DEFAULTS } from "../CaptureQuality/captureQualityConfig";

export const LEAD_IN_COUNTDOWN_FROM = 3;
export const GO_MESSAGE = "Go!";
export const MANUAL_STOP_HINT_DELAY_MS = 3000; // CameraRecording's showManualStopHint effect

// CameraRecording.tsx's resize handler skips recalculation while isRecording ("Skip
// recalculation during recording for maximum performance"). The capture-quality checks
// are equally per-frame-expensive and were specified to run pre-recording only, so this
// mirrors that convention as a named, flippable flag rather than a hardcoded branch.
export const RUN_CAPTURE_QUALITY_CHECKS_WHILE_RECORDING = false;

export const HUD_UPDATE_EVERY_N_FRAMES = 3; // same throttle RealTimeProcessor.tsx uses

// Both mirror RealTimeProcessor.tsx - see the constants there for the reasoning.
export const DETECTOR_INPUT_MAX_W = 1024;
export const DETECT_TICK_INTERVAL_MS = 1000 / CAPTURE_QUALITY_DEFAULTS.sampling.liveTickHz;

// CameraRecording's cameraReadyStabilityTimeoutRef delay after loadedmetadata before
// enabling the record button — avoids a flash of "ready" right as the stream attaches.
export const CAMERA_READY_STABILITY_DELAY_MS = 200;

// [Feature: Test Motor]
//
// Every tunable the motor hand check has, in one place. NOTHING HERE IS CALIBRATED.
// The gait checks earned their numbers by replaying committed recordings (see
// captureQualityConfig.ts); these are carried over from the values hardcoded in
// Website's hand_model.ts, where they were arrived at by eye. Treat them as a starting
// point to iterate against on a phone, not as measured limits.

/**
 * The guide box the patient must put both hands inside, as a fraction of the displayed
 * frame. The SVG guide draws this same rectangle (see MotorTrackingGraphic), so the box
 * the check tests against and the box the patient sees are one rectangle by construction.
 *
 * Website derived this at runtime instead, by reading the SVG's getBoundingClientRect
 * and scaling it by the overlay canvas's internal size. That canvas had no width/height
 * attributes, so it was 300x150 while the detections were in displayed-pixel space - the
 * box and the hands were being compared in two different coordinate systems. Deriving it
 * from a constant removes the DOM round trip and that whole class of bug.
 *
 * WIDENED 2026-09-10 from the source asset's 0.134-0.828 (x=112.5 w=582 in the 839-wide
 * viewBox) to 0.06-0.94, because two hands held at a natural distance apart did not fit.
 *
 * Widening this is NOT free: detectionRegions derives its crops from this box, so a wider
 * box means a larger crop and fewer model-input pixels per hand - at 1620x911 the palm
 * goes from ~58px to ~46px, against ~22px for the whole-frame framing this replaced.
 * There is a width past which the resolution win is given back entirely.
 */
export const HAND_GUIDE_BOX = {
	x: 0.06,
	y: 239.5 / 520,
	width: 0.88,
	height: 245 / 520,
} as const;

/**
 * Accepted palm orientation, in radians, as returned by handOrientation() - atan2 with y
 * pointing down, so -PI/2 is a palm pointing straight up the frame. The window is
 * carried over from hand_model.ts's `radians < -1.0 && radians > -2.0`, i.e. roughly
 * +/- 29 degrees either side of vertical. UNCALIBRATED.
 */
/**
 * Fraction of extra width each half-crop takes, so a hand on the centre seam is whole in
 * at least one of them.
 */
export const REGION_OVERLAP = 0.12;

export const HAND_ALIGNMENT_RADIANS = { min: -2.0, max: -1.0 } as const;

/** Motor is a selfie assessment: the preview is mirrored, so display x is flipped. */
export const MIRROR_PREVIEW = true;

export const REQUIRED_HAND_COUNT = 2;

/**
 * Status smoothing. Website ran the check on a buffer sized to fps/2 and required 70% of
 * it to disagree before it acted; the same shape is kept here, as ticks rather than
 * frames, so the banner cannot flicker on a single dropped detection.
 */
export const STATUS_WINDOW_TICKS = 8;
export const STATUS_HOLD_RATIO = 0.7;

/** Detector cadence. Website alternated frames (~15Hz on a 30fps preview); this is explicit. */
export const DETECT_TICK_INTERVAL_MS = 1000 / 15;

/** Re-rendering the HUD every tick is wasted work - the status is smoothed anyway. */
export const HUD_UPDATE_EVERY_N_TICKS = 3;

/**
 * The checks are per-frame expensive and recording must never wait on one. Same
 * convention (and same reason) as testGaitConfig's identically named flag.
 */
export const RUN_CHECKS_WHILE_RECORDING = false;

/** CameraRecording's stability delay after loadedmetadata before enabling record. */
export const CAMERA_READY_STABILITY_DELAY_MS = 200;

export const LEAD_IN_COUNTDOWN_FROM = 3;
export const GO_MESSAGE = "Go!";

/**
 * The three takes of Motor: Hand (home), in order, from
 * HandTrackingAtHomeAssessmentJSON.tsx. One recording each, no repeat trials.
 */
export const MOTOR_TESTS = [
	{ id: "finger-tap", label: "Finger Tap", instruction: "Tap your index finger and thumb together as quickly as you can." },
	{ id: "hand-open-close", label: "Hand Open/Close", instruction: "Open and close both hands as quickly as you can." },
	{ id: "pronation-supination", label: "Pronation/Supination", instruction: "Turn both hands palm up and palm down as quickly as you can." },
] as const;

export type MotorTest = typeof MOTOR_TESTS[number];

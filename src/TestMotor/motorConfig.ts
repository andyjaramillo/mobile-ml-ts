// [Feature: Test Motor]
//
// Every tunable the motor hand check has, in one place. NOTHING HERE IS CALIBRATED.
// The gait checks earned their numbers by replaying committed recordings (see
// captureQualityConfig.ts); these are either carried over from values hardcoded in
// Website's hand_model.ts, where they were arrived at by eye, or first guesses at
// geometry the palm detector could not measure at all. Treat them as a starting point to
// iterate against on a phone, not as measured limits - the recorder exports the raw
// value behind every one of them.

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
 * The half-crop framing that used to derive from this box is gone with the palm detector:
 * HandLandmarker tracks each hand and re-crops around it internally, so widening the box
 * no longer costs detector resolution.
 */
export const HAND_GUIDE_BOX = {
	x: 0.06,
	y: 239.5 / 520,
	width: 0.88,
	height: 245 / 520,
} as const;

/**
 * How far inside the frame edge every one of a hand's 21 landmarks must sit to count as
 * fully in view, as a fraction of the frame. Small and positive rather than zero:
 * landmarks are estimated, not observed, at the boundary, and a hand touching the edge is
 * about to be clipped anyway. UNCALIBRATED.
 */
export const FRAME_EDGE_MARGIN = 0.01;

/**
 * Accepted pointing direction, in radians (atan2, y down), measured wrist -> middle
 * knuckle. -PI/2 is straight up. Carried over from the palm detector's
 * `radians < -1.0 && radians > -2.0`, roughly +/- 29 degrees either side of vertical, but
 * now measured on a real hand axis rather than from one palm landmark. UNCALIBRATED.
 */
export const HAND_ALIGNMENT_RADIANS = { min: -2.0, max: -1.0 } as const;

/**
 * palmFacingScore above this counts as the palm facing the camera. The score passes
 * through zero as a hand turns edge-on, so the band between +/- this value is "cannot
 * tell" and is deliberately treated as not-facing: telling a patient to turn a hand that
 * is already correct is a cheaper mistake than passing one that is not.
 *
 * UNCALIBRATED, and the number here most likely to be wrong - its sign folds MediaPipe's
 * handedness together with a mirrored preview. The recorder exports the raw score per
 * hand so it can be fitted from a palms-in / palms-out pair.
 */
export const PALM_FACING_MIN_SCORE = 0.15;

/**
 * Minimum knuckle-to-tip distance, in palm-size units, for every finger. Below this a
 * finger is curled. UNCALIBRATED.
 */
export const FINGER_EXTENSION_MIN = 0.75;

/**
 * Minimum gap between neighbouring fingertips, in palm-size units. Below this the fingers
 * are pressed together or overlapping. UNCALIBRATED.
 */
export const FINGER_SEPARATION_MIN = 0.12;

/**
 * MediaPipe documents handedness as assuming a MIRRORED (selfie-flipped) input image. The
 * detector is fed the raw sensor frame, so the label it returns is the opposite of the
 * patient's actual hand and has to be swapped.
 *
 * Asserted from the documentation, not measured, and getting it backwards silently swaps
 * every left/right instruction - so the check derives the side independently from which
 * half of the guide the hand is in, uses THAT, and records whether the two agree.
 */
export const SWAP_MEDIAPIPE_HANDEDNESS = true;

/** Motor is a selfie assessment: the preview is mirrored, so display x is flipped. */
export const MIRROR_PREVIEW = true;

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

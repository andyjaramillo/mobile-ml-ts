// [Feature: Test Motor]
//
// Every tunable the motor hand check has, in one place. Each is marked FITTED (against a
// committed recording) or UNCALIBRATED (a guess). Most are still guesses.
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
 * through zero as a hand turns edge-on, so a threshold near zero is a band of "cannot
 * tell" rather than a hard flip.
 *
 * FITTED from tests/TestMotor/fixtures/palms-rotating-inward.mh5.txt (2026-09-11), a take
 * that rotates both palms slowly inward from correct to edge-on. Hands the operator
 * accepted as facing forward scored 0.468-0.621; the first hands to go wrong under
 * rotation scored at most 0.455. 0.46 is wedged between the two.
 *
 * The previous value of 0.15 produced the WRONG INSTRUCTION rather than no instruction.
 * Rotating a palm away foreshortens the fingers, which collapses fingerSpreadRatio long
 * before the facing score reaches 0.15, so a patient turning their hands was told to
 * spread their fingers - which they had already done. Palm facing is checked before
 * openness for exactly this reason; the check only works if the threshold fires first.
 *
 * The window between the two classes is 0.013 wide, by far the tightest here, because the
 * take rotates through the boundary continuously and there is no gap to sit in. Roughly,
 * the score is the full-face value scaled by the cosine of the rotation, so 0.46 against a
 * ~0.62 full-face reading is about 45 degrees off square. If this proves brittle across
 * different hands, the robust form is a per-person full-face reference taken while the
 * patient is already reading HANDS_READY, not a tighter absolute number.
 */
export const PALM_FACING_MIN_SCORE = 0.46;

/**
 * Minimum knuckle-to-tip distance, in palm-size units, for every finger.
 *
 * FITTED from tests/TestMotor/fixtures/palms-forward-spread-then-natural.mh4.txt
 * (2026-09-10, 46 two-hand ticks, palms forward, alternating spread and relaxed). Spread
 * fingers measured 0.73-0.84 and a relaxed hand with the fingers still apart measured
 * 0.52-0.69; both are acceptable setups, so the boundary sits below 0.52. At the original
 * guess of 0.75 this rejected 43 of 92 hands in that take, all of them correct.
 *
 * The UPPER side is calibrated, the LOWER side is not: no recording of a closed fist or
 * of fingers pressed flat together exists yet, so how much room is left before those
 * start passing is unmeasured. Do not lower this further without one.
 */
export const FINGER_EXTENSION_MIN = 0.45;

/**
 * Minimum finger spread, as the fingertip-gap / finger-length ratio - roughly the angle
 * in radians that adjacent fingers open out by. 0.35 is about 20 degrees.
 *
 * FITTED across both committed takes. Relaxed hands with the fingers apart measured
 * 0.385-0.603; fingers deliberately held together measured 0.257-0.328. 0.35 sits in the
 * gap, nearer the rejecting side so a borderline hand is accepted rather than nagged.
 *
 * This replaced a raw fingertip-gap threshold, which could not be made to work: on the
 * same data those two classes were 0.005 apart, so any threshold separating them was
 * within noise of misclassifying both. See fingerSpreadRatio for why dividing helps.
 */
export const FINGER_SPREAD_RATIO_MIN = 0.35;

/**
 * Minimum horizontal gap between the two hands' landmark bounds, in palm-size units.
 *
 * DEFINITIONAL rather than fitted: zero is the point where the boxes touch, so anything
 * below it means the hands' landmarks genuinely overlap. Nothing to tune unless it turns
 * out to be too strict for hands held legitimately close, which a recording would show -
 * the measure is exported per tick for exactly that reason.
 */
export const HAND_GAP_MIN = 0;

/**
 * MediaPipe documents handedness as assuming a MIRRORED (selfie-flipped) input image, and
 * the detector is fed the raw sensor frame - which reads as "swap the label".
 *
 * MEASURED FALSE. In the 2026-09-10 take every one of 92 hands disagreed with the side
 * derived from the guide half, on both hands at once - a systematic inversion, not a
 * patient crossing their hands. So MediaPipe's raw label already matches the patient's
 * actual hand here, most likely because the front-facing stream arrives already mirrored.
 *
 * This flag only drives the cross-check: the side the patient is told about comes from
 * the guide half, which is what they can see and act on. That is why the disagreement was
 * visible in the data instead of silently swapping every left/right instruction.
 */
export const SWAP_MEDIAPIPE_HANDEDNESS = false;

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

// [Feature: Test Motor]
//
// Pure geometry over one hand's 21 landmarks. No React, no MediaPipe types - it takes
// plain points, so every threshold below is testable without a camera or a model.
//
// All input is expected in DISPLAY space (mirrored already, if the preview is). Angles
// and signed areas both flip under a mirror, so doing the flip once at the boundary and
// working in one space afterwards is the only way to keep this straight - the earlier
// palm-detector code got this wrong in two different places.

/** MediaPipe hand landmark indices, named where this module uses them. */
export const LM = {
	wrist: 0,
	thumbCmc: 1,
	thumbTip: 4,
	indexMcp: 5,
	indexTip: 8,
	middleMcp: 9,
	middleTip: 12,
	ringMcp: 13,
	ringTip: 16,
	pinkyMcp: 17,
	pinkyTip: 20,
} as const;

export const LANDMARK_COUNT = 21;

export interface Point2D {
	x: number;
	y: number;
}

function distance(a: Point2D, b: Point2D): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Wrist to middle-finger knuckle. Used as the scale reference for every other measure
 * here, so a hand close to the camera and one further away produce the same numbers.
 */
export function palmSize(landmarks: readonly Point2D[]): number {
	return distance(landmarks[LM.wrist], landmarks[LM.middleMcp]);
}

/**
 * Direction the hand points, in radians (atan2, y down), measured wrist -> middle
 * knuckle. -PI/2 is straight up the frame.
 */
export function pointingRadians(landmarks: readonly Point2D[]): number {
	const wrist = landmarks[LM.wrist];
	const middle = landmarks[LM.middleMcp];
	return Math.atan2(middle.y - wrist.y, middle.x - wrist.x);
}

/**
 * Signed area of the palm triangle (wrist, index knuckle, pinky knuckle), normalised by
 * palm size so it is scale-free. Its SIGN flips when a hand turns over, which is the
 * only 2D signal that separates a palm from the back of a hand.
 *
 * The sign also flips between a left and a right hand, so a caller must combine this
 * with handedness before deciding anything - see palmFacingScore.
 */
export function palmSignedArea(landmarks: readonly Point2D[]): number {
	const wrist = landmarks[LM.wrist];
	const index = landmarks[LM.indexMcp];
	const pinky = landmarks[LM.pinkyMcp];
	const size = palmSize(landmarks);
	if (size === 0) return 0;
	const cross = (index.x - wrist.x) * (pinky.y - wrist.y) - (index.y - wrist.y) * (pinky.x - wrist.x);
	return cross / (size * size);
}

/**
 * Positive when the palm faces the camera, negative when the back of the hand does.
 * Folds handedness into palmSignedArea's sign so callers get one comparable number for
 * either hand.
 *
 * The magnitude falls toward zero as the hand turns edge-on, so it doubles as a
 * confidence: a hand seen exactly side-on is neither, and a threshold near zero is
 * deliberately a band of "cannot tell" rather than a hard flip.
 */
export function palmFacingScore(landmarks: readonly Point2D[], isRightHand: boolean): number {
	return palmSignedArea(landmarks) * (isRightHand ? 1 : -1);
}

const FINGER_SPANS: ReadonlyArray<readonly [number, number]> = [
	[LM.thumbCmc, LM.thumbTip],
	[LM.indexMcp, LM.indexTip],
	[LM.middleMcp, LM.middleTip],
	[LM.ringMcp, LM.ringTip],
	[LM.pinkyMcp, LM.pinkyTip],
];

/**
 * Smallest knuckle-to-tip distance across the five fingers, in palm-size units. A curled
 * finger folds its tip back toward its own knuckle, so the minimum drops sharply - one
 * bent finger is enough to fail, which is the intent.
 */
export function minFingerExtension(landmarks: readonly Point2D[]): number {
	const size = palmSize(landmarks);
	if (size === 0) return 0;
	return Math.min(...FINGER_SPANS.map(([from, to]) => distance(landmarks[from], landmarks[to]) / size));
}

const ADJACENT_TIPS: ReadonlyArray<readonly [number, number]> = [
	[LM.indexTip, LM.middleTip],
	[LM.middleTip, LM.ringTip],
	[LM.ringTip, LM.pinkyTip],
];

/**
 * Smallest gap between neighbouring fingertips, in palm-size units. Separates an open
 * hand from fingers held together, and is the signal that fingers are overlapping each
 * other. The thumb is excluded: it sits naturally close to the index finger on an open
 * hand and would dominate the minimum.
 */
export function minFingerSeparation(landmarks: readonly Point2D[]): number {
	const size = palmSize(landmarks);
	if (size === 0) return 0;
	return Math.min(...ADJACENT_TIPS.map(([a, b]) => distance(landmarks[a], landmarks[b]) / size));
}

/**
 * Fingertip gap divided by finger length - approximately the ANGLE, in radians, that
 * adjacent fingers open out by. Two fingers of length L parted by angle t have their tips
 * about L*t apart, so this ratio is t and is independent of both palm size and how far
 * away the hand is.
 *
 * This exists because the raw fingertip gap could not do the job: across the two
 * committed takes, fingers deliberately held together reached 0.234 while relaxed hands
 * with the fingers apart fell to 0.239 - the classes touch. Dividing by extension
 * separates them by 0.057 instead, because holding fingers together also straightens
 * them, which raises the denominator exactly when the numerator falls.
 *
 * Uses the MINIMUM of each measure, so the gap and the length may come from different
 * fingers. Computing a ratio per adjacent pair and taking the minimum of those would be
 * the stricter form; it cannot be fitted against the existing recordings, which carry
 * only the two minima, so it needs a new take before it is worth changing.
 */
export function fingerSpreadRatio(landmarks: readonly Point2D[]): number {
	const extension = minFingerExtension(landmarks);
	if (extension === 0) return 0;
	return minFingerSeparation(landmarks) / extension;
}

export interface HandBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** Tight box over all 21 landmarks - the whole hand, not the palm box the old model gave. */
export function handBounds(landmarks: readonly Point2D[]): HandBounds {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const point of landmarks) {
		if (point.x < minX) minX = point.x;
		if (point.y < minY) minY = point.y;
		if (point.x > maxX) maxX = point.x;
		if (point.y > maxY) maxY = point.y;
	}
	return { minX, minY, maxX, maxY };
}

/**
 * Horizontal gap between two hands' landmark bounds, in palm-size units. Negative when
 * the boxes overlap, which is what interleaved fingers look like.
 *
 * Horizontal only: the assessment puts one hand on each side of the guide, so hands come
 * together sideways. A vertical measure would also fire on one hand held above the other,
 * which is a different posture nobody has asked to reject.
 */
export function boundsGapNorm(a: readonly Point2D[], b: readonly Point2D[]): number {
	const boundsA = handBounds(a);
	const boundsB = handBounds(b);
	const [left, right] = boundsA.minX <= boundsB.minX ? [boundsA, boundsB] : [boundsB, boundsA];
	const scale = (palmSize(a) + palmSize(b)) / 2;
	if (scale === 0) return 0;
	return (right.minX - left.maxX) / scale;
}

/** Palm centre: the centroid of the wrist and the four knuckles. */
export function palmCenter(landmarks: readonly Point2D[]): Point2D {
	const points = [LM.wrist, LM.indexMcp, LM.middleMcp, LM.ringMcp, LM.pinkyMcp].map((i) => landmarks[i]);
	return {
		x: points.reduce((total, point) => total + point.x, 0) / points.length,
		y: points.reduce((total, point) => total + point.y, 0) / points.length,
	};
}

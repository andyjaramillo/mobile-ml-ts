// Synthetic 21-landmark hands for the geometry and status tests.
//
// The canonical hand is reasoned from anatomy rather than copied from a recording: a
// RIGHT hand, palm toward the camera, fingers up, seen in a MIRRORED preview. In that
// view the thumb points to the patient's own left (negative x) and the pinky knuckle
// sits to the right of the wrist. Everything else is derived from it by reflection, so
// a test asserting the palm-facing SIGN is asserting that reasoning, not restating the
// implementation.
import type { Point2D } from "../../src/TestMotor/handGeometry";
import { LM } from "../../src/TestMotor/handGeometry";
import type { LandmarkedHand } from "../../src/TestMotor/handLandmarker";

/** Wrist at the origin, y down, palm size (wrist -> middle knuckle) exactly 100. */
const CANONICAL: Record<number, Point2D> = {
	[LM.wrist]: { x: 0, y: 0 },
	[LM.thumbCmc]: { x: -40, y: -15 },
	[LM.thumbTip]: { x: -110, y: -85 },
	[LM.indexMcp]: { x: -30, y: -95 },
	[LM.indexTip]: { x: -38, y: -190 },
	[LM.middleMcp]: { x: 0, y: -100 },
	[LM.middleTip]: { x: 0, y: -205 },
	[LM.ringMcp]: { x: 25, y: -95 },
	[LM.ringTip]: { x: 32, y: -195 },
	[LM.pinkyMcp]: { x: 48, y: -85 },
	[LM.pinkyTip]: { x: 68, y: -180 },
};

const CHAINS: ReadonlyArray<readonly [number, number, number, number]> = [
	[LM.thumbCmc, 2, 3, LM.thumbTip],
	[LM.indexMcp, 6, 7, LM.indexTip],
	[LM.middleMcp, 10, 11, LM.middleTip],
	[LM.ringMcp, 14, 15, LM.ringTip],
	[LM.pinkyMcp, 18, 19, LM.pinkyTip],
];

function lerp(a: Point2D, b: Point2D, t: number): Point2D {
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export interface HandOptions {
	/** Patient's hand. A left hand is the right hand reflected about the wrist. */
	side?: "left" | "right";
	/** Back of the hand toward the camera - another reflection, which flips the palm sign. */
	palmAway?: boolean;
	/** Fold every fingertip back toward its knuckle. 0 = fully open, 1 = tip on the knuckle. */
	curl?: number;
	/** Pull the fingertips together horizontally. 0 = natural spread, 1 = all tips aligned. */
	pinch?: number;
	/** Rotation in radians applied about the wrist; 0 leaves the hand pointing up. */
	rotation?: number;
	scale?: number;
	at?: Point2D;
}

/** Landmarks in DISPLAY space, which is what evaluateHandFrame works in after mirroring. */
export function handLandmarks(options: HandOptions = {}): Point2D[] {
	const { side = "right", palmAway = false, curl = 0, pinch = 0, rotation = 0, scale = 1, at = { x: 0, y: 0 } } = options;

	const base: Point2D[] = new Array(21);
	for (const [mcp, a, b, tip] of CHAINS) {
		base[mcp] = { ...CANONICAL[mcp] };
		base[tip] = { ...CANONICAL[tip] };
		base[a] = lerp(CANONICAL[mcp], CANONICAL[tip], 1 / 3);
		base[b] = lerp(CANONICAL[mcp], CANONICAL[tip], 2 / 3);
	}
	base[LM.wrist] = { ...CANONICAL[LM.wrist] };

	if (curl > 0) {
		for (const [mcp, , , tip] of CHAINS) {
			base[tip] = lerp(base[tip], base[mcp], curl);
		}
	}
	if (pinch > 0) {
		const middleX = base[LM.middleTip].x;
		for (const tip of [LM.indexTip, LM.ringTip, LM.pinkyTip]) {
			base[tip] = { x: base[tip].x + (middleX - base[tip].x) * pinch, y: base[tip].y };
		}
	}

	// A left hand, and the back of a hand, are each a horizontal reflection. Doing both
	// returns the original silhouette with the opposite palm sign, which is exactly the
	// ambiguity palmFacingScore folds handedness in to resolve.
	const reflections = (side === "left" ? 1 : 0) + (palmAway ? 1 : 0);
	const flip = reflections % 2 === 1 ? -1 : 1;

	const cos = Math.cos(rotation);
	const sin = Math.sin(rotation);
	return base.map((point) => {
		const x = point.x * flip * scale;
		const y = point.y * scale;
		return { x: at.x + x * cos - y * sin, y: at.y + x * sin + y * cos };
	});
}

/**
 * evaluateHandFrame is fed SENSOR-space landmarks and mirrors them itself, so a fixture
 * that wants a hand to land at a given DISPLAY position has to be reflected back first.
 * Reflecting the whole hand (not just translating it) matters: a mirror flips the
 * silhouette, and a fixture that only moved the position would arrive with its palm sign
 * inverted and read as the back of the hand.
 */
export function toSensorSpace(landmarks: readonly Point2D[], frameWidth: number): Point2D[] {
	return landmarks.map((point) => ({ x: frameWidth - point.x, y: point.y }));
}

export function landmarkedHand(
	options: HandOptions & { rawHandedness?: "Left" | "Right"; frameWidth?: number } = {}
): LandmarkedHand {
	const { rawHandedness, frameWidth, ...handOptions } = options;
	const side = handOptions.side ?? "right";
	const display = handLandmarks(handOptions);
	return {
		landmarks: frameWidth === undefined ? display : toSensorSpace(display, frameWidth),
		// MediaPipe is fed an unmirrored frame and documented to assume a mirrored one, so
		// the label it returns is the opposite of the patient's actual hand.
		rawHandedness: rawHandedness ?? (side === "left" ? "Right" : "Left"),
		handednessScore: 0.95,
	};
}

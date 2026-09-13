import { describe, expect, it } from "vitest";
import {
	handBounds,
	minFingerExtension,
	minFingerSeparation,
	palmCenter,
	palmFacingScore,
	palmSignedArea,
	palmSize,
	pointingRadians,
	thumbOutScore,
} from "../../src/TestMotor/handGeometry";
import { handLandmarks } from "./handFixtures";

describe("palmSize", () => {
	it("measures wrist to middle knuckle and scales with the hand", () => {
		expect(palmSize(handLandmarks())).toBeCloseTo(100, 5);
		expect(palmSize(handLandmarks({ scale: 2 }))).toBeCloseTo(200, 5);
	});
});

describe("pointingRadians", () => {
	it("reads -90 degrees for a hand pointing up the frame", () => {
		expect(pointingRadians(handLandmarks())).toBeCloseTo(-Math.PI / 2, 5);
	});

	it("follows a rotation of the hand", () => {
		const rotated = pointingRadians(handLandmarks({ rotation: 0.4 }));
		expect(rotated).toBeCloseTo(-Math.PI / 2 + 0.4, 5);
	});
});

describe("palmFacingScore", () => {
	// The sign convention is the thing most likely to be silently wrong, so these assert
	// it from both hands and both facings rather than from one case.
	it("is positive for either palm facing the camera", () => {
		expect(palmFacingScore(handLandmarks({ side: "right" }), true)).toBeGreaterThan(0);
		expect(palmFacingScore(handLandmarks({ side: "left" }), false)).toBeGreaterThan(0);
	});

	it("is negative when the back of either hand faces the camera", () => {
		expect(palmFacingScore(handLandmarks({ side: "right", palmAway: true }), true)).toBeLessThan(0);
		expect(palmFacingScore(handLandmarks({ side: "left", palmAway: true }), false)).toBeLessThan(0);
	});

	it("has the same magnitude either way, so one threshold serves both hands", () => {
		const right = palmFacingScore(handLandmarks({ side: "right" }), true);
		const left = palmFacingScore(handLandmarks({ side: "left" }), false);
		expect(left).toBeCloseTo(right, 5);
	});

	it("is scale-free, so distance from the camera does not change it", () => {
		const near = palmFacingScore(handLandmarks({ scale: 2 }), true);
		const far = palmFacingScore(handLandmarks({ scale: 0.5 }), true);
		expect(near).toBeCloseTo(far, 5);
	});

	it("is unchanged by rotation, which only pointingRadians should see", () => {
		const upright = palmFacingScore(handLandmarks(), true);
		const tilted = palmFacingScore(handLandmarks({ rotation: 0.8 }), true);
		expect(tilted).toBeCloseTo(upright, 5);
	});

	it("flips sign with palmSignedArea, which knows nothing about handedness", () => {
		expect(palmSignedArea(handLandmarks({ side: "right" }))).toBeGreaterThan(0);
		expect(palmSignedArea(handLandmarks({ side: "left" }))).toBeLessThan(0);
	});
});

describe("minFingerExtension", () => {
	it("is near a palm length for an open hand", () => {
		expect(minFingerExtension(handLandmarks())).toBeGreaterThan(0.9);
	});

	it("collapses toward zero as fingers curl", () => {
		expect(minFingerExtension(handLandmarks({ curl: 0.5 }))).toBeLessThan(0.55);
		expect(minFingerExtension(handLandmarks({ curl: 1 }))).toBeCloseTo(0, 5);
	});

	it("is scale-free", () => {
		expect(minFingerExtension(handLandmarks({ scale: 3 }))).toBeCloseTo(minFingerExtension(handLandmarks()), 5);
	});

	it("fails on a single curled finger, not just a whole fist", () => {
		const oneBent = handLandmarks();
		// Fold only the ring finger back onto its knuckle.
		oneBent[16] = { ...oneBent[13] };
		expect(minFingerExtension(oneBent)).toBeCloseTo(0, 5);
	});
});

describe("minFingerSeparation", () => {
	it("is comfortably positive for a spread hand", () => {
		expect(minFingerSeparation(handLandmarks())).toBeGreaterThan(0.3);
	});

	it("collapses as the fingertips are drawn together", () => {
		expect(minFingerSeparation(handLandmarks({ pinch: 1 }))).toBeLessThan(0.12);
	});

	it("ignores the thumb, which sits close to the index on an open hand", () => {
		const wideThumb = handLandmarks();
		const tightThumb = handLandmarks();
		tightThumb[4] = { ...tightThumb[8] };
		expect(minFingerSeparation(tightThumb)).toBeCloseTo(minFingerSeparation(wideThumb), 5);
	});
});

describe("handBounds and palmCenter", () => {
	it("bounds every landmark, not just the palm", () => {
		const points = handLandmarks();
		const bounds = handBounds(points);
		for (const point of points) {
			expect(point.x).toBeGreaterThanOrEqual(bounds.minX);
			expect(point.x).toBeLessThanOrEqual(bounds.maxX);
			expect(point.y).toBeGreaterThanOrEqual(bounds.minY);
			expect(point.y).toBeLessThanOrEqual(bounds.maxY);
		}
		// The fingertips reach past the palm, which is the whole reason this replaced the
		// palm box for the clipped-hand check.
		expect(bounds.minY).toBeLessThan(-200);
	});

	it("puts the palm centre between the wrist and the knuckles", () => {
		const center = palmCenter(handLandmarks());
		expect(center.y).toBeLessThan(0);
		expect(center.y).toBeGreaterThan(-100);
	});
});

describe("thumbOutScore", () => {
	it("is positive for a thumb held out to the side of either hand", () => {
		expect(thumbOutScore(handLandmarks({ side: "right" }), true)).toBeGreaterThan(0);
		expect(thumbOutScore(handLandmarks({ side: "left" }), false)).toBeGreaterThan(0);
	});

	it("goes negative once the thumb crosses onto the palm", () => {
		expect(thumbOutScore(handLandmarks({ side: "right", thumbTuck: 1 }), true)).toBeLessThan(0);
		expect(thumbOutScore(handLandmarks({ side: "left", thumbTuck: 1 }), false)).toBeLessThan(0);
	});

	it("falls as the thumb folds further in", () => {
		const out = thumbOutScore(handLandmarks(), true);
		const half = thumbOutScore(handLandmarks({ thumbTuck: 0.5 }), true);
		const tucked = thumbOutScore(handLandmarks({ thumbTuck: 1 }), true);
		expect(half).toBeLessThan(out);
		expect(tucked).toBeLessThan(half);
	});

	it("is scale-free and unaffected by rotation", () => {
		expect(thumbOutScore(handLandmarks({ scale: 3 }), true)).toBeCloseTo(thumbOutScore(handLandmarks(), true), 5);
		expect(thumbOutScore(handLandmarks({ rotation: 0.9 }), true)).toBeCloseTo(thumbOutScore(handLandmarks(), true), 5);
	});

	it("is invisible to the measures that already existed, which is why it was needed", () => {
		const open = handLandmarks();
		const tucked = handLandmarks({ thumbTuck: 1 });
		// A tucked thumb keeps its length and is excluded from fingertip separation, so
		// neither of the openness measures moves enough to notice.
		expect(minFingerExtension(tucked)).toBeGreaterThan(0.45);
		expect(minFingerSeparation(tucked)).toBeCloseTo(minFingerSeparation(open), 5);
	});
});

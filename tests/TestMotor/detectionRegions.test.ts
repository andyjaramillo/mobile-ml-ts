import { describe, expect, it } from "vitest";
import { detectionRegions } from "../../src/TestMotor/detectionRegions";
import { HAND_GUIDE_BOX, MIRROR_PREVIEW } from "../../src/TestMotor/motorConfig";

// The frame the 2026-09-10 recording was taken at.
const W = 1620;
const H = 911;

describe("detectionRegions", () => {
	it("returns the whole frame in full mode", () => {
		expect(detectionRegions(W, H, "full")).toEqual([{ sx: 0, sy: 0, sw: W, sh: H }]);
	});

	it("returns two square crops in halves mode", () => {
		const regions = detectionRegions(W, H, "halves");
		expect(regions.length).toBe(2);
		for (const region of regions) {
			expect(region.sw).toBeCloseTo(region.sh, 5);
		}
	});

	it("scales the hand up enough to clear the detector floor", () => {
		const [region] = detectionRegions(W, H, "halves");
		// The whole-frame path scaled by 192/1620 = 0.118; the point of halves is a
		// materially larger hand at the model input, not a marginally larger one.
		//
		// This guard is deliberately tight enough to fail when HAND_GUIDE_BOX is widened:
		// the crops are derived from that box, so every widening spends resolution. It read
		// 2.6x at the box's original 0.694 width and 2.0x after the 2026-09-10 widening to
		// 0.88. If a future widening drops it below this, the halves framing has given back
		// most of what it was introduced to win and needs rethinking, not a lower number.
		const wholeFrameScale = 192 / W;
		const halvesScale = 192 / region.sw;
		expect(halvesScale / wholeFrameScale).toBeGreaterThan(1.9);
	});

	it("keeps both crops inside the frame", () => {
		for (const region of detectionRegions(W, H, "halves")) {
			expect(region.sx).toBeGreaterThanOrEqual(0);
			expect(region.sy).toBeGreaterThanOrEqual(0);
			expect(region.sx + region.sw).toBeLessThanOrEqual(W + 1e-6);
			expect(region.sy + region.sh).toBeLessThanOrEqual(H + 1e-6);
		}
	});

	it("overlaps at the seam so a centred hand is whole in one crop", () => {
		const [left, right] = detectionRegions(W, H, "halves");
		expect(left.sx + left.sw).toBeGreaterThan(right.sx);
	});

	it("covers the guide box, reflected into sensor space", () => {
		const [left, right] = detectionRegions(W, H, "halves");
		const boxSensorX = (MIRROR_PREVIEW ? 1 - (HAND_GUIDE_BOX.x + HAND_GUIDE_BOX.width) : HAND_GUIDE_BOX.x) * W;
		const boxSensorRight = boxSensorX + HAND_GUIDE_BOX.width * W;
		// Each hand sits near the centre of its half; those centres must be covered.
		const leftHandX = boxSensorX + HAND_GUIDE_BOX.width * W * 0.25;
		const rightHandX = boxSensorX + HAND_GUIDE_BOX.width * W * 0.75;
		expect(leftHandX).toBeGreaterThanOrEqual(left.sx);
		expect(leftHandX).toBeLessThanOrEqual(left.sx + left.sw);
		expect(rightHandX).toBeGreaterThanOrEqual(right.sx);
		expect(rightHandX).toBeLessThanOrEqual(right.sx + right.sw);
		expect(boxSensorRight).toBeLessThanOrEqual(W);
	});

	it("never exceeds frame height on a tall crop", () => {
		const regions = detectionRegions(400, 200, "halves");
		for (const region of regions) expect(region.sh).toBeLessThanOrEqual(200);
	});
});

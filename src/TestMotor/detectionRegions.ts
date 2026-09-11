// [Feature: Test Motor]
//
// Chooses which part of the frame to hand the detector.
//
// WHY THIS EXISTS: feeding the whole 16:9 frame to a 192x192 model scales by ~0.12 AND
// wastes 44% of the input on letterbox bars, so a ~190px palm arrives as ~22px - at the
// palm detector's floor. Measured on a real take (2026-09-10, 1620x911): max score
// peaked at 0.81 with a median of 0.54, against 0.047 on a blank input, and only 18 of
// 87 ticks crossed threshold. The hands were correctly LOCATED on the ticks that did
// cross, so this is a resolution problem, not a placement one.
//
// "halves" crops one square per hand from the guide box. The assessment is exactly two
// hands, one per side of a wide, short box, and a square per side is the only framing
// that spends the whole model input on a hand: the guide box's own aspect is ~2.6, so
// letterboxing it whole is worse than the full frame.
import { HAND_GUIDE_BOX, MIRROR_PREVIEW, REGION_OVERLAP } from "./motorConfig";

export type DetectionRegionMode = "halves" | "full";

/** A source rect in the VIDEO's own (unmirrored) pixel space. */
export interface DetectionRegion {
	sx: number;
	sy: number;
	sw: number;
	sh: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * The guide box is authored in DISPLAY space and the preview is mirrored, so the region
 * to crop out of the sensor image is its horizontal reflection. The box is not centred
 * (0.134 to 0.828), so this is a real offset, not a no-op.
 */
function guideBoxSensorNorm(): { x: number; y: number; width: number; height: number } {
	const x = MIRROR_PREVIEW ? 1 - (HAND_GUIDE_BOX.x + HAND_GUIDE_BOX.width) : HAND_GUIDE_BOX.x;
	return { x, y: HAND_GUIDE_BOX.y, width: HAND_GUIDE_BOX.width, height: HAND_GUIDE_BOX.height };
}

export function detectionRegions(
	frameWidth: number,
	frameHeight: number,
	mode: DetectionRegionMode
): DetectionRegion[] {
	if (mode === "full") return [{ sx: 0, sy: 0, sw: frameWidth, sh: frameHeight }];

	const box = guideBoxSensorNorm();
	const centerY = (box.y + box.height / 2) * frameHeight;
	// Overlapping halves so a hand sitting on the seam is whole in at least one crop;
	// duplicates are collapsed by the same distance grouping that already dedupes anchors.
	const size = Math.min((box.width / 2) * (1 + REGION_OVERLAP) * frameWidth, frameHeight);

	return [0, 1].map((half) => {
		const centerX = (box.x + box.width * (0.25 + 0.5 * half)) * frameWidth;
		return {
			sx: clamp(centerX - size / 2, 0, Math.max(0, frameWidth - size)),
			sy: clamp(centerY - size / 2, 0, Math.max(0, frameHeight - size)),
			sw: size,
			sh: size,
		};
	});
}

export function regionModeFromUrl(): DetectionRegionMode {
	if (typeof window === "undefined") return "halves";
	return new URLSearchParams(window.location.search).get("crop") === "full" ? "full" : "halves";
}

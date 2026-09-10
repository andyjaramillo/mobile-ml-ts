// [Feature: Test Motor]
//
// The drawing half of Website's HandModel, split out: boxes, palm landmarks and the
// orientation arrow. Everything it is handed is already in displayed-frame pixel space
// (see EvaluatedHand), so unlike the original it does not rely on a CSS scale(-1,1) on
// the canvas to line up with a mirrored preview - a transform that had to agree with the
// coordinate maths in a second file for either to be right.
import type { EvaluatedHand } from "./handStatus";
import { guideBoxPixels } from "./handStatus";

const OK_COLOR = "#33FF00";
const BAD_COLOR = "#FF3366";

export function drawHandOverlay(
	ctx: CanvasRenderingContext2D,
	hands: readonly EvaluatedHand[],
	frameWidth: number,
	frameHeight: number,
	showGuideBox: boolean
): void {
	ctx.clearRect(0, 0, frameWidth, frameHeight);

	if (showGuideBox) {
		const box = guideBoxPixels(frameWidth, frameHeight);
		ctx.strokeStyle = "rgba(255,255,255,0.35)";
		ctx.lineWidth = 1;
		ctx.setLineDash([6, 6]);
		ctx.strokeRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
		ctx.setLineDash([]);
	}

	const arrowLength = frameWidth * 0.1;

	for (const hand of hands) {
		const color = hand.insideGuide && hand.aligned ? OK_COLOR : BAD_COLOR;
		const [x1, y1, x2, y2] = hand.bbox;

		ctx.strokeStyle = color;
		ctx.lineWidth = 2;
		ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

		ctx.fillStyle = color;
		for (const point of hand.landmarks) {
			ctx.beginPath();
			ctx.arc(point.x, point.y, 3, 0, 2 * Math.PI);
			ctx.fill();
		}

		ctx.beginPath();
		ctx.moveTo(hand.x, hand.y);
		ctx.lineTo(hand.x + arrowLength * Math.cos(hand.radians), hand.y + arrowLength * Math.sin(hand.radians));
		ctx.strokeStyle = color;
		ctx.lineWidth = 5;
		ctx.lineCap = "round";
		ctx.stroke();

		ctx.beginPath();
		ctx.arc(hand.x, hand.y, 5, 0, 2 * Math.PI);
		ctx.fill();
	}
}

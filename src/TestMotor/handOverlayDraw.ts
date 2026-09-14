// [Feature: Test Motor]
//
// Landmarks arrive already in displayed-frame pixel space (see EvaluatedHand), so this
// never relies on a CSS transform to line up with the mirrored preview.
import { LM } from "./handGeometry";
import type { EvaluatedHand } from "./handStatus";
import { guideBoxPixels } from "./handStatus";

const OK_COLOR = "#33FF00";
const BAD_COLOR = "#FF3366";

/** MediaPipe's standard 21-landmark hand topology. */
const CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
	[0, 1], [1, 2], [2, 3], [3, 4],
	[0, 5], [5, 6], [6, 7], [7, 8],
	[5, 9], [9, 10], [10, 11], [11, 12],
	[9, 13], [13, 14], [14, 15], [15, 16],
	[13, 17], [17, 18], [18, 19], [19, 20],
	[0, 17],
];

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

	for (const hand of hands) {
		const ok = hand.insideGuide && hand.fullyInFrame && hand.palmFacing && hand.open && hand.upright;
		const color = ok ? OK_COLOR : BAD_COLOR;
		const points = hand.landmarks;

		ctx.strokeStyle = color;
		ctx.lineWidth = 2;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.beginPath();
		for (const [from, to] of CONNECTIONS) {
			ctx.moveTo(points[from].x, points[from].y);
			ctx.lineTo(points[to].x, points[to].y);
		}
		ctx.stroke();

		ctx.fillStyle = color;
		ctx.font = "bold 14px system-ui, sans-serif";
		ctx.fillText(hand.side, points[LM.wrist].x - 12, points[LM.wrist].y + 20);
	}
}

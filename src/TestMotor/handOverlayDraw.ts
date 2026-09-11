// [Feature: Test Motor]
//
// Draws what the detector actually returned: the hand skeleton, not a box. With 21
// landmarks a box hides the information that matters - a curled finger or a hand turned
// over looks identical inside one - and the skeleton is what makes a wrong threshold
// obvious on the phone rather than only in the recording.
//
// Everything it is handed is already in displayed-frame pixel space (see EvaluatedHand),
// so unlike the palm-detector version it never relies on a CSS transform to line up with
// a mirrored preview.
import { LM } from "./handGeometry";
import type { EvaluatedHand } from "./handStatus";
import { guideBoxPixels } from "./handStatus";

const OK_COLOR = "#33FF00";
const BAD_COLOR = "#FF3366";

/** MediaPipe's standard hand connections: palm arch plus the five digits. */
const CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
	[0, 1], [1, 2], [2, 3], [3, 4],
	[0, 5], [5, 6], [6, 7], [7, 8],
	[5, 9], [9, 10], [10, 11], [11, 12],
	[9, 13], [13, 14], [14, 15], [15, 16],
	[13, 17], [17, 18], [18, 19], [19, 20],
	[0, 17],
];

const FINGERTIPS: readonly number[] = [LM.thumbTip, LM.indexTip, LM.middleTip, LM.ringTip, LM.pinkyTip];

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
		ctx.beginPath();
		for (const [from, to] of CONNECTIONS) {
			ctx.moveTo(points[from].x, points[from].y);
			ctx.lineTo(points[to].x, points[to].y);
		}
		ctx.stroke();

		// Fingertips drawn larger than the other joints: they are what the openness and
		// separation thresholds are measured between.
		ctx.fillStyle = color;
		for (let i = 0; i < points.length; i++) {
			const radius = FINGERTIPS.includes(i) ? 5 : 3;
			ctx.beginPath();
			ctx.arc(points[i].x, points[i].y, radius, 0, 2 * Math.PI);
			ctx.fill();
		}

		ctx.font = "bold 14px system-ui, sans-serif";
		ctx.fillText(hand.side, points[LM.wrist].x - 12, points[LM.wrist].y + 20);
	}
}

// [Feature: Test Motor]
//
// Debug readout for calibrating the hand check: what the detector actually returned this
// tick, next to what the smoothing decided to display. Harness-only.
//
// Every number a threshold is fitted against is shown raw, because the thresholds in
// motorConfig.ts are all UNCALIBRATED - the point of this panel is to replace guesses
// with values read off a phone.
import type { HandFrameEvaluation, MotorIssueCode } from "./handStatus";
import type { HandModelBackend } from "./handModel";
import { HAND_ALIGNMENT_RADIANS } from "./motorConfig";

interface Props {
	evaluation: HandFrameEvaluation | null;
	reported: MotorIssueCode;
	/** Highest anchor score before thresholding - see HandDetectionResult.maxScore. */
	maxScore: number;
	aboveThresholdCount: number;
	scoreThreshold: number;
	regionMode: string;
	backend: HandModelBackend;
	modelReady: boolean;
	tickHz: number;
	inferenceMs: number;
	embedded?: boolean;
}

function degrees(radians: number): string {
	return `${((radians * 180) / Math.PI).toFixed(0)}deg`;
}

function MotorHandHud({ evaluation, reported, maxScore, aboveThresholdCount, scoreThreshold, regionMode, backend, modelReady, tickHz, inferenceMs, embedded = false }: Props) {
	return (
		<div className={embedded ? "mhh-embedded" : "mhh-root"}>
			<style>{CSS}</style>
			<div className="mhh-title">HANDS</div>
			<div className="mhh-row">
				<span>model</span>
				<span>{modelReady ? backend ?? "ready" : "loading"}</span>
			</div>
			<div className="mhh-row">
				<span>crop</span>
				<span>{regionMode}</span>
			</div>
			<div className="mhh-row">
				<span>tick</span>
				<span>{tickHz.toFixed(1)} Hz / infer {inferenceMs.toFixed(0)} ms</span>
			</div>
			<div className="mhh-row mhh-row--strong">
				<span>max score</span>
				<span className={maxScore >= scoreThreshold ? "mhh-ok" : "mhh-bad"}>
					{maxScore.toFixed(3)} / thr {scoreThreshold.toFixed(2)}
				</span>
			</div>
			<div className="mhh-row">
				<span>over thr</span>
				<span>{aboveThresholdCount} anchors</span>
			</div>
			<div className="mhh-row">
				<span>raw</span>
				<span>{evaluation ? evaluation.code : "-"}</span>
			</div>
			<div className="mhh-row mhh-row--strong">
				<span>shown</span>
				<span>{reported}</span>
			</div>
			<div className="mhh-row">
				<span>count</span>
				<span>{evaluation ? evaluation.handCount : "-"}</span>
			</div>
			<div className="mhh-row">
				<span>aligned band</span>
				<span>{degrees(HAND_ALIGNMENT_RADIANS.min)} to {degrees(HAND_ALIGNMENT_RADIANS.max)}</span>
			</div>
			{evaluation?.hands.map((hand, index) => (
				<div className="mhh-hand" key={index}>
					<div className="mhh-row mhh-row--strong">
						<span>{hand.side} hand</span>
						<span>score {hand.score.toFixed(2)}</span>
					</div>
					<div className="mhh-row">
						<span>pos</span>
						<span>{hand.x.toFixed(0)}, {hand.y.toFixed(0)}</span>
					</div>
					<div className="mhh-row">
						<span>angle</span>
						<span className={hand.aligned ? "mhh-ok" : "mhh-bad"}>{degrees(hand.radians)}</span>
					</div>
					<div className="mhh-row">
						<span>in box</span>
						<span className={hand.insideGuide ? "mhh-ok" : "mhh-bad"}>{hand.insideGuide ? "yes" : "no"}</span>
					</div>
					<div className="mhh-row">
						<span>in frame</span>
						<span className={hand.fullyInFrame ? "mhh-ok" : "mhh-bad"}>{hand.fullyInFrame ? "whole" : "clipped"}</span>
					</div>
				</div>
			))}
		</div>
	);
}

const CSS = `
	.mhh-root {
		position: fixed;
		left: 8px;
		bottom: 8px;
		z-index: 60;
		padding: 8px 10px;
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.7);
		color: #eaf4ff;
		font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
		font-size: clamp(10px, 3vw, 13px);
		line-height: 1.45;
		max-width: min(320px, calc(100vw - 16px));
	}
	.mhh-embedded { font-family: inherit; }
	.mhh-title { font-weight: 700; letter-spacing: 0.06em; opacity: 0.75; }
	.mhh-row { display: flex; justify-content: space-between; gap: 12px; }
	.mhh-row--strong { font-weight: 700; }
	.mhh-hand { margin-top: 4px; padding-top: 4px; border-top: 1px dashed rgba(255,255,255,0.18); }
	.mhh-ok { color: #86efac; }
	.mhh-bad { color: #fca5a5; }
`;

export default MotorHandHud;

// [Feature: Test Motor]
//
// Playback of the take just recorded, Rerecord / Continue. Landscape video, unlike
// gait's portrait review.
import { useEffect, useRef } from "react";

interface Props {
	testLabel: string;
	testNumber: number;
	totalTests: number;
	videoUrl: string;
	onRerecord: () => void;
	onContinue: () => void;
}

function TestMotorReview({ testLabel, testNumber, totalTests, videoUrl, onRerecord, onContinue }: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const isLastTest = testNumber >= totalTests;

	useEffect(() => {
		if (videoRef.current) videoRef.current.playsInline = true;
	}, []);

	return (
		<div className="tm-review-root">
			<style>{CSS}</style>
			<h1 className="tm-review-title">Review Your Video</h1>
			<p className="tm-review-trial">
				Test {testNumber} of {totalTests}: {testLabel}
			</p>

			<video ref={videoRef} className="tm-review-video" src={videoUrl} controls playsInline />

			<p className="tm-review-desc">
				Check that both hands stayed in frame for the whole recording and that the movement is clear.
			</p>
			<p className="tm-review-note">Nothing is uploaded - this stays on your device for review only.</p>

			<div className="tm-review-buttons">
				<button type="button" className="tm-btn tm-btn-hollow" onClick={onRerecord}>
					Rerecord
				</button>
				<button type="button" className="tm-btn tm-btn-primary" onClick={onContinue}>
					{isLastTest ? "Finish" : "Continue"}
				</button>
			</div>
		</div>
	);
}

const CSS = `
	.tm-review-root {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		background: #1C2434;
		color: #fff;
		overflow-y: auto;
		box-sizing: border-box;
		padding: max(1rem, env(safe-area-inset-top, 0px)) max(1.25rem, env(safe-area-inset-right, 0px)) max(1rem, env(safe-area-inset-bottom, 0px)) max(1.25rem, env(safe-area-inset-left, 0px));
	}
	.tm-review-title { margin: 0; font-size: 1.3rem; font-weight: 700; text-align: center; }
	.tm-review-trial { margin: 0; font-size: 0.9rem; color: rgba(255,255,255,0.7); text-align: center; }
	.tm-review-video {
		width: min(100%, 34rem);
		max-height: 45svh;
		aspect-ratio: 16 / 9;
		border-radius: 8px;
		background: #000;
		flex-shrink: 0;
	}
	.tm-review-desc { margin: 0; max-width: 28rem; text-align: center; font-size: 0.95rem; line-height: 1.4; color: rgba(255,255,255,0.9); }
	.tm-review-note { margin: 0; max-width: 28rem; text-align: center; font-size: 0.8rem; color: rgba(255,255,255,0.55); }
	.tm-review-buttons {
		margin-top: auto;
		width: 100%;
		max-width: 28rem;
		display: flex;
		gap: 0.5rem;
	}
	.tm-btn {
		flex: 1;
		min-height: 48px;
		border-radius: 999px;
		font-weight: 700;
		font-size: 1rem;
		touch-action: manipulation;
		cursor: pointer;
	}
	.tm-btn-hollow { background: transparent; border: 1px solid #fff; color: #fff; }
	.tm-btn-primary { background: #dc2626; border: none; color: #fff; }
`;

export default TestMotorReview;

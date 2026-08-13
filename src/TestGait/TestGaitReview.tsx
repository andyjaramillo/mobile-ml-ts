// [Feature: Test Gait]
//
// Approximates WebsiteCode/Website's VideoReview.tsx: play back what was just recorded,
// Rerecord / Continue. Drops the presigned-URL prefetch (no backend here) and the
// optional early-finish / "add another trial" choice — this harness always walks all
// three trials in order, matching the task's specified sequence rather than Website's
// more flexible (and more complex) trial-count logic.
import { useEffect, useRef } from "react";

interface Props {
	trialNumber: number;
	totalTrials: number;
	videoUrl: string;
	onRerecord: () => void;
	onContinue: () => void;
}

const REVIEW_DESCRIPTION =
	"Make sure the video is clear and all motions of the patient are recorded. Ensure lighting is proper and no other individuals are in frame.";

function TestGaitReview({ trialNumber, totalTrials, videoUrl, onRerecord, onContinue }: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const isLastTrial = trialNumber >= totalTrials;

	// iOS Safari needs playsInline set as a real DOM property (not just the JSX attr) on
	// some versions to avoid forcing fullscreen playback.
	useEffect(() => {
		if (videoRef.current) videoRef.current.playsInline = true;
	}, []);

	return (
		<div className="tg-review-root">
			<style>{CSS}</style>
			<h1 className="tg-review-title">Review Your Video</h1>
			<p className="tg-review-trial">Trial {trialNumber} of {totalTrials}</p>

			<video ref={videoRef} className="tg-review-video" src={videoUrl} controls playsInline muted={false} />

			<p className="tg-review-desc">{REVIEW_DESCRIPTION}</p>
			<p className="tg-review-note">Nothing is uploaded — this stays on your device for review only.</p>

			<div className="tg-review-buttons">
				<button type="button" className="tg-btn tg-btn-hollow" onClick={onRerecord}>
					Rerecord
				</button>
				<button type="button" className="tg-btn tg-btn-primary" onClick={onContinue}>
					{isLastTrial ? "Finish" : "Continue"}
				</button>
			</div>
		</div>
	);
}

const CSS = `
	.tg-review-root {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		background: #1C2434;
		color: #fff;
		overflow-y: auto;
		box-sizing: border-box;
		padding: max(1.5rem, env(safe-area-inset-top, 0px)) max(1.25rem, env(safe-area-inset-right, 0px)) max(1.5rem, env(safe-area-inset-bottom, 0px)) max(1.25rem, env(safe-area-inset-left, 0px));
	}
	.tg-review-title { margin: 0; font-size: 1.4rem; font-weight: 700; text-align: center; }
	.tg-review-trial { margin: 0; font-size: 0.9rem; color: rgba(255,255,255,0.7); }
	.tg-review-video {
		width: min(56vw, 13rem);
		max-height: min(42svh, 20rem);
		aspect-ratio: 9 / 16;
		border-radius: 8px;
		background: #000;
		flex-shrink: 0;
	}
	.tg-review-desc { margin: 0; max-width: 28rem; text-align: center; font-size: 0.95rem; line-height: 1.4; color: rgba(255,255,255,0.9); }
	.tg-review-note { margin: 0; max-width: 28rem; text-align: center; font-size: 0.8rem; color: rgba(255,255,255,0.55); }
	.tg-review-buttons {
		margin-top: auto;
		width: 100%;
		max-width: 28rem;
		display: flex;
		gap: 0.5rem;
	}
	.tg-btn {
		flex: 1;
		min-height: 48px;
		border-radius: 999px;
		font-weight: 700;
		font-size: 1rem;
		touch-action: manipulation;
		cursor: pointer;
	}
	.tg-btn-hollow { background: transparent; border: 1px solid #fff; color: #fff; }
	.tg-btn-primary { background: #dc2626; border: none; color: #fff; }
`;

export default TestGaitReview;

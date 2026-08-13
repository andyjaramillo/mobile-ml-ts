// [Feature: Test Gait]
//
// Approximates the intent of Website's CameraPermission.tsx (explain what's about to
// happen, then request the camera) without its full platform-guidance/retry-countdown
// state machine — that machinery is about handling denial across browsers gracefully,
// not about the recording flow this harness exists to test. A single request with a
// plain denied/error fallback is enough here.
import { useCallback, useState } from "react";

type ViewState = "idle" | "requesting" | "denied" | "error";

interface Props {
	onGranted: () => void;
}

function TestGaitPermission({ onGranted }: Props) {
	const [viewState, setViewState] = useState<ViewState>("idle");

	const requestPermission = useCallback(async () => {
		setViewState("requesting");
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ video: true });
			// Only probing for permission here — TestGaitCamera acquires its own stream
			// via react-webcam once mounted, same division of labor as Website's
			// CameraPermission (permission screen) vs CameraRecording (actual capture).
			stream.getTracks().forEach((track) => track.stop());
			onGranted();
		} catch (error) {
			const name = (error as DOMException)?.name;
			setViewState(name === "NotAllowedError" || name === "PermissionDeniedError" ? "denied" : "error");
		}
	}, [onGranted]);

	return (
		<div className="tg-permission-root">
			<style>{CSS}</style>
			<div className="tg-permission-card">
				<h1 className="tg-permission-title">Test Gait</h1>
				<p className="tg-permission-body">
					This reproduces the FDA gait recording flow used in the real product: camera
					setup with live capture-quality checks, a lead-in countdown, three recorded
					trials with a review step after each, then a completion screen.
				</p>
				<p className="tg-permission-note">
					Nothing is uploaded. Recordings stay in memory on this device only, and are
					discarded when you close or reload the page.
				</p>

				{viewState === "denied" && (
					<p className="tg-permission-error">
						Camera access was denied. Check your browser's site settings and try again.
					</p>
				)}
				{viewState === "error" && (
					<p className="tg-permission-error">Could not access the camera. Try again.</p>
				)}

				<button
					type="button"
					className="tg-permission-button"
					onClick={requestPermission}
					disabled={viewState === "requesting"}
				>
					{viewState === "requesting" ? "Requesting..." : "Allow Camera & Start"}
				</button>
			</div>
		</div>
	);
}

const CSS = `
	.tg-permission-root {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #1C2434;
		padding: max(1.5rem, env(safe-area-inset-top, 0px)) max(1.5rem, env(safe-area-inset-right, 0px)) max(1.5rem, env(safe-area-inset-bottom, 0px)) max(1.5rem, env(safe-area-inset-left, 0px));
		box-sizing: border-box;
	}
	.tg-permission-card {
		width: min(28rem, 100%);
		display: flex;
		flex-direction: column;
		gap: 1rem;
		color: #fff;
		text-align: center;
	}
	.tg-permission-title { margin: 0; font-size: 1.75rem; font-weight: 700; }
	.tg-permission-body { margin: 0; font-size: 1rem; line-height: 1.5; color: rgba(255,255,255,0.9); }
	.tg-permission-note { margin: 0; font-size: 0.875rem; line-height: 1.4; color: rgba(255,255,255,0.65); }
	.tg-permission-error { margin: 0; font-size: 0.9rem; color: #fca5a5; }
	.tg-permission-button {
		margin-top: 0.5rem;
		min-height: 48px;
		padding: 0 1.5rem;
		border-radius: 999px;
		border: none;
		background: #dc2626;
		color: #fff;
		font-size: 1rem;
		font-weight: 700;
		touch-action: manipulation;
		cursor: pointer;
	}
	.tg-permission-button:disabled { opacity: 0.6; cursor: not-allowed; }
`;

export default TestGaitPermission;

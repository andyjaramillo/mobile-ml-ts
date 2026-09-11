// [Feature: Test Motor]
//
// Same single-request permission probe as TestGaitPermission - the camera itself is
// acquired by TestMotorCamera once mounted.
import { useCallback, useState } from "react";

type ViewState = "idle" | "requesting" | "denied" | "error";

interface Props {
	onGranted: () => void;
}

function TestMotorPermission({ onGranted }: Props) {
	const [viewState, setViewState] = useState<ViewState>("idle");

	const requestPermission = useCallback(async () => {
		setViewState("requesting");
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ video: true });
			stream.getTracks().forEach((track) => track.stop());
			onGranted();
		} catch (error) {
			const name = (error as DOMException)?.name;
			setViewState(name === "NotAllowedError" || name === "PermissionDeniedError" ? "denied" : "error");
		}
	}, [onGranted]);

	return (
		<div className="tm-permission-root">
			<style>{CSS}</style>
			<div className="tm-permission-card">
				<h1 className="tm-permission-title">Test Motor</h1>
				<p className="tm-permission-body">
					Reproduces Motor: Hand (home): three recordings - finger tap, hand open/close,
					pronation/supination - with the live hand-position check running during setup.
					Hold the phone in landscape.
				</p>
				<p className="tm-permission-note">
					Nothing is uploaded. Recordings stay in memory on this device only, and are
					discarded when you close or reload the page.
				</p>

				{viewState === "denied" && (
					<p className="tm-permission-error">
						Camera access was denied. Check your browser's site settings and try again.
					</p>
				)}
				{viewState === "error" && <p className="tm-permission-error">Could not access the camera. Try again.</p>}

				<button
					type="button"
					className="tm-permission-button"
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
	.tm-permission-root {
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
		overflow-y: auto;
	}
	.tm-permission-card {
		width: min(28rem, 100%);
		display: flex;
		flex-direction: column;
		gap: 1rem;
		color: #fff;
		text-align: center;
	}
	.tm-permission-title { margin: 0; font-size: 1.75rem; font-weight: 700; }
	.tm-permission-body { margin: 0; font-size: 1rem; line-height: 1.5; color: rgba(255,255,255,0.9); }
	.tm-permission-note { margin: 0; font-size: 0.875rem; line-height: 1.4; color: rgba(255,255,255,0.65); }
	.tm-permission-error { margin: 0; font-size: 0.9rem; color: #fca5a5; }
	.tm-permission-button {
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
	.tm-permission-button:disabled { opacity: 0.6; cursor: not-allowed; }
`;

export default TestMotorPermission;

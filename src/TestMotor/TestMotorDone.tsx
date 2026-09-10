// [Feature: Test Motor]
//
// Completion screen. No backend here, so this only states that nothing was sent.
interface Props {
	totalTests: number;
	onRestart: () => void;
}

function TestMotorDone({ totalTests, onRestart }: Props) {
	return (
		<div className="tm-done-root">
			<style>{CSS}</style>
			<h1 className="tm-done-title">All {totalTests} Tests Recorded</h1>
			<p className="tm-done-body">
				Nothing was uploaded - no network call was made. This was a local-only test of the
				motor capture flow; all recordings have been discarded from memory.
			</p>
			<button type="button" className="tm-done-button" onClick={onRestart}>
				Start Over
			</button>
		</div>
	);
}

const CSS = `
	.tm-done-root {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		background: #1C2434;
		color: #fff;
		text-align: center;
		box-sizing: border-box;
		padding: max(1.5rem, env(safe-area-inset-top, 0px)) max(1.5rem, env(safe-area-inset-right, 0px)) max(1.5rem, env(safe-area-inset-bottom, 0px)) max(1.5rem, env(safe-area-inset-left, 0px));
	}
	.tm-done-title { margin: 0; font-size: 1.4rem; font-weight: 700; }
	.tm-done-body { margin: 0; max-width: 26rem; font-size: 0.95rem; line-height: 1.5; color: rgba(255,255,255,0.85); }
	.tm-done-button {
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
`;

export default TestMotorDone;

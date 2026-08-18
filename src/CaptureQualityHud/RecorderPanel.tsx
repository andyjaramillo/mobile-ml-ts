// Harness-only capture-quality data recorder UI. Replaces on-device eyeballing with a
// dataset a human can copy off the phone and paste into a chat, then replay offline
// (see scripts/calibrate). Kept out of src/CaptureQuality/, same reasoning as
// MarkerBoardHud.tsx: this is React and will not be ported into Website as-is.
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import {
	buildCompactExport,
	clearCaptureRecording,
	getElapsedMs,
	startCaptureRecording,
	stopCaptureRecording,
	type CaptureRecorderState,
} from "./captureRecorder";

interface Props {
	stateRef: MutableRefObject<CaptureRecorderState>;
	/** Distance from the safe-area top inset, in px. Defaults to the RealTimeProcessor.tsx layout (below its model/facing-mode <select> pair); callers with different top chrome (e.g. TestGait's setup instructions) can push this panel down. */
	topOffsetPx?: number;
	/** Render as a section of DebugHudStack instead of a self-positioned floating box. */
	embedded?: boolean;
}

// Top-anchored and slim: the board sits low-centre in frame, and MarkerBoardHud already
// owns the bottom. Placed below the model/facing-mode <select> pair (RealTimeProcessor
// renders those at top:0), which is why this bar's own top offset leaves room for them.
function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function RecorderPanel({ stateRef, topOffsetPx = 40, embedded = false }: Props) {
	const [tagInput, setTagInput] = useState(stateRef.current.scenarioTag);
	const [isRecording, setIsRecording] = useState(stateRef.current.recording);
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "fallback">("idle");
	const [fallbackText, setFallbackText] = useState<string | null>(null);
	// Bumped on a timer while recording so elapsed/count/char-count stay live without
	// re-rendering on every ~30fps detector tick that mutates stateRef in place.
	const [, setRefreshTick] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		if (!isRecording) return;
		const id = setInterval(() => setRefreshTick((t) => t + 1), 250);
		return () => clearInterval(id);
	}, [isRecording]);

	useEffect(() => {
		if (fallbackText !== null && textareaRef.current) {
			textareaRef.current.focus();
			textareaRef.current.select();
		}
	}, [fallbackText]);

	const state = stateRef.current;
	const elapsedMs = getElapsedMs(state, performance.now());
	const sampleCount = state.samples.length;
	const exportString = buildCompactExport(state);
	const charCount = exportString.length;

	function handleTagChange(value: string) {
		setTagInput(value);
		stateRef.current.scenarioTag = value;
	}

	function handleStartStop() {
		if (state.recording) {
			stopCaptureRecording(state);
			setIsRecording(false);
		} else {
			startCaptureRecording(state, performance.now());
			setIsRecording(true);
			setCopyStatus("idle");
			setFallbackText(null);
		}
	}

	function handleClear() {
		clearCaptureRecording(state);
		setIsRecording(false);
		setCopyStatus("idle");
		setFallbackText(null);
	}

	// iOS Safari only honors navigator.clipboard.writeText as a direct result of a user
	// gesture: no await before this call, or the write is silently rejected.
	function handleCopy() {
		const text = buildCompactExport(stateRef.current);
		if (!navigator.clipboard || !navigator.clipboard.writeText) {
			setFallbackText(text);
			setCopyStatus("fallback");
			return;
		}
		navigator.clipboard.writeText(text).then(
			() => {
				setCopyStatus("copied");
				setFallbackText(null);
			},
			() => {
				setFallbackText(text);
				setCopyStatus("fallback");
			}
		);
	}

	return (
		<div
			className={`crp-root${embedded ? " crp-embedded" : ""}`}
			style={embedded ? undefined : { top: `calc(env(safe-area-inset-top, 0px) + ${topOffsetPx}px)` }}
		>
			<style>{CSS}</style>
			<div className="crp-row">
				<input
					className="crp-tag"
					type="text"
					placeholder="scenario tag (e.g. A baseline 3m)"
					value={tagInput}
					onChange={(e) => handleTagChange(e.target.value)}
					maxLength={60}
				/>
				<button type="button" className={`crp-btn ${isRecording ? "crp-btn-stop" : "crp-btn-start"}`} onClick={handleStartStop}>
					{isRecording ? "Stop" : "Start"}
				</button>
			</div>
			<div className="crp-row crp-row-stats">
				<span className="crp-stat">
					{formatElapsed(elapsedMs)} - {sampleCount} samples - {charCount} chars
				</span>
				<button type="button" className="crp-btn" onClick={handleCopy} disabled={sampleCount === 0}>
					{copyStatus === "copied" ? "Copied" : "Copy"}
				</button>
				<button type="button" className="crp-btn" onClick={handleClear} disabled={sampleCount === 0 && !isRecording}>
					Clear
				</button>
			</div>
			{fallbackText !== null && (
				<div className="crp-row crp-fallback">
					<span className="crp-stat">Clipboard write failed - copy manually:</span>
					<textarea ref={textareaRef} className="crp-textarea" readOnly value={fallbackText} onFocus={(e) => e.currentTarget.select()} />
				</div>
			)}
		</div>
	);
}

const CSS = `
	/* Rendered as a section of DebugHudStack rather than as its own floating box:
	   drop the fixed positioning, the background and the width cap, and let the
	   container own all three. */
	.crp-root.crp-embedded {
		position: static;
		inset: auto;
		transform: none;
		margin: 0;
		padding: 0;
		border-radius: 0;
		background: transparent;
		max-width: none;
		width: auto;
		font-size: inherit;
		line-height: inherit;
	}
	/* The container is the scroll box; a section must never clip its own values -
	   that is what hid the lighting and residual figures on the first on-device read. */
	.crp-root.crp-embedded .crp-row { white-space: normal; overflow: visible; text-overflow: clip; }
	.crp-root {
		position: fixed;
		left: env(safe-area-inset-left, 0px);
		right: env(safe-area-inset-right, 0px);
		top: calc(env(safe-area-inset-top, 0px) + 40px);
		z-index: 100;
		margin: 4px 8px;
		padding: 6px;
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.72);
		color: #eaffea;
		font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
		font-size: clamp(11px, 3.2vw, 13px);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.crp-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
	.crp-row-stats { justify-content: space-between; }
	.crp-stat { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.crp-tag {
		flex: 1 1 160px;
		min-width: 0;
		min-height: 44px;
		padding: 0 8px;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.3);
		background: rgba(255, 255, 255, 0.08);
		color: #eaffea;
		font-size: inherit;
		touch-action: manipulation;
	}
	.crp-btn {
		min-height: 44px;
		min-width: 44px;
		padding: 0 12px;
		border-radius: 8px;
		border: none;
		background: rgba(255, 255, 255, 0.15);
		color: #eaffea;
		font-weight: 700;
		font-size: inherit;
		touch-action: manipulation;
	}
	.crp-btn:active { background: rgba(255, 255, 255, 0.3); }
	.crp-btn:disabled { opacity: 0.4; }
	.crp-btn-start { background: rgba(34, 197, 94, 0.35); }
	.crp-btn-stop { background: rgba(239, 68, 68, 0.35); }
	.crp-fallback { flex-direction: column; align-items: stretch; }
	.crp-textarea {
		width: 100%;
		min-height: 88px;
		font-family: inherit;
		font-size: inherit;
		color: #111;
		padding: 6px;
		border-radius: 8px;
		border: none;
	}
`;

export default RecorderPanel;

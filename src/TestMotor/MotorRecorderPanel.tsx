// [Feature: Test Motor]
//
// Copy-off-the-phone UI for the hand recorder. Deliberately the same interaction as
// CaptureQualityHud/RecorderPanel (tag, Start/Stop, Copy, Clear, manual-select fallback)
// so an operator who has recorded a gait take already knows how to record a motor one.
// Separate component rather than a shared generic: the two recorders encode different
// data, and the only thing genuinely common is four buttons.
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import {
	buildCompactExport,
	clearMotorRecording,
	getElapsedMs,
	startMotorRecording,
	stopMotorRecording,
	type MotorRecorderState,
} from "./motorRecorder";

interface Props {
	stateRef: MutableRefObject<MotorRecorderState>;
	embedded?: boolean;
}

function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	return `${String(Math.floor(totalSec / 60)).padStart(2, "0")}:${String(totalSec % 60).padStart(2, "0")}`;
}

function MotorRecorderPanel({ stateRef, embedded = false }: Props) {
	const [tagInput, setTagInput] = useState(stateRef.current.scenarioTag);
	const [isRecording, setIsRecording] = useState(stateRef.current.recording);
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "fallback">("idle");
	const [fallbackText, setFallbackText] = useState<string | null>(null);
	// Ticks a timer while recording so the counters stay live without re-rendering on
	// every detector tick, which mutates stateRef in place.
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
	const charCount = buildCompactExport(state).length;

	function handleStartStop() {
		if (state.recording) {
			stopMotorRecording(state);
			setIsRecording(false);
		} else {
			startMotorRecording(state, performance.now());
			setIsRecording(true);
			setCopyStatus("idle");
			setFallbackText(null);
		}
	}

	function handleClear() {
		clearMotorRecording(state);
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
		<div className={`mrp-root${embedded ? " mrp-embedded" : ""}`}>
			<style>{CSS}</style>
			<div className="mrp-row">
				<input
					className="mrp-tag"
					type="text"
					placeholder="scenario tag (e.g. hands in box, palms up)"
					value={tagInput}
					onChange={(e) => {
						setTagInput(e.target.value);
						stateRef.current.scenarioTag = e.target.value;
					}}
					maxLength={60}
				/>
				<button type="button" className={`mrp-btn ${isRecording ? "mrp-btn-stop" : "mrp-btn-start"}`} onClick={handleStartStop}>
					{isRecording ? "Stop" : "Start"}
				</button>
			</div>
			<div className="mrp-row mrp-row-stats">
				<span className="mrp-stat">
					{formatElapsed(elapsedMs)} - {sampleCount} samples - {charCount} chars
				</span>
				<button type="button" className="mrp-btn" onClick={handleCopy} disabled={sampleCount === 0}>
					{copyStatus === "copied" ? "Copied" : "Copy"}
				</button>
				<button type="button" className="mrp-btn" onClick={handleClear} disabled={sampleCount === 0 && !isRecording}>
					Clear
				</button>
			</div>
			{fallbackText !== null && (
				<div className="mrp-row mrp-fallback">
					<span className="mrp-stat">Clipboard write failed - copy manually:</span>
					<textarea ref={textareaRef} className="mrp-textarea" readOnly value={fallbackText} onFocus={(e) => e.currentTarget.select()} />
				</div>
			)}
		</div>
	);
}

const CSS = `
	.mrp-root.mrp-embedded {
		position: static;
		margin: 0;
		padding: 0;
		border-radius: 0;
		background: transparent;
		max-width: none;
		font-size: inherit;
		line-height: inherit;
	}
	.mrp-root.mrp-embedded .mrp-row { white-space: normal; overflow: visible; text-overflow: clip; }
	.mrp-root {
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
	.mrp-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
	.mrp-row-stats { justify-content: space-between; }
	.mrp-stat { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.mrp-tag {
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
	.mrp-btn {
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
	.mrp-btn:active { background: rgba(255, 255, 255, 0.3); }
	.mrp-btn:disabled { opacity: 0.4; }
	.mrp-btn-start { background: rgba(34, 197, 94, 0.35); }
	.mrp-btn-stop { background: rgba(239, 68, 68, 0.35); }
	.mrp-fallback { flex-direction: column; align-items: stretch; }
	.mrp-textarea {
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

export default MotorRecorderPanel;

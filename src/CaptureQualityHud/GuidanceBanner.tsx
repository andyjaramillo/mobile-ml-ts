// [Feature: Capture Quality Warnings - guidance banner]
//
// Patient-facing replacement for the debug HUD's developer chips ("TOO SMALL" etc). Shows
// exactly one plain-language instruction at a time (see captureQualityGuidance.ts for the
// priority order and copy) plus a small toggle for the debug HUD (MarkerBoardHud/
// LowLightHud), so the debug chips can be hidden to see what a patient would actually see.
// Harness-only, same as MarkerBoardHud.tsx - not ported into Website as-is.
import { pickGuidanceMessage } from "./captureQualityGuidance";
import type { SubjectPositionWindowAggregate } from "../CaptureQuality/subjectPositionCheck";
import type { GuidanceSelectionCode } from "./captureQualityGuidance";
import type { LowLightWindowAggregate } from "../CaptureQuality/lowLightCheck";
import type { MarkerBoardWindowAggregate } from "../CaptureQuality/markerBoardCheck";

interface Props {
	markerBoardAggregate: MarkerBoardWindowAggregate | null;
	lowLightAggregate: LowLightWindowAggregate | null;
	/** Optional: omit (or pass null) and the banner behaves exactly as it did before subject detection existed - the fail-open path when the person model is unavailable. */
	subjectAggregate?: SubjectPositionWindowAggregate | null;
	showDebugHud: boolean;
	onToggleDebugHud: () => void;
	/**
	 * Patient view: hides the debug toggle entirely, so the banner is exactly what a customer
	 * sees. The toggle is a harness affordance and a clinician must never be one stray tap
	 * from a screen full of developer numbers.
	 */
	hideDebugToggle?: boolean;
	/** Distance from the safe-area top inset, in px - callers tune this to clear their own top chrome (see MarkerBoardHud/RecorderPanel's identical prop convention). */
	topOffsetPx?: number;
}

const CRITICAL_CODES = new Set<GuidanceSelectionCode>(["MARKER_INCOMPLETE", "MARKER_TOO_CLOSE", "MARKER_OBSTRUCTED"]);

// SETUP_VERIFIED gets its own tone rather than reusing the green: green is the operator's
// cue that the trial can start, and the patient is not in position yet.
function toneFor(code: GuidanceSelectionCode): "ok" | "info" | "pending" | "critical" | "warning" {
	if (code === "READY") return "ok";
	if (code === "SETUP_VERIFIED") return "info";
	if (code === "PENDING") return "pending";
	if (CRITICAL_CODES.has(code)) return "critical";
	return "warning";
}

function GuidanceBanner({ markerBoardAggregate, lowLightAggregate, subjectAggregate = null, showDebugHud, onToggleDebugHud, hideDebugToggle = false, topOffsetPx = 0 }: Props) {
	const selection = pickGuidanceMessage(markerBoardAggregate, lowLightAggregate, subjectAggregate);
	const tone = toneFor(selection.code);

	return (
		<div
			className={`gb-root gb-${tone}`}
			role="status"
			aria-live="polite"
			style={{ top: `calc(env(safe-area-inset-top, 0px) + ${topOffsetPx}px)` }}
		>
			<style>{CSS}</style>
			<span className="gb-message">{selection.message}</span>
			{!hideDebugToggle && (
				<button type="button" className="gb-toggle" onClick={onToggleDebugHud} aria-pressed={showDebugHud}>
					{showDebugHud ? "Hide debug" : "Show debug"}
				</button>
			)}
		</div>
	);
}

const CSS = `
	.gb-root {
		position: fixed;
		left: env(safe-area-inset-left, 0px);
		right: env(safe-area-inset-right, 0px);
		z-index: 200;
		margin: 8px;
		padding: 10px 12px;
		border-radius: 12px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		color: #fff;
		font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
	}
	.gb-message {
		font-size: clamp(14px, 4vw, 18px);
		font-weight: 700;
		line-height: 1.3;
	}
	.gb-toggle {
		flex-shrink: 0;
		min-height: 44px;
		min-width: 44px;
		padding: 0 10px;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.4);
		background: rgba(0, 0, 0, 0.2);
		color: #fff;
		font-size: 12px;
		font-weight: 600;
		touch-action: manipulation;
		cursor: pointer;
	}
	.gb-toggle:active { background: rgba(0, 0, 0, 0.4); }
	.gb-ok { background: rgba(22, 163, 74, 0.92); }
	.gb-info { background: rgba(37, 99, 235, 0.92); }
	.gb-warning { background: rgba(217, 119, 6, 0.92); }
	.gb-critical { background: rgba(220, 38, 38, 0.92); }
	.gb-pending { background: rgba(75, 85, 99, 0.92); }
`;

export default GuidanceBanner;

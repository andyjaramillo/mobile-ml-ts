// [Feature: Test Motor]
//
// Patient-facing single instruction, same role as the gait GuidanceBanner but reading
// motor codes. Not shared with that component: it resolves gait's three aggregate types,
// and widening it to take either shape would couple two flows that have no reason to
// move together.
//
// English lives here, not in handStatus.ts. On the way back into Website these strings
// become MobileAssessment.CaptureQuality.* i18n keys.
import type { MotorIssueCode } from "./handStatus";

const MESSAGES: Record<MotorIssueCode, string> = {
	BOTH_HANDS_MISSING: "Hold both hands up in front of the camera",
	LEFT_HAND_MISSING: "Bring your left hand into view",
	RIGHT_HAND_MISSING: "Bring your right hand into view",
	BOTH_HANDS_NOT_FULLY_IN_FRAME: "Both hands are cut off - move them further into view",
	LEFT_HAND_NOT_FULLY_IN_FRAME: "Your left hand is cut off - move it further into view",
	RIGHT_HAND_NOT_FULLY_IN_FRAME: "Your right hand is cut off - move it further into view",
	BOTH_HANDS_OUTSIDE_GUIDE: "Move both hands into the dashed box",
	LEFT_HAND_OUTSIDE_GUIDE: "Move your left hand into the dashed box",
	RIGHT_HAND_OUTSIDE_GUIDE: "Move your right hand into the dashed box",
	HANDS_TOO_CLOSE: "Move your hands further apart so they do not overlap",
	BOTH_PALMS_NOT_FACING_CAMERA: "Turn both palms to face the camera",
	LEFT_PALM_NOT_FACING_CAMERA: "Turn your left palm to face the camera",
	RIGHT_PALM_NOT_FACING_CAMERA: "Turn your right palm to face the camera",
	BOTH_HANDS_NOT_OPEN: "Open both hands and spread your fingers apart",
	LEFT_HAND_NOT_OPEN: "Open your left hand and spread your fingers apart",
	RIGHT_HAND_NOT_OPEN: "Open your right hand and spread your fingers apart",
	BOTH_HANDS_NOT_UPRIGHT: "Point both hands up toward the top of the screen",
	LEFT_HAND_NOT_UPRIGHT: "Point your left hand up toward the top of the screen",
	RIGHT_HAND_NOT_UPRIGHT: "Point your right hand up toward the top of the screen",
	TOO_MANY_HANDS: "Only the patient's hands should be in view",
	HANDS_READY: "Hands look good - press the red button when you are ready",
	PENDING: "Checking your camera view...",
};

function toneFor(code: MotorIssueCode): "ok" | "pending" | "warning" {
	if (code === "HANDS_READY") return "ok";
	if (code === "PENDING") return "pending";
	return "warning";
}

interface Props {
	code: MotorIssueCode;
	showDebugHud: boolean;
	onToggleDebugHud: () => void;
	/** Patient view: the debug toggle is a harness affordance and must not be one tap away. */
	hideDebugToggle?: boolean;
	topOffsetPx?: number;
}

function MotorGuidanceBanner({ code, showDebugHud, onToggleDebugHud, hideDebugToggle = false, topOffsetPx = 0 }: Props) {
	return (
		<div
			className={`mgb-root mgb-${toneFor(code)}`}
			role="status"
			aria-live="polite"
			style={{ top: `calc(env(safe-area-inset-top, 0px) + ${topOffsetPx}px)` }}
		>
			<style>{CSS}</style>
			<span className="mgb-message">{MESSAGES[code]}</span>
			{!hideDebugToggle && (
				<button type="button" className="mgb-toggle" onClick={onToggleDebugHud} aria-pressed={showDebugHud}>
					{showDebugHud ? "Hide debug" : "Show debug"}
				</button>
			)}
		</div>
	);
}

const CSS = `
	.mgb-root {
		position: fixed;
		left: env(safe-area-inset-left, 0px);
		right: env(safe-area-inset-right, 0px);
		z-index: 200;
		margin: 0 8px;
		padding: 10px 12px;
		border-radius: 10px;
		display: flex;
		align-items: center;
		gap: 10px;
		max-width: min(460px, calc(100vw - 16px));
		margin-left: auto;
		margin-right: auto;
		color: #fff;
		font-size: clamp(0.95rem, 3.6vw, 1.05rem);
		font-weight: 600;
		line-height: 1.3;
		text-shadow: 0 1px 3px rgba(0,0,0,0.4);
	}
	.mgb-message { flex: 1; }
	.mgb-ok { background: rgba(21, 128, 61, 0.85); }
	.mgb-warning { background: rgba(180, 83, 9, 0.85); }
	.mgb-pending { background: rgba(51, 65, 85, 0.85); }
	.mgb-toggle {
		flex-shrink: 0;
		min-height: 32px;
		padding: 0 0.6rem;
		border-radius: 8px;
		border: 1px solid rgba(255,255,255,0.35);
		background: rgba(255,255,255,0.15);
		color: #fff;
		font-size: 0.75rem;
		font-weight: 600;
		touch-action: manipulation;
		cursor: pointer;
	}
`;

export default MotorGuidanceBanner;

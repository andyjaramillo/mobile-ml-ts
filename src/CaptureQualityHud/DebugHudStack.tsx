// Harness-only container that stacks every debug panel into ONE scrollable column.
//
// Replaces the previous arrangement, where each panel pinned itself to a different screen
// edge (marker board bottom, lighting right, subject left, recorder top) to stay clear of
// the others. That works on a desktop viewport and collapses completely on a phone: the
// panels are tall relative to the screen, so all four landed on top of each other and none
// of them was readable. Edge-pinning cannot be made to work here - there are more panels
// than there are edges, and each one grows as checks are added.
//
// Bounded top and bottom so it never covers the two things the operator has to see while
// calibrating: the guidance banner above, and the record button plus the board itself
// below. If the content outgrows that box it scrolls rather than expanding over them.
import type { ReactNode } from "react";

interface Props {
	/** Distance below the safe-area top inset, in px - clears whatever the caller renders above (TestGait's setup banner + guidance banner). */
	topOffsetPx?: number;
	/**
	 * Share of the viewport this may occupy before it scrolls, 0-1. Capped rather than
	 * stretched to the bottom of the screen because the marker board lies on the FLOOR and
	 * therefore images low in frame - a panel filling the viewport hides the exact thing the
	 * operator is trying to frame while reading it.
	 */
	maxHeightFraction?: number;
	children: ReactNode;
}

function DebugHudStack({ topOffsetPx = 0, maxHeightFraction = 0.46, children }: Props) {
	return (
		<div
			className="dhs-root"
			style={{
				top: `calc(env(safe-area-inset-top, 0px) + ${topOffsetPx}px)`,
				maxHeight: `${Math.round(maxHeightFraction * 100)}vh`,
			}}
		>
			<style>{CSS}</style>
			{children}
		</div>
	);
}

const CSS = `
	.dhs-root {
		position: fixed;
		left: env(safe-area-inset-left, 0px);
		right: env(safe-area-inset-right, 0px);
		z-index: 60;
		margin: 0 8px;
		padding: 8px 10px;
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.7);
		color: #eaf4ff;
		font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
		font-size: clamp(10px, 3vw, 13px);
		line-height: 1.45;
		max-width: min(460px, calc(100vw - 16px));
		display: flex;
		flex-direction: column;
		gap: 6px;
		/* Scrolls rather than growing over the banner or the record button. */
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}
	/* Each embedded panel drops its own background/positioning and becomes a section of this
	   one column, separated by a rule instead of by being a separate floating box. */
	.dhs-root > * + * {
		border-top: 1px solid rgba(255, 255, 255, 0.16);
		padding-top: 6px;
	}
`;

export default DebugHudStack;

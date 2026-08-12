// Harness-only debug overlay for calibrating marker-board thresholds by hand.
// Deliberately kept out of src/CaptureQuality/, which stays framework-free/portable -
// this is React, renders numbers, and will not be ported into Website as-is.
import type { MarkerBoardCheckConfig, MarkerBoardWindowAggregate } from "../CaptureQuality/markerBoardCheck";
import type { CaptureQualityIssueCode } from "../CaptureQuality/types";

interface Props {
	aggregate: MarkerBoardWindowAggregate | null;
	config: MarkerBoardCheckConfig;
}

// Values in this check run ~0.004-0.008 at close range; toFixed(4) on that reads as
// "0.0043" (2 significant figures). toPrecision(4) keeps 4 sig figs regardless of
// magnitude, which is the point of this whole panel - showing thresholds are being
// missed by a real, readable margin instead of rounding everything to 0.00.
function fmt(value: number | null | undefined): string {
	if (value === null || value === undefined || Number.isNaN(value)) return "--";
	return Number(value).toPrecision(4);
}

const CODE_LABEL: Record<CaptureQualityIssueCode, string> = {
	MARKER_INCOMPLETE: "INCOMPLETE",
	MARKER_TOO_CLOSE: "TOO CLOSE",
	MARKER_TOO_SMALL: "TOO SMALL",
	MARKER_SKEWED: "SKEWED",
	MARKER_WRONG_ORIENTATION: "WRONG ORIENTATION",
	SUBJECT_NOT_DETECTED: "SUBJECT_NOT_DETECTED",
	SUBJECT_NOT_STATIONARY: "SUBJECT_NOT_STATIONARY",
	SUBJECT_NOT_AT_START_LINE: "SUBJECT_NOT_AT_START_LINE",
	START_LINE_UNKNOWN: "START_LINE_UNKNOWN",
	MULTIPLE_PEOPLE: "MULTIPLE_PEOPLE",
	PROXIMATE_PEOPLE: "PROXIMATE_PEOPLE",
	LOW_LIGHT: "LOW_LIGHT",
	LOW_CONTRAST: "LOW_CONTRAST",
	VIDEO_TOO_SHORT: "VIDEO_TOO_SHORT",
	VIDEO_TOO_LONG: "VIDEO_TOO_LONG",
};

function MarkerBoardHud({ aggregate, config }: Props) {
	const latest = aggregate?.latest ?? null;
	const codes = aggregate?.activeCodes ?? [];
	const ok = aggregate !== null && codes.length === 0 && (latest?.visibleCount ?? 0) > 0;
	const hasCritical = codes.includes("MARKER_INCOMPLETE") || codes.includes("MARKER_TOO_CLOSE");

	return (
		<div className="mbh-root" role="status" aria-live="polite">
			<style>{CSS}</style>
			<div className="mbh-row mbh-header">
				<span className={`mbh-dot ${ok ? "mbh-dot-ok" : hasCritical ? "mbh-dot-critical" : codes.length > 0 ? "mbh-dot-warning" : "mbh-dot-idle"}`} />
				<span>marker board</span>
			</div>

			<div className="mbh-row">ids: {latest && latest.visibleIds.length > 0 ? latest.visibleIds.join(",") : "none"} ({latest?.visibleCount ?? 0})</div>

			<div className="mbh-row mbh-cols">
				<span>frame area {fmt(latest?.normalizedArea)}</span>
				<span>avg {fmt(aggregate?.weightedNormalizedArea)}</span>
			</div>
			<div className="mbh-row mbh-cols">
				<span>frame diag {fmt(latest?.diagonalRatio)}</span>
				<span>avg {fmt(aggregate?.weightedDiagonalRatio)}</span>
			</div>
			<div className="mbh-row mbh-cols">
				<span>frame rot {fmt(latest?.orientationAngleRad)}</span>
				<span>avg {fmt(aggregate?.weightedOrientationAngleRad)}</span>
			</div>
			<div className="mbh-row">full-set score: {fmt(aggregate?.weightedFullSetScore)} (min {fmt(config.thresholds.minimumFullSetWeight)})</div>

			<div className="mbh-row mbh-codes">
				{codes.length === 0 ? (
					<span className="mbh-chip mbh-chip-ok">ok</span>
				) : (
					codes.map((code) => (
						<span key={code} className={`mbh-chip ${code === "MARKER_INCOMPLETE" || code === "MARKER_TOO_CLOSE" ? "mbh-chip-critical" : "mbh-chip-warning"}`}>
							{CODE_LABEL[code]}
						</span>
					))
				)}
			</div>
		</div>
	);
}

const CSS = `
	.mbh-root {
		position: fixed;
		left: env(safe-area-inset-left, 0px);
		right: env(safe-area-inset-right, 0px);
		bottom: env(safe-area-inset-bottom, 0px);
		z-index: 50;
		pointer-events: none;
		margin: 8px;
		padding: 8px 10px;
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.72);
		color: #eaffea;
		font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
		font-size: clamp(11px, 3.2vw, 14px);
		line-height: 1.5;
		max-width: min(420px, calc(100vw - 16px));
	}
	.mbh-row { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.mbh-cols { display: flex; justify-content: space-between; gap: 12px; }
	.mbh-header { display: flex; align-items: center; gap: 6px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
	.mbh-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
	.mbh-dot-ok { background: #22c55e; }
	.mbh-dot-warning { background: #f59e0b; }
	.mbh-dot-critical { background: #ef4444; }
	.mbh-dot-idle { background: #6b7280; }
	.mbh-codes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
	.mbh-chip { padding: 2px 7px; border-radius: 999px; font-size: 0.85em; font-weight: 600; }
	.mbh-chip-ok { background: rgba(34, 197, 94, 0.25); color: #86efac; }
	.mbh-chip-warning { background: rgba(245, 158, 11, 0.25); color: #fcd34d; }
	.mbh-chip-critical { background: rgba(239, 68, 68, 0.3); color: #fca5a5; }
`;

export default MarkerBoardHud;

// Harness-only debug overlay for the lighting pre-check, mirroring MarkerBoardHud.tsx.
// Deliberately kept out of src/CaptureQuality/ (same reasoning as MarkerBoardHud.tsx):
// this is React and will not be ported into Website as-is.
//
// PLACEMENT: MarkerBoardHud already spans the full width of the bottom safe area, and
// RecorderPanel + the model/facing-mode <select> pair occupy the top - the board itself
// sits low-centre in frame (see RealTimeProcessor.tsx layout). Stacking a second
// bottom-width panel would either collide with MarkerBoardHud or cover more of the
// low-centre board, so this one is pinned to the vertical-centre of the RIGHT edge
// instead - clear of the top controls, clear of the bottom marker panel, and narrow
// enough to stay off the board.
import type { LowLightCheckConfig, LowLightWindowAggregate } from "../CaptureQuality/lowLightCheck";
import type { CaptureQualityIssueCode } from "../CaptureQuality/types";

interface Props {
	aggregate: LowLightWindowAggregate | null;
	config: LowLightCheckConfig;
}

// Luma/contrast-std live on a 0-255 scale, not a [0,1] fraction - toFixed(1) already
// keeps a real digit of precision at that magnitude (e.g. "38.4"), unlike a naive
// toFixed(2) on a small fraction which can round to "0.00". Cell fractions ARE small
// [0,1] values, so those go through toPrecision(3) instead (e.g. an early single dark
// cell in an 8x8 grid is 1/64 = 0.0156 - toFixed(2) would still read "0.02", but
// toPrecision keeps it meaningful at even smaller fractions from a finer future grid).
function fmtScale255(value: number | null | undefined): string {
	if (value === null || value === undefined || Number.isNaN(value)) return "--";
	return value.toFixed(1);
}

function fmtFraction(value: number | null | undefined): string {
	if (value === null || value === undefined || Number.isNaN(value)) return "--";
	return Number(value).toPrecision(3);
}

const CODE_LABEL: Partial<Record<CaptureQualityIssueCode, string>> = {
	LOW_LIGHT: "LOW LIGHT",
	LOW_CONTRAST: "LOW CONTRAST",
};

function LowLightHud({ aggregate, config }: Props) {
	const latest = aggregate?.latest ?? null;
	const codes = aggregate?.activeCodes ?? [];
	const ok = aggregate !== null && codes.length === 0 && (latest?.computableCellCount ?? 0) > 0;

	return (
		<div className="llh-root" role="status" aria-live="polite">
			<style>{CSS}</style>
			<div className="llh-row llh-header">
				<span className={`llh-dot ${ok ? "llh-dot-ok" : codes.length > 0 ? "llh-dot-warning" : "llh-dot-idle"}`} />
				<span>lighting</span>
			</div>

			<div className="llh-row">luma {fmtScale255(latest?.meanLuma)} / avg {fmtScale255(aggregate?.weightedMeanLuma)}</div>
			<div className="llh-row">dark cells {fmtFraction(aggregate?.weightedDarkCellFraction)} (min {config.thresholds.darkCellFractionThreshold})</div>
			<div className="llh-row">contrast {fmtScale255(latest?.meanContrastStd)} / avg {fmtScale255(aggregate?.weightedMeanContrastStd)}</div>
			<div className="llh-row">flat cells {fmtFraction(aggregate?.weightedFlatCellFraction)} (min {config.thresholds.flatCellFractionThreshold})</div>

			<div className="llh-row llh-codes">
				{codes.length === 0 ? (
					<span className="llh-chip llh-chip-ok">ok</span>
				) : (
					codes.map((code) => (
						<span key={code} className="llh-chip llh-chip-warning">
							{CODE_LABEL[code] ?? code}
						</span>
					))
				)}
			</div>
		</div>
	);
}

const CSS = `
	.llh-root {
		position: fixed;
		right: env(safe-area-inset-right, 0px);
		top: 50%;
		transform: translateY(-50%);
		z-index: 50;
		pointer-events: none;
		margin: 8px;
		padding: 8px 10px;
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.72);
		color: #eaf4ff;
		font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
		font-size: clamp(11px, 3.2vw, 14px);
		line-height: 1.5;
		width: max-content;
		max-width: min(160px, 40vw);
	}
	.llh-row { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.llh-header { display: flex; align-items: center; gap: 6px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
	.llh-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
	.llh-dot-ok { background: #22c55e; }
	.llh-dot-warning { background: #f59e0b; }
	.llh-dot-idle { background: #6b7280; }
	.llh-codes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
	.llh-chip { padding: 2px 7px; border-radius: 999px; font-size: 0.85em; font-weight: 600; }
	.llh-chip-ok { background: rgba(34, 197, 94, 0.25); color: #86efac; }
	.llh-chip-warning { background: rgba(245, 158, 11, 0.25); color: #fcd34d; }
`;

export default LowLightHud;

// Harness-only readout for the detect loop's per-stage cost. Split out of
// SubjectPositionHud so each section of DebugHudStack covers one subject; the timings are
// about the loop, not about the person in it.
//
// READ `rate` AND `work` TOGETHER. `rate` is derived from the measured gap between ticks;
// `work` is how long the body of one tick takes. They answer different questions, and
// deriving a rate from `work` (which an earlier version of this panel did) reports the
// ceiling the loop COULD reach rather than what it delivers - which made a starved loop
// read as healthy. A large `idle` means the loop is being starved rather than the work
// being slow, and no amount of optimizing the stages below will move it.
import { amortizedMs, deliveredTickHz, idleBetweenTicksMs, unaccountedMs } from "./tickProfiler";
import type { TickProfiler } from "./tickProfiler";

interface Props {
	profiler: TickProfiler | null;
	/** Rate the loop is throttled to, for comparison against the delivered rate. */
	targetHz: number;
	embedded?: boolean;
}

function fmtMs(value: number | null | undefined): string {
	if (value === null || value === undefined || Number.isNaN(value)) return "--";
	return `${Math.round(value)}ms`;
}

function TickProfilerHud({ profiler, targetHz, embedded = false }: Props) {
	const deliveredHz = profiler ? deliveredTickHz(profiler) : null;
	// Means are noise until a handful of ticks have landed - say so rather than showing a
	// confident-looking number derived from two samples.
	const warmedUp = (profiler?.sampleCount ?? 0) >= 10;
	const starved = deliveredHz !== null && deliveredHz < targetHz * 0.75;

	return (
		<div className={`tph-root${embedded ? " tph-embedded" : ""}`} role="status" aria-live="polite">
			<style>{CSS}</style>
			<div className="tph-row tph-header">
				<span className={`tph-dot ${!warmedUp ? "tph-dot-idle" : starved ? "tph-dot-warning" : "tph-dot-ok"}`} />
				<span>loop</span>
			</div>

			<div className="tph-grid">
				<span className="tph-k">rate</span>
				<span className={`tph-v ${starved ? "tph-v-bad" : ""}`}>
					{deliveredHz === null ? "--" : `${deliveredHz.toFixed(1)}Hz`} <span className="tph-dim">/ {targetHz}Hz</span>
				</span>

				<span className="tph-k">work</span>
				<span className="tph-v">{fmtMs(profiler?.meanMs.total)}</span>

				<span className="tph-k">idle</span>
				<span className="tph-v">{fmtMs(profiler ? idleBetweenTicksMs(profiler) : null)}</span>

				<span className="tph-k tph-sub">draw</span>
				<span className="tph-v tph-sub">{fmtMs(profiler?.meanMs.draw)}</span>

				<span className="tph-k tph-sub">aruco</span>
				<span className="tph-v tph-sub">{fmtMs(profiler?.meanMs.aruco)}</span>

				{/* Per-run cost AND its per-tick share: person detection is round-robined, so
				    the raw figure is what one run costs, and only the amortized one is
				    comparable against `work` above. */}
				<span className="tph-k tph-sub">person</span>
				<span className="tph-v tph-sub">
					{fmtMs(profiler?.meanMs.person)}{" "}
					<span className="tph-dim">({fmtMs(profiler ? amortizedMs(profiler, "person") : null)}/tick)</span>
				</span>

				<span className="tph-k tph-sub">light</span>
				<span className="tph-v tph-sub">{fmtMs(profiler?.meanMs.lighting)}</span>

				<span className="tph-k tph-sub">checks</span>
				<span className="tph-v tph-sub">{fmtMs(profiler?.meanMs.checks)}</span>

				<span className="tph-k tph-sub">other</span>
				<span className="tph-v tph-sub">{fmtMs(profiler ? unaccountedMs(profiler) : null)}</span>
			</div>

			{!warmedUp && <div className="tph-row tph-dim">warming up ({profiler?.sampleCount ?? 0}/10 ticks)</div>}
		</div>
	);
}

const CSS = `
	.tph-root.tph-embedded {
		position: static;
		inset: auto;
		transform: none;
		margin: 0;
		padding: 0;
		border-radius: 0;
		background: transparent;
		max-width: none;
		width: auto;
	}
	.tph-root {
		font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
		color: #eaf4ff;
	}
	.tph-row { white-space: nowrap; }
	.tph-header { display: flex; align-items: center; gap: 6px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
	.tph-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
	.tph-dot-ok { background: #22c55e; }
	.tph-dot-warning { background: #f59e0b; }
	.tph-dot-idle { background: #6b7280; }
	/* Two aligned columns rather than free text: these are read as a list of magnitudes,
	   and a ragged left edge makes an outlier much harder to spot. */
	.tph-grid { display: grid; grid-template-columns: auto 1fr; column-gap: 10px; row-gap: 0; }
	.tph-k { color: #9db4c8; }
	.tph-v { text-align: right; font-variant-numeric: tabular-nums; }
	.tph-v-bad { color: #fcd34d; font-weight: 700; }
	.tph-sub { opacity: 0.75; }
	.tph-dim { color: #9db4c8; font-size: 0.9em; }
`;

export default TickProfilerHud;

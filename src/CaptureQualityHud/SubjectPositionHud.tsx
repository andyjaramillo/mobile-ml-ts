// Harness-only debug overlay for the subject-position pre-check, mirroring
// MarkerBoardHud.tsx and LowLightHud.tsx. React, so deliberately outside src/CaptureQuality/.
//
// PLACEMENT: pass `embedded` and render inside DebugHudStack, which owns position and
// background. The standalone (non-embedded) mode pins to the left edge and exists only for
// RealTimeProcessor.tsx, the frozen fast-iteration page.
//
// The loop timings that used to live here now have their own section (TickProfilerHud) -
// they are read alongside this one but describe the loop, not the subject.
import type { SubjectPositionCheckConfig, SubjectPositionWindowAggregate } from "../CaptureQuality/subjectPositionCheck";
import type { CaptureQualityIssueCode } from "../CaptureQuality/types";
import type { PersonDetectorStatus } from "../model/usePersonDetector";

interface Props {
	aggregate: SubjectPositionWindowAggregate | null;
	config: SubjectPositionCheckConfig;
	detectorStatus: PersonDetectorStatus;
	/** Render as a section of DebugHudStack instead of a self-positioned floating box. */
	embedded?: boolean;
}

function fmt(value: number | null | undefined, digits = 2): string {
	if (value === null || value === undefined || Number.isNaN(value)) return "--";
	return value.toFixed(digits);
}

const CODE_LABEL: Partial<Record<CaptureQualityIssueCode, string>> = {
	SUBJECT_NOT_DETECTED: "NO SUBJECT",
	SUBJECT_NOT_STATIONARY: "MOVING",
	SUBJECT_NOT_AT_START_LINE: "OFF START",
	START_LINE_UNKNOWN: "NO START LINE",
	MULTIPLE_PEOPLE: "MULTI PERSON",
};

const STATUS_LABEL: Record<PersonDetectorStatus, string> = {
	loading: "loading",
	ready: "ready",
	unavailable: "off",
};

function SubjectPositionHud({ aggregate, config, detectorStatus, embedded = false }: Props) {
	const codes = aggregate?.activeCodes ?? [];
	const ran = (aggregate?.detectionFrameCount ?? 0) > 0;
	const ok = ran && codes.length === 0;

	return (
		<div className={`sph-root${embedded ? " sph-embedded" : ""}`} role="status" aria-live="polite">
			<style>{CSS}</style>
			<div className="sph-row sph-header">
				<span className={`sph-dot ${ok ? "sph-dot-ok" : codes.length > 0 ? "sph-dot-warning" : "sph-dot-idle"}`} />
				<span>subject</span>
			</div>

			{/* Value then threshold, in aligned columns - a number with no bound beside it says
			    nothing about whether the check is about to fire. Rows marked "info" are
			    computed and reported but do NOT gate anything (see the check's module header);
			    `gap` is the one that decides SUBJECT_NOT_AT_START_LINE - it must stay inside the
			    band shown beside it. */}
			<div className="sph-grid">
				<span className="sph-k">model</span>
				<span className="sph-v">{STATUS_LABEL[detectorStatus]}</span>
				<span className="sph-lim" />

				<span className="sph-k">people</span>
				<span className="sph-v">{aggregate?.latest?.personCount ?? "--"}</span>
				<span className="sph-lim" />

				<span className="sph-k">seen</span>
				<span className="sph-v">{fmt(aggregate?.weightedDetectionScore)}</span>
				<span className="sph-lim">min {config.thresholds.minimumDetectionWeight}</span>

				<span className="sph-k">gap</span>
				<span className="sph-v">{fmt(aggregate?.weightedBoardToSubjectGapNorm, 3)}</span>
				<span className="sph-lim">
					{config.thresholds.tooFarBackGapNorm}-{config.thresholds.tooFarForwardGapNorm}
				</span>

				<span className="sph-k">area</span>
				<span className="sph-v">{fmt(aggregate?.weightedSubjectAreaNorm, 3)}</span>
				<span className="sph-lim">info</span>

				<span className="sph-k">dist</span>
				<span className="sph-v">{fmt(aggregate?.weightedStartLineDistanceBoardLengths)} bl</span>
				<span className="sph-lim">info</span>

				<span className="sph-k">speed</span>
				<span className="sph-v">{fmt(aggregate?.weightedSpeedBoardLengthsPerSec)} bl/s</span>
				<span className="sph-lim">info</span>

				<span className="sph-k">area cv</span>
				<span className="sph-v">{fmt(aggregate?.subjectAreaCv)}</span>
				<span className="sph-lim">info</span>
			</div>

			<div className="sph-row sph-codes">
				{codes.length === 0 ? (
					<span className="sph-chip sph-chip-ok">{ran ? "ok" : "idle"}</span>
				) : (
					codes.map((code) => (
						<span key={code} className="sph-chip sph-chip-warning">
							{CODE_LABEL[code] ?? code}
						</span>
					))
				)}
			</div>
		</div>
	);
}

const CSS = `
	/* Rendered as a section of DebugHudStack rather than as its own floating box:
	   drop the fixed positioning, the background and the width cap, and let the
	   container own all three. */
	.sph-root.sph-embedded {
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
	.sph-root.sph-embedded .sph-row { white-space: normal; overflow: visible; text-overflow: clip; }
	.sph-root {
		position: fixed;
		left: env(safe-area-inset-left, 0px);
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
		max-width: min(210px, 48vw);
	}
	.sph-row { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.sph-grid { display: grid; grid-template-columns: auto 1fr auto; column-gap: 10px; align-items: baseline; }
	.sph-k { color: #9db4c8; }
	.sph-v { text-align: right; font-variant-numeric: tabular-nums; }
	.sph-lim { color: #9db4c8; font-size: 0.85em; text-align: right; }
	.sph-header { display: flex; align-items: center; gap: 6px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
	.sph-divider { margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.18); }
	.sph-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
	.sph-dot-ok { background: #22c55e; }
	.sph-dot-warning { background: #f59e0b; }
	.sph-dot-idle { background: #6b7280; }
	.sph-codes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
	.sph-chip { padding: 2px 7px; border-radius: 999px; font-size: 0.85em; font-weight: 600; }
	.sph-chip-ok { background: rgba(34, 197, 94, 0.25); color: #86efac; }
	.sph-chip-warning { background: rgba(245, 158, 11, 0.25); color: #fcd34d; }
`;

export default SubjectPositionHud;

// Sweeps the recency-weight alpha and the four MarkerBoardThresholds pass/fail fields
// (minimumFullSetWeight is included alongside the three geometry thresholds - it is the
// lever most directly responsible for the marker-dropout flapping this whole tool
// exists to diagnose, per the recorded-data note in the task). Every combination is
// replayed through the real code (see replay.ts / evaluateCombo below) - this file only
// aggregates the per-step results into fire-rate/flap-count summaries.
import { DEFAULTS, MARKER_BOARD } from "../../src/CaptureQuality/captureQualityConfig";
import type { MarkerBoardThresholds } from "../../src/CaptureQuality/captureQualityConfig";
import type { MarkerBoardCheckConfig } from "../../src/CaptureQuality/markerBoardCheck";
import type { CaptureQualityIssueCode } from "../../src/CaptureQuality/types";
import { replayRecording } from "./replay";
import type { ParsedCaptureRecording } from "./parse";

export interface SweepGrid {
	liveWindowRecencyWeight: readonly number[];
	/** Swept as the pass/fail size floor (see MarkerBoardThresholds's zone table). sizeIdealLowerNorm/sizeIdealUpperNorm are NOT swept - they never feed a pass/fail branch, only the HUD's positive-confirmation read, so they are held at DEFAULTS.markerBoard in buildCombos below. sizeWarnUpperNorm/sizeWarnUpperClearNorm are also held at DEFAULTS.markerBoard, not swept - see captureQualityConfig.ts for why that boundary is a human-stated framing limit, not a fitted one this tool should be searching for. */
	sizeWarnLowerNorm: readonly number[];
	diagonalRatioMin: readonly number[];
	diagonalRatioMax: readonly number[];
	orientationMarginRad: readonly number[];
	minimumFullSetWeight: readonly number[];
	/** 0.0045 is the 2026-08-13 interpolated ceiling (see captureQualityConfig.ts); null keeps the pre-ceiling "always MARKER_INCOMPLETE" behavior in the grid for comparison. */
	tooCloseDetectedAreaNorm: readonly (number | null)[];
}

// Ranges deliberately span well below and above every UNCALIBRATED default in
// captureQualityConfig.ts rather than hugging the one measured reading quoted in the
// task - a single anecdote is not a range. Grid size is kept in the low thousands of
// combinations so a real 20-30s multi-file sweep finishes in a few seconds.
// Alpha reaches far below the 0.2 floor of the first grid: measured baseline data has
// the far corner (marker 2) dropping 19% of frames in runs of up to 4, so an EWMA
// settling near 0.79 must survive a 4-frame gap without crossing the full-set
// threshold. That needs alpha in the 0.03-0.1 range; anything at or above 0.2 trips on
// a good setup no matter how the other thresholds are set.
// minimumFullSetWeight now reaches up to 0.97 (was capped at 0.6) so the sweep can
// actually bracket the 2026-08-13 sweet-spot default of 0.90 and report what would be
// flap-free around it, not just the old 0.4-era range.
export const DEFAULT_SWEEP_GRID: SweepGrid = {
	liveWindowRecencyWeight: [0.03, 0.05, 0.08, 0.12, 0.2, 0.4],
	sizeWarnLowerNorm: [0.0008, 0.001, 0.0012, 0.0015, 0.0018, 0.002, 0.003, 0.009],
	diagonalRatioMin: [0.05, 0.1, 0.15, 0.19],
	diagonalRatioMax: [0.45, 0.6, 0.75],
	orientationMarginRad: [0.2, 0.25, 0.3, 0.5],
	minimumFullSetWeight: [0.3, 0.4, 0.5, 0.6, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97],
	tooCloseDetectedAreaNorm: [null, 0.0045],
};

export interface SweepCombo {
	alpha: number;
	thresholds: MarkerBoardThresholds;
}

export function buildCombos(grid: SweepGrid = DEFAULT_SWEEP_GRID): SweepCombo[] {
	const combos: SweepCombo[] = [];
	for (const alpha of grid.liveWindowRecencyWeight) {
		for (const sizeWarnLowerNorm of grid.sizeWarnLowerNorm) {
			for (const diagonalRatioMin of grid.diagonalRatioMin) {
				for (const diagonalRatioMax of grid.diagonalRatioMax) {
					for (const orientationMarginRad of grid.orientationMarginRad) {
						for (const minimumFullSetWeight of grid.minimumFullSetWeight) {
							for (const tooCloseDetectedAreaNorm of grid.tooCloseDetectedAreaNorm) {
								combos.push({
									alpha,
									thresholds: {
										sizeWarnLowerNorm,
										// Hysteresis clear levels are NOT swept alongside their warn
										// levels above - held fixed at DEFAULTS, same as
										// persistentMissThresholdMs below. This tool explores warn-level
										// placement, not hysteresis gap sizing; a swept warn level can
										// therefore land past its (fixed) clear level for some combos,
										// which is harmless here (applyHysteresis degrades gracefully -
										// see markerBoardCheck.ts) but means the per-combo flap counts
										// this tool reports do not necessarily reflect the actual
										// DEFAULTS hysteresis gaps unless sizeWarnLowerNorm/
										// minimumFullSetWeight/orientationMarginRad happen to match
										// DEFAULTS too.
										sizeWarnLowerClearNorm: DEFAULTS.markerBoard.sizeWarnLowerClearNorm,
										// Not swept - see the SweepGrid field doc: these boundaries
										// never feed a pass/fail branch, so sweeping them would not
										// change any classification this tool measures.
										sizeIdealLowerNorm: DEFAULTS.markerBoard.sizeIdealLowerNorm,
										sizeIdealUpperNorm: DEFAULTS.markerBoard.sizeIdealUpperNorm,
										sizeWarnUpperNorm: DEFAULTS.markerBoard.sizeWarnUpperNorm,
										sizeWarnUpperClearNorm: DEFAULTS.markerBoard.sizeWarnUpperClearNorm,
										diagonalRatioMin,
										diagonalRatioMax,
										orientationMarginRad,
										orientationClearMarginRad: DEFAULTS.markerBoard.orientationClearMarginRad,
										minimumFullSetWeight,
										minimumFullSetClearWeight: DEFAULTS.markerBoard.minimumFullSetClearWeight,
										tooCloseDetectedAreaNorm,
										// Not swept - the task calibrates marker geometry, not the
										// persistence threshold, which is spec-given (see
										// captureQualityConfig.ts). Held fixed so combos vary only
										// the fields this tool is meant to explore.
										persistentMissThresholdMs: DEFAULTS.markerBoard.persistentMissThresholdMs,
									},
								});
							}
						}
					}
				}
			}
		}
	}
	return combos;
}

export interface ComboFileResult {
	sourceLabel: string;
	scenarioTag: string;
	codePct: Partial<Record<CaptureQualityIssueCode, number>>;
	dominantState: string;
	flapCount: number;
	stepCount: number;
}

export interface ComboResult {
	combo: SweepCombo;
	perFile: ComboFileResult[];
	totalFlapCount: number;
}

function stateKey(codes: readonly CaptureQualityIssueCode[]): string {
	return codes.length === 0 ? "OK" : [...codes].sort().join("+");
}

export function evaluateCombo(combo: SweepCombo, recordings: readonly ParsedCaptureRecording[], windowSize: number): ComboResult {
	const config: MarkerBoardCheckConfig = {
		layout: MARKER_BOARD,
		thresholds: combo.thresholds,
		liveWindowRecencyWeight: combo.alpha,
	};

	const perFile: ComboFileResult[] = recordings.map((recording) => {
		const steps = replayRecording(recording, config, windowSize);
		const codeCounts: Partial<Record<CaptureQualityIssueCode, number>> = {};
		const stateCounts = new Map<string, number>();
		let flapCount = 0;
		let prevKey: string | null = null;

		for (const step of steps) {
			for (const code of step.activeCodes) {
				codeCounts[code] = (codeCounts[code] ?? 0) + 1;
			}
			const key = stateKey(step.activeCodes);
			stateCounts.set(key, (stateCounts.get(key) ?? 0) + 1);
			if (prevKey !== null && key !== prevKey) flapCount++;
			prevKey = key;
		}

		const codePct: Partial<Record<CaptureQualityIssueCode, number>> = {};
		for (const [code, count] of Object.entries(codeCounts)) {
			codePct[code as CaptureQualityIssueCode] = steps.length > 0 ? (count / steps.length) * 100 : 0;
		}

		let dominantState = "OK";
		let dominantCount = -1;
		for (const [key, count] of stateCounts) {
			if (count > dominantCount) {
				dominantState = key;
				dominantCount = count;
			}
		}

		return { sourceLabel: recording.sourceLabel, scenarioTag: recording.scenarioTag, codePct, dominantState, flapCount, stepCount: steps.length };
	});

	return { combo, perFile, totalFlapCount: perFile.reduce((sum, f) => sum + f.flapCount, 0) };
}

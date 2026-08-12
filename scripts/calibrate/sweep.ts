// Sweeps the recency-weight alpha and the four MarkerBoardThresholds pass/fail fields
// (minimumFullSetWeight is included alongside the three geometry thresholds - it is the
// lever most directly responsible for the marker-dropout flapping this whole tool
// exists to diagnose, per the recorded-data note in the task). Every combination is
// replayed through the real code (see replay.ts / evaluateCombo below) - this file only
// aggregates the per-step results into fire-rate/flap-count summaries.
import { MARKER_BOARD } from "../../src/CaptureQuality/captureQualityConfig";
import type { MarkerBoardThresholds } from "../../src/CaptureQuality/captureQualityConfig";
import type { MarkerBoardCheckConfig } from "../../src/CaptureQuality/markerBoardCheck";
import type { CaptureQualityIssueCode } from "../../src/CaptureQuality/types";
import { replayRecording } from "./replay";
import type { ParsedCaptureRecording } from "./parse";

export interface SweepGrid {
	liveWindowRecencyWeight: readonly number[];
	minimumMarkerAreaNorm: readonly number[];
	diagonalRatioMin: readonly number[];
	diagonalRatioMax: readonly number[];
	orientationMarginRad: readonly number[];
	minimumFullSetWeight: readonly number[];
	/** No committed recording carries the data to sweep this meaningfully (see replay.ts) - fixed at "disabled" so it doesn't inflate the combo count. */
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
export const DEFAULT_SWEEP_GRID: SweepGrid = {
	liveWindowRecencyWeight: [0.03, 0.05, 0.08, 0.12, 0.2, 0.4],
	minimumMarkerAreaNorm: [0.0008, 0.001, 0.0012, 0.0015, 0.0018, 0.002, 0.003, 0.009],
	diagonalRatioMin: [0.05, 0.1, 0.15, 0.19],
	diagonalRatioMax: [0.45, 0.6, 0.75],
	orientationMarginRad: [0.2, 0.25, 0.3, 0.5],
	minimumFullSetWeight: [0.3, 0.4, 0.5, 0.6],
	tooCloseDetectedAreaNorm: [null],
};

export interface SweepCombo {
	alpha: number;
	thresholds: MarkerBoardThresholds;
}

export function buildCombos(grid: SweepGrid = DEFAULT_SWEEP_GRID): SweepCombo[] {
	const combos: SweepCombo[] = [];
	for (const alpha of grid.liveWindowRecencyWeight) {
		for (const minimumMarkerAreaNorm of grid.minimumMarkerAreaNorm) {
			for (const diagonalRatioMin of grid.diagonalRatioMin) {
				for (const diagonalRatioMax of grid.diagonalRatioMax) {
					for (const orientationMarginRad of grid.orientationMarginRad) {
						for (const minimumFullSetWeight of grid.minimumFullSetWeight) {
							for (const tooCloseDetectedAreaNorm of grid.tooCloseDetectedAreaNorm) {
								combos.push({
									alpha,
									thresholds: {
										minimumMarkerAreaNorm,
										diagonalRatioMin,
										diagonalRatioMax,
										orientationMarginRad,
										minimumFullSetWeight,
										tooCloseDetectedAreaNorm,
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

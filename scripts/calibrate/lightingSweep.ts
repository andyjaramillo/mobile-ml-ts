// Sweeps the lighting thresholds (captureQualityConfig.ts LightingThresholds) and the
// recency-weight alpha, mirroring sweep.ts's marker-board sweep exactly but over
// replayLighting/aggregateLowLightMetrics instead. Kept as a separate file rather than
// folded into sweep.ts: that file's own header says "Sweeps... four MarkerBoardThresholds"
// and the task calls for keeping the existing marker sweep intact, not generalizing it.
import { DEFAULTS, LIGHTING_GRID, LIGHTING_ROI } from "../../src/CaptureQuality/captureQualityConfig";
import type { LightingThresholds } from "../../src/CaptureQuality/captureQualityConfig";
import type { LowLightCheckConfig } from "../../src/CaptureQuality/lowLightCheck";
import type { CaptureQualityIssueCode } from "../../src/CaptureQuality/types";
import { replayLighting } from "./lightingReplay";
import type { ParsedCaptureRecording } from "./parse";

export interface LightingSweepGrid {
	liveWindowRecencyWeight: readonly number[];
	cellDarkLumaMax: readonly number[];
	darkCellFractionThreshold: readonly number[];
	cellFlatContrastMax: readonly number[];
	flatCellFractionThreshold: readonly number[];
}

// No real lighting data existed anywhere in this repo before this change (the six
// pre-existing calibration/*.cq1.txt recordings are CQ1 - no lighting section at all),
// so - like DEFAULT_SWEEP_GRID's own comment about not hugging a single anecdote - this
// range is a broad, unvalidated span over plausible 8-bit luma/contrast values, not a
// range informed by any measurement. It exists so the mechanism works the day real CQ2
// recordings arrive; the specific numbers should be revisited once they do.
export const DEFAULT_LIGHTING_SWEEP_GRID: LightingSweepGrid = {
	liveWindowRecencyWeight: [0.1, 0.15, 0.3, 0.5],
	cellDarkLumaMax: [20, 30, 40, 60, 80],
	darkCellFractionThreshold: [0.1, 0.2, 0.35, 0.5],
	cellFlatContrastMax: [5, 10, 15, 25],
	flatCellFractionThreshold: [0.1, 0.2, 0.35, 0.5],
};

export interface LightingSweepCombo {
	alpha: number;
	thresholds: LightingThresholds;
}

export function buildLightingCombos(grid: LightingSweepGrid = DEFAULT_LIGHTING_SWEEP_GRID): LightingSweepCombo[] {
	const combos: LightingSweepCombo[] = [];
	for (const alpha of grid.liveWindowRecencyWeight) {
		for (const cellDarkLumaMax of grid.cellDarkLumaMax) {
			for (const darkCellFractionThreshold of grid.darkCellFractionThreshold) {
				for (const cellFlatContrastMax of grid.cellFlatContrastMax) {
					for (const flatCellFractionThreshold of grid.flatCellFractionThreshold) {
						combos.push({
							alpha,
							thresholds: {
								cellDarkLumaMax,
								darkCellFractionThreshold,
								// Clear levels held at DEFAULTS, not swept - this tool
								// explores warn-level placement only.
								darkCellFractionClearThreshold: DEFAULTS.lighting.darkCellFractionClearThreshold,
								cellFlatContrastMax,
								flatCellFractionThreshold,
								flatCellFractionClearThreshold: DEFAULTS.lighting.flatCellFractionClearThreshold,
							},
						});
					}
				}
			}
		}
	}
	return combos;
}

export interface LightingComboFileResult {
	sourceLabel: string;
	scenarioTag: string;
	codePct: Partial<Record<CaptureQualityIssueCode, number>>;
	dominantState: string;
	flapCount: number;
	stepCount: number;
}

export interface LightingComboResult {
	combo: LightingSweepCombo;
	perFile: LightingComboFileResult[];
	totalFlapCount: number;
}

function stateKey(codes: readonly CaptureQualityIssueCode[]): string {
	return codes.length === 0 ? "OK" : [...codes].sort().join("+");
}

export function evaluateLightingCombo(
	combo: LightingSweepCombo,
	recordings: readonly ParsedCaptureRecording[],
	windowSize: number
): LightingComboResult {
	const config: LowLightCheckConfig = { grid: LIGHTING_GRID, roi: LIGHTING_ROI, thresholds: combo.thresholds, liveWindowRecencyWeight: combo.alpha };

	// Whole-frame recordings are excluded even when they carry lighting samples: sweeping
	// ROI-fit thresholds against whole-frame stats would pool two different measurements.
	const perFile: LightingComboFileResult[] = recordings
		.filter((r) => r.lightingScope === "roi" && r.lightingSamples.length > 0)
		.map((recording) => {
			const steps = replayLighting(recording, config, windowSize);
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

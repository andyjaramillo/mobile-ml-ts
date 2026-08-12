// CLI entry point: `npm run calibrate -- <export-file> [export-file...]`.
// Ingests one or more pasted CQ1 recordings (see src/CaptureQualityHud/captureRecorder.ts
// for the format) and reports what the real markerBoardCheck.ts aggregation would have
// done under a grid of alpha/threshold combinations, plus raw distribution and
// per-marker dropout stats. Exists so threshold tuning is a replay against recorded
// data instead of a human re-testing on-device per attempt.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { DEFAULTS, MARKER_BOARD } from "../../src/CaptureQuality/captureQualityConfig";
import { parseCompactExportFile } from "./parse";
import type { ParsedCaptureRecording } from "./parse";
import { computeDropoutStats, summarize } from "./stats";
import type { DistributionStats } from "./stats";
import { buildCombos, evaluateCombo } from "./sweep";
import type { ComboResult } from "./sweep";

const TOP_N = 15;

function fmtStats(label: string, stats: DistributionStats | null): string {
	if (!stats) return `    ${label}: no full-set frames with this metric computed`;
	return (
		`    ${label}: n=${stats.count} min=${stats.min.toFixed(5)} p5=${stats.p5.toFixed(5)} ` +
		`median=${stats.median.toFixed(5)} mean=${stats.mean.toFixed(5)} p95=${stats.p95.toFixed(5)} ` +
		`max=${stats.max.toFixed(5)} std=${stats.std.toFixed(5)}`
	);
}

function decodedValues(recording: ParsedCaptureRecording, pick: "area" | "diag" | "rot", exponentIndex: 0 | 1 | 2): number[] {
	const scale = 10 ** recording.scaleExponents[exponentIndex];
	const out: number[] = [];
	for (const s of recording.samples) {
		const raw = s[pick];
		if (raw !== null) out.push(raw / scale);
	}
	return out;
}

function printRecordingStats(recording: ParsedCaptureRecording): void {
	console.log(`\n  ${recording.sourceLabel} ("${recording.scenarioTag}")`);
	console.log(fmtStats("normalizedArea", summarize(decodedValues(recording, "area", 0))));
	console.log(fmtStats("diagonalRatio ", summarize(decodedValues(recording, "diag", 1))));
	console.log(fmtStats("orientationRad", summarize(decodedValues(recording, "rot", 2))));

	const fullSetCount = recording.samples.filter((s) => s.bitmask === (1 << MARKER_BOARD.expectedMarkerIds.length) - 1).length;
	console.log(`    full-set frames: ${fullSetCount}/${recording.samples.length} (${((fullSetCount / Math.max(1, recording.samples.length)) * 100).toFixed(1)}%)`);

	console.log(`    per-marker dropout (missing = bit not set):`);
	for (const d of computeDropoutStats(recording.samples, MARKER_BOARD.expectedMarkerIds)) {
		console.log(`      id ${d.markerId}: missing ${d.missingCount}/${recording.samples.length} (${d.missingPct.toFixed(1)}%), longest run ${d.longestMissingRun}`);
	}
}

function writeSweepCsv(path: string, results: readonly ComboResult[]): void {
	const header = [
		"alpha",
		"minimumMarkerAreaNorm",
		"diagonalRatioMin",
		"diagonalRatioMax",
		"orientationMarginRad",
		"minimumFullSetWeight",
		"sourceLabel",
		"scenarioTag",
		"stepCount",
		"flapCount",
		"dominantState",
		"pct_MARKER_INCOMPLETE",
		"pct_MARKER_TOO_SMALL",
		"pct_MARKER_SKEWED",
		"pct_MARKER_WRONG_ORIENTATION",
	];
	const rows = results.flatMap((result) =>
		result.perFile.map((f) =>
			[
				result.combo.alpha,
				result.combo.thresholds.minimumMarkerAreaNorm,
				result.combo.thresholds.diagonalRatioMin,
				result.combo.thresholds.diagonalRatioMax,
				result.combo.thresholds.orientationMarginRad,
				result.combo.thresholds.minimumFullSetWeight,
				f.sourceLabel,
				f.scenarioTag,
				f.stepCount,
				f.flapCount,
				f.dominantState,
				(f.codePct.MARKER_INCOMPLETE ?? 0).toFixed(2),
				(f.codePct.MARKER_TOO_SMALL ?? 0).toFixed(2),
				(f.codePct.MARKER_SKEWED ?? 0).toFixed(2),
				(f.codePct.MARKER_WRONG_ORIENTATION ?? 0).toFixed(2),
			].join(",")
		)
	);
	mkdirSync("calibrate-output", { recursive: true });
	writeFileSync(path, [header.join(","), ...rows].join("\n"));
}

function comboLabel(result: ComboResult): string {
	const t = result.combo.thresholds;
	return `alpha=${result.combo.alpha} area>=${t.minimumMarkerAreaNorm} diag=[${t.diagonalRatioMin},${t.diagonalRatioMax}] orient<=${t.orientationMarginRad} fullset>=${t.minimumFullSetWeight}`;
}

function printComboTable(results: readonly ComboResult[]): void {
	for (const result of results) {
		console.log(`  ${comboLabel(result)}  total_flaps=${result.totalFlapCount}`);
		for (const f of result.perFile) {
			const codes = Object.entries(f.codePct)
				.map(([code, pct]) => `${code}=${(pct ?? 0).toFixed(1)}%`)
				.join(" ");
			console.log(`      ${f.sourceLabel} ("${f.scenarioTag}"): dominant=${f.dominantState} flaps=${f.flapCount} ${codes || "(no codes fired)"}`);
		}
	}
}

function main(): void {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.error("usage: npm run calibrate -- <export-file> [export-file...]");
		process.exitCode = 1;
		return;
	}

	const recordings = args.flatMap((path) => parseCompactExportFile(path, readFileSync(path, "utf8")));
	if (recordings.length === 0) {
		console.error("no CQ1 recording lines found in the given file(s)");
		process.exitCode = 1;
		return;
	}

	console.log(`loaded ${recordings.length} recording(s) from ${args.length} file(s):`);
	for (const r of recordings) {
		console.log(
			`  ${r.sourceLabel}: tag="${r.scenarioTag}" samples=${r.samples.length} stride=${r.stride} fps~=${r.fpsMean} res=${r.frameWidth}x${r.frameHeight}` +
				(r.stride > 1 ? " (decimated - buffer cap was hit while recording, gaps between samples are wider than 1 tick)" : "")
		);
	}

	console.log("\n--- per-recording metric distributions and marker dropout ---");
	for (const r of recordings) printRecordingStats(r);

	const windowSize = DEFAULTS.sampling.liveWindowFrameCount;
	const combos = buildCombos();
	console.log(`\n--- parameter sweep: ${combos.length} combinations, replay window=${windowSize} frames (DEFAULTS.sampling.liveWindowFrameCount) ---`);
	const start = Date.now();
	const results = combos.map((combo) => evaluateCombo(combo, recordings, windowSize));
	console.log(`sweep replayed in ${Date.now() - start}ms`);

	const outPath = `calibrate-output/sweep-${Date.now()}.csv`;
	writeSweepCsv(outPath, results);
	console.log(`full grid (${results.length} combos x ${recordings.length} recording(s)) written to ${outPath}`);

	const sortedByFlap = [...results].sort((a, b) => a.totalFlapCount - b.totalFlapCount);
	console.log(`\n--- lowest-flap candidates (top ${TOP_N} of ${results.length}; low flap only, not validated against ground truth) ---`);
	printComboTable(sortedByFlap.slice(0, TOP_N));

	if (recordings.length < 2) {
		console.log(
			"\n--- separation across recordings: UNDETERMINABLE ---\n" +
				"  Only one recording was provided. This tool cannot tell whether any threshold\n" +
				"  combination distinguishes a passing capture from a failing one without at least\n" +
				"  one more recording of a contrasting scenario. The stats above describe this\n" +
				"  recording in isolation only."
		);
	} else {
		const separating = results.filter((r) => new Set(r.perFile.map((f) => f.dominantState)).size > 1);
		if (separating.length === 0) {
			console.log(
				"\n--- separation across recordings: NONE FOUND ---\n" +
					"  No combination in the sweep produced a different steady-state indicator across\n" +
					"  the provided recordings. Either these recordings are not meaningfully different\n" +
					"  in the recorded marker geometry, or the swept ranges do not separate them.\n" +
					"  Do not treat the lowest-flap candidates above as a pass/fail threshold - they\n" +
					"  only describe stability, not correctness, until a genuinely contrasting\n" +
					"  recording (e.g. board clearly too far away) is captured and replayed."
			);
		} else {
			const bestSeparating = [...separating].sort((a, b) => a.totalFlapCount - b.totalFlapCount).slice(0, TOP_N);
			console.log(
				`\n--- separating candidates (top ${bestSeparating.length} of ${separating.length} combos where recordings land on different steady states) ---\n` +
					"  These are candidates worth investigating by hand, not a final recommendation -\n" +
					"  \"separates\" here only means the dominant code differs between recordings, not\n" +
					"  that the classification is the medically/functionally correct one."
			);
			printComboTable(bestSeparating);
		}
	}
}

main();

// The six subject recordings ARE the specification for this check. Each one replays through
// the real aggregation (see scripts/calibrate/subjectReplay.ts - no reimplementation) and
// pins the classification it must produce. A threshold change that breaks real-world
// behavior fails here instead of being discovered on a phone.
//
// Captured 2026-08-17 on the real board with a real subject, at the ~3Hz the device actually
// delivers. These are the FIRST recordings in this repo containing a person at all.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/CaptureQuality/captureQualityConfig";
import { defaultSubjectPositionCheckConfig } from "../../src/CaptureQuality/subjectPositionCheck";
import { parseCompactExportFile } from "../../scripts/calibrate/parse";
import { replaySubjectRecording } from "../../scripts/calibrate/subjectReplay";

const CALIBRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../calibration");
const config = defaultSubjectPositionCheckConfig(DEFAULTS);

// Resolved by scenario name rather than by full filename: recordings carry the date they
// were captured, and a later session adding one would otherwise have to touch every call.
function replay(name: string) {
	const file = readdirSync(CALIBRATION_DIR).find((f) => f.endsWith(`gait-${name}.cq4.txt`));
	if (!file) throw new Error(`no calibration recording for scenario "${name}"`);
	const [recording] = parseCompactExportFile(file, readFileSync(join(CALIBRATION_DIR, file), "utf8"));
	return { recording, aggregate: replaySubjectRecording(recording, config) };
}

describe("subject recordings replayed through the real check", () => {
	it("subject-at-start-still: green light", () => {
		const { aggregate } = replay("subject-at-start-still");
		expect(aggregate.activeCodes).toEqual([]);
		expect(aggregate.weightedBoardToSubjectGapNorm as number).toBeGreaterThan(config.thresholds.tooFarBackGapNorm);
	});

	it("subject-at-start-fidget: green light - normal sway must not warn", () => {
		const { aggregate } = replay("subject-at-start-fidget");
		expect(aggregate.activeCodes).toEqual([]);
	});

	it("subject-too-far-back: SUBJECT_NOT_AT_START_LINE", () => {
		const { aggregate } = replay("subject-too-far-back");
		expect(aggregate.activeCodes).toContain("SUBJECT_NOT_AT_START_LINE");
	});

	it("subject-absent: SUBJECT_NOT_DETECTED", () => {
		const { aggregate } = replay("subject-absent");
		expect(aggregate.activeCodes).toContain("SUBJECT_NOT_DETECTED");
	});

	it("subject-two-people: MULTIPLE_PEOPLE", () => {
		const { aggregate } = replay("subject-two-people");
		expect(aggregate.activeCodes).toContain("MULTIPLE_PEOPLE");
	});

	it("subject-walking-away: does NOT warn about movement", () => {
		// Stillness is deliberately not gated. The check may report position, but must never
		// emit a stationarity code - that is not something this feature warns about.
		const { aggregate } = replay("subject-walking-away");
		expect(aggregate.activeCodes).not.toContain("SUBJECT_NOT_STATIONARY");
	});

	it("separates at-the-line from too-far-back where neither earlier signal could", () => {
		// Both discarded signals, pinned so nobody reinstates one: centroid distance reads the
		// same for both states, and bbox area overlaps once lateral movement is included.
		const still = replay("subject-at-start-still").aggregate;
		const farBack = replay("subject-too-far-back").aggregate;
		const lateral = replay("subject-far-back-lateral").aggregate;

		const stillDist = still.weightedStartLineDistanceBoardLengths as number;
		const farDist = farBack.weightedStartLineDistanceBoardLengths as number;
		expect(Math.abs(stillDist - farDist)).toBeLessThan(0.3); // distance: indistinguishable

		// area: the lateral recording's subject is too far back throughout, yet reads SMALLER
		// than the at-the-line one because frame-edge clipping shrinks the box.
		expect(lateral.weightedSubjectAreaNorm as number).toBeLessThan(still.weightedSubjectAreaNorm as number);

		// gap: cleanly separated, and the lateral recording lands with the far-back class.
		const gate = config.thresholds.tooFarBackGapNorm;
		expect(still.weightedBoardToSubjectGapNorm as number).toBeGreaterThan(gate);
		expect(farBack.weightedBoardToSubjectGapNorm as number).toBeLessThan(gate);
		expect(lateral.weightedBoardToSubjectGapNorm as number).toBeLessThan(gate);
	});

	it("subject-far-back-lateral: too far back for the whole lateral sweep", () => {
		// The recording that killed the area signal: the subject crosses the frame from edge
		// to edge while staying too far back. Every part of that sweep must classify the same.
		const { aggregate } = replay("subject-far-back-lateral");
		expect(aggregate.activeCodes).toContain("SUBJECT_NOT_AT_START_LINE");
	});

	it("detects a person on every detection tick in all five populated recordings", () => {
		for (const name of [
			"subject-at-start-still",
			"subject-at-start-fidget",
			"subject-too-far-back",
			"subject-two-people",
			"subject-walking-away",
		]) {
			const { aggregate } = replay(name);
			expect(aggregate.weightedDetectionScore).toBeCloseTo(1, 5);
		}
	});
});

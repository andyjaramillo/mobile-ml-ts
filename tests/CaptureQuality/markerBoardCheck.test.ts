import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/CaptureQuality/captureQualityConfig";
import type { CaptureQualityDetectedMarker, CaptureQualityFrameSample } from "../../src/CaptureQuality/types";
import {
	aggregateMarkerBoardMetrics,
	createMarkerBoardFrameWindow,
	defaultMarkerBoardCheckConfig,
	evaluateMarkerBoardFrame,
	evaluateMarkerBoardWindow,
	evaluateMarkerBoardWindowAggregate,
	pushMarkerBoardFrame,
	resetMarkerBoardFrameWindow,
} from "../../src/CaptureQuality/markerBoardCheck";
import type { MarkerBoardFrameMetrics } from "../../src/CaptureQuality/markerBoardCheck";
import { parseCompactExportFile } from "../../scripts/calibrate/parse";
import { replayRecording } from "../../scripts/calibrate/replay";

const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 360;

// Real measured values from the six 2026-08-12 iPhone recordings against the physical
// ArUco board (see calibration/*.cq1.txt and captureQualityConfig.ts for the full
// derivation). Fixtures below are sized/valued to hit these exact numbers so a future
// threshold change that breaks real-world behavior fails a test, not just a synthetic one.
const AREA_D_MID_MEDIAN = 0.00316; // d-mid 1.5m (GOOD, 93% full-set rate) normalizedArea median
const AREA_BASELINE_MEDIAN = 0.00229; // baseline (marginal, 79% full-set rate) normalizedArea median
const ORIENTATION_ALIGNED_MEDIAN = 0.1518; // d-mid orientationRad median - an on-axis board, not zero (see phone-roll comment below)
const ORIENTATION_ROT_SLIGHT_MEDIAN = 0.8221; // rot-slight (~43 deg intentional yaw) orientationRad median
const ORIENTATION_ROT_90_MEDIAN = 1.5656; // rot-90 (90 deg intentional yaw) orientationRad median

// size such that a square marker's bbox area / (FRAME_WIDTH*FRAME_HEIGHT) equals `area`
// exactly (up to floating point) - lets the fixtures below be built from the real
// normalizedArea constants above rather than an arbitrary pixel size.
function sizeForArea(area: number): number {
	return Math.sqrt(area * FRAME_WIDTH * FRAME_HEIGHT);
}

const GOOD_SIZE = sizeForArea(AREA_D_MID_MEDIAN);
const TOO_SMALL_SIZE = sizeForArea(AREA_BASELINE_MEDIAN);

const config = defaultMarkerBoardCheckConfig(DEFAULTS);

function squareMarker(id: number, cx: number, cy: number, size: number): CaptureQualityDetectedMarker {
	const h = size / 2;
	return {
		id,
		corners: [
			{ x: cx - h, y: cy - h },
			{ x: cx + h, y: cy - h },
			{ x: cx + h, y: cy + h },
			{ x: cx - h, y: cy + h },
		],
	};
}

// Synthetic diamond arranged around the hardware-verified corner roles (top=2,
// right=0, bottom=6, left=8). diagonalRatio is no longer a firing check (widened to
// non-firing in captureQualityConfig.ts - it's confounded by distance/rotation/aspect
// ratio, see that file), so this fixture no longer needs foreshortening to dodge it;
// kept for realism only.
function fullSetMarkers(size: number): CaptureQualityDetectedMarker[] {
	const cx = FRAME_WIDTH / 2;
	const cy = FRAME_HEIGHT / 2;
	const vh = 90;
	const hh = 250;
	return [
		squareMarker(2, cx, cy - vh, size),
		squareMarker(0, cx + hh, cy, size),
		squareMarker(6, cx, cy + vh, size),
		squareMarker(8, cx - hh, cy, size),
		squareMarker(1, cx, cy - vh / 2, size),
		squareMarker(5, cx - hh / 2, cy, size),
		squareMarker(4, cx, cy, size),
		squareMarker(3, cx + hh / 2, cy, size),
		squareMarker(7, cx, cy + vh / 2, size),
	];
}

function frameFor(markers: CaptureQualityDetectedMarker[] | null): CaptureQualityFrameSample {
	return {
		imageData: null,
		timestampMs: 0,
		frameWidth: FRAME_WIDTH,
		frameHeight: FRAME_HEIGHT,
		people: null,
		markers,
	};
}

describe("evaluateMarkerBoardWindow", () => {
	it("reports no issues for an aligned, well-framed full board (real d-mid 1.5m area)", () => {
		const results = evaluateMarkerBoardWindow([frameFor(fullSetMarkers(GOOD_SIZE))], config);
		expect(results).toEqual([]);
	});

	it("does not fire MARKER_INCOMPLETE when the full marker set is visible", () => {
		const results = evaluateMarkerBoardWindow([frameFor(fullSetMarkers(GOOD_SIZE))], config);
		expect(results.some((r) => r.code === "MARKER_INCOMPLETE")).toBe(false);
	});

	it("fires only MARKER_INCOMPLETE, suppressing geometry codes, when the board is not fully visible", () => {
		const markers = fullSetMarkers(GOOD_SIZE).slice(0, 5); // 5 of 9 expected ids
		const results = evaluateMarkerBoardWindow([frameFor(markers)], config);
		expect(results.map((r) => r.code)).toEqual(["MARKER_INCOMPLETE"]);
	});

	it("fires MARKER_TOO_SMALL for the real baseline (marginal) area, not MARKER_INCOMPLETE", () => {
		const results = evaluateMarkerBoardWindow([frameFor(fullSetMarkers(TOO_SMALL_SIZE))], config);
		expect(results.some((r) => r.code === "MARKER_INCOMPLETE")).toBe(false);
		expect(results.some((r) => r.code === "MARKER_TOO_SMALL")).toBe(true);
	});

	it("surfaces both the weighted-window aggregate and the latest frame in details", () => {
		const results = evaluateMarkerBoardWindow([frameFor(fullSetMarkers(TOO_SMALL_SIZE))], config);
		const details = results[0].details;
		expect(typeof details.weightedFullSetScore).toBe("number");
		expect(typeof details.weightedNormalizedArea).toBe("number");
		expect(typeof details.latestNormalizedArea).toBe("number");
		expect(typeof details.latestVisibleCount).toBe("number");
	});
});

describe("evaluateMarkerBoardFrame", () => {
	it("treats duplicate marker IDs as an invalid set without crashing", () => {
		const markers = [...fullSetMarkers(GOOD_SIZE), squareMarker(4, 10, 10, GOOD_SIZE)];
		expect(() => evaluateMarkerBoardFrame(frameFor(markers), config)).not.toThrow();
		const metrics = evaluateMarkerBoardFrame(frameFor(markers), config);
		expect(metrics.isFullSet).toBe(false);
		expect(metrics.normalizedArea).toBeNull();
	});

	it("ignores marker IDs outside the expected set without crashing", () => {
		const markers = [...fullSetMarkers(GOOD_SIZE), squareMarker(42, 5, 5, GOOD_SIZE)];
		expect(() => evaluateMarkerBoardFrame(frameFor(markers), config)).not.toThrow();
		const metrics = evaluateMarkerBoardFrame(frameFor(markers), config);
		expect(metrics.isFullSet).toBe(true);
		expect(metrics.visibleCount).toBe(10);
	});

	it("returns null metrics rather than crashing when there are no markers at all", () => {
		const metrics = evaluateMarkerBoardFrame(frameFor(null), config);
		expect(metrics).toEqual({
			visibleCount: 0,
			visibleIds: [],
			isFullSet: false,
			normalizedArea: null,
			diagonalRatio: null,
			orientationAngleRad: null,
			geometryOk: null,
			orientationOk: null,
			detectedMarkerAreaNorm: null,
		});
	});

	it("computes detectedMarkerAreaNorm from whatever markers ARE present on an incomplete set, unlike normalizedArea which stays null", () => {
		const markers = fullSetMarkers(GOOD_SIZE).slice(0, 5); // 5 of 9 - incomplete
		const metrics = evaluateMarkerBoardFrame(frameFor(markers), config);
		expect(metrics.isFullSet).toBe(false);
		expect(metrics.normalizedArea).toBeNull();
		expect(metrics.detectedMarkerAreaNorm).toBeCloseTo(AREA_D_MID_MEDIAN, 5);
	});
});

describe("orientation gates the metrics that assume its corner-role mapping (priority reorder)", () => {
	function metricsFullSet(overrides: Partial<MarkerBoardFrameMetrics> = {}): MarkerBoardFrameMetrics {
		return {
			visibleCount: 9,
			visibleIds: [0, 1, 2, 3, 4, 5, 6, 7, 8],
			isFullSet: true,
			normalizedArea: AREA_D_MID_MEDIAN,
			diagonalRatio: 0.24,
			orientationAngleRad: ORIENTATION_ALIGNED_MEDIAN,
			geometryOk: null,
			orientationOk: null,
			detectedMarkerAreaNorm: AREA_D_MID_MEDIAN,
			...overrides,
		};
	}

	it("an aligned full-set frame at the real d-mid orientation and area passes clean", () => {
		const aggregate = aggregateMarkerBoardMetrics([metricsFullSet()], config);
		expect(aggregate.activeCodes).toEqual([]);
	});

	it("the real rot-slight orientation (0.822 rad) trips MARKER_WRONG_ORIENTATION", () => {
		const aggregate = aggregateMarkerBoardMetrics(
			[metricsFullSet({ orientationAngleRad: ORIENTATION_ROT_SLIGHT_MEDIAN })],
			config
		);
		expect(aggregate.activeCodes).toEqual(["MARKER_WRONG_ORIENTATION"]);
	});

	it("gates MARKER_TOO_SMALL behind orientation: a rotated frame with the real baseline (too-small) area reports only WRONG_ORIENTATION", () => {
		// rot-90's own measured area (0.00414) is actually ABOVE minimumMarkerAreaNorm, so
		// this deliberately combines rot-90's real orientation with baseline's real
		// (too-small) area to prove the gate, not just describe one recording.
		const aggregate = aggregateMarkerBoardMetrics(
			[metricsFullSet({ orientationAngleRad: ORIENTATION_ROT_90_MEDIAN, normalizedArea: AREA_BASELINE_MEDIAN })],
			config
		);
		expect(aggregate.activeCodes).toEqual(["MARKER_WRONG_ORIENTATION"]);
		expect(aggregate.activeCodes).not.toContain("MARKER_TOO_SMALL");
	});
});

describe("MARKER_TOO_CLOSE vs MARKER_INCOMPLETE", () => {
	function metricsIncomplete(detectedMarkerAreaNorm: number | null): MarkerBoardFrameMetrics {
		return {
			visibleCount: 3,
			visibleIds: [1, 2, 5],
			isFullSet: false,
			normalizedArea: null,
			diagonalRatio: null,
			orientationAngleRad: null,
			geometryOk: null,
			orientationOk: null,
			detectedMarkerAreaNorm,
		};
	}

	it("with DEFAULTS (tooCloseDetectedAreaNorm uncalibrated/null), a large-marker incomplete set still reports MARKER_INCOMPLETE", () => {
		// Documents the deliberate ship-disabled state (see captureQualityConfig.ts): no
		// committed recording has real partial-set marker-size data to calibrate this
		// against, so the split never fires under DEFAULTS today, even for a very large
		// detected area.
		const aggregate = aggregateMarkerBoardMetrics([metricsIncomplete(0.05)], config);
		expect(aggregate.activeCodes).toEqual(["MARKER_INCOMPLETE"]);
	});

	// The two cases below prove the classification LOGIC itself is correct, using an
	// explicit test-local threshold (0.02) rather than DEFAULTS - that threshold is not
	// calibrated or claimed as a real boundary (see the test above and
	// captureQualityConfig.ts for why no real one exists yet).
	const testThresholdConfig = {
		...config,
		thresholds: { ...config.thresholds, tooCloseDetectedAreaNorm: 0.02 },
	};

	it("a large-marker incomplete set trips MARKER_TOO_CLOSE, not MARKER_INCOMPLETE, once a threshold is configured", () => {
		const aggregate = aggregateMarkerBoardMetrics([metricsIncomplete(0.05)], testThresholdConfig);
		expect(aggregate.activeCodes).toEqual(["MARKER_TOO_CLOSE"]);
	});

	it("a small-marker incomplete set still trips MARKER_INCOMPLETE, not MARKER_TOO_CLOSE, once a threshold is configured", () => {
		const aggregate = aggregateMarkerBoardMetrics([metricsIncomplete(0.005)], testThresholdConfig);
		expect(aggregate.activeCodes).toEqual(["MARKER_INCOMPLETE"]);
	});
});

describe("evaluateMarkerBoardWindowAggregate recency weighting", () => {
	const good = frameFor(fullSetMarkers(GOOD_SIZE));
	const bad = frameFor(fullSetMarkers(GOOD_SIZE).slice(0, 5));

	it("scores a mostly-bad window ending good higher than the reverse, at a realistic window length", () => {
		// A 2-frame toy window doesn't demonstrate this at the calibrated alpha=0.15 (see
		// captureQualityConfig.ts): the running EWMA here seeds its first sample at full
		// weight rather than blending it, so a short window is dominated by whichever frame
		// came first, not last. That residual seed influence decays as (1-alpha)^(n-1), which
		// only becomes small at a window length close to the real
		// sampling.liveWindowFrameCount (15) this check actually runs with - so this test
		// uses that real length rather than an arbitrarily short one.
		const windowSize = DEFAULTS.sampling.liveWindowFrameCount;
		const endingGood = evaluateMarkerBoardWindowAggregate([...Array(windowSize - 1).fill(bad), good], config);
		const endingBad = evaluateMarkerBoardWindowAggregate([good, ...Array(windowSize - 1).fill(bad)], config);

		expect(endingGood.weightedFullSetScore).toBeGreaterThan(endingBad.weightedFullSetScore);
		// Neither clears MARKER_INCOMPLETE from a single good/bad frame at the edge of an
		// otherwise-uniform window - alpha=0.15 was calibrated specifically to resist
		// flapping on one-off frames (see the six-recording replay evidence in
		// captureQualityConfig.ts), so a lone opposite frame moving the score is expected
		// to be visible in weightedFullSetScore without necessarily crossing
		// minimumFullSetWeight and changing the fired code.
		expect(endingGood.activeCodes).toContain("MARKER_INCOMPLETE");
		expect(endingBad.activeCodes).toContain("MARKER_INCOMPLETE");
	});

	it("returns an empty, zeroed aggregate for an empty window", () => {
		const aggregate = evaluateMarkerBoardWindowAggregate([], config);
		expect(aggregate).toEqual({
			frameCount: 0,
			weightedFullSetScore: 0,
			weightedNormalizedArea: null,
			weightedDiagonalRatio: null,
			weightedOrientationAngleRad: null,
			weightedDetectedMarkerAreaNorm: null,
			latest: null,
			activeCodes: [],
		});
	});
});

describe("MarkerBoardFrameWindow", () => {
	it("caps the buffer at maxFrames", () => {
		const window = createMarkerBoardFrameWindow(3);
		const good = frameFor(fullSetMarkers(GOOD_SIZE));
		for (let i = 0; i < 10; i++) pushMarkerBoardFrame(window, good);
		expect(window.frames).toHaveLength(3);
	});

	it("resetting the window clears prior frames so a new trial starts clean", () => {
		const window = createMarkerBoardFrameWindow(DEFAULTS.sampling.liveWindowFrameCount);
		const bad = frameFor(fullSetMarkers(GOOD_SIZE).slice(0, 5));
		for (let i = 0; i < 5; i++) pushMarkerBoardFrame(window, bad);
		expect(evaluateMarkerBoardWindowAggregate(window.frames, config).activeCodes).toContain("MARKER_INCOMPLETE");

		resetMarkerBoardFrameWindow(window);
		expect(window.frames).toHaveLength(0);

		const good = frameFor(fullSetMarkers(GOOD_SIZE));
		pushMarkerBoardFrame(window, good);
		const aggregate = evaluateMarkerBoardWindowAggregate(window.frames, config);
		expect(aggregate.frameCount).toBe(1);
		expect(aggregate.activeCodes).not.toContain("MARKER_INCOMPLETE");
	});
});

// Acceptance criterion for the 2026-08-12 threshold calibration (captureQualityConfig.ts):
// replays the six real iPhone recordings against the physical board through the actual
// aggregation code via the offline calibrate pipeline (scripts/calibrate), exactly as
// `npm run calibrate` does, and pins the resulting classification.
describe("end-to-end classification of the six real 2026-08-12 calibration recordings", () => {
	const CALIBRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../calibration");
	const windowSize = DEFAULTS.sampling.liveWindowFrameCount;

	function replayFile(fileName: string) {
		const path = join(CALIBRATION_DIR, fileName);
		const [recording] = parseCompactExportFile(path, readFileSync(path, "utf8"));
		return replayRecording(recording, config, windowSize);
	}

	function dominantStateKey(fileName: string): string {
		const steps = replayFile(fileName);
		const counts = new Map<string, number>();
		for (const step of steps) {
			const key = step.activeCodes.length === 0 ? "OK" : [...step.activeCodes].sort().join("+");
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		let bestKey = "OK";
		let bestCount = -1;
		for (const [key, count] of counts) {
			if (count > bestCount) {
				bestKey = key;
				bestCount = count;
			}
		}
		return bestKey;
	}

	it("d-mid 1.5m (GOOD) replays with zero fired codes on every step", () => {
		const steps = replayFile("2026-08-12-gait-d-mid-1p5m.cq1.txt");
		expect(steps.every((s) => s.activeCodes.length === 0)).toBe(true);
	});

	it("baseline (marginal) classifies dominant MARKER_TOO_SMALL", () => {
		expect(dominantStateKey("2026-08-12-gait-baseline.cq1.txt")).toBe("MARKER_TOO_SMALL");
	});

	it("d-far 6ft (bad) classifies dominant MARKER_INCOMPLETE", () => {
		expect(dominantStateKey("2026-08-12-gait-d-far-6ft.cq1.txt")).toBe("MARKER_INCOMPLETE");
	});

	it("rot-slight (~43 deg yaw) classifies dominant MARKER_WRONG_ORIENTATION", () => {
		expect(dominantStateKey("2026-08-12-gait-rot-slight-cw.cq1.txt")).toBe("MARKER_WRONG_ORIENTATION");
	});

	it("rot-90 (90 deg yaw) classifies dominant MARKER_WRONG_ORIENTATION", () => {
		expect(dominantStateKey("2026-08-12-gait-rot-90cw.cq1.txt")).toBe("MARKER_WRONG_ORIENTATION");
	});

	// d-near/2ft is the one recording where the ideal classification would be
	// MARKER_TOO_CLOSE - but it replays as MARKER_INCOMPLETE, and that is correct given
	// what this recording actually contains: the CQ1 v1 recorder only ever stored
	// normalizedArea/detectedMarkerAreaNorm-equivalent data on full-set frames (see
	// scripts/calibrate/replay.ts sampleToMetrics), and d-near never reaches a full set
	// (0/236 frames - the board doesn't fit the frame at 2ft). There is no real size
	// measurement anywhere in this recording to classify it as "too close" from, so
	// markerBoard.tooCloseDetectedAreaNorm is deliberately left null and this recording
	// falls back to the safe pre-existing behavior. A re-capture with an updated recorder
	// that stores detectedMarkerAreaNorm on partial-set frames too is required before this
	// can classify as MARKER_TOO_CLOSE for real.
	it("d-near 2ft (too close) falls back to MARKER_INCOMPLETE - see comment for why MARKER_TOO_CLOSE cannot be verified here", () => {
		expect(dominantStateKey("2026-08-12-gait-d-near-2ft.cq1.txt")).toBe("MARKER_INCOMPLETE");
	});
});

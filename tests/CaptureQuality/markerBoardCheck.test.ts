import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULTS, MARKER_ALIGNMENT } from "../../src/CaptureQuality/captureQualityConfig";
import type { CaptureQualityDetectedMarker, CaptureQualityFrameSample } from "../../src/CaptureQuality/types";
import {
	aggregateMarkerBoardMetrics,
	createMarkerBoardFrameWindow,
	createMarkerBoardHysteresisState,
	createMarkerPersistenceTracker,
	defaultMarkerBoardCheckConfig,
	evaluateMarkerBoardFrame,
	evaluateMarkerBoardWindow,
	evaluateMarkerBoardWindowAggregate,
	evaluateMarkerPersistence,
	pushMarkerBoardFrame,
	resetMarkerBoardFrameWindow,
	resetMarkerBoardHysteresisState,
	resetMarkerPersistenceTracker,
	resolveEwmaAlpha,
	updateMarkerPersistenceTracker,
} from "../../src/CaptureQuality/markerBoardCheck";
import type { MarkerBoardFrameMetrics } from "../../src/CaptureQuality/markerBoardCheck";
import { parseCompactExportFile } from "../../scripts/calibrate/parse";
import { replayRecording } from "../../scripts/calibrate/replay";

const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 360;

// Real measured values from the 2026-08-12/2026-08-13 iPhone recordings against the
// physical ArUco board (see calibration/*.cq1.txt/*.cq2.txt and captureQualityConfig.ts
// for the full derivation). Fixtures below are sized/valued to hit these exact numbers
// so a future threshold change that breaks real-world behavior fails a test, not just a
// synthetic one.
//
// 2026-08-13 "viable range" revision: sizeWarnUpperNorm/MARKER_TOO_LARGE are back (see
// captureQualityConfig.ts's DEFAULTS.markerBoard comment) at 0.0038, a human-stated
// framing limit measured well above these fixtures' values - d-mid 1.5m stays a clean
// fixture, comfortably inside the widened ideal band alongside ideal-overlay-match and
// baseline, none of which approach the new upper boundary.
const AREA_IDEAL_MEDIAN = 0.00197; // ideal-overlay-match normalizedArea median (78.3% full-set rate) - the primary good-setup reference
const AREA_BASELINE_MEDIAN = 0.00229; // baseline normalizedArea median - inside the ideal band
const AREA_D_MID_MEDIAN = 0.00316; // d-mid 1.5m normalizedArea median (93% full-set rate) - inside the widened ideal band (sizeIdealUpperNorm=0.0032), clean under the current model
const AREA_D_FAR_MEDIAN = 0.00106; // d-far 6ft normalizedArea median (26.2% full-set rate) - below sizeWarnLowerNorm, the real too-small fixture
const ORIENTATION_ALIGNED_MEDIAN = 0.1518; // d-mid orientationRad median - an on-axis board, not zero (see phone-roll comment below)
const ORIENTATION_ROT_SLIGHT_MEDIAN = 0.8221; // rot-slight (~43 deg intentional yaw) orientationRad median
const ORIENTATION_ROT_90_MEDIAN = 1.5656; // rot-90 (90 deg intentional yaw) orientationRad median

// size such that a square marker's bbox area / (FRAME_WIDTH*FRAME_HEIGHT) equals `area`
// exactly (up to floating point) - lets the fixtures below be built from the real
// normalizedArea constants above rather than an arbitrary pixel size.
function sizeForArea(area: number): number {
	return Math.sqrt(area * FRAME_WIDTH * FRAME_HEIGHT);
}

const GOOD_SIZE = sizeForArea(AREA_IDEAL_MEDIAN);
const TOO_SMALL_SIZE = sizeForArea(AREA_D_FAR_MEDIAN);

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
// Centred on the alignment target the overlay asks for (MARKER_ALIGNMENT), not on the frame
// centre: MARKER_NOT_ALIGNED now fires on a board sitting in the wrong part of the frame, and
// a fixture at the frame centre is roughly a third of the frame height above where the
// overlay puts the board. Tests that specifically exercise misalignment override this.
function fullSetMarkers(size: number, targetX = MARKER_ALIGNMENT.targetXNorm, targetY = MARKER_ALIGNMENT.targetYNorm): CaptureQualityDetectedMarker[] {
	const cx = FRAME_WIDTH * targetX;
	const cy = FRAME_HEIGHT * targetY;
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
	it("reports no issues for an aligned, well-framed full board (real ideal-overlay-match area)", () => {
		const results = evaluateMarkerBoardWindow([frameFor(fullSetMarkers(GOOD_SIZE))], config);
		expect(results).toEqual([]);
	});

	it("reports no issues at the real baseline area - now the top edge of the ideal band, not a too-small fixture", () => {
		const results = evaluateMarkerBoardWindow([frameFor(fullSetMarkers(sizeForArea(AREA_BASELINE_MEDIAN)))], config);
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

	it("fires MARKER_TOO_SMALL for the real d-far 6ft area, not MARKER_INCOMPLETE", () => {
		const results = evaluateMarkerBoardWindow([frameFor(fullSetMarkers(TOO_SMALL_SIZE))], config);
		expect(results.some((r) => r.code === "MARKER_INCOMPLETE")).toBe(false);
		expect(results.some((r) => r.code === "MARKER_TOO_SMALL")).toBe(true);
	});

	// d-mid 1.5m's own measured area (0.00316) sits inside the widened ideal band
	// (sizeIdealUpperNorm=0.0032) and well below the reintroduced sizeWarnUpperNorm
	// (0.0038 - see captureQualityConfig.ts), so this must report clean.
	it("reports no issues at the real d-mid 1.5m area - inside the ideal band, below the upper size warning", () => {
		const results = evaluateMarkerBoardWindow([frameFor(fullSetMarkers(sizeForArea(AREA_D_MID_MEDIAN)))], config);
		expect(results).toEqual([]);
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
			timestampMs: 0,
			visibleCount: 0,
			visibleIds: [],
			isFullSet: false,
			normalizedArea: null,
			diagonalRatio: null,
			orientationAngleRad: null,
			geometryOk: null,
			orientationOk: null,
			detectedMarkerAreaNorm: null,
			boardCentroidNorm: null,
		});
	});

	it("computes detectedMarkerAreaNorm from whatever markers ARE present on an incomplete set, unlike normalizedArea which stays null", () => {
		const markers = fullSetMarkers(GOOD_SIZE).slice(0, 5); // 5 of 9 - incomplete
		const metrics = evaluateMarkerBoardFrame(frameFor(markers), config);
		expect(metrics.isFullSet).toBe(false);
		expect(metrics.normalizedArea).toBeNull();
		expect(metrics.detectedMarkerAreaNorm).toBeCloseTo(AREA_IDEAL_MEDIAN, 5);
	});
});

describe("orientation is evaluated independent of (and ahead of) both the full-set gate and size, and still gates the metrics that assume its corner-role mapping", () => {
	function metricsFullSet(overrides: Partial<MarkerBoardFrameMetrics> = {}): MarkerBoardFrameMetrics {
		return {
			timestampMs: 0,
			visibleCount: 9,
			visibleIds: [0, 1, 2, 3, 4, 5, 6, 7, 8],
			isFullSet: true,
			normalizedArea: AREA_IDEAL_MEDIAN,
			diagonalRatio: 0.22,
			orientationAngleRad: ORIENTATION_ALIGNED_MEDIAN,
			geometryOk: null,
			orientationOk: null,
			detectedMarkerAreaNorm: AREA_IDEAL_MEDIAN,
			...overrides,
		};
	}

	it("an aligned full-set frame at the real ideal-overlay-match orientation and area passes clean", () => {
		const aggregate = aggregateMarkerBoardMetrics([metricsFullSet()], config);
		expect(aggregate.activeCodes).toEqual([]);
	});

	it("an aligned full-set frame at the real d-mid area (inside the widened ideal band) passes clean, not WRONG_ORIENTATION", () => {
		const aggregate = aggregateMarkerBoardMetrics(
			[metricsFullSet({ normalizedArea: AREA_D_MID_MEDIAN, detectedMarkerAreaNorm: AREA_D_MID_MEDIAN })],
			config
		);
		expect(aggregate.activeCodes).toEqual([]);
	});

	it("the real rot-slight orientation (0.822 rad) trips MARKER_WRONG_ORIENTATION", () => {
		const aggregate = aggregateMarkerBoardMetrics(
			[metricsFullSet({ orientationAngleRad: ORIENTATION_ROT_SLIGHT_MEDIAN })],
			config
		);
		expect(aggregate.activeCodes).toEqual(["MARKER_WRONG_ORIENTATION"]);
	});

	it("gates MARKER_TOO_SMALL behind orientation: a rotated frame with the real d-far (too-small) area reports only WRONG_ORIENTATION", () => {
		// A rotated reading corrupts normalizedArea (see the field's own gating comment in
		// aggregateMarkerBoardMetrics), so this combines rot-90's real orientation with
		// d-far's real (too-small) area to prove the size code is still suppressed while
		// orientation is bad - both MARKER_TOO_SMALL and MARKER_TOO_LARGE are size codes
		// gated the same way (see the same suppression comment in
		// aggregateMarkerBoardMetrics).
		const aggregate = aggregateMarkerBoardMetrics(
			[metricsFullSet({ orientationAngleRad: ORIENTATION_ROT_90_MEDIAN, normalizedArea: AREA_D_FAR_MEDIAN, detectedMarkerAreaNorm: AREA_D_FAR_MEDIAN })],
			config
		);
		expect(aggregate.activeCodes).toEqual(["MARKER_WRONG_ORIENTATION"]);
		expect(aggregate.activeCodes).not.toContain("MARKER_TOO_SMALL");
	});

	// Real regression fix (2026-08-13): under the previous priority order (orientation
	// gated BEHIND the full-set-weight gate), a rotated board with a depressed full-set
	// score would report a visibility code (MARKER_INCOMPLETE) instead of the actionable
	// MARKER_WRONG_ORIENTATION - see aggregateMarkerBoardMetrics's priority-order comment
	// and rot-90's end-to-end classification below. This proves the independence directly:
	// a single sample can't carry a "depressed full-set score" (that requires a multi-frame
	// window), so the equivalent single-frame proof is that WRONG_ORIENTATION fires from
	// this priority chain without any full-set-score input being involved at all.
	it("fires WRONG_ORIENTATION from a single misoriented full-set sample, independent of full-set score", () => {
		const aggregate = aggregateMarkerBoardMetrics(
			[metricsFullSet({ orientationAngleRad: ORIENTATION_ROT_90_MEDIAN })],
			config
		);
		expect(aggregate.weightedFullSetScore).toBe(1); // a single full-set sample scores 1.0, well above minimumFullSetWeight
		expect(aggregate.activeCodes).toEqual(["MARKER_WRONG_ORIENTATION"]);
	});
});

describe("MARKER_TOO_CLOSE / MARKER_OBSTRUCTED / MARKER_INCOMPLETE split", () => {
	function metricsIncomplete(detectedMarkerAreaNorm: number | null): MarkerBoardFrameMetrics {
		return {
			timestampMs: 0,
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

	// One marker (id 4, arbitrary) reported as continuously missing - the precondition
	// the decision table requires ("no + persistent") before size is allowed to pick
	// between TOO_CLOSE/OBSTRUCTED/INCOMPLETE at all.
	const persistentMiss = { persistentMissingIds: [4], longestCurrentMissMs: 900 };

	it("a scattered (non-persistent) incomplete set reports MARKER_INCOMPLETE regardless of size - the close/obstructed split never applies to scattered dropout", () => {
		// No persistence argument -> defaults to NO_PERSISTENT_MISS.
		const aggregate = aggregateMarkerBoardMetrics([metricsIncomplete(0.05)], config);
		expect(aggregate.activeCodes).toEqual(["MARKER_INCOMPLETE"]);
	});

	it("a persistent miss above the ceiling (DEFAULTS tooCloseDetectedAreaNorm=0.0045) reports MARKER_TOO_CLOSE", () => {
		const aggregate = aggregateMarkerBoardMetrics([metricsIncomplete(0.005)], config, persistentMiss);
		expect(aggregate.activeCodes).toEqual(["MARKER_TOO_CLOSE"]);
	});

	it("a persistent miss between the floor (0.0015) and ceiling (0.0045) reports MARKER_OBSTRUCTED", () => {
		const aggregate = aggregateMarkerBoardMetrics([metricsIncomplete(0.0035)], config, persistentMiss);
		expect(aggregate.activeCodes).toEqual(["MARKER_OBSTRUCTED"]);
	});

	it("a persistent miss below the floor reports MARKER_INCOMPLETE, not MARKER_OBSTRUCTED - too far to resolve, not covered", () => {
		const aggregate = aggregateMarkerBoardMetrics([metricsIncomplete(0.001)], config, persistentMiss);
		expect(aggregate.activeCodes).toEqual(["MARKER_INCOMPLETE"]);
	});

	it("a persistent miss with no detected-area data at all (CQ1-recorded incomplete frames) falls back to MARKER_INCOMPLETE", () => {
		const aggregate = aggregateMarkerBoardMetrics([metricsIncomplete(null)], config, persistentMiss);
		expect(aggregate.activeCodes).toEqual(["MARKER_INCOMPLETE"]);
	});

	it("disabling the ceiling (tooCloseDetectedAreaNorm: null) disables both TOO_CLOSE and OBSTRUCTED even with a persistent miss", () => {
		const disabledConfig = { ...config, thresholds: { ...config.thresholds, tooCloseDetectedAreaNorm: null } };
		const aggregate = aggregateMarkerBoardMetrics([metricsIncomplete(0.05)], disabledConfig, persistentMiss);
		expect(aggregate.activeCodes).toEqual(["MARKER_INCOMPLETE"]);
	});
});

describe("evaluateMarkerBoardWindowAggregate recency weighting", () => {
	const good = frameFor(fullSetMarkers(GOOD_SIZE));
	const bad = frameFor(fullSetMarkers(GOOD_SIZE).slice(0, 5));

	// alpha was LOOSENED 2026-08-13 (0.15 -> 0.08 - see captureQualityConfig.ts) precisely
	// so this pre-check reacts slower and resists flapping, since it is advisory, not a
	// binding gate. A direct consequence at this window length (15): a single good frame's
	// contribution when it lands LAST (weight = alpha alone, since every earlier bad frame
	// nets to exactly 0) is now smaller than the residual a single good frame leaves behind
	// when it lands FIRST (weight = (1-alpha)^14, decaying slowly at low alpha) - i.e. at
	// alpha=0.08 "ends good" no longer outscores "starts good" the way it did at the old
	// 0.15 (see git history for that assertion). That inversion is the intended effect of
	// loosening alpha, not a bug, so this test asserts the EWMA math directly (bounded
	// against the all-bad/all-good extremes) rather than a since-inverted "recent frame
	// wins" comparison.
	it("a lone good frame at the end of an otherwise-bad window lifts the score by exactly alpha, still short of the full-set gate", () => {
		const windowSize = DEFAULTS.sampling.liveWindowFrameCount;
		const alpha = DEFAULTS.sampling.liveWindowRecencyWeight;
		const allBad = evaluateMarkerBoardWindowAggregate(Array(windowSize).fill(bad), config);
		const endingGood = evaluateMarkerBoardWindowAggregate([...Array(windowSize - 1).fill(bad), good], config);

		expect(allBad.weightedFullSetScore).toBe(0);
		expect(endingGood.weightedFullSetScore).toBeCloseTo(alpha, 10);
		expect(endingGood.weightedFullSetScore).toBeGreaterThan(allBad.weightedFullSetScore);
		expect(endingGood.activeCodes).toContain("MARKER_INCOMPLETE"); // alpha (0.08) is far below minimumFullSetWeight (0.6)
	});

	it("a lone good frame at the start of an otherwise-bad window decays toward, but does not reach, the all-bad score", () => {
		const windowSize = DEFAULTS.sampling.liveWindowFrameCount;
		const alpha = DEFAULTS.sampling.liveWindowRecencyWeight;
		const allGood = evaluateMarkerBoardWindowAggregate(Array(windowSize).fill(good), config);
		const startingGood = evaluateMarkerBoardWindowAggregate([good, ...Array(windowSize - 1).fill(bad)], config);

		expect(allGood.weightedFullSetScore).toBe(1);
		expect(startingGood.weightedFullSetScore).toBeCloseTo((1 - alpha) ** (windowSize - 1), 10);
		expect(startingGood.weightedFullSetScore).toBeLessThan(allGood.weightedFullSetScore);
		expect(startingGood.activeCodes).toContain("MARKER_INCOMPLETE"); // still well below minimumFullSetWeight (0.6)
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
			weightedBoardCentroidNorm: null,
			alignmentOffsetNorm: null,
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

describe("MarkerBoardHysteresisState / hysteresis in aggregateMarkerBoardMetrics", () => {
	function metricsFullSetAt(normalizedArea: number): MarkerBoardFrameMetrics {
		return {
			timestampMs: 0,
			visibleCount: 9,
			visibleIds: [0, 1, 2, 3, 4, 5, 6, 7, 8],
			isFullSet: true,
			normalizedArea,
			diagonalRatio: 0.22,
			orientationAngleRad: 0.15,
			geometryOk: null,
			orientationOk: null,
			detectedMarkerAreaNorm: normalizedArea,
		};
	}

	it("creates a fresh state with nothing bad", () => {
		expect(createMarkerBoardHysteresisState()).toEqual({
			alignmentBad: false,
			orientationBad: false,
			fullSetBad: false,
			tooSmallBad: false,
			tooLargeBad: false,
		});
	});

	it("resets all five flags back to false", () => {
		const state = createMarkerBoardHysteresisState();
		state.alignmentBad = true;
		state.orientationBad = true;
		state.fullSetBad = true;
		state.tooSmallBad = true;
		state.tooLargeBad = true;
		resetMarkerBoardHysteresisState(state);
		expect(state).toEqual({ alignmentBad: false, orientationBad: false, fullSetBad: false, tooSmallBad: false, tooLargeBad: false });
	});

	// Direct test of the MARKER_TOO_SMALL boundary's hysteresis (sizeWarnLowerNorm=0.0014,
	// sizeWarnLowerClearNorm=0.00155 - see captureQualityConfig.ts): a reading that dips
	// just under the warn level fires, a partial recovery that stops short of the clear
	// level must NOT clear it (this is the whole point - a plain re-crossing of 0.0014
	// would clear it and reintroduce the flapping this feature exists to remove), and only
	// a reading past the clear level actually clears it.
	it("MARKER_TOO_SMALL requires crossing the clear level, not just the warn level, to release", () => {
		const state = createMarkerBoardHysteresisState();

		const dips = aggregateMarkerBoardMetrics([metricsFullSetAt(0.0013)], config, undefined, state);
		expect(dips.activeCodes).toEqual(["MARKER_TOO_SMALL"]);
		expect(state.tooSmallBad).toBe(true);

		// Recovers past the OLD single threshold (0.0014) but short of the clear level
		// (0.00155) - must still be reported as too small.
		const partialRecovery = aggregateMarkerBoardMetrics([metricsFullSetAt(0.0015)], config, undefined, state);
		expect(partialRecovery.activeCodes).toEqual(["MARKER_TOO_SMALL"]);
		expect(state.tooSmallBad).toBe(true);

		const fullRecovery = aggregateMarkerBoardMetrics([metricsFullSetAt(0.0016)], config, undefined, state);
		expect(fullRecovery.activeCodes).toEqual([]);
		expect(state.tooSmallBad).toBe(false);
	});

	// Mirror of the MARKER_TOO_SMALL test above, for the reintroduced upper boundary
	// (sizeWarnUpperNorm=0.0038, sizeWarnUpperClearNorm=0.00365 - see
	// captureQualityConfig.ts). Same hysteresis shape, opposite direction: a reading that
	// rises past the warn level fires, a partial recovery back under the warn level but
	// still above the clear level must NOT release it, and only dropping past the clear
	// level actually clears it.
	it("MARKER_TOO_LARGE requires dropping past the clear level, not just the warn level, to release", () => {
		const state = createMarkerBoardHysteresisState();

		const rises = aggregateMarkerBoardMetrics([metricsFullSetAt(0.0039)], config, undefined, state);
		expect(rises.activeCodes).toEqual(["MARKER_TOO_LARGE"]);
		expect(state.tooLargeBad).toBe(true);

		// Back under the warn level (0.0038) but still above the clear level (0.00365) -
		// must still be reported as too large.
		const partialRecovery = aggregateMarkerBoardMetrics([metricsFullSetAt(0.0037)], config, undefined, state);
		expect(partialRecovery.activeCodes).toEqual(["MARKER_TOO_LARGE"]);
		expect(state.tooLargeBad).toBe(true);

		const fullRecovery = aggregateMarkerBoardMetrics([metricsFullSetAt(0.0035)], config, undefined, state);
		expect(fullRecovery.activeCodes).toEqual([]);
		expect(state.tooLargeBad).toBe(false);
	});

	it("a fresh (unthreaded) hysteresis state behaves like a plain single-threshold comparison, matching pre-hysteresis behavior", () => {
		// No state passed - aggregateMarkerBoardMetrics's default parameter creates a new
		// one internally on every call, so there is nothing to remember between these two
		// independent calls.
		const belowWarn = aggregateMarkerBoardMetrics([metricsFullSetAt(0.0013)], config);
		expect(belowWarn.activeCodes).toEqual(["MARKER_TOO_SMALL"]);

		const betweenWarnAndClear = aggregateMarkerBoardMetrics([metricsFullSetAt(0.0015)], config);
		expect(betweenWarnAndClear.activeCodes).toEqual([]); // 0.0015 > sizeWarnLowerNorm (0.0014) - a fresh call has no "was bad" memory

		const aboveWarn = aggregateMarkerBoardMetrics([metricsFullSetAt(0.0039)], config);
		expect(aboveWarn.activeCodes).toEqual(["MARKER_TOO_LARGE"]);
	});

	it("the full-set gate requires climbing past minimumFullSetClearWeight, not just minimumFullSetWeight, to release", () => {
		const state = createMarkerBoardHysteresisState();
		const bad = frameFor(fullSetMarkers(GOOD_SIZE).slice(0, 5)); // incomplete set
		const good = frameFor(fullSetMarkers(GOOD_SIZE));
		const windowSize = DEFAULTS.sampling.liveWindowFrameCount;

		const allBad = evaluateMarkerBoardWindowAggregate(Array(windowSize).fill(bad), config, undefined, state);
		expect(allBad.activeCodes).toContain("MARKER_INCOMPLETE");
		expect(state.fullSetBad).toBe(true);

		// A window that averages to a score between minimumFullSetWeight (0.60) and
		// minimumFullSetClearWeight (0.67) must still report the gate as failed. At
		// alpha=0.15, 9 bad frames followed by 6 good ones settles at 1-(0.85^6)=0.623.
		const marginal = evaluateMarkerBoardWindowAggregate(
			[...Array(windowSize - 6).fill(bad), ...Array(6).fill(good)],
			config,
			undefined,
			state
		);
		expect(marginal.weightedFullSetScore).toBeGreaterThan(DEFAULTS.markerBoard.minimumFullSetWeight);
		expect(marginal.weightedFullSetScore).toBeLessThan(DEFAULTS.markerBoard.minimumFullSetClearWeight);
		expect(marginal.activeCodes).toContain("MARKER_INCOMPLETE");
		expect(state.fullSetBad).toBe(true);

		const allGood = evaluateMarkerBoardWindowAggregate(Array(windowSize).fill(good), config, undefined, state);
		expect(allGood.activeCodes).not.toContain("MARKER_INCOMPLETE");
		expect(state.fullSetBad).toBe(false);
	});

	it("orientation requires dropping below orientationClearMarginRad, not just orientationMarginRad, to release", () => {
		const state = createMarkerBoardHysteresisState();
		// Derived from the config: this test is about the gap between the two levels, not
		// about where the calibrated values sit.
		const { orientationMarginRad: warn, orientationClearMarginRad: clear } = config.thresholds;
		const rotated = aggregateMarkerBoardMetrics(
			[{ ...metricsFullSetAt(AREA_IDEAL_MEDIAN), orientationAngleRad: warn + 0.05 }],
			config,
			undefined,
			state
		);
		expect(rotated.activeCodes).toEqual(["MARKER_WRONG_ORIENTATION"]);
		expect(state.orientationBad).toBe(true);

		// Back under orientationMarginRad but not under orientationClearMarginRad - must
		// still report WRONG_ORIENTATION.
		const partialRecovery = aggregateMarkerBoardMetrics(
			[{ ...metricsFullSetAt(AREA_IDEAL_MEDIAN), orientationAngleRad: (warn + clear) / 2 }],
			config,
			undefined,
			state
		);
		expect(partialRecovery.activeCodes).toEqual(["MARKER_WRONG_ORIENTATION"]);
		expect(state.orientationBad).toBe(true);

		const fullRecovery = aggregateMarkerBoardMetrics(
			[{ ...metricsFullSetAt(AREA_IDEAL_MEDIAN), orientationAngleRad: clear - 0.05 }],
			config,
			undefined,
			state
		);
		expect(fullRecovery.activeCodes).toEqual([]);
		expect(state.orientationBad).toBe(false);
	});

	it("releases a stuck orientation verdict once no full-set frame is left in the window", () => {
		// The board washes out or gets covered: no full-set frames, so no angle can be
		// measured. Holding the previous verdict would latch WRONG_ORIENTATION forever and
		// suppress the visibility codes that describe what is actually wrong.
		const state = createMarkerBoardHysteresisState();
		const rotated = aggregateMarkerBoardMetrics(
			[{ ...metricsFullSetAt(AREA_IDEAL_MEDIAN), orientationAngleRad: config.thresholds.orientationMarginRad + 0.05 }],
			config,
			undefined,
			state
		);
		expect(rotated.activeCodes).toEqual(["MARKER_WRONG_ORIENTATION"]);

		const unmeasurable = aggregateMarkerBoardMetrics(
			[{ ...metricsFullSetAt(AREA_IDEAL_MEDIAN), isFullSet: false, orientationAngleRad: null, normalizedArea: null, diagonalRatio: null }],
			config,
			undefined,
			state
		);
		expect(state.orientationBad).toBe(false);
		expect(unmeasurable.activeCodes).not.toContain("MARKER_WRONG_ORIENTATION");
	});
});

describe("MarkerPersistenceTracker", () => {
	it("reports no persistent miss for a marker never absent", () => {
		const tracker = createMarkerPersistenceTracker();
		updateMarkerPersistenceTracker(tracker, 0, [1, 2, 3]);
		updateMarkerPersistenceTracker(tracker, 1000, [1, 2, 3]);
		const result = evaluateMarkerPersistence(tracker, [1, 2, 3], 1000, 500);
		expect(result.persistentMissingIds).toEqual([]);
	});

	it("reports a persistent miss once a marker's absence reaches the threshold", () => {
		const tracker = createMarkerPersistenceTracker();
		updateMarkerPersistenceTracker(tracker, 0, [1, 2, 3]); // marker 2 seen at t=0
		updateMarkerPersistenceTracker(tracker, 200, [1, 3]); // marker 2 missing from here on
		updateMarkerPersistenceTracker(tracker, 400, [1, 3]);
		const stillUnder = evaluateMarkerPersistence(tracker, [1, 2, 3], 400, 500); // 400ms missing < 500ms
		expect(stillUnder.persistentMissingIds).toEqual([]);

		updateMarkerPersistenceTracker(tracker, 600, [1, 3]);
		const overThreshold = evaluateMarkerPersistence(tracker, [1, 2, 3], 600, 500); // 600ms missing >= 500ms
		expect(overThreshold.persistentMissingIds).toEqual([2]);
		expect(overThreshold.longestCurrentMissMs).toBe(600);
	});

	it("treats a marker never seen since the tracker started as missing since the first frame", () => {
		const tracker = createMarkerPersistenceTracker();
		updateMarkerPersistenceTracker(tracker, 100, [1]); // marker 2 never seen
		updateMarkerPersistenceTracker(tracker, 700, [1]);
		const result = evaluateMarkerPersistence(tracker, [1, 2], 700, 500);
		expect(result.persistentMissingIds).toEqual([2]);
	});

	it("a brief 1-2 frame gap (good-setup scale) never crosses a 500ms threshold at realistic fps", () => {
		const tracker = createMarkerPersistenceTracker();
		const fps = 37; // d-mid's measured fps
		const frameMs = 1000 / fps;
		updateMarkerPersistenceTracker(tracker, 0, [2]);
		// marker 2 missing for 2 frames, matching d-mid's real longest single-marker run
		updateMarkerPersistenceTracker(tracker, frameMs, []);
		updateMarkerPersistenceTracker(tracker, frameMs * 2, []);
		updateMarkerPersistenceTracker(tracker, frameMs * 3, [2]);
		const result = evaluateMarkerPersistence(tracker, [2], frameMs * 2, 500);
		expect(result.persistentMissingIds).toEqual([]);
	});

	it("clears all tracked state on reset", () => {
		const tracker = createMarkerPersistenceTracker();
		updateMarkerPersistenceTracker(tracker, 0, [1]);
		updateMarkerPersistenceTracker(tracker, 1000, []);
		expect(evaluateMarkerPersistence(tracker, [1], 1000, 500).persistentMissingIds).toEqual([1]);

		resetMarkerPersistenceTracker(tracker);
		expect(evaluateMarkerPersistence(tracker, [1], 1000, 500)).toEqual({ persistentMissingIds: [], longestCurrentMissMs: null });
	});
});

describe("pushMarkerBoardFrame / resetMarkerBoardFrameWindow keep the persistence tracker in sync", () => {
	function markerFrame(timestampMs: number, ids: number[], size: number): CaptureQualityFrameSample {
		return { ...frameFor(fullSetMarkers(size).filter((m) => ids.includes(m.id))), timestampMs };
	}

	it("pushMarkerBoardFrame updates window.persistence alongside window.frames", () => {
		const window = createMarkerBoardFrameWindow(50);
		pushMarkerBoardFrame(window, markerFrame(0, [0, 1, 2, 3, 4, 5, 6, 7, 8], GOOD_SIZE));
		pushMarkerBoardFrame(window, markerFrame(1000, [0, 1, 3, 4, 5, 6, 7, 8], GOOD_SIZE)); // marker 2 missing
		const result = evaluateMarkerPersistence(window.persistence, [0, 1, 2, 3, 4, 5, 6, 7, 8], 1000, 500);
		expect(result.persistentMissingIds).toEqual([2]);
	});

	it("resetMarkerBoardFrameWindow clears window.persistence, not just window.frames", () => {
		const window = createMarkerBoardFrameWindow(50);
		pushMarkerBoardFrame(window, markerFrame(0, [0, 1, 3, 4, 5, 6, 7, 8], GOOD_SIZE)); // marker 2 missing
		pushMarkerBoardFrame(window, markerFrame(1000, [0, 1, 3, 4, 5, 6, 7, 8], GOOD_SIZE));
		expect(evaluateMarkerPersistence(window.persistence, [0, 1, 2, 3, 4, 5, 6, 7, 8], 1000, 500).persistentMissingIds).toEqual([2]);

		resetMarkerBoardFrameWindow(window);
		pushMarkerBoardFrame(window, markerFrame(2000, [0, 1, 2, 3, 4, 5, 6, 7, 8], GOOD_SIZE));
		expect(evaluateMarkerPersistence(window.persistence, [0, 1, 2, 3, 4, 5, 6, 7, 8], 2000, 500).persistentMissingIds).toEqual([]);
	});
});

// Acceptance criterion for the 2026-08-13 "sweet spot" threshold revision
// (captureQualityConfig.ts): replays all NINE real iPhone recordings against the
// physical board through the actual aggregation code via the offline calibrate pipeline
// (scripts/calibrate), exactly as `npm run calibrate` does, and pins the RESULTING
// (measured, not assumed) classification - including where raising minimumFullSetWeight
// to 0.90 changes behavior from the 2026-08-12 revision. See markerBoardCheck.test.ts's
// git history for that revision's six-recording pins at minimumFullSetWeight=0.4.
// 2026-08-13 "widened ideal band + hysteresis" revision, threshold values later updated
// by the same-day "viable range" revision (see captureQualityConfig.ts's
// DEFAULTS.markerBoard comment). good-place-drift (the human's own reported real-world
// setup - 93.6% raw full-set rate, the best-detecting recording in the whole dataset) is
// a PRIMARY reference alongside ideal-overlay-match. All eleven real recordings are
// replayed here, pinned to the ACTUAL measured classification under the current
// thresholds (sizeWarnLowerNorm=0.0014/clear=0.00155, sizeIdealLowerNorm=0.0018,
// sizeIdealUpperNorm=0.0032, sizeWarnUpperNorm=0.0038/clear=0.00365,
// minimumFullSetWeight=0.60/clear=0.67, orientationMarginRad=0.45/clear=0.40,
// liveWindowRecencyWeight=0.15) - not the old "overlay match" or "widened ideal band"
// pins from git history. d-3p5ft-good (0.00374-0.00400) is the one recording in this set
// whose classification actually changes under the reintroduced sizeWarnUpperNorm - see
// that test below for why.
describe("end-to-end classification of the eleven real calibration recordings", () => {
	const CALIBRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../calibration");
	const windowSize = DEFAULTS.sampling.liveWindowFrameCount;

	function replayFile(fileName: string) {
		const path = join(CALIBRATION_DIR, fileName);
		const [recording] = parseCompactExportFile(path, readFileSync(path, "utf8"));
		return replayRecording(recording, config, windowSize);
	}

	function stateCounts(fileName: string): Map<string, number> {
		const steps = replayFile(fileName);
		const counts = new Map<string, number>();
		for (const step of steps) {
			const key = step.activeCodes.length === 0 ? "OK" : [...step.activeCodes].sort().join("+");
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return counts;
	}

	function flapCount(fileName: string): number {
		const steps = replayFile(fileName);
		let flaps = 0;
		let prevKey: string | null = null;
		for (const step of steps) {
			const key = step.activeCodes.length === 0 ? "OK" : [...step.activeCodes].sort().join("+");
			if (prevKey !== null && key !== prevKey) flaps++;
			prevKey = key;
		}
		return flaps;
	}

	function dominantStateKey(fileName: string): string {
		const counts = stateCounts(fileName);
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

	// The primary reference matching the product's own framing spec (78.3% raw full-set
	// rate - the DESIGNED operating point at that framing, not a defect - see
	// captureQualityConfig.ts). MEASURED under the final config (alpha=0.15, hysteresis
	// gaps applied): dominant OK (160/189 = 84.7%), MARKER_INCOMPLETE the rest (29/189 =
	// 14.8%), 16 state-transition flaps - down from 42 under the retired alpha=0.08/
	// no-hysteresis config. Persistence never fires (marker 2's longest run is 3 frames,
	// ~79ms at this recording's 38fps - nowhere near the 500ms threshold). See
	// sampling.liveWindowRecencyWeight's doc in captureQualityConfig.ts for the alpha sweep
	// behind that improvement.
	//
	// Re-pinned when the EWMA became time-based (sampling.ewmaReferenceTickHz): this
	// recording ran at 38fps, faster than the 30Hz reference, so each frame now carries
	// slightly LESS weight than the flat 0.15 it used to get - marginally more smoothing,
	// moving one frame from MARKER_INCOMPLETE to OK. Dominant state is unchanged.
	it("ideal-overlay-match classifies dominant OK with minimal flapping and no persistence firing", () => {
		const counts = stateCounts("2026-08-13-gait-ideal-overlay-match.cq2.txt");
		expect(dominantStateKey("2026-08-13-gait-ideal-overlay-match.cq2.txt")).toBe("OK");
		expect(counts.get("OK")).toBe(161);
		expect(counts.get("MARKER_INCOMPLETE")).toBe(28);
		expect(counts.has("MARKER_TOO_CLOSE")).toBe(false);
		expect(counts.has("MARKER_OBSTRUCTED")).toBe(false);
		expect(flapCount("2026-08-13-gait-ideal-overlay-match.cq2.txt")).toBe(16);
	});

	// The human's own reported real-world setup - the SECOND primary reference (task:
	// "standing in a good position, small phone movements flip the warning on and off").
	// This recording has BETTER detection than ideal-overlay-match (93.6% vs 78.3% raw
	// full-set rate) yet was flagged by the old sizeWarnUpperNorm=0.0028 boundary - the
	// false positive that boundary's 2026-08-13 removal fixed. The reintroduced boundary
	// (0.0038, human-stated framing limit rather than a detection number - see
	// captureQualityConfig.ts) sits well above this recording's own range (0.00262-
	// 0.00308), so it stays clean here too. MEASURED: dominant OK (266/280 = 95.0%), only
	// 1 state-transition flap. Re-pinned by one frame when the EWMA became time-based -
	// same 37fps-vs-30Hz-reference effect described on ideal-overlay-match above.
	it("good-place-drift (the human's reported real-world setup) classifies dominant OK with minimal flapping", () => {
		const counts = stateCounts("2026-08-13-gait-good-place-drift.cq2.txt");
		expect(dominantStateKey("2026-08-13-gait-good-place-drift.cq2.txt")).toBe("OK");
		expect(counts.get("OK")).toBe(266);
		expect(counts.get("MARKER_INCOMPLETE")).toBe(14);
		expect(counts.has("MARKER_TOO_CLOSE")).toBe(false);
		expect(counts.has("MARKER_OBSTRUCTED")).toBe(false);
		expect(flapCount("2026-08-13-gait-good-place-drift.cq2.txt")).toBe(1);
	});

	// Baseline's own median (0.00229) sits inside the ideal band.
	it("baseline classifies dominant OK, not MARKER_TOO_SMALL - its own median sits inside the ideal band", () => {
		expect(dominantStateKey("2026-08-12-gait-baseline.cq1.txt")).toBe("OK");
	});

	// d-mid 1.5m (93.0% full-set rate, normalizedArea median 0.00316) sits inside the
	// widened ideal band and well below the reintroduced sizeWarnUpperNorm (0.0038) - clean.
	it("d-mid 1.5m classifies dominant OK - inside the ideal band, below the upper size warning", () => {
		expect(dominantStateKey("2026-08-12-gait-d-mid-1p5m.cq1.txt")).toBe("OK");
	});

	// d-3p5ft-good (99.1% full-set rate - the best detection in the whole dataset)
	// measures normalizedArea 0.00374-0.00400, ENTIRELY above sizeWarnUpperNorm (0.0038).
	// This is the expected, correct behavior change from reintroducing the boundary, not a
	// regression: detection here is excellent, but this distance sits closer than the
	// human's own demonstrated viable range (max 0.00344 - see
	// calibration/2026-08-13-gait-viable-range-sweep.cq2.txt), so the framing constraint
	// - not a detection judgement - correctly flags it. MEASURED: 212/212 steps
	// MARKER_TOO_LARGE, 0 flaps (the recording's own std is 0.00006 - far too tight to
	// straddle the hysteresis gap).
	it("d-3p5ft-good classifies dominant MARKER_TOO_LARGE - closer than the human's demonstrated viable range, even though detection there is excellent", () => {
		const counts = stateCounts("2026-08-12-gait-d-3p5ft-good.cq2.txt");
		expect(counts.get("MARKER_TOO_LARGE")).toBe(212);
		expect(counts.size).toBe(1);
		expect(flapCount("2026-08-12-gait-d-3p5ft-good.cq2.txt")).toBe(0);
	});

	it("d-far 6ft (bad) classifies dominant MARKER_INCOMPLETE", () => {
		expect(dominantStateKey("2026-08-12-gait-d-far-6ft.cq1.txt")).toBe("MARKER_INCOMPLETE");
	});

	it("rot-slight (~43 deg yaw, 92.9% full-set rate) classifies dominant MARKER_WRONG_ORIENTATION", () => {
		expect(dominantStateKey("2026-08-12-gait-rot-slight-cw.cq1.txt")).toBe("MARKER_WRONG_ORIENTATION");
	});

	// FIXED REGRESSION (2026-08-13): at the previous minimumFullSetWeight=0.90, rot-90's
	// 80.0% raw full-set rate failed the visibility gate before orientation was ever
	// evaluated, splitting 51.6% MARKER_INCOMPLETE / 48.4% MARKER_WRONG_ORIENTATION - a
	// rotated board reporting as a visibility problem. Lowering the gate to 0.60 AND
	// evaluating orientation independent of (ahead of) the gate (see
	// aggregateMarkerBoardMetrics's priority-order comment) both contribute to the fix;
	// MEASURED here at 100% MARKER_WRONG_ORIENTATION, zero flaps - a clean, unambiguous
	// classification, not just a "different" dominant winner.
	it("rot-90 (90 deg yaw) now classifies WRONG_ORIENTATION cleanly - the visibility-gate regression is fixed", () => {
		const counts = stateCounts("2026-08-12-gait-rot-90cw.cq1.txt");
		expect(counts.get("MARKER_WRONG_ORIENTATION")).toBe(190);
		expect(counts.size).toBe(1);
		expect(flapCount("2026-08-12-gait-rot-90cw.cq1.txt")).toBe(0);
	});

	// d-3ft-cropped is a CQ2 recording, so detectedMarkerAreaNorm exists on its
	// (always-incomplete) frames - persistence tracking (markers 3/6/7 missing 100%,
	// vastly past the 500ms threshold) plus a detected area above the 0.0045 ceiling
	// (measured ~0.0052 per the task's ground truth) correctly classifies MARKER_TOO_CLOSE.
	it("d-3ft-cropped (never reaches a full set) classifies dominant MARKER_TOO_CLOSE", () => {
		expect(dominantStateKey("2026-08-12-gait-d-3ft-cropped.cq2.txt")).toBe("MARKER_TOO_CLOSE");
	});

	// d-near/2ft is CLOSER than d-3ft-cropped, so it should ALSO be a MARKER_TOO_CLOSE
	// case physically - but it is a CQ1 recording, and the CQ1 v1 recorder only ever
	// stored normalizedArea/detectedMarkerAreaNorm-equivalent data on full-set frames
	// (see scripts/calibrate/replay.ts sampleToMetrics); d-near never reaches a full set
	// (0/236 frames), so there is no real size measurement anywhere in this recording to
	// split TOO_CLOSE from INCOMPLETE with. This is unchanged by the 2026-08-13 revision -
	// it is the same pre-existing CQ1-format gap the 2026-08-12 test suite already
	// documented, carried forward, not a new bug. A CQ2 re-capture of this scenario is
	// required before MARKER_TOO_CLOSE can be verified for 2ft specifically.
	it("d-near 2ft (too close) falls back to MARKER_INCOMPLETE - CQ1 format has no detArea to classify TOO_CLOSE from, see comment", () => {
		expect(dominantStateKey("2026-08-12-gait-d-near-2ft.cq1.txt")).toBe("MARKER_INCOMPLETE");
	});

	it("back-away (not in the task's ground-truth table) classifies dominant MARKER_INCOMPLETE", () => {
		expect(dominantStateKey("2026-08-12-gait-back-away.cq1.txt")).toBe("MARKER_INCOMPLETE");
	});
});

describe("per-marker persistence signal against the real recordings", () => {
	const CALIBRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../calibration");
	const windowSize = DEFAULTS.sampling.liveWindowFrameCount;

	function replayFile(fileName: string) {
		const path = join(CALIBRATION_DIR, fileName);
		const [recording] = parseCompactExportFile(path, readFileSync(path, "utf8"));
		return replayRecording(recording, config, windowSize);
	}

	function everFiresPersistenceDrivenCode(fileName: string): boolean {
		return replayFile(fileName).some(
			(step) => step.activeCodes.includes("MARKER_TOO_CLOSE") || step.activeCodes.includes("MARKER_OBSTRUCTED")
		);
	}

	// The ideal-overlay-match recording peaks at a 3-frame single-marker miss (marker 2)
	// - nowhere near the 500ms persistence threshold - so the persistence-driven codes
	// must never appear, and neither should MARKER_TOO_CLOSE/MARKER_OBSTRUCTED sneak in
	// via the size-nudge branch (those only ever come from the incomplete-set branch).
	it("never fires a persistence-driven code on the ideal-overlay-match recording", () => {
		expect(everFiresPersistenceDrivenCode("2026-08-13-gait-ideal-overlay-match.cq2.txt")).toBe(false);
	});

	// Both d-mid and d-3p5ft-good peak at a 1-2 frame single-marker miss (marker 2, the
	// weakest - see MARKER_BOARD's corners-are-weakest note) - nowhere near the 500ms
	// persistence threshold - so the persistence-driven codes (TOO_CLOSE/OBSTRUCTED, which
	// only ever come from the incomplete-set branch) must never appear on either, whether
	// or not the size nudge fires - MARKER_TOO_LARGE (d-3p5ft-good's own dominant code, see
	// above) comes from a completely separate branch (the full-set size check).
	it("never fires a persistence-driven code on d-mid 1.5m", () => {
		expect(everFiresPersistenceDrivenCode("2026-08-12-gait-d-mid-1p5m.cq1.txt")).toBe(false);
	});

	it("never fires a persistence-driven code on d-3p5ft-good", () => {
		expect(everFiresPersistenceDrivenCode("2026-08-12-gait-d-3p5ft-good.cq2.txt")).toBe(false);
	});

	// Markers 3, 6, 7 are missing for all 250 frames of this recording - the clearest
	// possible structural miss - so the persistence signal must fire.
	it("fires a persistence-driven code (MARKER_TOO_CLOSE) on d-3ft-cropped", () => {
		expect(everFiresPersistenceDrivenCode("2026-08-12-gait-d-3ft-cropped.cq2.txt")).toBe(true);
	});
});

// PRIMARY acceptance criterion for the 2026-08-13 "viable range" revision
// (captureQualityConfig.ts): the human recorded a deliberate range sweep - start at
// optimal framing, move closer to the point the board or the person would leave frame,
// then further to the point both would read too small - and explicitly judged the WHOLE
// sweep viable framing (n=277, normalizedArea min=0.00149/max=0.00344, 75.5% full-set
// rate). sizeWarnLowerNorm/sizeWarnUpperNorm are set from that measured range (0.0014/
// 0.0038 - see captureQualityConfig.ts's DEFAULTS.markerBoard comment for the exact
// derivation), so a size warning anywhere in this replay would mean the boundaries
// contradict the human's own stated judgement - the strongest single assertion in this
// suite, since it pins both boundaries at once against real demonstrated limits, not a
// synthetic fixture. MEASURED under the current thresholds: 184/277 OK, 93/277
// MARKER_INCOMPLETE (full-set rate dips well below minimumFullSetWeight during the sweep,
// as expected - that gate is unaffected by this revision), 26 state-transition flaps -
// zero steps of either size code.
//
// This recording moved the most when the EWMA became time-based, and it is the only pinned
// one that was DECIMATED (stride=2 - the recorder halved its sampling when the buffer
// capped). Its stored samples are ~53ms apart rather than ~26ms, so each now carries
// alpha 0.226 instead of a flat 0.150 - about 1.5x the weight, so less smoothing, hence
// 5 more OK frames and 8 more flaps.
// That is the intended correction - the old flat weight silently treated a decimated
// series as if it were full-rate - but it does mean the flap count here is no longer
// directly comparable with the stride=1 recordings above.
describe("viable-range-sweep - pinned regression against the human's demonstrated viable range", () => {
	const CALIBRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../calibration");
	const windowSize = DEFAULTS.sampling.liveWindowFrameCount;
	const FILE_NAME = "2026-08-13-gait-viable-range-sweep.cq2.txt";

	function replaySweep() {
		const path = join(CALIBRATION_DIR, FILE_NAME);
		const [recording] = parseCompactExportFile(path, readFileSync(path, "utf8"));
		return replayRecording(recording, defaultMarkerBoardCheckConfig(DEFAULTS), windowSize);
	}

	it("never fires MARKER_TOO_SMALL or MARKER_TOO_LARGE across the entire 277-sample recording", () => {
		const steps = replaySweep();
		expect(steps).toHaveLength(277);
		expect(steps.some((s) => s.activeCodes.includes("MARKER_TOO_SMALL"))).toBe(false);
		expect(steps.some((s) => s.activeCodes.includes("MARKER_TOO_LARGE"))).toBe(false);
	});

	it("matches the measured OK/MARKER_INCOMPLETE split and flap count", () => {
		const steps = replaySweep();
		const counts = new Map<string, number>();
		let flaps = 0;
		let prevKey: string | null = null;
		for (const step of steps) {
			const key = step.activeCodes.length === 0 ? "OK" : [...step.activeCodes].sort().join("+");
			counts.set(key, (counts.get(key) ?? 0) + 1);
			if (prevKey !== null && key !== prevKey) flaps++;
			prevKey = key;
		}
		expect(counts.get("OK")).toBe(184);
		expect(counts.get("MARKER_INCOMPLETE")).toBe(93);
		expect(counts.size).toBe(2);
		expect(flaps).toBe(26);
	});
});

describe("resolveEwmaAlpha - rate-invariant smoothing", () => {
	const REF_HZ = DEFAULTS.sampling.ewmaReferenceTickHz;
	const REF_ALPHA = DEFAULTS.sampling.liveWindowRecencyWeight;
	const REF_DT = 1000 / REF_HZ;

	it("returns the configured weight unchanged at exactly the reference interval", () => {
		expect(resolveEwmaAlpha(REF_DT, REF_HZ, REF_ALPHA)).toBeCloseTo(REF_ALPHA, 12);
	});

	it("composes exactly: N sub-steps decay the same as one reference step", () => {
		// The property that makes the smoothing independent of tick rate - subdividing an
		// interval must not change how much the old value has decayed by the end of it.
		for (const n of [2, 4, 8, 37]) {
			const sub = resolveEwmaAlpha(REF_DT / n, REF_HZ, REF_ALPHA);
			expect((1 - sub) ** n).toBeCloseTo(1 - REF_ALPHA, 12);
		}
	});

	it("weights a longer gap more heavily, so a throttled loop is not slower to react in wall-clock terms", () => {
		const fast = resolveEwmaAlpha(REF_DT / 4, REF_HZ, REF_ALPHA);
		const slow = resolveEwmaAlpha(REF_DT * 4, REF_HZ, REF_ALPHA);
		expect(fast).toBeLessThan(REF_ALPHA);
		expect(slow).toBeGreaterThan(REF_ALPHA);
		expect(slow).toBeLessThan(1);
	});

	it("reaches the same smoothed value from either rate after equal wall-clock time", () => {
		// Drive a step input for 1s at the reference rate and at the 8Hz live tick; both
		// must land at the same place, which is the whole point of the conversion.
		function settle(tickHz: number): number {
			const dt = 1000 / tickHz;
			const alpha = resolveEwmaAlpha(dt, REF_HZ, REF_ALPHA);
			let value = 0;
			for (let elapsed = 0; elapsed < 1000; elapsed += dt) value = alpha * 1 + (1 - alpha) * value;
			return value;
		}
		expect(settle(DEFAULTS.sampling.liveTickHz)).toBeCloseTo(settle(REF_HZ), 6);
	});

	it("falls back to the reference weight on a first frame, duplicate timestamp, or backwards clock", () => {
		for (const bad of [NaN, 0, -5, Infinity]) {
			expect(resolveEwmaAlpha(bad, REF_HZ, REF_ALPHA)).toBe(REF_ALPHA);
		}
	});
});

describe("MARKER_NOT_ALIGNED - board is visible and well formed but in the wrong part of frame", () => {
	function alignedFrames(targetX: number, targetY: number, count = 20) {
		return Array.from({ length: count }, (_, i) => ({
			imageData: null,
			timestampMs: i * 125,
			frameWidth: FRAME_WIDTH,
			frameHeight: FRAME_HEIGHT,
			people: null,
			markers: fullSetMarkers(GOOD_SIZE, targetX, targetY),
		}));
	}

	it("is silent for a board sitting on the overlay's target", () => {
		const aggregate = evaluateMarkerBoardWindowAggregate(
			alignedFrames(MARKER_ALIGNMENT.targetXNorm, MARKER_ALIGNMENT.targetYNorm),
			defaultMarkerBoardCheckConfig(DEFAULTS)
		);
		expect(aggregate.activeCodes).not.toContain("MARKER_NOT_ALIGNED");
	});

	it("stays silent across the whole spread the operator actually produced", () => {
		// Measured board centroids across all seven subject recordings: x 0.310-0.387,
		// y 0.822-0.874. Every one of those framings was considered fine, so none may warn.
		for (const [x, y] of [
			[0.310, 0.822],
			[0.387, 0.874],
			[0.310, 0.874],
			[0.387, 0.822],
		]) {
			const aggregate = evaluateMarkerBoardWindowAggregate(alignedFrames(x, y), defaultMarkerBoardCheckConfig(DEFAULTS));
			expect(aggregate.activeCodes, `centroid ${x},${y}`).not.toContain("MARKER_NOT_ALIGNED");
		}
	});

	it("fires when the board sits well off to one side", () => {
		const aggregate = evaluateMarkerBoardWindowAggregate(
			alignedFrames(MARKER_ALIGNMENT.targetXNorm + 0.25, MARKER_ALIGNMENT.targetYNorm),
			defaultMarkerBoardCheckConfig(DEFAULTS)
		);
		expect(aggregate.activeCodes).toContain("MARKER_NOT_ALIGNED");
	});

	it("fires when the board sits well too high in frame", () => {
		const aggregate = evaluateMarkerBoardWindowAggregate(
			alignedFrames(MARKER_ALIGNMENT.targetXNorm, MARKER_ALIGNMENT.targetYNorm - 0.25),
			defaultMarkerBoardCheckConfig(DEFAULTS)
		);
		expect(aggregate.activeCodes).toContain("MARKER_NOT_ALIGNED");
	});

	it("never displaces a more fundamental board problem", () => {
		// A misaligned AND incomplete board must say "make the whole board visible" first -
		// where it sits is not actionable while the camera cannot resolve it.
		const frames = Array.from({ length: 20 }, (_, i) => ({
			imageData: null,
			timestampMs: i * 125,
			frameWidth: FRAME_WIDTH,
			frameHeight: FRAME_HEIGHT,
			people: null,
			markers: fullSetMarkers(GOOD_SIZE, 0.9, 0.2).slice(0, 4),
		}));
		const aggregate = evaluateMarkerBoardWindowAggregate(frames, defaultMarkerBoardCheckConfig(DEFAULTS));
		expect(aggregate.activeCodes[0]).toBe("MARKER_INCOMPLETE");
		expect(aggregate.activeCodes).not.toContain("MARKER_NOT_ALIGNED");
	});
});

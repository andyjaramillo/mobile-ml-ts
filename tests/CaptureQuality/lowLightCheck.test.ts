import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULTS, LIGHTING_GRID } from "../../src/CaptureQuality/captureQualityConfig";
import type { LightingRoiRect } from "../../src/CaptureQuality/captureQualityConfig";
import type { CaptureQualityDetectedMarker, CaptureQualityFrameSample } from "../../src/CaptureQuality/types";
import {
	aggregateLowLightMetrics,
	createLowLightFrameWindow,
	createLowLightHysteresisState,
	defaultLowLightCheckConfig,
	evaluateLowLightFrame,
	evaluateLowLightWindow,
	evaluateLowLightWindowAggregate,
	pushLowLightFrame,
	resetLowLightFrameWindow,
	resolveLowLightRoi,
} from "../../src/CaptureQuality/lowLightCheck";
import type { LowLightFrameMetrics } from "../../src/CaptureQuality/lowLightCheck";
import { parseCompactExportFile } from "../../scripts/calibrate/parse";
import { lightingSampleToMetrics } from "../../scripts/calibrate/lightingReplay";
import { defaultMarkerBoardCheckConfig } from "../../src/CaptureQuality/markerBoardCheck";
import { replayRecording } from "../../scripts/calibrate/replay";

const WIDTH = 200;
const HEIGHT = 200;
const config = defaultLowLightCheckConfig(DEFAULTS);
const FULL_FRAME_ROI: LightingRoiRect = { xNorm: 0, yNorm: 0, widthNorm: 1, heightNorm: 1 };

// The "board" occupies the middle third of the frame in both axes - far from the edges,
// so a resolved ROI (padded outward from this rect) never clips against the frame
// boundary in a way that would confound the "does the ROI actually isolate the board"
// assertions below.
const BOARD_RECT = { xNorm: 1 / 3, yNorm: 1 / 3, widthNorm: 1 / 3, heightNorm: 1 / 3 };

// jsdom (the test environment - see vitest.config.ts) does not implement the ImageData
// constructor, so fixtures build the same {data, width, height} shape by hand rather than
// via `new ImageData(...)`.
function makeImageData(width: number, height: number, pixel: (x: number, y: number) => number): ImageData {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const l = pixel(x, y);
			const i = (y * width + x) * 4;
			data[i] = l;
			data[i + 1] = l;
			data[i + 2] = l;
			data[i + 3] = 255;
		}
	}
	return { data, width, height } as ImageData;
}

function frameFor(imageData: ImageData | null, markers: CaptureQualityDetectedMarker[] | null = null): CaptureQualityFrameSample {
	return {
		imageData,
		timestampMs: 0,
		frameWidth: imageData?.width ?? WIDTH,
		frameHeight: imageData?.height ?? HEIGHT,
		people: null,
		markers,
	};
}

function markerAt(id: number, rect: { xNorm: number; yNorm: number; widthNorm: number; heightNorm: number }): CaptureQualityDetectedMarker {
	const x0 = rect.xNorm * WIDTH;
	const y0 = rect.yNorm * HEIGHT;
	const x1 = (rect.xNorm + rect.widthNorm) * WIDTH;
	const y1 = (rect.yNorm + rect.heightNorm) * HEIGHT;
	return {
		id,
		corners: [
			{ x: x0, y: y0 },
			{ x: x1, y: y0 },
			{ x: x1, y: y1 },
			{ x: x0, y: y1 },
		],
	};
}

// Deterministic per-pixel "texture" (not a flat fill) so a bright/dark region isn't ALSO
// a flat/washed one by construction - real scenes have local variation, and this keeps
// the LOW_LIGHT and LOW_CONTRAST fixtures below from conflating the two failure modes.
function textured(base: number, amplitude: number, x: number, y: number): number {
	return base + amplitude * Math.sin(x * 0.9) * Math.cos(y * 0.7);
}

/** Builds a WIDTH x HEIGHT image with BOARD_RECT painted by `board` and everywhere else painted by `background`. */
function boardVsBackgroundImage(board: (x: number, y: number) => number, background: (x: number, y: number) => number): ImageData {
	const x0 = BOARD_RECT.xNorm * WIDTH;
	const y0 = BOARD_RECT.yNorm * HEIGHT;
	const x1 = x0 + BOARD_RECT.widthNorm * WIDTH;
	const y1 = y0 + BOARD_RECT.heightNorm * HEIGHT;
	return makeImageData(WIDTH, HEIGHT, (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1 ? board(x, y) : background(x, y)));
}

describe("evaluateLowLightFrame", () => {
	it("returns an empty-metrics result rather than crashing when imageData is null", () => {
		const metrics = evaluateLowLightFrame(frameFor(null), config, FULL_FRAME_ROI);
		expect(metrics.computableCellCount).toBe(0);
		expect(metrics.meanLuma).toBeNull();
		expect(metrics.darkCellFraction).toBeNull();
		expect(metrics.meanContrastStd).toBeNull();
		expect(metrics.flatCellFraction).toBeNull();
	});

	it("computes cellCount = grid.cols * grid.rows for a normally-sized frame", () => {
		const image = makeImageData(WIDTH, HEIGHT, (x, y) => textured(200, 20, x, y));
		const metrics = evaluateLowLightFrame(frameFor(image), config, FULL_FRAME_ROI);
		expect(metrics.cellCount).toBe(config.grid.cols * config.grid.rows);
		expect(metrics.computableCellCount).toBe(config.grid.cols * config.grid.rows);
	});

	it("defaults to config.roi.defaultRoi when no roi argument is supplied", () => {
		const image = makeImageData(WIDTH, HEIGHT, (x, y) => textured(200, 20, x, y));
		const withDefault = evaluateLowLightFrame(frameFor(image), config);
		const withExplicitDefault = evaluateLowLightFrame(frameFor(image), config, config.roi.defaultRoi);
		expect(withDefault).toEqual(withExplicitDefault);
	});
});

describe("ROI scoping - the false-positive fix", () => {
	it("a bright, textured board (with any background) passes clean", () => {
		const image = boardVsBackgroundImage(
			(x, y) => textured(210, 25, x, y),
			(x, y) => textured(210, 25, x, y)
		);
		const results = evaluateLowLightWindow([frameFor(image, [markerAt(0, BOARD_RECT)])], config);
		expect(results).toEqual([]);
	});

	it("a dark board trips LOW_LIGHT even with a BRIGHT background - the whole point of ROI scoping", () => {
		const image = boardVsBackgroundImage(
			(x, y) => textured(30, 25, x, y), // dark, textured board
			(x, y) => textured(220, 25, x, y) // bright background - a whole-frame check would average this away
		);
		const results = evaluateLowLightWindow([frameFor(image, [markerAt(0, BOARD_RECT)])], config);
		expect(results.map((r) => r.code)).toContain("LOW_LIGHT");
	});

	it("the inverse: a bright board with a DARK surrounding does NOT warn", () => {
		// 120 over 45, not the 210 over 20 this fixture used before GLARE existed. Both old
		// values are outside anything a real capture produces (the two 2026-09-01 recordings
		// span 45-126 clean and 45-171 under glare), and a 210 board over a 20 floor reads as
		// exactly the blown-out patch GLARE now exists to report. The split is still a clear
		// bright-board-on-dark-floor, and the assertion is unchanged.
		const image = boardVsBackgroundImage(
			(x, y) => textured(120, 25, x, y), // bright, textured board
			(x, y) => textured(45, 5, x, y) // dark background - a whole-frame check could plausibly drag the mean down
		);
		const results = evaluateLowLightWindow([frameFor(image, [markerAt(0, BOARD_RECT)])], config);
		expect(results).toEqual([]);
	});

	it("a flat/washed board trips LOW_CONTRAST regardless of a differently-textured background", () => {
		const image = boardVsBackgroundImage(
			() => 220, // perfectly flat, bright board
			(x, y) => textured(120, 40, x, y) // ordinary textured background
		);
		const results = evaluateLowLightWindow([frameFor(image, [markerAt(0, BOARD_RECT)])], config);
		expect(results.map((r) => r.code)).toContain("LOW_CONTRAST");
		expect(results.map((r) => r.code)).not.toContain("LOW_LIGHT");
	});

	it("reproduces the reported bug: blank wall/floor/ceiling cells far outside the board no longer count toward LOW_CONTRAST", () => {
		// Flat wall/floor/ceiling only in the outer ring, well outside the padded ROI,
		// while the board and its immediate surroundings stay textured - the shape of the
		// real false-positive recording, where the flat cells were distant wall rather
		// than board-adjacent floor.
		const image = makeImageData(WIDTH, HEIGHT, (x, y) => {
			const xNorm = x / WIDTH;
			const yNorm = y / HEIGHT;
			const farFromBoard = xNorm < 0.1 || xNorm > 0.9 || yNorm < 0.1 || yNorm > 0.9;
			return farFromBoard ? 200 : textured(180, 30, x, y);
		});
		const results = evaluateLowLightWindow([frameFor(image, [markerAt(0, BOARD_RECT)])], config);
		expect(results).toEqual([]);
	});

	it("reports GLARE for a blown-out patch on part of the board", () => {
		// Bright patch over one side, ordinary level elsewhere - the shape of the 2026-09-01
		// glare recording (five of sixteen cells bright, spread 120-126, markers under the
		// patch not resolving). Both halves of the signal have to be present.
		const image = boardVsBackgroundImage(
			(x, y) => (x > (BOARD_RECT.xNorm + BOARD_RECT.widthNorm / 2) * WIDTH ? 225 : textured(85, 20, x, y)),
			(x, y) => textured(85, 20, x, y)
		);
		const results = evaluateLowLightWindow([frameFor(image, [markerAt(0, BOARD_RECT)])], config);
		expect(results.map((r) => r.code)).toContain("GLARE");
	});

	it("does NOT report GLARE when the whole ROI is bright - that is a bright room, not a patch", () => {
		const image = boardVsBackgroundImage(
			(x, y) => textured(210, 25, x, y),
			(x, y) => textured(210, 25, x, y)
		);
		const results = evaluateLowLightWindow([frameFor(image, [markerAt(0, BOARD_RECT)])], config);
		expect(results.map((r) => r.code)).not.toContain("GLARE");
	});

	it("does NOT report GLARE for a bright but EVEN roi - the false positive the first pass shipped", () => {
		// Modeled on false-glare-a: plenty of bright cells (0.39-0.47 of them) but a spread of
		// only 80-89, and every one of the nine markers resolving on every frame.
		const image = boardVsBackgroundImage(
			(x, y) => textured(150, 20, x, y),
			(x, y) => textured(140, 20, x, y)
		);
		const results = evaluateLowLightWindow([frameFor(image, [markerAt(0, BOARD_RECT)])], config);
		expect(results.map((r) => r.code)).not.toContain("GLARE");
	});

	it("does not report GLARE off a fallback ROI either - a lamp in the default rect is not glare on the board", () => {
		const blankBrightRoom = frameFor(
			makeImageData(WIDTH, HEIGHT, (x, y) => (x > WIDTH / 2 ? 200 : textured(90, 25, x, y))),
			null
		);
		const aggregate = evaluateLowLightWindowAggregate([blankBrightRoom, blankBrightRoom], config);
		expect(aggregate.latestRoiSource).toBe("default");
		expect(aggregate.activeCodes).not.toContain("GLARE");
	});

	it("does not report LOW_CONTRAST off a fallback ROI - a blank room says nothing about the board", () => {
		// No markers anywhere, so the ROI falls to the default rect, which lands on floor and
		// wall. Bright and perfectly flat: the reading is real, it is just not about the board.
		const blankRoom = frameFor(makeImageData(WIDTH, HEIGHT, () => 200), null);
		const aggregate = evaluateLowLightWindowAggregate([blankRoom, blankRoom, blankRoom], config);
		expect(aggregate.latestRoiSource).toBe("default");
		expect(aggregate.activeCodes).not.toContain("LOW_CONTRAST");
	});

	it("releases a LOW_CONTRAST verdict once no frame in the window still finds the board", () => {
		const state = createLowLightHysteresisState();
		const washedBoard = frameFor(
			boardVsBackgroundImage(
				() => 220,
				(x, y) => textured(120, 40, x, y)
			),
			[markerAt(0, BOARD_RECT)]
		);
		expect(evaluateLowLightWindowAggregate([washedBoard], config, state).activeCodes).toContain("LOW_CONTRAST");

		// Board gone: applyHysteresis's null-hold would otherwise carry that verdict forever,
		// since only a detected-ROI frame can lower it again.
		const blankRoom = frameFor(makeImageData(WIDTH, HEIGHT, () => 200), null);
		const after = evaluateLowLightWindowAggregate([blankRoom, blankRoom], config, state);
		expect(state.lowContrastBad).toBe(false);
		expect(after.activeCodes).not.toContain("LOW_CONTRAST");
	});
});

describe("resolveLowLightRoi - the three selection paths", () => {
	it("path 1 (detected): uses this frame's own marker bounding box, padded", () => {
		const frame = frameFor(makeImageData(WIDTH, HEIGHT, () => 128), [markerAt(0, BOARD_RECT)]);
		const { roi, source } = resolveLowLightRoi([frame], config);
		expect(source).toBe("detected");
		// Padded outward from BOARD_RECT (marginFrac/minMarginNorm both push outward -
		// see computeDetectedRoi), so the resolved box must fully contain BOARD_RECT.
		expect(roi.xNorm).toBeLessThanOrEqual(BOARD_RECT.xNorm);
		expect(roi.yNorm).toBeLessThanOrEqual(BOARD_RECT.yNorm);
		expect(roi.xNorm + roi.widthNorm).toBeGreaterThanOrEqual(BOARD_RECT.xNorm + BOARD_RECT.widthNorm);
		expect(roi.yNorm + roi.heightNorm).toBeGreaterThanOrEqual(BOARD_RECT.yNorm + BOARD_RECT.heightNorm);
	});

	it("path 2 (last-known): reuses the most recent detected ROI when the newest frame has no markers", () => {
		const withMarkers = frameFor(makeImageData(WIDTH, HEIGHT, () => 128), [markerAt(0, BOARD_RECT)]);
		const withoutMarkers = frameFor(makeImageData(WIDTH, HEIGHT, () => 128), null);
		const { roi: detectedRoi } = resolveLowLightRoi([withMarkers], config);

		const { roi, source } = resolveLowLightRoi([withMarkers, withoutMarkers, withoutMarkers], config);
		expect(source).toBe("last-known");
		expect(roi).toEqual(detectedRoi);
	});

	it("path 3 (default): falls back to config.roi.defaultRoi when no frame in the window has markers", () => {
		const withoutMarkers = frameFor(makeImageData(WIDTH, HEIGHT, () => 128), null);
		const { roi, source } = resolveLowLightRoi([withoutMarkers, withoutMarkers], config);
		expect(source).toBe("default");
		expect(roi).toEqual(config.roi.defaultRoi);
	});

	it("path 3 also covers an empty window (nothing evaluated yet, e.g. a dark room with no detection ever)", () => {
		const { roi, source } = resolveLowLightRoi([], config);
		expect(source).toBe("default");
		expect(roi).toEqual(config.roi.defaultRoi);
	});

	it("falls back correctly when markers vanish mid-window: last-known while the detection is still in the bounded window, default once it rolls out", () => {
		const window = createLowLightFrameWindow(3);
		const withMarkers = frameFor(makeImageData(WIDTH, HEIGHT, () => 128), [markerAt(0, BOARD_RECT)]);
		const withoutMarkers = frameFor(makeImageData(WIDTH, HEIGHT, () => 128), null);

		pushLowLightFrame(window, withMarkers);
		expect(resolveLowLightRoi(window.frames, config).source).toBe("detected");

		pushLowLightFrame(window, withoutMarkers);
		expect(resolveLowLightRoi(window.frames, config).source).toBe("last-known");

		pushLowLightFrame(window, withoutMarkers);
		// window.maxFrames = 3, and this is the 3rd push - the original detection is still
		// the oldest frame in the window, so it must still be reachable.
		expect(resolveLowLightRoi(window.frames, config).source).toBe("last-known");

		pushLowLightFrame(window, withoutMarkers);
		// 4th push evicts the original detected frame (bounded ring buffer) - no frame in
		// the window has ever seen a marker anymore, so this must decay to default.
		expect(resolveLowLightRoi(window.frames, config).source).toBe("default");
	});
});

describe("hysteresis (LOW_LIGHT/LOW_CONTRAST)", () => {
	function metricsWithFractions(darkCellFraction: number, flatCellFraction: number): LowLightFrameMetrics {
		return {
			cellCount: 16,
			computableCellCount: 16,
			meanLuma: 100,
			darkCellFraction,
			meanContrastStd: 20,
			flatCellFraction,
		} as LowLightFrameMetrics;
	}

	it("holds LOW_LIGHT active between the warn and clear thresholds instead of flapping on noise, and clears only below the clear threshold", () => {
		const hysteresis = createLowLightHysteresisState();
		const warn = config.thresholds.darkCellFractionThreshold;
		const clear = config.thresholds.darkCellFractionClearThreshold;
		expect(clear).toBeLessThan(warn);

		// Crosses warn -> becomes bad.
		let agg = aggregateLowLightMetrics([metricsWithFractions(warn + 0.05, 0)], config, hysteresis);
		expect(agg.activeCodes).toContain("LOW_LIGHT");

		// Drops below warn but stays above clear - must still read as bad (this is exactly
		// the noise band a bare threshold comparison would flap on).
		const between = (warn + clear) / 2;
		agg = aggregateLowLightMetrics([metricsWithFractions(between, 0)], config, hysteresis);
		expect(agg.activeCodes).toContain("LOW_LIGHT");

		// Drops to/below clear - now it clears.
		agg = aggregateLowLightMetrics([metricsWithFractions(clear - 0.02, 0)], config, hysteresis);
		expect(agg.activeCodes).not.toContain("LOW_LIGHT");
	});

	it("does the same for LOW_CONTRAST independently of LOW_LIGHT", () => {
		const hysteresis = createLowLightHysteresisState();
		const warn = config.thresholds.flatCellFractionThreshold;
		const clear = config.thresholds.flatCellFractionClearThreshold;

		let agg = aggregateLowLightMetrics([metricsWithFractions(0, warn + 0.05)], config, hysteresis);
		expect(agg.activeCodes).toContain("LOW_CONTRAST");
		expect(agg.activeCodes).not.toContain("LOW_LIGHT");

		agg = aggregateLowLightMetrics([metricsWithFractions(0, (warn + clear) / 2)], config, hysteresis);
		expect(agg.activeCodes).toContain("LOW_CONTRAST");

		agg = aggregateLowLightMetrics([metricsWithFractions(0, clear - 0.02)], config, hysteresis);
		expect(agg.activeCodes).not.toContain("LOW_CONTRAST");
	});
});

describe("window reset", () => {
	it("clears prior frames AND hysteresis so a new trial does not inherit a previous trial's lighting state", () => {
		const window = createLowLightFrameWindow(DEFAULTS.sampling.liveWindowFrameCount);
		const dark = frameFor(makeImageData(WIDTH, HEIGHT, (x, y) => textured(30, 25, x, y)));
		for (let i = 0; i < 5; i++) pushLowLightFrame(window, dark);
		expect(evaluateLowLightWindowAggregate(window.frames, config, window.hysteresis).activeCodes).toContain("LOW_LIGHT");

		resetLowLightFrameWindow(window);
		expect(window.frames).toHaveLength(0);
		expect(window.hysteresis.lowLightBad).toBe(false);
		expect(window.hysteresis.lowContrastBad).toBe(false);

		const bright = frameFor(makeImageData(WIDTH, HEIGHT, (x, y) => textured(210, 25, x, y)));
		pushLowLightFrame(window, bright);
		const aggregate = evaluateLowLightWindowAggregate(window.frames, config, window.hysteresis);
		expect(aggregate.frameCount).toBe(1);
		expect(aggregate.activeCodes).not.toContain("LOW_LIGHT");
	});
});

describe("aggregateLowLightMetrics", () => {
	it("returns a zeroed aggregate for an empty window", () => {
		const aggregate = aggregateLowLightMetrics([], config);
		expect(aggregate).toEqual({
			frameCount: 0,
			weightedMeanLuma: null,
			weightedDarkCellFraction: null,
			weightedBrightCellFraction: null,
			weightedLumaSpread: null,
			weightedMeanContrastStd: null,
			weightedFlatCellFraction: null,
			latest: null,
			latestRoi: null,
			latestRoiSource: null,
			activeCodes: [],
		});
	});

	it("carries a metric forward unchanged on a frame where it is not computable, rather than pulling the EWMA toward a fabricated value", () => {
		const bright = evaluateLowLightFrame(frameFor(makeImageData(WIDTH, HEIGHT, (x, y) => textured(210, 25, x, y))), config, FULL_FRAME_ROI);
		const empty = evaluateLowLightFrame(frameFor(null), config, FULL_FRAME_ROI);
		const aggregate = aggregateLowLightMetrics([bright, empty], config);
		expect(aggregate.weightedMeanLuma).toBe(bright.meanLuma);
	});
});

describe("evaluateLowLightWindowAggregate - latestRoi/latestRoiSource", () => {
	it("reports the ROI and source used for the newest frame", () => {
		const frame = frameFor(makeImageData(WIDTH, HEIGHT, () => 150), [markerAt(0, BOARD_RECT)]);
		const aggregate = evaluateLowLightWindowAggregate([frame], config);
		expect(aggregate.latestRoiSource).toBe("detected");
		expect(aggregate.latestRoi).not.toBeNull();
	});
});

describe("CQ1 export lines still parse under the extended (CQ1/CQ2/CQ3) parser", () => {
	const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures/sample-recording.cq1.txt");

	it("parses a CQ1 line as formatVersion 1 with no lighting samples", () => {
		const [recording] = parseCompactExportFile(FIXTURE_PATH, readFileSync(FIXTURE_PATH, "utf8"));
		expect(recording.formatVersion).toBe(1);
		expect(recording.lightingSamples).toEqual([]);
		expect(recording.lightingGrid).toBeNull();
		expect(recording.lightingScope).toBe("none");
		expect(recording.samples.every((s) => s.detArea === null)).toBe(true);
	});
});

describe("GLARE across every ROI-scoped recording - exactly one of them is glare", () => {
	// The first pass at GLARE was fitted to two recordings and false-fired on the phone;
	// this pins it against all of them, so a threshold move has to answer for every setup
	// on file rather than the two it was tuned on. GLARE_FILE is the only recording where
	// the board actually failed to resolve (marker 8 absent in 31/31 frames).
	const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const GLARE_FILE = "2026-09-01-gait-roi-glare.cq4.txt";
	const ROI_RECORDINGS = [
		"2026-08-13-gait-1024-viable-range-sweep.cq3.txt",
		"2026-08-13-gait-768-viable-range-sweep.cq3.txt",
		"2026-08-13-gait-ideal-1024-throttled.cq3.txt",
		"2026-08-17-gait-subject-absent.cq4.txt",
		"2026-08-17-gait-subject-at-start-fidget.cq4.txt",
		"2026-08-17-gait-subject-at-start-still.cq4.txt",
		"2026-08-17-gait-subject-too-far-back.cq4.txt",
		"2026-08-17-gait-subject-two-people.cq4.txt",
		"2026-08-17-gait-subject-walking-away.cq4.txt",
		"2026-08-18-gait-subject-far-back-lateral.cq4.txt",
		"2026-09-01-gait-roi-contrast-false-warn.cq4.txt",
		"2026-09-01-gait-roi-false-glare-a.cq4.txt",
		"2026-09-01-gait-roi-false-glare-b.cq4.txt",
		GLARE_FILE,
	];

	function glareFiredIn(file: string): boolean {
		const path = join(REPO_ROOT, "calibration", file);
		const [recording] = parseCompactExportFile(path, readFileSync(path, "utf8"));
		expect(recording.lightingScope).toBe("roi");
		const grid = recording.lightingGrid ?? LIGHTING_GRID;
		const metrics = recording.lightingSamples.map((sample, i) =>
			lightingSampleToMetrics(sample, grid, DEFAULTS.lighting, i * 250)
		);
		const hysteresis = createLowLightHysteresisState();
		return metrics.some((_, i) =>
			aggregateLowLightMetrics(metrics.slice(0, i + 1), config, hysteresis).activeCodes.includes("GLARE")
		);
	}

	for (const file of ROI_RECORDINGS) {
		const shouldFire = file === GLARE_FILE;
		it(`${shouldFire ? "reports" : "stays silent on"} ${file}`, () => {
			expect(glareFiredIn(file)).toBe(shouldFire);
		});
	}
});

describe("the six committed CQ2 recordings - lighting data is historical (whole-frame), marker classifications are unaffected by the ROI change", () => {
	const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	// Final-frame state, pinned against markerBoardCheck.ts DEFAULTS. Re-pin if those
	// legitimately change; a move caused by a lighting-only edit means the two modules have
	// become coupled. ideal-overlay-match moved here when the EWMA became time-based - see
	// markerBoardCheck.test.ts's note on that recording; its dominant state is unchanged,
	// this is the last frame only, which sits right on the full-set gate.
	const EXPECTED: Record<string, string> = {
		"2026-08-12-gait-d-3ft-cropped.cq2.txt": "MARKER_TOO_CLOSE",
		"2026-08-12-gait-d-3p5ft-good.cq2.txt": "MARKER_TOO_LARGE",
		"2026-08-13-gait-good-lighting-false-warn.cq2.txt": "OK",
		"2026-08-13-gait-good-place-drift.cq2.txt": "OK",
		"2026-08-13-gait-ideal-overlay-match.cq2.txt": "OK",
		"2026-08-13-gait-viable-range-sweep.cq2.txt": "MARKER_INCOMPLETE",
	};

	for (const [fileName, expectedLastState] of Object.entries(EXPECTED)) {
		it(`${fileName} still parses as CQ2/whole-frame and replays to the same dominant marker state`, () => {
			const path = join(REPO_ROOT, "calibration", fileName);
			const [recording] = parseCompactExportFile(path, readFileSync(path, "utf8"));

			expect(recording.formatVersion).toBe(2);
			expect(recording.lightingSamples.length).toBeGreaterThan(0);
			// The load-bearing assertion for this change: CQ2 lighting must be labeled
			// whole-frame/historical, never mistaken for ROI-scoped CQ3 data.
			expect(recording.lightingScope).toBe("whole-frame");
			for (const sample of recording.lightingSamples) {
				expect(sample.roi).toBeNull();
				expect(sample.roiSource).toBeNull();
			}

			const markerConfig = defaultMarkerBoardCheckConfig(DEFAULTS);
			const steps = replayRecording(recording, markerConfig, DEFAULTS.sampling.liveWindowFrameCount);
			const last = steps[steps.length - 1];
			const lastState = last.activeCodes.length === 0 ? "OK" : [...last.activeCodes].sort().join("+");
			expect(lastState).toBe(expectedLastState);
		});
	}
});

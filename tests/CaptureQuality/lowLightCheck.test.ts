import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/CaptureQuality/captureQualityConfig";
import type { CaptureQualityFrameSample } from "../../src/CaptureQuality/types";
import {
	aggregateLowLightMetrics,
	createLowLightFrameWindow,
	defaultLowLightCheckConfig,
	evaluateLowLightFrame,
	evaluateLowLightWindow,
	evaluateLowLightWindowAggregate,
	pushLowLightFrame,
	resetLowLightFrameWindow,
} from "../../src/CaptureQuality/lowLightCheck";
import { parseCompactExportFile } from "../../scripts/calibrate/parse";

const WIDTH = 128;
const HEIGHT = 72;
const config = defaultLowLightCheckConfig(DEFAULTS);

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

function frameFor(imageData: ImageData | null): CaptureQualityFrameSample {
	return {
		imageData,
		timestampMs: 0,
		frameWidth: imageData?.width ?? WIDTH,
		frameHeight: imageData?.height ?? HEIGHT,
		people: null,
		markers: null,
	};
}

// Deterministic per-pixel "texture" (not a flat fill) so a bright/dark frame isn't ALSO
// a flat/washed one by construction - real scenes have local variation, and this keeps
// the LOW_LIGHT and LOW_CONTRAST fixtures below from conflating the two failure modes.
function textured(base: number, amplitude: number, x: number, y: number): number {
	return base + amplitude * Math.sin(x * 0.9) * Math.cos(y * 0.7);
}

describe("evaluateLowLightFrame", () => {
	it("returns an empty-metrics result rather than crashing when imageData is null", () => {
		const metrics = evaluateLowLightFrame(frameFor(null), config);
		expect(metrics.computableCellCount).toBe(0);
		expect(metrics.meanLuma).toBeNull();
		expect(metrics.darkCellFraction).toBeNull();
		expect(metrics.meanContrastStd).toBeNull();
		expect(metrics.flatCellFraction).toBeNull();
	});

	it("computes cellCount = grid.cols * grid.rows for a normally-sized frame", () => {
		const image = makeImageData(WIDTH, HEIGHT, (x, y) => textured(200, 20, x, y));
		const metrics = evaluateLowLightFrame(frameFor(image), config);
		expect(metrics.cellCount).toBe(config.grid.cols * config.grid.rows);
		expect(metrics.computableCellCount).toBe(config.grid.cols * config.grid.rows);
	});
});

describe("evaluateLowLightWindow - the four required scenarios", () => {
	it("a uniformly bright, textured frame passes clean (no LOW_LIGHT, no LOW_CONTRAST)", () => {
		const image = makeImageData(WIDTH, HEIGHT, (x, y) => textured(210, 25, x, y));
		const results = evaluateLowLightWindow([frameFor(image)], config);
		expect(results).toEqual([]);
	});

	it("a uniformly dark frame trips LOW_LIGHT", () => {
		// Textured but dark: mean luma well below cellDarkLumaMax on every cell, amplitude
		// kept small enough that std stays above cellFlatContrastMax so this does not also
		// fire LOW_CONTRAST - isolating that this scenario is specifically a lighting problem.
		const image = makeImageData(WIDTH, HEIGHT, (x, y) => textured(30, 25, x, y));
		const metrics = evaluateLowLightFrame(frameFor(image), config);
		expect(metrics.darkCellFraction).toBe(1);
		const results = evaluateLowLightWindow([frameFor(image)], config);
		expect(results.map((r) => r.code)).toContain("LOW_LIGHT");
		expect(results.map((r) => r.code)).not.toContain("LOW_CONTRAST");
	});

	it("a flat/washed frame trips LOW_CONTRAST", () => {
		// Bright (not dark) and perfectly uniform per cell: mean well above
		// cellDarkLumaMax, std = 0 everywhere - a washed-out/overexposed scene, not a dark one.
		const image = makeImageData(WIDTH, HEIGHT, () => 220);
		const metrics = evaluateLowLightFrame(frameFor(image), config);
		expect(metrics.flatCellFraction).toBe(1);
		expect(metrics.darkCellFraction).toBe(0);
		const results = evaluateLowLightWindow([frameFor(image)], config);
		expect(results.map((r) => r.code)).toContain("LOW_CONTRAST");
		expect(results.map((r) => r.code)).not.toContain("LOW_LIGHT");
	});

	it("a localized dark patch stays localized to the cells it covers, not the whole frame - the case that justifies a grid over a single whole-frame statistic", () => {
		const cols = config.grid.cols;
		const rows = config.grid.rows;
		const cellW = WIDTH / cols;
		const cellH = HEIGHT / rows;
		// Cell (0,0) is fully dark and flat; every other cell is bright and textured.
		const image = makeImageData(WIDTH, HEIGHT, (x, y) => {
			if (x < cellW && y < cellH) return 5;
			return textured(210, 25, x, y);
		});
		const metrics = evaluateLowLightFrame(frameFor(image), config);

		// Exactly one of cols*rows cells reads dark - a single shadowed corner, not a dark room.
		expect(metrics.darkCellFraction).toBeCloseTo(1 / (cols * rows), 5);
		// A single dark cell is not remotely close to the fraction-of-cells threshold, so it
		// must not fire LOW_LIGHT - a whole-frame MEAN luma check could plausibly have been
		// dragged down further by one very dark cell than a per-cell fraction is, which is
		// exactly the false-positive-on-a-shadow failure mode the grid avoids.
		const results = evaluateLowLightWindow([frameFor(image)], config);
		expect(results.map((r) => r.code)).not.toContain("LOW_LIGHT");
		expect(results.map((r) => r.code)).not.toContain("LOW_CONTRAST");
	});
});

describe("window reset", () => {
	it("clears prior frames so a new trial does not inherit a previous trial's lighting state", () => {
		const window = createLowLightFrameWindow(DEFAULTS.sampling.liveWindowFrameCount);
		const dark = frameFor(makeImageData(WIDTH, HEIGHT, (x, y) => textured(30, 25, x, y)));
		for (let i = 0; i < 5; i++) pushLowLightFrame(window, dark);
		expect(evaluateLowLightWindowAggregate(window.frames, config).activeCodes).toContain("LOW_LIGHT");

		resetLowLightFrameWindow(window);
		expect(window.frames).toHaveLength(0);

		const bright = frameFor(makeImageData(WIDTH, HEIGHT, (x, y) => textured(210, 25, x, y)));
		pushLowLightFrame(window, bright);
		const aggregate = evaluateLowLightWindowAggregate(window.frames, config);
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
			weightedMeanContrastStd: null,
			weightedFlatCellFraction: null,
			latest: null,
			activeCodes: [],
		});
	});

	it("carries a metric forward unchanged on a frame where it is not computable, rather than pulling the EWMA toward a fabricated value", () => {
		const bright = evaluateLowLightFrame(frameFor(makeImageData(WIDTH, HEIGHT, (x, y) => textured(210, 25, x, y))), config);
		const empty = evaluateLowLightFrame(frameFor(null), config);
		const aggregate = aggregateLowLightMetrics([bright, empty], config);
		expect(aggregate.weightedMeanLuma).toBe(bright.meanLuma);
	});
});

describe("CQ1 export lines still parse under the extended (CQ1/CQ2) parser", () => {
	const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures/sample-recording.cq1.txt");

	it("parses a CQ1 line as formatVersion 1 with no lighting samples", () => {
		const [recording] = parseCompactExportFile(FIXTURE_PATH, readFileSync(FIXTURE_PATH, "utf8"));
		expect(recording.formatVersion).toBe(1);
		expect(recording.lightingSamples).toEqual([]);
		expect(recording.lightingGrid).toBeNull();
		expect(recording.samples.every((s) => s.detArea === null)).toBe(true);
	});
});

import { describe, expect, it } from "vitest";
import { DEFAULTS, MARKER_BOARD } from "../../src/CaptureQuality/captureQualityConfig";
import type { CaptureQualityBBox, CaptureQualityDetectedMarker, CaptureQualityFrameSample } from "../../src/CaptureQuality/types";
import {
	aggregateSubjectPositionMetrics,
	createSubjectPositionFrameWindow,
	createSubjectPositionHysteresisState,
	defaultSubjectPositionCheckConfig,
	evaluateSubjectPositionFrame,
	evaluateSubjectPositionWindowAggregate,
	pushSubjectPositionFrame,
	resetSubjectPositionFrameWindow,
	selectSubject,
} from "../../src/CaptureQuality/subjectPositionCheck";

const WIDTH = 1024;
const HEIGHT = 768;
const config = defaultSubjectPositionCheckConfig(DEFAULTS);

// A minimal board: only the two forward-axis markers are needed for boardLengthPx, which
// is the unit every distance in this check is expressed in. Placed 100px apart so one
// board length is exactly 100px and the expected values below are readable by hand.
const [AXIS_TAIL, AXIS_HEAD] = MARKER_BOARD.forwardAxisMarkerIds;

function markerAt(id: number, x: number, y: number): CaptureQualityDetectedMarker {
	return {
		id,
		corners: [
			{ x: x - 2, y: y - 2 },
			{ x: x + 2, y: y - 2 },
			{ x: x + 2, y: y + 2 },
			{ x: x - 2, y: y + 2 },
		],
	};
}

/** Board centroid lands at (500, 500); one board length is 100px. */
function boardMarkers(): CaptureQualityDetectedMarker[] {
	return [markerAt(AXIS_TAIL, 500, 550), markerAt(AXIS_HEAD, 500, 450)];
}

// The gating signal is (boardCentroidY - subjectCentroidY) / frameHeight. boardMarkers()
// puts the board centroid at y=500 in a 768-high frame, so a subject centred at y=326 gives
// a gap of (500-326)/768 = 0.227 - the middle of the measured at-the-line band (0.204-0.259).
// Size is irrelevant to the gate now and only feeds the reported area.
function personAt(centerX: number, centerY: number, width = 400, height = 315): CaptureQualityBBox {
	return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

function frame(
	timestampMs: number,
	people: CaptureQualityBBox[] | null,
	markers: CaptureQualityDetectedMarker[] = boardMarkers()
): CaptureQualityFrameSample {
	return {
		imageData: null,
		timestampMs,
		frameWidth: WIDTH,
		frameHeight: HEIGHT,
		people,
		markers,
	};
}

describe("evaluateSubjectPositionFrame", () => {
	it("reports personCount null - not 0 - when detection did not run", () => {
		const metrics = evaluateSubjectPositionFrame(frame(0, null), config);
		expect(metrics.personCount).toBeNull();
		expect(metrics.subjectBBox).toBeNull();
		expect(metrics.startLineDistanceBoardLengths).toBeNull();
	});

	it("distinguishes a ran-and-found-nobody frame from a skipped one", () => {
		const metrics = evaluateSubjectPositionFrame(frame(0, []), config);
		expect(metrics.personCount).toBe(0);
		expect(metrics.subjectBBox).toBeNull();
	});

	it("still reports start-line distance in board lengths, though it no longer gates", () => {
		// Subject 174px above the board centroid, board length 100px -> 1.74 board lengths.
		const metrics = evaluateSubjectPositionFrame(frame(0, [personAt(500, 326)]), config);
		expect(metrics.boardLengthPx).toBeCloseTo(100, 5);
		expect(metrics.startLineDistanceBoardLengths).toBeCloseTo(1.74, 2);
	});

	it("measures the board-to-subject gap as a fraction of frame height", () => {
		// board centroid y=500, subject centroid y=326, frame height 768 -> 0.227.
		const metrics = evaluateSubjectPositionFrame(frame(0, [personAt(500, 326)]), config);
		expect(metrics.boardToSubjectGapNorm).toBeCloseTo((500 - 326) / 768, 5);
	});

	it("yields the same board-length distance at a different camera distance", () => {
		// Everything scaled by 0.5 - a camera twice as far away. A frame-fraction metric
		// would halve; a board-relative one must not move at all.
		const halfBoard = [markerAt(AXIS_TAIL, 250, 275), markerAt(AXIS_HEAD, 250, 225)];
		const metrics = evaluateSubjectPositionFrame(frame(0, [personAt(250, 325)], halfBoard), config);
		expect(metrics.boardLengthPx).toBeCloseTo(50, 5);
		expect(metrics.startLineDistanceBoardLengths).toBeCloseTo(1.5, 5);
	});

	it("leaves boardLengthPx null when only one forward-axis marker is visible", () => {
		const metrics = evaluateSubjectPositionFrame(frame(0, [personAt(500, 326)], [markerAt(AXIS_TAIL, 500, 550)]), config);
		expect(metrics.boardLengthPx).toBeNull();
		expect(metrics.startLineDistanceBoardLengths).toBeNull();
		// The board centroid is still computable from the one marker; only the UNIT is missing.
		expect(metrics.boardCentroid).not.toBeNull();
	});
});

describe("selectSubject", () => {
	it("picks the person nearest the board, not the largest box", () => {
		const boardCentroid = { x: 500, y: 500 };
		const patientFarAndSmall = personAt(500, 520, 40, 100);
		const bystanderNearAndLarge = personAt(200, 700, 200, 500);
		const chosen = selectSubject([bystanderNearAndLarge, patientFarAndSmall], boardCentroid);
		expect(chosen).toBe(patientFarAndSmall);
	});

	it("falls back to the largest box when there is no board to be near", () => {
		const small = personAt(500, 520, 40, 100);
		const large = personAt(200, 700, 200, 500);
		expect(selectSubject([small, large], null)).toBe(large);
	});
});

// The default person (60x160 in a 1024x768 frame) is area 0.0122 - comfortably "at the
// start line". A far-back subject images LARGER, so these tests scale the box up, not down.
// Sits LOWER in frame (nearer the camera), shrinking the gap to (500-380)/768 = 0.156,
// under the 0.187 boundary.
function farBackPerson(): CaptureQualityBBox {
	return personAt(500, 380);
}

// Sits HIGHER in frame (further down the path), opening the gap to (500-250)/768 = 0.326,
// over the 0.30 boundary.
function farForwardPerson(): CaptureQualityBBox {
	return personAt(500, 250);
}

describe("aggregateSubjectPositionMetrics", () => {
	function aggregateFrames(frames: CaptureQualityFrameSample[], hysteresis = createSubjectPositionHysteresisState()) {
		return aggregateSubjectPositionMetrics(
			frames.map((f) => evaluateSubjectPositionFrame(f, config)),
			config,
			hysteresis
		);
	}

	it("stays silent when person detection never ran - the round-robin must not warn", () => {
		const frames = [frame(0, null), frame(125, null), frame(250, null)];
		const aggregate = aggregateFrames(frames);
		expect(aggregate.detectionFrameCount).toBe(0);
		expect(aggregate.activeCodes).toEqual([]);
	});

	it("stays silent when the person detector never loaded at all", () => {
		// Indistinguishable from the case above by design: a failed model load must look
		// exactly like the check not existing (fail-open).
		const aggregate = aggregateFrames(Array.from({ length: 20 }, (_, i) => frame(i * 125, null)));
		expect(aggregate.activeCodes).toEqual([]);
	});

	it("ignores skipped ticks rather than counting them against detection", () => {
		// A 1-in-3 round robin with the subject present on every detection tick. If skipped
		// ticks counted as misses the detection score would sit near 0.33 and fire
		// SUBJECT_NOT_DETECTED permanently.
		const frames: CaptureQualityFrameSample[] = [];
		for (let i = 0; i < 30; i += 1) {
			frames.push(frame(i * 125, i % 3 === 0 ? [personAt(500, 326)] : null));
		}
		const aggregate = aggregateFrames(frames);
		expect(aggregate.detectionFrameCount).toBe(10);
		expect(aggregate.weightedDetectionScore).toBeCloseTo(1, 5);
		expect(aggregate.activeCodes).not.toContain("SUBJECT_NOT_DETECTED");
	});

	it("fires SUBJECT_NOT_DETECTED when detection ran and consistently found nobody", () => {
		const frames = Array.from({ length: 20 }, (_, i) => frame(i * 125, []));
		const aggregate = aggregateFrames(frames);
		expect(aggregate.weightedDetectionScore).toBeCloseTo(0, 5);
		expect(aggregate.activeCodes).toContain("SUBJECT_NOT_DETECTED");
	});

	it("is silent for a subject standing at the board", () => {
		const frames = Array.from({ length: 20 }, (_, i) => frame(i * 125, [personAt(500, 326)]));
		const aggregate = aggregateFrames(frames);
		expect(aggregate.activeCodes).toEqual([]);
	});

	it("fires SUBJECT_NOT_AT_START_LINE when the subject sits low in frame (= too far back)", () => {
		const frames = Array.from({ length: 20 }, (_, i) => frame(i * 125, [farBackPerson()]));
		const aggregate = aggregateFrames(frames);
		expect(aggregate.weightedBoardToSubjectGapNorm as number).toBeLessThan(config.thresholds.tooFarBackGapNorm);
		expect(aggregate.activeCodes).toContain("SUBJECT_NOT_AT_START_LINE");
	});

	it("still decides position when the board is not measurable at all", () => {
		// The area signal does not reference the board, unlike the distance metric it
		// replaced. Board framing is the marker check's job; this one keeps working without
		// it rather than going quiet.
		const noAxis = [markerAt(4, 500, 500)];
		const frames = Array.from({ length: 20 }, (_, i) => frame(i * 125, [farBackPerson()], noAxis));
		const aggregate = aggregateFrames(frames);
		expect(aggregate.latest?.boardLengthPx).toBeNull();
		expect(aggregate.activeCodes).toContain("SUBJECT_NOT_AT_START_LINE");
	});

	it("does not warn about movement - stillness is deliberately not gated", () => {
		// A subject walking away is not something this feature reports. The signal is
		// computed (area CV measured 0.73 walking vs 0.03 still) but must not block the
		// green light. See the check's module header.
		const frames = Array.from({ length: 20 }, (_, i) =>
			frame(i * 125, [personAt(500, 520, 60 - i * 2, 160 - i * 6)])
		);
		const aggregate = aggregateFrames(frames);
		expect(aggregate.subjectAreaCv).toBeGreaterThan(0.2);
		expect(aggregate.activeCodes).not.toContain("SUBJECT_NOT_STATIONARY");
	});

	it("fires MULTIPLE_PEOPLE while still reporting the chosen subject's geometry", () => {
		const frames = Array.from({ length: 20 }, (_, i) =>
			frame(i * 125, [personAt(500, 326), personAt(150, 700, 200, 400)])
		);
		const aggregate = aggregateFrames(frames);
		expect(aggregate.activeCodes).toContain("MULTIPLE_PEOPLE");
		// The nearer-the-board box is still the subject, so position still reads clean.
		expect(aggregate.activeCodes).not.toContain("SUBJECT_NOT_AT_START_LINE");
	});

	it("holds SUBJECT_NOT_AT_START_LINE through a dip that clears the warn level but not the clear level", () => {
		const hysteresis = createSubjectPositionHysteresisState();
		const far = Array.from({ length: 20 }, (_, i) => frame(i * 125, [farBackPerson()]));
		expect(aggregateFrames(far, hysteresis).activeCodes).toContain("SUBJECT_NOT_AT_START_LINE");

		// gap (500-353)/768 = 0.191: back over the 0.187 warn level, but under the 0.20 clear level.
		const borderline = Array.from({ length: 40 }, (_, i) => frame(2500 + i * 125, [personAt(500, 353)]));
		const aggregate = aggregateFrames(borderline, hysteresis);
		expect(aggregate.weightedBoardToSubjectGapNorm as number).toBeGreaterThan(config.thresholds.tooFarBackGapNorm);
		expect(aggregate.activeCodes).toContain("SUBJECT_NOT_AT_START_LINE");
	});
});

describe("SubjectPositionFrameWindow", () => {
	it("bounds the window and drops the oldest frames", () => {
		const window = createSubjectPositionFrameWindow(3);
		for (let i = 0; i < 10; i += 1) pushSubjectPositionFrame(window, frame(i * 125, [personAt(500, 326)]));
		expect(window.frames).toHaveLength(3);
		expect(window.frames[0].timestampMs).toBe(7 * 125);
	});

	it("clears frames and hysteresis on reset, so trial 2 cannot inherit trial 1", () => {
		const window = createSubjectPositionFrameWindow(30);
		for (let i = 0; i < 20; i += 1) pushSubjectPositionFrame(window, frame(i * 125, [farBackPerson()]));
		evaluateSubjectPositionWindowAggregate(window.frames, config, window.hysteresis);
		expect(window.hysteresis.tooFarBackBad).toBe(true);

		resetSubjectPositionFrameWindow(window);
		expect(window.frames).toHaveLength(0);
		expect(window.hysteresis.tooFarBackBad).toBe(false);
	});
});

describe("duplicate marker IDs (measured on the two-person recording)", () => {
	it("refuses to compute a board length when a forward-axis marker is duplicated", () => {
		// 48% of otherwise-complete frames in subject-two-people carried duplicate IDs, and
		// taking the first occurrence produced board lengths up to 4x the truth. The distance
		// readout derived from it is reported on the HUD, so a 4x-wrong unit is still worth
		// refusing even though it no longer gates anything.
		const dupes = [...boardMarkers(), markerAt(AXIS_HEAD, 900, 120)];
		const metrics = evaluateSubjectPositionFrame(frame(0, [personAt(500, 326)], dupes), config);
		expect(metrics.boardLengthPx).toBeNull();
		expect(metrics.startLineDistanceBoardLengths).toBeNull();
	});
});

describe("the opposite bound - subject too far forward", () => {
	it("fires SUBJECT_NOT_AT_START_LINE when the subject sits high in frame (= walked past the board)", () => {
		const frames = Array.from({ length: 20 }, (_, i) => frame(i * 125, [farForwardPerson()]));
		const aggregate = evaluateSubjectPositionWindowAggregate(frames, config);
		expect(aggregate.weightedBoardToSubjectGapNorm as number).toBeGreaterThan(config.thresholds.tooFarForwardGapNorm);
		expect(aggregate.activeCodes).toContain("SUBJECT_NOT_AT_START_LINE");
	});

	it("does not fire at the widest gap ever measured at the start line", () => {
		// still's maximum was 0.259; the ceiling sits at 0.30. gap (500-301)/768 = 0.259.
		const frames = Array.from({ length: 20 }, (_, i) => frame(i * 125, [personAt(500, 301)]));
		const aggregate = evaluateSubjectPositionWindowAggregate(frames, config);
		expect(aggregate.weightedBoardToSubjectGapNorm as number).toBeCloseTo(0.259, 2);
		expect(aggregate.activeCodes).toEqual([]);
	});

	it("is unaffected by the subject standing at the edge of frame", () => {
		// The failure that killed the area signal: a clipped box shrinks, so area under-read
		// by 3x and a far-back subject passed as good. A vertical gap does not care where the
		// subject stands horizontally.
		const centre = evaluateSubjectPositionFrame(frame(0, [personAt(512, 380)]), config);
		const edge = evaluateSubjectPositionFrame(frame(0, [personAt(1000, 380, 120, 315)]), config);
		expect(edge.boardToSubjectGapNorm).toBeCloseTo(centre.boardToSubjectGapNorm as number, 5);
		expect(edge.subjectAreaNorm).not.toBeCloseTo(centre.subjectAreaNorm as number, 3);
	});
});

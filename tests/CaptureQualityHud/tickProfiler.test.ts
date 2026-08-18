import { describe, expect, it } from "vitest";
import {
	amortizedMs,
	completeTick,
	createTickProfiler,
	deliveredTickHz,
	idleBetweenTicksMs,
	recordStage,
	resetTickProfiler,
	unaccountedMs,
} from "../../src/CaptureQualityHud/tickProfiler";

describe("tickProfiler", () => {
	it("seeds a stage with its first measurement rather than easing up from zero", () => {
		const profiler = createTickProfiler();
		recordStage(profiler, "aruco", 200);
		expect(profiler.meanMs.aruco).toBe(200);
	});

	it("does not drag a stage's mean toward zero on ticks it did not run", () => {
		// The round-robin trap: person detection runs on one tick in three. Recording 0 on
		// the other two would report it at a third of its real cost - the precise misreading
		// that would make a second model look affordable when it is not.
		const profiler = createTickProfiler();
		for (let i = 0; i < 30; i += 1) {
			if (i % 3 === 0) recordStage(profiler, "person", 90);
			completeTick(profiler, i % 3 === 0);
		}
		expect(profiler.meanMs.person).toBe(90);
		expect(profiler.sampleCount).toBe(30);
		expect(profiler.personTickCount).toBe(10);
	});

	it("attributes the residual to unaccounted time", () => {
		const profiler = createTickProfiler();
		recordStage(profiler, "draw", 40);
		recordStage(profiler, "aruco", 60);
		recordStage(profiler, "total", 330);
		completeTick(profiler, false);
		expect(unaccountedMs(profiler)).toBeCloseTo(230, 5);
	});

	it("derives the delivered rate from the interval, not from the work duration", () => {
		// The distinction this module exists for, and the one the first on-device read got
		// wrong: 75ms of work delivered every 330ms is a 3Hz loop, not a 13Hz one. Deriving
		// a rate from `total` reports the ceiling the loop could reach if it were never
		// starved - which is exactly the number that made a starved loop look healthy.
		const profiler = createTickProfiler();
		recordStage(profiler, "total", 75);
		recordStage(profiler, "interval", 330);
		expect(deliveredTickHz(profiler)).toBeCloseTo(1000 / 330, 5);
		expect(idleBetweenTicksMs(profiler)).toBeCloseTo(255, 5);
	});

	it("reports no delivered rate until a second tick has actually run", () => {
		const profiler = createTickProfiler();
		recordStage(profiler, "total", 75);
		expect(deliveredTickHz(profiler)).toBeNull();
	});

	it("amortizes a round-robined stage before subtracting it from the residual", () => {
		// The bug this caught on-device: person detection costs ~300ms on the one tick in
		// three that it runs, so subtracting its full per-run mean from an all-ticks average
		// drove `other` to -196ms. Only its per-tick share is comparable against `total`.
		const profiler = createTickProfiler();
		for (let i = 0; i < 30; i += 1) {
			recordStage(profiler, "draw", 27);
			if (i % 3 === 0) recordStage(profiler, "person", 300);
			recordStage(profiler, "total", 150);
			completeTick(profiler, i % 3 === 0);
		}
		expect(profiler.meanMs.person).toBeCloseTo(300, 5);
		expect(amortizedMs(profiler, "person")).toBeCloseTo(100, 5);
		// 150 total - (27 draw + 100 amortized person) = 23, and crucially not negative.
		expect(unaccountedMs(profiler)).toBeCloseTo(23, 5);
		expect(unaccountedMs(profiler)).toBeGreaterThan(0);
	});

	it("excludes the interval from the unaccounted residual", () => {
		// interval is wall-clock between ticks, not a slice of work - folding it into the
		// parts sum would drive `other` negative and hide real unattributed cost.
		const profiler = createTickProfiler();
		recordStage(profiler, "draw", 40);
		recordStage(profiler, "aruco", 20);
		recordStage(profiler, "total", 75);
		recordStage(profiler, "interval", 330);
		completeTick(profiler, false);
		expect(unaccountedMs(profiler)).toBeCloseTo(15, 5);
	});

	it("clears every stage on reset", () => {
		const profiler = createTickProfiler();
		recordStage(profiler, "draw", 40);
		completeTick(profiler, true);
		resetTickProfiler(profiler);
		expect(profiler.meanMs.draw).toBe(0);
		expect(profiler.sampleCount).toBe(0);
		expect(profiler.personTickCount).toBe(0);
	});
});

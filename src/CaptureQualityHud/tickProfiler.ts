// Harness-only per-stage timing for the live detect loop. Pure (no React) so it is
// unit-testable and so the detect loop can update it without triggering a render.
//
// Exists because the configured tick rate and the delivered tick rate disagree by roughly
// 200ms per tick, and the previously assumed explanation ("the 1024 ArUco pass costs
// ~330ms") was measured to be false - the 768 experiment cut pixel count by 44% and bought
// no frame rate at all. Rather than form another plausible hypothesis, this attributes the
// time directly. Adding a second model to a budget nobody has measured is precisely what
// the repo's lightweight-first rule forbids.
//
// Cost of the instrument itself: two performance.now() calls per stage. That is noise
// against stages measured in tens of milliseconds, so this stays on rather than hiding
// behind a flag that would inevitably be off when the number is next needed.

// "total" is the DURATION OF THE TICK BODY. "interval" is the WALL-CLOCK GAP between two
// consecutive ticks actually running. They answer different questions and confusing them is
// the whole reason this module exists: work that takes 75ms inside a loop delivering one
// tick every 330ms means the cost is NOT in the work. Derive a delivered rate from
// `interval` only - 1000/total is a ceiling on how fast the loop COULD tick, never a
// measurement of how fast it does.
export const TICK_STAGES = ["draw", "aruco", "lighting", "person", "checks", "total", "interval"] as const;

export type TickStage = typeof TICK_STAGES[number];

// CUMULATIVE means, not an EWMA. An EWMA over a strongly periodic signal oscillates rather
// than settling: person detection spikes one tick in three, so an EWMA of `total` reads
// anywhere between the quiet and the spiked value depending on where in the cycle it is
// sampled. Two EWMAs with different cadences cannot be subtracted from each other at all -
// that is what produced a negative `other`. A cumulative mean is stable, exactly comparable
// across stages, and is what a human reading a diagnostic panel actually wants.

export interface TickProfiler {
	/**
	 * Mean cost of a stage ON THE TICKS IT RAN - not per tick overall. A round-robined stage
	 * runs on a fraction of ticks, so this is the cost of one run, which is the number worth
	 * reading. Use amortizedMs to get its per-tick share.
	 */
	meanMs: Record<TickStage, number>;
	/** Running total per stage; meanMs is this over runCount. */
	sumMs: Record<TickStage, number>;
	/** How many ticks each stage actually ran on - the denominator meanMs is over. */
	runCount: Record<TickStage, number>;
	/** Ticks observed since reset; the means are meaningless until this is at least ~10. */
	sampleCount: number;
	/** Ticks on which person detection actually ran, for confirming the round-robin cadence is doing what the config says. */
	personTickCount: number;
}

export function createTickProfiler(): TickProfiler {
	const meanMs = {} as Record<TickStage, number>;
	const sumMs = {} as Record<TickStage, number>;
	const runCount = {} as Record<TickStage, number>;
	for (const stage of TICK_STAGES) {
		meanMs[stage] = 0;
		sumMs[stage] = 0;
		runCount[stage] = 0;
	}
	return { meanMs, sumMs, runCount, sampleCount: 0, personTickCount: 0 };
}

export function resetTickProfiler(profiler: TickProfiler): void {
	for (const stage of TICK_STAGES) {
		profiler.meanMs[stage] = 0;
		profiler.sumMs[stage] = 0;
		profiler.runCount[stage] = 0;
	}
	profiler.sampleCount = 0;
	profiler.personTickCount = 0;
}

/**
 * Folds one stage measurement in. A stage that did not run on this tick must simply not be
 * recorded - passing 0 would drag its mean toward zero and make an expensive stage that
 * runs every third tick look cheap, which is the exact misreading this module exists to
 * prevent.
 */
export function recordStage(profiler: TickProfiler, stage: TickStage, durationMs: number): void {
	profiler.sumMs[stage] += durationMs;
	profiler.runCount[stage] += 1;
	profiler.meanMs[stage] = profiler.sumMs[stage] / profiler.runCount[stage];
}

/** Call once per completed tick, after every recordStage for that tick. */
export function completeTick(profiler: TickProfiler, ranPersonDetection: boolean): void {
	profiler.sampleCount += 1;
	if (ranPersonDetection) profiler.personTickCount += 1;
}

/** Times `fn`, folds the result into `stage`, and returns whatever `fn` returned. */
export async function timeStage<T>(profiler: TickProfiler, stage: TickStage, fn: () => Promise<T> | T): Promise<T> {
	const startedAt = performance.now();
	try {
		return await fn();
	} finally {
		recordStage(profiler, stage, performance.now() - startedAt);
	}
}

/**
 * A stage's share of an AVERAGE tick: its per-run cost scaled by how often it runs. A
 * round-robined stage costing 300ms every third tick contributes 100ms to the average tick,
 * and only the amortized figure is comparable against `total` (which averages over every
 * tick, including the ones that stage sat out).
 */
export function amortizedMs(profiler: TickProfiler, stage: TickStage): number {
	if (profiler.sampleCount === 0) return 0;
	return (profiler.meanMs[stage] * profiler.runCount[stage]) / profiler.sampleCount;
}

/**
 * Time inside a tick not attributed to any named stage. Sums the AMORTIZED stage costs, not
 * the raw means: subtracting a 1-in-3 stage's full per-run cost from an all-ticks average
 * drove this negative, which is how the round-robin first showed up as a -196ms residual.
 *
 * A large POSITIVE residual means the cost is outside the instrumented code (compositing,
 * video decode, GC) and that adding more stage timers will not find it.
 */
export function unaccountedMs(profiler: TickProfiler): number {
	const parts = TICK_STAGES.filter((s) => s !== "total" && s !== "interval").reduce(
		(sum, s) => sum + amortizedMs(profiler, s),
		0
	);
	return profiler.meanMs.total - parts;
}

/**
 * Time the loop spends NOT running a tick: the delivered interval minus the work done in
 * it. This is the figure the ~3Hz investigation actually needs. A large value means the
 * loop is being starved (rAF not firing, or the throttle gate rejecting ticks), not that
 * the work is slow - and no amount of optimizing the stages above will move it.
 */
export function idleBetweenTicksMs(profiler: TickProfiler): number {
	if (profiler.meanMs.interval === 0) return 0;
	return profiler.meanMs.interval - profiler.meanMs.total;
}

/** Delivered tick rate, from the measured interval. Null until at least two ticks have run. */
export function deliveredTickHz(profiler: TickProfiler): number | null {
	if (profiler.meanMs.interval <= 0) return null;
	return 1000 / profiler.meanMs.interval;
}

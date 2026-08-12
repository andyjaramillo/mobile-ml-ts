// Plain descriptive statistics - no dependency on markerBoardCheck.ts, this is just arithmetic.

export interface DistributionStats {
	count: number;
	min: number;
	max: number;
	mean: number;
	median: number;
	p5: number;
	p95: number;
	std: number;
}

function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 1) return sorted[0];
	const idx = p * (sorted.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	const frac = idx - lo;
	return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Returns null for an empty sample rather than fabricating zeros - callers must handle "no computable frames". */
export function summarize(values: readonly number[]): DistributionStats | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	const mean = sorted.reduce((a, b) => a + b, 0) / n;
	const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
	return {
		count: n,
		min: sorted[0],
		max: sorted[n - 1],
		mean,
		median: percentile(sorted, 0.5),
		p5: percentile(sorted, 0.05),
		p95: percentile(sorted, 0.95),
		std: Math.sqrt(variance),
	};
}

export interface MarkerDropoutStats {
	markerId: number;
	missingCount: number;
	missingPct: number;
	longestMissingRun: number;
}

export function computeDropoutStats(
	samples: readonly { bitmask: number }[],
	expectedMarkerIds: readonly number[]
): MarkerDropoutStats[] {
	return expectedMarkerIds.map((id) => {
		let missingCount = 0;
		let longestRun = 0;
		let currentRun = 0;
		for (const s of samples) {
			const present = (s.bitmask & (1 << id)) !== 0;
			if (present) {
				currentRun = 0;
				continue;
			}
			missingCount++;
			currentRun++;
			if (currentRun > longestRun) longestRun = currentRun;
		}
		return {
			markerId: id,
			missingCount,
			missingPct: samples.length > 0 ? (missingCount / samples.length) * 100 : 0,
			longestMissingRun: longestRun,
		};
	});
}

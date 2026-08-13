// Parser for the CQ1/CQ2/CQ3 compact single-line capture-quality exports (see
// src/CaptureQualityHud/captureRecorder.ts for the format and the encoder this mirrors).
// A pasted file may contain more than one recognized line; every recognized line becomes
// its own ParsedCaptureRecording. CQ1/CQ2 support is permanent, not a migration shim -
// the committed calibration recordings are in those formats.
//
// CQ2's lighting distributions were measured over the whole frame, CQ3's over the
// marker-board ROI. These are not the same measurement and must never be pooled - see
// ParsedCaptureRecording.lightingScope.

export interface ParsedCaptureSample {
	bitmask: number;
	area: number | null;
	diag: number | null;
	rot: number | null;
	/** CQ2/CQ3 only - MarkerBoardFrameMetrics.detectedMarkerAreaNorm. Always null for a CQ1 line (the field did not exist in that format). */
	detArea: number | null;
}

export interface ParsedLightingDistribution {
	min: number;
	p25: number;
	median: number;
	p75: number;
	max: number;
	mean: number;
}

/** Re-declared rather than imported from lowLightCheck.ts so this offline tool consumes only the export format, not the live check's types. */
export type ParsedRoiSource = "detected" | "last-known" | "default";

export interface ParsedRoiRect {
	xNorm: number;
	yNorm: number;
	widthNorm: number;
	heightNorm: number;
}

export interface ParsedLightingSample {
	luma: ParsedLightingDistribution;
	contrast: ParsedLightingDistribution;
	/** CQ3 only - null for a CQ2 line (whole-frame; no ROI was ever measured). */
	roi: ParsedRoiRect | null;
	/** CQ3 only - null for a CQ2 line. */
	roiSource: ParsedRoiSource | null;
}

/** What region a recording's lightingSamples were measured over - branch on this before comparing lighting stats across recordings. "none" also covers a CQ2/CQ3 line that captured zero lighting samples. */
export type LightingScope = "none" | "whole-frame" | "roi";

export interface ParsedCaptureRecording {
	sourceLabel: string;
	formatVersion: 1 | 2 | 3;
	scenarioTag: string;
	declaredSampleCount: number;
	stride: number;
	fpsMean: number;
	frameWidth: number;
	frameHeight: number;
	scaleExponents: readonly [number, number, number];
	samples: ParsedCaptureSample[];
	/** CQ2/CQ3 only - null for a CQ1 line. */
	lightingGrid: { cols: number; rows: number } | null;
	/** CQ2: [lumaExp, contrastExp]. CQ3: [lumaExp, contrastExp, roiExp]. Null for a CQ1 line. */
	lightingScaleExponents: readonly number[] | null;
	lightingSamples: ParsedLightingSample[];
	lightingScope: LightingScope;
}

function parseKeyInt(token: string, key: string, sourceLabel: string): number {
	const match = new RegExp(`^${key}=(-?\\d+)$`).exec(token);
	if (!match) throw new Error(`${sourceLabel}: expected "${key}=<int>", got "${token}"`);
	return Number(match[1]);
}

function parseMaybeInt(token: string): number | null {
	return token === "-" ? null : Number(token);
}

function parseResToken(token: string, sourceLabel: string): { width: number; height: number } {
	const match = /^res=(\d+)x(\d+)$/.exec(token);
	if (!match) throw new Error(`${sourceLabel}: malformed "res=" token: "${token}"`);
	return { width: Number(match[1]), height: Number(match[2]) };
}

function parseScToken(token: string, sourceLabel: string): [number, number, number] {
	const match = /^sc=(\d+),(\d+),(\d+)$/.exec(token);
	if (!match) throw new Error(`${sourceLabel}: malformed "sc=" token: "${token}"`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseCq1SampleToken(token: string, index: number, sourceLabel: string): ParsedCaptureSample {
	const parts = token.split(":");
	if (parts.length !== 4) {
		throw new Error(`${sourceLabel}: malformed CQ1 sample at index ${index}: "${token}" (expected bitmask:area:diag:rot)`);
	}
	const [bitmaskStr, areaStr, diagStr, rotStr] = parts;
	const bitmask = Number(bitmaskStr);
	if (!Number.isFinite(bitmask)) {
		throw new Error(`${sourceLabel}: malformed bitmask at sample ${index}: "${bitmaskStr}"`);
	}
	return { bitmask, area: parseMaybeInt(areaStr), diag: parseMaybeInt(diagStr), rot: parseMaybeInt(rotStr), detArea: null };
}

function parseCq2SampleToken(token: string, index: number, sourceLabel: string): ParsedCaptureSample {
	const parts = token.split(":");
	if (parts.length !== 5) {
		throw new Error(`${sourceLabel}: malformed CQ2 sample at index ${index}: "${token}" (expected bitmask:area:diag:rot:detArea)`);
	}
	const [bitmaskStr, areaStr, diagStr, rotStr, detAreaStr] = parts;
	const bitmask = Number(bitmaskStr);
	if (!Number.isFinite(bitmask)) {
		throw new Error(`${sourceLabel}: malformed bitmask at sample ${index}: "${bitmaskStr}"`);
	}
	return {
		bitmask,
		area: parseMaybeInt(areaStr),
		diag: parseMaybeInt(diagStr),
		rot: parseMaybeInt(rotStr),
		detArea: parseMaybeInt(detAreaStr),
	};
}

function parseLightingDistributionToken(
	parts: readonly string[],
	offset: number,
	scale: number,
	sourceLabel: string,
	index: number
): ParsedLightingDistribution {
	const nums = parts.slice(offset, offset + 6).map(Number);
	if (nums.length !== 6 || nums.some((n) => !Number.isFinite(n))) {
		throw new Error(`${sourceLabel}: malformed lighting distribution at sample ${index}`);
	}
	const [min, p25, median, p75, max, mean] = nums.map((n) => n / scale);
	return { min, p25, median, p75, max, mean };
}

/** CQ2 lighting token: 12 ints, whole-frame, no ROI - roi/roiSource are always null. */
function parseCq2LightingSampleToken(
	token: string,
	index: number,
	scaleExponents: readonly [number, number],
	sourceLabel: string
): ParsedLightingSample {
	const parts = token.split(":");
	if (parts.length !== 12) {
		throw new Error(`${sourceLabel}: malformed CQ2 lighting sample at index ${index}: "${token}" (expected 12 colon-separated integers)`);
	}
	const lumaScale = 10 ** scaleExponents[0];
	const contrastScale = 10 ** scaleExponents[1];
	return {
		luma: parseLightingDistributionToken(parts, 0, lumaScale, sourceLabel, index),
		contrast: parseLightingDistributionToken(parts, 6, contrastScale, sourceLabel, index),
		roi: null,
		roiSource: null,
	};
}

const ROI_SOURCE_BY_CODE: readonly ParsedRoiSource[] = ["detected", "last-known", "default"];

/** CQ3 lighting token: 17 ints - the same 6+6 luma/contrast distributions, plus roiXNorm/roiYNorm/roiWidthNorm/roiHeightNorm and a roiSourceCode (0/1/2 - see ROI_SOURCE_BY_CODE). */
function parseCq3LightingSampleToken(
	token: string,
	index: number,
	scaleExponents: readonly [number, number, number],
	sourceLabel: string
): ParsedLightingSample {
	const parts = token.split(":");
	if (parts.length !== 17) {
		throw new Error(`${sourceLabel}: malformed CQ3 lighting sample at index ${index}: "${token}" (expected 17 colon-separated integers)`);
	}
	const lumaScale = 10 ** scaleExponents[0];
	const contrastScale = 10 ** scaleExponents[1];
	const roiScale = 10 ** scaleExponents[2];

	const roiNums = parts.slice(12, 16).map(Number);
	const sourceCode = Number(parts[16]);
	if (roiNums.length !== 4 || roiNums.some((n) => !Number.isFinite(n)) || !Number.isInteger(sourceCode)) {
		throw new Error(`${sourceLabel}: malformed CQ3 ROI fields at sample ${index}: "${token}"`);
	}
	const [xNorm, yNorm, widthNorm, heightNorm] = roiNums.map((n) => n / roiScale);
	const roiSource = ROI_SOURCE_BY_CODE[sourceCode];
	if (!roiSource) throw new Error(`${sourceLabel}: unrecognized ROI source code ${sourceCode} at sample ${index}`);

	return {
		luma: parseLightingDistributionToken(parts, 0, lumaScale, sourceLabel, index),
		contrast: parseLightingDistributionToken(parts, 6, contrastScale, sourceLabel, index),
		roi: { xNorm, yNorm, widthNorm, heightNorm },
		roiSource,
	};
}

function parseCq1Line(line: string, sourceLabel: string): ParsedCaptureRecording {
	const tokens = line.split("|");
	if (tokens.length !== 8 || tokens[0] !== "CQ1") {
		throw new Error(`${sourceLabel}: not a recognized CQ1 export line (expected 8 "|"-separated fields)`);
	}
	const [, scenarioTag, nToken, strideToken, fpsToken, resToken, scToken, payload] = tokens;

	const declaredSampleCount = parseKeyInt(nToken, "n", sourceLabel);
	const stride = parseKeyInt(strideToken, "stride", sourceLabel);
	const fpsMean = parseKeyInt(fpsToken, "fps", sourceLabel);
	const { width: frameWidth, height: frameHeight } = parseResToken(resToken, sourceLabel);
	const scaleExponents = parseScToken(scToken, sourceLabel);

	const samples = payload.length === 0 ? [] : payload.split(";").map((tok, i) => parseCq1SampleToken(tok, i, sourceLabel));
	if (samples.length !== declaredSampleCount) {
		// Not fatal - the declared count is a cross-check, not the source of truth; the
		// actual token list is. Surface the mismatch so a truncated/corrupted paste is visible.
		console.warn(
			`${sourceLabel}: declared n=${declaredSampleCount} but payload has ${samples.length} samples - using the actual count`
		);
	}

	return {
		sourceLabel,
		formatVersion: 1,
		scenarioTag,
		declaredSampleCount,
		stride,
		fpsMean,
		frameWidth,
		frameHeight,
		scaleExponents,
		samples,
		lightingGrid: null,
		lightingScaleExponents: null,
		lightingSamples: [],
		lightingScope: "none",
	};
}

function parseCq2Line(line: string, sourceLabel: string): ParsedCaptureRecording {
	const tokens = line.split("|");
	if (tokens.length !== 12 || tokens[0] !== "CQ2") {
		throw new Error(`${sourceLabel}: not a recognized CQ2 export line (expected 12 "|"-separated fields)`);
	}
	const [, scenarioTag, nToken, strideToken, fpsToken, resToken, scToken, payload, lgToken, lnToken, lscToken, lightingPayload] =
		tokens;

	const declaredSampleCount = parseKeyInt(nToken, "n", sourceLabel);
	const stride = parseKeyInt(strideToken, "stride", sourceLabel);
	const fpsMean = parseKeyInt(fpsToken, "fps", sourceLabel);
	const { width: frameWidth, height: frameHeight } = parseResToken(resToken, sourceLabel);
	const scaleExponents = parseScToken(scToken, sourceLabel);

	const samples = payload.length === 0 ? [] : payload.split(";").map((tok, i) => parseCq2SampleToken(tok, i, sourceLabel));
	if (samples.length !== declaredSampleCount) {
		console.warn(
			`${sourceLabel}: declared n=${declaredSampleCount} but payload has ${samples.length} samples - using the actual count`
		);
	}

	const lgMatch = /^lg=(\d+)x(\d+)$/.exec(lgToken);
	if (!lgMatch) throw new Error(`${sourceLabel}: malformed "lg=" token: "${lgToken}"`);
	const lightingGrid = { cols: Number(lgMatch[1]), rows: Number(lgMatch[2]) };

	const declaredLightingCount = parseKeyInt(lnToken, "ln", sourceLabel);

	const lscMatch = /^lsc=(\d+),(\d+)$/.exec(lscToken);
	if (!lscMatch) throw new Error(`${sourceLabel}: malformed "lsc=" token: "${lscToken}"`);
	const lightingScaleExponents: [number, number] = [Number(lscMatch[1]), Number(lscMatch[2])];

	const lightingSamples =
		lightingPayload.length === 0
			? []
			: lightingPayload.split(";").map((tok, i) => parseCq2LightingSampleToken(tok, i, lightingScaleExponents, sourceLabel));
	if (lightingSamples.length !== declaredLightingCount) {
		console.warn(
			`${sourceLabel}: declared ln=${declaredLightingCount} but lighting payload has ${lightingSamples.length} samples - using the actual count`
		);
	}

	return {
		sourceLabel,
		formatVersion: 2,
		scenarioTag,
		declaredSampleCount,
		stride,
		fpsMean,
		frameWidth,
		frameHeight,
		scaleExponents,
		samples,
		lightingGrid,
		lightingScaleExponents,
		lightingSamples,
		lightingScope: lightingSamples.length > 0 ? "whole-frame" : "none",
	};
}

function parseCq3Line(line: string, sourceLabel: string): ParsedCaptureRecording {
	const tokens = line.split("|");
	if (tokens.length !== 12 || tokens[0] !== "CQ3") {
		throw new Error(`${sourceLabel}: not a recognized CQ3 export line (expected 12 "|"-separated fields)`);
	}
	const [, scenarioTag, nToken, strideToken, fpsToken, resToken, scToken, payload, lgToken, lnToken, lscToken, lightingPayload] =
		tokens;

	const declaredSampleCount = parseKeyInt(nToken, "n", sourceLabel);
	const stride = parseKeyInt(strideToken, "stride", sourceLabel);
	const fpsMean = parseKeyInt(fpsToken, "fps", sourceLabel);
	const { width: frameWidth, height: frameHeight } = parseResToken(resToken, sourceLabel);
	const scaleExponents = parseScToken(scToken, sourceLabel);

	// CQ3's marker section is identical to CQ2's; only the lighting format changed.
	const samples = payload.length === 0 ? [] : payload.split(";").map((tok, i) => parseCq2SampleToken(tok, i, sourceLabel));
	if (samples.length !== declaredSampleCount) {
		console.warn(
			`${sourceLabel}: declared n=${declaredSampleCount} but payload has ${samples.length} samples - using the actual count`
		);
	}

	const lgMatch = /^lg=(\d+)x(\d+)$/.exec(lgToken);
	if (!lgMatch) throw new Error(`${sourceLabel}: malformed "lg=" token: "${lgToken}"`);
	const lightingGrid = { cols: Number(lgMatch[1]), rows: Number(lgMatch[2]) };

	const declaredLightingCount = parseKeyInt(lnToken, "ln", sourceLabel);

	const lscMatch = /^lsc=(\d+),(\d+),(\d+)$/.exec(lscToken);
	if (!lscMatch) throw new Error(`${sourceLabel}: malformed "lsc=" token: "${lscToken}"`);
	const lightingScaleExponents: [number, number, number] = [Number(lscMatch[1]), Number(lscMatch[2]), Number(lscMatch[3])];

	const lightingSamples =
		lightingPayload.length === 0
			? []
			: lightingPayload.split(";").map((tok, i) => parseCq3LightingSampleToken(tok, i, lightingScaleExponents, sourceLabel));
	if (lightingSamples.length !== declaredLightingCount) {
		console.warn(
			`${sourceLabel}: declared ln=${declaredLightingCount} but lighting payload has ${lightingSamples.length} samples - using the actual count`
		);
	}

	return {
		sourceLabel,
		formatVersion: 3,
		scenarioTag,
		declaredSampleCount,
		stride,
		fpsMean,
		frameWidth,
		frameHeight,
		scaleExponents,
		samples,
		lightingGrid,
		lightingScaleExponents,
		lightingSamples,
		lightingScope: lightingSamples.length > 0 ? "roi" : "none",
	};
}

/** Parses one CQ1, CQ2, or CQ3 line. Throws with a message identifying sourceLabel on any malformed token. */
export function parseCompactLine(line: string, sourceLabel: string): ParsedCaptureRecording {
	if (line.startsWith("CQ3|")) return parseCq3Line(line, sourceLabel);
	if (line.startsWith("CQ2|")) return parseCq2Line(line, sourceLabel);
	if (line.startsWith("CQ1|")) return parseCq1Line(line, sourceLabel);
	throw new Error(`${sourceLabel}: not a recognized CQ1/CQ2/CQ3 export line`);
}

/** Parses every CQ1/CQ2/CQ3 line found in a file's text, skipping blank lines and anything not starting with "CQ1|"/"CQ2|"/"CQ3|". */
export function parseCompactExportFile(sourceLabel: string, text: string): ParsedCaptureRecording[] {
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	const cqLines = lines.filter((l) => l.startsWith("CQ1|") || l.startsWith("CQ2|") || l.startsWith("CQ3|"));
	return cqLines.map((line, i) => parseCompactLine(line, cqLines.length > 1 ? `${sourceLabel}#${i + 1}` : sourceLabel));
}

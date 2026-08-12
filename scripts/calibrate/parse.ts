// Parser for the CQ1 compact single-line capture-quality export (see
// src/CaptureQualityHud/captureRecorder.ts for the format and the encoder this mirrors).
// A pasted file may contain more than one CQ1 line (e.g. several messages concatenated
// into one paste); every recognized line becomes its own ParsedCaptureRecording.

export interface ParsedCaptureSample {
	bitmask: number;
	area: number | null;
	diag: number | null;
	rot: number | null;
}

export interface ParsedCaptureRecording {
	sourceLabel: string;
	scenarioTag: string;
	declaredSampleCount: number;
	stride: number;
	fpsMean: number;
	frameWidth: number;
	frameHeight: number;
	scaleExponents: readonly [number, number, number];
	samples: ParsedCaptureSample[];
}

function parseKeyInt(token: string, key: string, sourceLabel: string): number {
	const match = new RegExp(`^${key}=(-?\\d+)$`).exec(token);
	if (!match) throw new Error(`${sourceLabel}: expected "${key}=<int>", got "${token}"`);
	return Number(match[1]);
}

function parseMaybeInt(token: string): number | null {
	return token === "-" ? null : Number(token);
}

function parseSampleToken(token: string, index: number, sourceLabel: string): ParsedCaptureSample {
	const parts = token.split(":");
	if (parts.length !== 4) {
		throw new Error(`${sourceLabel}: malformed sample at index ${index}: "${token}" (expected bitmask:area:diag:rot)`);
	}
	const [bitmaskStr, areaStr, diagStr, rotStr] = parts;
	const bitmask = Number(bitmaskStr);
	if (!Number.isFinite(bitmask)) {
		throw new Error(`${sourceLabel}: malformed bitmask at sample ${index}: "${bitmaskStr}"`);
	}
	return { bitmask, area: parseMaybeInt(areaStr), diag: parseMaybeInt(diagStr), rot: parseMaybeInt(rotStr) };
}

/** Parses one CQ1 line. Throws with a message identifying sourceLabel on any malformed token. */
export function parseCompactLine(line: string, sourceLabel: string): ParsedCaptureRecording {
	const tokens = line.split("|");
	if (tokens.length !== 8 || tokens[0] !== "CQ1") {
		throw new Error(`${sourceLabel}: not a recognized CQ1 export line (expected 8 "|"-separated fields)`);
	}
	const [, scenarioTag, nToken, strideToken, fpsToken, resToken, scToken, payload] = tokens;

	const declaredSampleCount = parseKeyInt(nToken, "n", sourceLabel);
	const stride = parseKeyInt(strideToken, "stride", sourceLabel);
	const fpsMean = parseKeyInt(fpsToken, "fps", sourceLabel);

	const resMatch = /^res=(\d+)x(\d+)$/.exec(resToken);
	if (!resMatch) throw new Error(`${sourceLabel}: malformed "res=" token: "${resToken}"`);
	const frameWidth = Number(resMatch[1]);
	const frameHeight = Number(resMatch[2]);

	const scMatch = /^sc=(\d+),(\d+),(\d+)$/.exec(scToken);
	if (!scMatch) throw new Error(`${sourceLabel}: malformed "sc=" token: "${scToken}"`);
	const scaleExponents: [number, number, number] = [Number(scMatch[1]), Number(scMatch[2]), Number(scMatch[3])];

	const samples = payload.length === 0 ? [] : payload.split(";").map((tok, i) => parseSampleToken(tok, i, sourceLabel));
	if (samples.length !== declaredSampleCount) {
		// Not fatal - the declared count is a cross-check, not the source of truth; the
		// actual token list is. Surface the mismatch so a truncated/corrupted paste is visible.
		console.warn(
			`${sourceLabel}: declared n=${declaredSampleCount} but payload has ${samples.length} samples - using the actual count`
		);
	}

	return { sourceLabel, scenarioTag, declaredSampleCount, stride, fpsMean, frameWidth, frameHeight, scaleExponents, samples };
}

/** Parses every CQ1 line found in a file's text, skipping blank lines and anything not starting with "CQ1|". */
export function parseCompactExportFile(sourceLabel: string, text: string): ParsedCaptureRecording[] {
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	const cqLines = lines.filter((l) => l.startsWith("CQ1|"));
	return cqLines.map((line, i) => parseCompactLine(line, cqLines.length > 1 ? `${sourceLabel}#${i + 1}` : sourceLabel));
}

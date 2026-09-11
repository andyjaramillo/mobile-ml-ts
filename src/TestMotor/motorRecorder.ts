// [Feature: Test Motor]
//
// Harness-only recorder for the hand check, modelled on CaptureQualityHud/captureRecorder.ts
// and existing for the same reason: the recording device is a phone whose only path off
// the device is copy -> paste into a chat, which forces a single-line, character-budgeted
// format.
//
// Pure (no React) so the encoder is unit-testable without rendering.
//
// EXPORT FORMAT (v5, "MH5"):
//
// v5 adds the inter-hand gap, which is a property of the PAIR and so has no place in the
// per-hand fields. parseMotorExport still reads MH4, because the committed fixtures are
// in it. v4 dropped the palm detector's score fields, which no longer exist, and adds the three
// geometry measures the landmark model made possible. v3 made a line SELF-DESCRIBING: the
// header carries the code list that <codeIndex> indexes into, so adding a check no longer
// silently renumbers older recordings the way v1 -> v2 did. Costs ~250 chars once a line.
//
//   MH5|<tag>|n=<count>|stride=<stride>|be=<backend>|res=<W>x<H>|hz=<tickHz>|inf=<meanInferMs>|codes=<name,name,...>|<samples>
//
// <samples> is `;`-joined, oldest first:
//
//   <codeIndex>:<gap>:<hand>/<hand>
//
// <gap> is the horizontal gap between the two hands' bounds in palm-size units, scaled by
// 1000 and signed - negative means they overlap - or "-" when fewer than two hands were
// found. MH4 lines have no such field, hence the version bump rather than a silent widening.
//
// <hand> is `<xMilli>,<yMilli>,<degrees>,<flags>,<facing>,<extension>,<separation>`.
// Position is normalized to the frame so a recording survives a resolution change; the
// angle is the wrist -> middle-knuckle direction in degrees. Flags are bit0=inside guide,
// bit1=upright, bit2=right hand (0=left), bit3=whole hand inside frame, bit4=palm facing,
// bit5=open, bit6=MediaPipe handedness agrees with which half of the guide the hand is in.
// The hand list is empty when nothing was detected.
//
// facing/extension/separation are the RAW geometry behind three of those flags, scaled by
// 1000/100/1000. Recording the raw value beside the verdict is the point: all three
// thresholds are UNCALIBRATED, and a recording carrying only pass/fail could not be used
// to fit them. Bit6 is here for the same reason - a wrong SWAP_MEDIAPIPE_HANDEDNESS and a
// patient crossing their hands look identical live, and only the data tells them apart.
import { MOTOR_ISSUE_CODES } from "./handStatus";
import type { EvaluatedHand, MotorIssueCode } from "./handStatus";

// Sized so a FULL buffer still fits MAX_EXPORT_CHARS without hitting the truncation
// safety net: a two-hand sample now encodes to ~70 chars (three extra geometry measures
// per hand), and 100 of them plus the header and the codes legend lands around 7.5k.
const MAX_SAMPLES = 100;
const MAX_TAG_CHARS = 60;
export const MAX_EXPORT_CHARS = 8192;

const POS_MILLI = 1000;
const GAP_MILLI = 1000;
const FACING_MILLI = 1000;
const EXTENSION_CENTI = 100;
const SEPARATION_MILLI = 1000;

export interface MotorRecorderSample {
	code: MotorIssueCode;
	hands: readonly EvaluatedHand[];
	handGap: number | null;
	frameWidth: number;
	frameHeight: number;
	inferenceMs: number;
	tickHz: number;
}

export interface MotorRecorderState {
	recording: boolean;
	scenarioTag: string;
	startedAtMs: number;
	stoppedAtMs: number;
	samples: MotorRecorderSample[];
	/** Every Nth tick is kept. Doubles whenever the buffer fills, so a long take stays whole. */
	stride: number;
	tickCounter: number;
	backend: string;
}

export function createMotorRecorderState(): MotorRecorderState {
	return {
		recording: false,
		scenarioTag: "",
		startedAtMs: 0,
		stoppedAtMs: 0,
		samples: [],
		stride: 1,
		tickCounter: 0,
		backend: "-",
	};
}

export function startMotorRecording(state: MotorRecorderState, nowMs: number): void {
	state.samples = [];
	state.stride = 1;
	state.tickCounter = 0;
	state.startedAtMs = nowMs;
	state.stoppedAtMs = 0;
	state.recording = true;
}

export function stopMotorRecording(state: MotorRecorderState): void {
	state.recording = false;
	state.stoppedAtMs = performance.now();
}

export function clearMotorRecording(state: MotorRecorderState): void {
	state.recording = false;
	state.samples = [];
	state.stride = 1;
	state.tickCounter = 0;
	state.startedAtMs = 0;
	state.stoppedAtMs = 0;
}

export function getElapsedMs(state: MotorRecorderState, nowMs: number): number {
	if (state.startedAtMs === 0) return 0;
	return (state.recording ? nowMs : state.stoppedAtMs) - state.startedAtMs;
}

export function recordMotorTick(state: MotorRecorderState, sample: MotorRecorderSample): void {
	if (!state.recording) return;

	state.tickCounter += 1;
	if ((state.tickCounter - 1) % state.stride !== 0) return;

	state.samples.push(sample);

	// Halve rather than drop the oldest: keeping the tail would throw away the setup
	// period, which is the part of a take where the check is actually being judged.
	if (state.samples.length > MAX_SAMPLES) {
		state.samples = state.samples.filter((_, index) => index % 2 === 0);
		state.stride *= 2;
	}
}

function encodeHand(hand: EvaluatedHand, frameWidth: number, frameHeight: number): string {
	const flags =
		(hand.insideGuide ? 1 : 0) |
		(hand.upright ? 2 : 0) |
		(hand.side === "right" ? 4 : 0) |
		(hand.fullyInFrame ? 8 : 0) |
		(hand.palmFacing ? 16 : 0) |
		(hand.open ? 32 : 0) |
		(hand.sidesAgree ? 64 : 0);
	return [
		Math.round((hand.x / frameWidth) * POS_MILLI),
		Math.round((hand.y / frameHeight) * POS_MILLI),
		Math.round((hand.pointingRadians * 180) / Math.PI),
		flags,
		Math.round(hand.palmFacingScore * FACING_MILLI),
		Math.round(hand.minFingerExtension * EXTENSION_CENTI),
		Math.round(hand.minFingerSeparation * SEPARATION_MILLI),
	].join(",");
}

function encodeSample(sample: MotorRecorderSample): string {
	const hands = sample.hands.map((hand) => encodeHand(hand, sample.frameWidth, sample.frameHeight)).join("/");
	const gap = sample.handGap === null ? "-" : String(Math.round(sample.handGap * GAP_MILLI));
	return [MOTOR_ISSUE_CODES.indexOf(sample.code), gap, hands].join(":");
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((total, value) => total + value, 0) / values.length;
}

export function buildCompactExport(state: MotorRecorderState): string {
	const samples = state.samples;
	const last = samples[samples.length - 1];
	const tag = state.scenarioTag.slice(0, MAX_TAG_CHARS).replace(/[|;:/]/g, " ").trim();

	const header = [
		"MH5",
		tag,
		`n=${samples.length}`,
		`stride=${state.stride}`,
		`be=${state.backend}`,
		`res=${last ? Math.round(last.frameWidth) : 0}x${last ? Math.round(last.frameHeight) : 0}`,
		`hz=${mean(samples.map((sample) => sample.tickHz)).toFixed(1)}`,
		`inf=${Math.round(mean(samples.map((sample) => sample.inferenceMs)))}`,
		`codes=${MOTOR_ISSUE_CODES.join(",")}`,
	].join("|");

	const line = `${header}|${samples.map(encodeSample).join(";")}`;
	const suffix = "|TRUNCATED";
	return line.length <= MAX_EXPORT_CHARS ? line : `${line.slice(0, MAX_EXPORT_CHARS - suffix.length)}${suffix}`;
}

// The decoder lives beside the encoder on purpose - one format, one implementation, no
// drift between what the phone writes and what a replay test reads. (captureRecorder.ts
// states the same goal but splits its parser into scripts/calibrate/.)

export interface ParsedHand {
	/** Normalised to the frame, as recorded. */
	x: number;
	y: number;
	degrees: number;
	flags: number;
	/** The RAW geometry, rescaled back from the integer encoding. */
	palmFacingScore: number;
	minFingerExtension: number;
	minFingerSeparation: number;
	/** The verdicts the RECORDING device reached, which a replay may disagree with. */
	insideGuide: boolean;
	upright: boolean;
	side: "left" | "right";
	fullyInFrame: boolean;
	palmFacing: boolean;
	open: boolean;
	sidesAgree: boolean;
}

export interface ParsedSample {
	code: string;
	/** Null for MH4 lines, which predate the measure, and for ticks with under two hands. */
	handGap: number | null;
	hands: ParsedHand[];
}

export interface ParsedMotorExport {
	version: "MH4" | "MH5";
	tag: string;
	stride: number;
	backend: string;
	frameWidth: number;
	frameHeight: number;
	tickHz: number;
	inferenceMs: number;
	codes: string[];
	samples: ParsedSample[];
}

function headerValue(parts: string[], key: string): string {
	const found = parts.find((part) => part.startsWith(`${key}=`));
	return found ? found.slice(key.length + 1) : "";
}

function parseHand(encoded: string): ParsedHand {
	const [x, y, degrees, flags, facing, extension, separation] = encoded.split(",").map(Number);
	return {
		x: x / POS_MILLI,
		y: y / POS_MILLI,
		degrees,
		flags,
		palmFacingScore: facing / FACING_MILLI,
		minFingerExtension: extension / EXTENSION_CENTI,
		minFingerSeparation: separation / SEPARATION_MILLI,
		insideGuide: (flags & 1) !== 0,
		upright: (flags & 2) !== 0,
		side: (flags & 4) !== 0 ? "right" : "left",
		fullyInFrame: (flags & 8) !== 0,
		palmFacing: (flags & 16) !== 0,
		open: (flags & 32) !== 0,
		sidesAgree: (flags & 64) !== 0,
	};
}

export function parseMotorExport(line: string): ParsedMotorExport {
	const parts = line.trim().split("|");
	const version = parts[0];
	if (version !== "MH4" && version !== "MH5") throw new Error(`unsupported export format: ${version}`);

	const [width, height] = headerValue(parts, "res").split("x").map(Number);
	const codes = headerValue(parts, "codes").split(",");

	const samples = parts[parts.length - 1]
		.split(";")
		.filter((chunk) => chunk.length > 0)
		.map((chunk) => {
			const fields = chunk.split(":");
			const code = codes[Number(fields[0])];
			const gapField = version === "MH5" ? fields[1] : "-";
			const handsPart = fields[version === "MH5" ? 2 : 1] ?? "";
			return {
				code,
				handGap: gapField === "-" || gapField === undefined ? null : Number(gapField) / GAP_MILLI,
				hands: handsPart ? handsPart.split("/").map(parseHand) : [],
			};
		});

	return {
		version,
		tag: parts[1],
		stride: Number(headerValue(parts, "stride")),
		backend: headerValue(parts, "be"),
		frameWidth: width,
		frameHeight: height,
		tickHz: Number(headerValue(parts, "hz")),
		inferenceMs: Number(headerValue(parts, "inf")),
		codes,
		samples,
	};
}

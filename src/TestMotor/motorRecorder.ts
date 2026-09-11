// [Feature: Test Motor]
//
// Harness-only recorder for the hand check, modelled on CaptureQualityHud/captureRecorder.ts
// and existing for the same reason: the recording device is a phone whose only path off
// the device is copy -> paste into a chat, which forces a single-line, character-budgeted
// format.
//
// Pure (no React) so the encoder is unit-testable without rendering.
//
// EXPORT FORMAT (v4, "MH4"):
//
// v4 drops the palm detector's score fields, which no longer exist, and adds the three
// geometry measures the landmark model made possible. v3 made a line SELF-DESCRIBING: the
// header carries the code list that <codeIndex> indexes into, so adding a check no longer
// silently renumbers older recordings the way v1 -> v2 did. Costs ~250 chars once a line.
//
//   MH4|<tag>|n=<count>|stride=<stride>|be=<backend>|res=<W>x<H>|hz=<tickHz>|inf=<meanInferMs>|codes=<name,name,...>|<samples>
//
// <samples> is `;`-joined, oldest first:
//
//   <codeIndex>:<hand>/<hand>
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
const FACING_MILLI = 1000;
const EXTENSION_CENTI = 100;
const SEPARATION_MILLI = 1000;

export interface MotorRecorderSample {
	code: MotorIssueCode;
	hands: readonly EvaluatedHand[];
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
	return [MOTOR_ISSUE_CODES.indexOf(sample.code), hands].join(":");
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
		"MH4",
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

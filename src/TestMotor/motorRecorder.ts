// [Feature: Test Motor]
//
// Harness-only recorder for the hand check, modelled on CaptureQualityHud/captureRecorder.ts
// and existing for the same reason: the recording device is a phone whose only path off
// the device is copy -> paste into a chat, which forces a single-line, character-budgeted
// format.
//
// Pure (no React) so the encoder is unit-testable without rendering.
//
// EXPORT FORMAT (v2, "MH2"):
//
// v2 renumbers <codeIndex>: MOTOR_ISSUE_CODES gained LEFT_HAND_MISSING/RIGHT_HAND_MISSING
// and dropped ONE_HAND_ONLY, and the index is positional, so an MH1 line read as MH2
// would decode to the wrong codes rather than fail. Hence a new prefix.
//
//   MH2|<tag>|n=<count>|stride=<stride>|be=<backend>|crop=<mode>|res=<W>x<H>|thr=<scoreMilli>|hz=<tickHz>|inf=<meanInferMs>|<samples>
//
// <samples> is `;`-joined, oldest first:
//
//   <maxScoreMilli>:<aboveThreshold>:<grouped>:<codeIndex>:<hand>/<hand>
//
// <hand> is `<xMilli>,<yMilli>,<degrees>,<flags>,<scoreCenti>` with position normalized
// to the frame (so a recording survives a resolution change) and flags as bit0=inside
// guide, bit1=aligned, bit2=right hand (0=left). The hand list is empty when nothing was
// detected.
//
// maxScoreMilli is the headline field: it is the highest score across EVERY anchor before
// thresholding, so a recording where it sits near 1000 while `grouped` stays 0 proves the
// model is seeing hands and the geometry is discarding them, and one where it sits near 0
// proves the opposite. Recording only post-threshold detections, the way an obvious
// version of this would, cannot distinguish those two and is exactly how the current
// UNCALIBRATED thresholds got shipped unexamined.
import { MOTOR_ISSUE_CODES } from "./handStatus";
import type { EvaluatedHand, MotorIssueCode } from "./handStatus";

// Sized so a FULL buffer still fits MAX_EXPORT_CHARS without hitting the truncation
// safety net: a two-hand sample encodes to ~44 chars, and 170 of them plus the header
// lands around 7.6k. Lower than gait's 300 because a motor sample carries two hands of
// position/angle/score where a marker sample carries five small integers.
const MAX_SAMPLES = 170;
const MAX_TAG_CHARS = 60;
export const MAX_EXPORT_CHARS = 8192;

const SCORE_MILLI = 1000;
const POS_MILLI = 1000;
const SCORE_CENTI = 100;

export interface MotorRecorderSample {
	maxScore: number;
	aboveThresholdCount: number;
	groupedCount: number;
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
	/** Recorded so a replay knows which threshold produced the grouped counts below. */
	scoreThreshold: number;
	/** Which framing produced these scores - comparing takes is the whole point. */
	regionMode: string;
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
		scoreThreshold: 0,
		regionMode: "-",
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
	const flags = (hand.insideGuide ? 1 : 0) | (hand.aligned ? 2 : 0) | (hand.side === "right" ? 4 : 0);
	return [
		Math.round((hand.x / frameWidth) * POS_MILLI),
		Math.round((hand.y / frameHeight) * POS_MILLI),
		Math.round((hand.radians * 180) / Math.PI),
		flags,
		Math.round(hand.score * SCORE_CENTI),
	].join(",");
}

function encodeSample(sample: MotorRecorderSample): string {
	const hands = sample.hands.map((hand) => encodeHand(hand, sample.frameWidth, sample.frameHeight)).join("/");
	return [
		Math.round(sample.maxScore * SCORE_MILLI),
		sample.aboveThresholdCount,
		sample.groupedCount,
		MOTOR_ISSUE_CODES.indexOf(sample.code),
		hands,
	].join(":");
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
		"MH2",
		tag,
		`n=${samples.length}`,
		`stride=${state.stride}`,
		`be=${state.backend}`,
		`crop=${state.regionMode}`,
		`res=${last ? Math.round(last.frameWidth) : 0}x${last ? Math.round(last.frameHeight) : 0}`,
		`thr=${Math.round(state.scoreThreshold * SCORE_MILLI)}`,
		`hz=${mean(samples.map((sample) => sample.tickHz)).toFixed(1)}`,
		`inf=${Math.round(mean(samples.map((sample) => sample.inferenceMs)))}`,
	].join("|");

	const line = `${header}|${samples.map(encodeSample).join(";")}`;
	const suffix = "|TRUNCATED";
	return line.length <= MAX_EXPORT_CHARS ? line : `${line.slice(0, MAX_EXPORT_CHARS - suffix.length)}${suffix}`;
}

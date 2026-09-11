// [Feature: Test Motor]
//
// Palm detector ported from WebsiteCode/Website/src/pages/MobilePage/onnx/hand_model.ts.
// The inference and decode math is carried over unchanged - anchors, sigmoid scoring,
// letterbox removal, distance-based grouping - because that part demonstrably works.
//
// What is deliberately NOT carried over is everything else that class did: canvas
// drawing, the countdown timer, MediaRecorder control, and the post-recording video
// rescan. A detector that also owns the record button cannot be tuned without also
// re-testing recording, which is most of why the original was hard to iterate on. Those
// concerns live in TestMotorCamera.tsx (UI/recording) and handStatus.ts (geometry).
import * as ort from "onnxruntime-web/all";
import { ANCHORS } from "./handAnchors";
import { groupBoxes } from "./handOnnxUtil";

// Committed to this repo rather than CDN-loaded: it is a public MediaPipe model, and
// Website self-hosts its models for the same CSP reason initPersonDetector.ts documents.
// See public/models/MODEL_PROVENANCE.md.
const PALM_MODEL_URL = "/models/palm_detection_mediapipe_2023feb.onnx";

/** The palm model's fixed square input. Frames are letterboxed into this, not stretched. */
export const HAND_MODEL_INPUT_SIZE = 192;

/** Carried over from hand_model.ts's score_threshold. */
export const DEFAULT_SCORE_THRESHOLD = 0.65;

/** Grouping radius, in frame pixels, for collapsing duplicate palm boxes. */
const GROUP_DISTANCE_PX = 20;

/** Palm-model landmark count (wrist, MCPs, etc) - 7, not the 21 of a full hand model. */
const LANDMARKS_PER_PALM = 7;

/** Floats per anchor in the box-delta output: 4 box + 7 landmarks x 2. */
const VALUES_PER_ANCHOR = 18;

export interface HandPoint {
	x: number;
	y: number;
}

export interface HandDetection {
	/** [x1, y1, x2, y2] in the same pixel space as the frameWidth/frameHeight passed to detect(). */
	bbox: [number, number, number, number];
	score: number;
	landmarks: HandPoint[];
	/** Palm centre, same pixel space as bbox. */
	x: number;
	y: number;
}

export type HandModelBackend = "webgl" | "wasm" | null;

export interface HandDetectionResult {
	detections: HandDetection[];
	/**
	 * Highest sigmoid score across every anchor, BEFORE the threshold. The single most
	 * diagnostic number this module produces: it separates "the model saw nothing" (a bad
	 * input, or a backend returning garbage) from "the model saw hands and the threshold
	 * or the grouping discarded them", which have opposite fixes.
	 */
	maxScore: number;
	/** Anchors above scoreThreshold, before grouping collapses duplicates. */
	aboveThresholdCount: number;
}

export interface HandModel {
	session: ort.InferenceSession;
	backend: HandModelBackend;
	scoreThreshold: number;
}

/**
 * Resolves to null when no backend can be created. Callers must treat that as "run
 * without the check" - a model that will not load must never block recording.
 */
export async function initHandModel(
	scoreThreshold = DEFAULT_SCORE_THRESHOLD,
	forcedBackend?: HandModelBackend
): Promise<HandModel | null> {
	// Multi-threaded WASM needs COOP/COEP; single-threaded keeps browser support broad.
	ort.env.wasm.numThreads = 1;

	// WebGL first, WASM as the fallback: WebGL-only sessions throw "no available backend
	// to use" when GPU init fails, which happens on some Chrome sessions.
	//
	// forcedBackend exists because ort-web's WebGL provider is legacy and silently falls
	// back per-operator; pinning WASM is the only way to tell a wrong-results-on-GPU
	// problem apart from a wrong-input problem without a rebuild.
	const providerAttempts: string[][] = forcedBackend
		? [[forcedBackend]]
		: [["webgl", "wasm"], ["wasm"]];

	for (const executionProviders of providerAttempts) {
		try {
			const session = await ort.InferenceSession.create(PALM_MODEL_URL, { executionProviders });
			return { session, backend: executionProviders[0] as HandModelBackend, scoreThreshold };
		} catch (error) {
			console.warn("[handModel] ONNX init failed with", executionProviders, error);
		}
	}

	console.error("[handModel] No ONNX backend available (WebGL and WASM both failed)");
	return null;
}

/**
 * Letterbox geometry for fitting a frame into the model's square input without
 * distorting it. Exported because the caller has to draw with exactly these values for
 * the decode below to undo them correctly.
 */
export function letterboxParams(frameWidth: number, frameHeight: number): { ratio: number; padW: number; padH: number } {
	const ratio = Math.min(HAND_MODEL_INPUT_SIZE / frameHeight, HAND_MODEL_INPUT_SIZE / frameWidth);
	return {
		ratio,
		padW: (HAND_MODEL_INPUT_SIZE - frameWidth * ratio) / 2,
		padH: (HAND_MODEL_INPUT_SIZE - frameHeight * ratio) / 2,
	};
}

function imageDataToTensor(data: Uint8ClampedArray): ort.Tensor {
	const pixels = HAND_MODEL_INPUT_SIZE * HAND_MODEL_INPUT_SIZE;
	const float32Data = new Float32Array(pixels * 3);
	for (let i = 0; i < pixels; i++) {
		// NHWC, RGB, dropping alpha.
		float32Data[i * 3] = data[i * 4] / 255.0;
		float32Data[i * 3 + 1] = data[i * 4 + 1] / 255.0;
		float32Data[i * 3 + 2] = data[i * 4 + 2] / 255.0;
	}
	return new ort.Tensor("float32", float32Data, [1, HAND_MODEL_INPUT_SIZE, HAND_MODEL_INPUT_SIZE, 3]);
}

function sigmoid(x: number): number {
	return 1 / (1 + Math.exp(-x));
}

/**
 * Decodes the raw model outputs back into frame pixel space, undoing the letterbox.
 * Carried over from hand_model.ts's postProcessWithMoreThanOneHand unchanged.
 */
function decodeDetections(
	outputMap: ort.InferenceSession.OnnxValueMapType,
	frameWidth: number,
	frameHeight: number,
	scoreThreshold: number
): HandDetectionResult {
	const outputNames = Object.keys(outputMap);
	const boxDelta = outputMap[outputNames[0]].data as Float32Array;
	const rawScores = outputMap[outputNames[1]].data as Float32Array;

	const { ratio, padW, padH } = letterboxParams(frameWidth, frameHeight);
	const detections: HandDetection[] = [];
	let maxScore = 0;

	for (let i = 0; i < ANCHORS.length; i++) {
		const score = sigmoid(rawScores[i]);
		if (score > maxScore) maxScore = score;
		if (score <= scoreThreshold) continue;

		const offset = i * VALUES_PER_ANCHOR;
		const anchorX = ANCHORS[i][0];
		const anchorY = ANCHORS[i][1];

		// Box deltas are anchor-relative in the model's 192-square space.
		const cxRaw = (boxDelta[offset] / HAND_MODEL_INPUT_SIZE + anchorX) * HAND_MODEL_INPUT_SIZE;
		const cyRaw = (boxDelta[offset + 1] / HAND_MODEL_INPUT_SIZE + anchorY) * HAND_MODEL_INPUT_SIZE;
		const wRaw = boxDelta[offset + 2];
		const hRaw = boxDelta[offset + 3];

		// Remove the padding while still normalised, then scale back up to frame pixels.
		const realX = ((cxRaw - padW) / (frameWidth * ratio)) * frameWidth;
		const realY = ((cyRaw - padH) / (frameHeight * ratio)) * frameHeight;
		const realW = (wRaw / (frameWidth * ratio)) * frameWidth;
		const realH = (hRaw / (frameHeight * ratio)) * frameHeight;

		const landmarks: HandPoint[] = [];
		for (let l = 0; l < LANDMARKS_PER_PALM; l++) {
			landmarks.push({
				x: ((boxDelta[offset + 4 + l * 2] / HAND_MODEL_INPUT_SIZE + anchorX) * HAND_MODEL_INPUT_SIZE - padW) / ratio,
				y: ((boxDelta[offset + 5 + l * 2] / HAND_MODEL_INPUT_SIZE + anchorY) * HAND_MODEL_INPUT_SIZE - padH) / ratio,
			});
		}

		detections.push({
			bbox: [realX - realW / 2, realY - realH / 2, realX + realW / 2, realY + realH / 2],
			score,
			landmarks,
			x: realX,
			y: realY,
		});
	}

	const aboveThresholdCount = detections.length;
	return {
		detections: aboveThresholdCount === 0 ? [] : (groupBoxes(detections, GROUP_DISTANCE_PX) as HandDetection[]),
		maxScore,
		aboveThresholdCount,
	};
}

/** Shifts detections from a crop's own pixel space into the full frame's. */
export function offsetDetections(detections: HandDetection[], dx: number, dy: number): HandDetection[] {
	if (dx === 0 && dy === 0) return detections;
	return detections.map((detection) => ({
		...detection,
		x: detection.x + dx,
		y: detection.y + dy,
		bbox: [detection.bbox[0] + dx, detection.bbox[1] + dy, detection.bbox[2] + dx, detection.bbox[3] + dy],
		landmarks: detection.landmarks.map((point) => ({ x: point.x + dx, y: point.y + dy })),
	}));
}

/**
 * Collapses detections of the same hand. Needed a second time when regions overlap: the
 * per-region grouping cannot see a duplicate produced by the neighbouring crop.
 */
export function groupDetections(detections: HandDetection[]): HandDetection[] {
	if (detections.length <= 1) return detections;
	return groupBoxes(detections, GROUP_DISTANCE_PX) as HandDetection[];
}

/**
 * One inference pass. `imageData` must be exactly HAND_MODEL_INPUT_SIZE square, with the
 * frame drawn into it using letterboxParams(frameWidth, frameHeight) - the decode undoes
 * that specific transform and returns detections in frameWidth/frameHeight pixel space.
 *
 * Returns null when inference throws, which the caller must read as "did not run", never
 * as "found no hands".
 */
export async function detectHands(
	model: HandModel,
	imageData: ImageData,
	frameWidth: number,
	frameHeight: number
): Promise<HandDetectionResult | null> {
	try {
		const feeds: Record<string, ort.Tensor> = {
			[model.session.inputNames[0]]: imageDataToTensor(imageData.data),
		};
		const outputMap = await model.session.run(feeds);
		return decodeDetections(outputMap, frameWidth, frameHeight, model.scoreThreshold);
	} catch (error) {
		console.error("[handModel] inference failed:", error);
		return null;
	}
}

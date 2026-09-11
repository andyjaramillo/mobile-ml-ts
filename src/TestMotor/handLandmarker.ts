// [Feature: Test Motor]
//
// Replaces the ONNX palm detector. HandLandmarker runs palm detection AND landmark
// regression in one pass, so this is a swap rather than a second model on the frame
// budget - which is what the repo's rules require before adding one.
//
// It also supersedes the halves-crop framing that was added to get enough pixels onto a
// hand: in VIDEO mode MediaPipe runs full detection only when it loses a hand, and
// otherwise tracks it by re-cropping around the previous result and running the landmark
// model on that crop at its own resolution. That is the same idea the crops implemented
// by hand, done inside the pipeline and without a second inference per tick.
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { Point2D } from "./handGeometry";
import { LANDMARK_COUNT } from "./handGeometry";

// Same CDN base as initModels.ts, including its wasm-glue preload workaround. Website
// self-hosts this directory instead because its CSP blocks the CDN - see
// public/models/MODEL_PROVENANCE.md for what has to change on the way back.
const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const MODEL_URL = "/models/hand_landmarker.task";

export type MediaPipeHandedness = "Left" | "Right";

export interface LandmarkedHand {
	/** 21 landmarks in the frame's own pixel space, unmirrored. */
	landmarks: Point2D[];
	/**
	 * Exactly as MediaPipe reported it, before any mirror correction. Kept raw so the
	 * correction can be checked against the data rather than assumed - see handStatus.
	 */
	rawHandedness: MediaPipeHandedness;
	handednessScore: number;
}

export interface HandLandmarkerHandle {
	detector: HandLandmarker;
}

async function preloadWasmGlue(wasmBase: string): Promise<void> {
	const g = globalThis as Record<string, unknown>;
	if (g.ModuleFactory) return;
	for (const name of ["vision_wasm_internal.js", "vision_wasm_nosimd_internal.js"]) {
		try {
			const res = await fetch(`${wasmBase}/${name}`);
			if (!res.ok) continue;
			const src = await res.text();
			(0, eval)(src);
			if (g.ModuleFactory) return;
		} catch {
			/* try next variant */
		}
	}
}

/** Resolves to null on any failure; the caller must then run with the check silent. */
export async function initHandLandmarker(): Promise<HandLandmarkerHandle | null> {
	try {
		await preloadWasmGlue(WASM_BASE);
		const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
		const detector = await HandLandmarker.createFromOptions(vision, {
			baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
			runningMode: "VIDEO",
			numHands: 2,
		});
		return { detector };
	} catch (error) {
		console.error("[handLandmarker] init failed:", error);
		return null;
	}
}

/**
 * Returns null when detection did not run - never [], which would mean "ran and found
 * no hands". MediaPipe's VIDEO mode throws rather than returning empty on a timestamp
 * that does not strictly increase, and that would take the whole detect loop down.
 */
export function detectHands(
	handle: HandLandmarkerHandle,
	video: HTMLVideoElement,
	timestampMs: number,
	frameWidth: number,
	frameHeight: number
): LandmarkedHand[] | null {
	try {
		const result = handle.detector.detectForVideo(video, timestampMs);
		const hands: LandmarkedHand[] = [];

		for (let i = 0; i < result.landmarks.length; i++) {
			const normalized = result.landmarks[i];
			if (!normalized || normalized.length < LANDMARK_COUNT) continue;
			const category = result.handednesses?.[i]?.[0];
			hands.push({
				// MediaPipe reports normalised coordinates; everything downstream works in
				// frame pixels, so the conversion happens once, here.
				landmarks: normalized.map((point) => ({ x: point.x * frameWidth, y: point.y * frameHeight })),
				rawHandedness: category?.categoryName === "Left" ? "Left" : "Right",
				handednessScore: category?.score ?? 0,
			});
		}
		return hands;
	} catch (error) {
		console.error("[handLandmarker] detectForVideo failed:", error);
		return null;
	}
}

export function closeHandLandmarker(handle: HandLandmarkerHandle): void {
	try {
		handle.detector.close();
	} catch {
		/* already gone */
	}
}

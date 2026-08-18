// [Feature: Capture Quality Warnings]
//
// Loads MediaPipe's ObjectDetector alongside the ArUco detector and exposes a
// person-only detect call, for the subject-position pre-check.
//
// Why this is a separate hook rather than a third branch of useModel: useModel switches
// between ONE model at a time and remounts its hidden canvas (see its `key` in
// RealTimeProcessor.tsx) to swap the canvas between a WebGL context for MediaPipe and a
// 2D context for ArUco. A single canvas element cannot serve both, and the capture-quality
// loop needs both models live at once, so this hook owns its own detached canvas and never
// touches useModel's.
//
// FAIL-OPEN, deliberately. Every failure path here - WASM fetch blocked, GPU delegate
// unavailable, model download failed, detectForVideo throwing mid-session - leaves people
// as null forever and lets the user record exactly as if the subject check did not exist.
// A capture-quality check must never be the reason a clinician cannot record a patient
// (see .claude/CLAUDE.md). Note this is the opposite of the fail-closed rule governing
// CurveAssure's permission checks; do not carry that instinct here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ObjectDetector } from "@mediapipe/tasks-vision";
import { initObjectDetector } from "./initModels";
import type { CaptureQualityBBox } from "../CaptureQuality/types";

export type PersonDetectorStatus = "loading" | "ready" | "unavailable";

/** MediaPipe's COCO category name for a person; every other detected class is discarded. */
const PERSON_CATEGORY = "person";

export interface PersonDetector {
	status: PersonDetectorStatus;
	/**
	 * Runs person detection on the video element directly - MediaPipe uploads the frame to
	 * a GPU texture itself, so this deliberately avoids the drawImage + getImageData pair
	 * the ArUco path needs. Boxes come back in the VIDEO's own pixel space
	 * (videoWidth x videoHeight), which is NOT the ArUco detector's 1024-wide space; the
	 * caller must rescale before putting both in one CaptureQualityFrameSample.
	 *
	 * Returns null when detection did not run (still loading, unavailable, or a
	 * non-monotonic timestamp) - never [], which would mean "ran and found nobody".
	 */
	detectPeople: (video: HTMLVideoElement, timestampMs: number) => CaptureQualityBBox[] | null;
}

export function usePersonDetector(enabled: boolean = true): PersonDetector {
	const [status, setStatus] = useState<PersonDetectorStatus>(enabled ? "loading" : "unavailable");
	const detectorRef = useRef<ObjectDetector | null>(null);
	// MediaPipe's VIDEO running mode rejects a timestamp that does not strictly increase,
	// and throws rather than returning empty - which would take the whole detect loop down.
	const lastTimestampRef = useRef(-1);
	const degradedRef = useRef(false);

	useEffect(() => {
		if (!enabled) return;
		let disposed = false;
		let active: ObjectDetector | null = null;

		const load = async () => {
			try {
				// A detached canvas, never mounted: it exists only to give the GPU delegate a
				// WebGL context of its own.
				const canvas = document.createElement("canvas");
				const detector = await initObjectDetector(canvas as unknown as OffscreenCanvas);
				if (disposed) {
					detector.close();
					return;
				}
				active = detector;
				detectorRef.current = detector;
				setStatus("ready");
			} catch (error) {
				if (disposed) return;
				console.warn("person detector unavailable; subject checks disabled", error);
				setStatus("unavailable");
			}
		};
		load();

		return () => {
			disposed = true;
			detectorRef.current = null;
			lastTimestampRef.current = -1;
			degradedRef.current = false;
			active?.close();
		};
	}, [enabled]);

	// Stable across renders (it reads only refs) so the returned object changes identity
	// solely on a real status transition - the detect loop holds this in a ref and would
	// otherwise re-sync it on every single render.
	const detectPeople = useCallback((video: HTMLVideoElement, timestampMs: number): CaptureQualityBBox[] | null => {
		const detector = detectorRef.current;
		if (!detector || degradedRef.current) return null;
		if (timestampMs <= lastTimestampRef.current) return null;
		lastTimestampRef.current = timestampMs;

		try {
			const result = detector.detectForVideo(video, timestampMs);
			return result.detections
				.filter((d) => d.categories.some((c) => c.categoryName === PERSON_CATEGORY))
				.map((d) => ({
					x: d.boundingBox?.originX ?? 0,
					y: d.boundingBox?.originY ?? 0,
					width: d.boundingBox?.width ?? 0,
					height: d.boundingBox?.height ?? 0,
				}))
				.filter((b) => b.width > 0 && b.height > 0);
		} catch (error) {
			// One throw is treated as permanent: retrying a broken GPU context every tick
			// costs the frame budget the check exists to protect.
			degradedRef.current = true;
			console.warn("person detection failed; subject checks disabled for this session", error);
			return null;
		}
	}, []);

	return useMemo(() => ({ status, detectPeople }), [status, detectPeople]);
}

export default usePersonDetector;

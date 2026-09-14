// [Feature: Test Motor]
//
// Loads the hand landmarker once per session. Owned by TestMotor rather than the camera
// because the camera remounts at every take, and re-fetching a 7.8MB model three times
// would cost the patient real time for nothing.
//
// Fails open. A model that never arrives leaves status "failed", the check silent, and
// every other part of the flow untouched.
import { useEffect, useState } from "react";
import { defaultHandDelegate, initHandLandmarker } from "./handLandmarker";
import type { HandDelegate, HandLandmarkerHandle } from "./handLandmarker";

export type HandModelStatus = "loading" | "ready" | "failed";

export interface HandModelHandle {
	model: HandLandmarkerHandle | null;
	status: HandModelStatus;
	requestedDelegate: HandDelegate;
}

/**
 * Module-scoped, not a ref, and never released. StrictMode mounts every effect twice, so
 * a per-hook guard either loads the model twice or - if the guard also short-circuits the
 * second mount - drops the first load's result into a torn-down closure and hangs on
 * "loading" forever. Caching the promise lets the second mount subscribe to the first
 * mount's in-flight load.
 *
 * Never released because it is deliberately session-scoped: the only consumer lives as
 * long as the page, and releasing it on a StrictMode teardown is precisely the bug above.
 */
const cachedLoads = new Map<HandDelegate, Promise<HandLandmarkerHandle | null>>();

export function useHandModel(enabled = true, delegate: HandDelegate = defaultHandDelegate()): HandModelHandle {
	const [handle, setHandle] = useState<HandModelHandle>({
		model: null,
		status: "loading",
		requestedDelegate: delegate,
	});

	useEffect(() => {
		if (!enabled) {
			setHandle({ model: null, status: "failed", requestedDelegate: delegate });
			return;
		}

		let cancelled = false;
		setHandle({ model: null, status: "loading", requestedDelegate: delegate });
		let load = cachedLoads.get(delegate);
		if (!load) {
			load = initHandLandmarker(delegate);
			cachedLoads.set(delegate, load);
		}
		load.then((model) => {
			if (cancelled) return;
			setHandle(
				model
					? { model, status: "ready", requestedDelegate: delegate }
					: { model: null, status: "failed", requestedDelegate: delegate }
			);
		});

		return () => {
			cancelled = true;
		};
	}, [enabled, delegate]);

	return handle;
}

export default useHandModel;

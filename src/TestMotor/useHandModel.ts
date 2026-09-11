// [Feature: Test Motor]
//
// Loads the palm model once per session. Owned by TestMotor rather than the camera for
// the same reason gait's usePersonDetector is: the camera remounts at every take, and
// re-fetching a 3.9MB model three times would cost the patient real time for nothing.
//
// Fails open. A model that never arrives leaves status "failed", the check silent, and
// every other part of the flow untouched.
import { useEffect, useState } from "react";
import { initHandModel } from "./handModel";
import type { HandModel, HandModelBackend } from "./handModel";

export type HandModelStatus = "loading" | "ready" | "failed";

export interface HandModelHandle {
	model: HandModel | null;
	status: HandModelStatus;
	backend: HandModelBackend;
}

/**
 * Module-scoped, not a ref, and never released. StrictMode mounts every effect twice, so
 * a per-hook guard either loads the model twice (usePersonDetector's tradeoff) or - if
 * the guard also short-circuits the second mount - drops the first load's result into a
 * torn-down closure and hangs on "loading" forever. Caching the promise instead lets the
 * second mount subscribe to the first mount's in-flight load.
 *
 * Never released because it is deliberately session-scoped: the only consumer lives for
 * as long as the page, and releasing it on a StrictMode teardown is precisely the bug
 * above.
 */
let cachedLoad: Promise<HandModel | null> | null = null;

/**
 * `?ort=wasm` or `?ort=webgl` pins the execution provider. ort-web's WebGL provider is
 * legacy and degrades per-operator without erroring, so being able to force WASM on the
 * actual phone - no rebuild, no redeploy - is the difference between diagnosing that in
 * one take and guessing at it.
 */
/** `?thr=0.45` overrides the score threshold, so a candidate can be tried on the phone. */
function thresholdFromUrl(): number | undefined {
	if (typeof window === "undefined") return undefined;
	const raw = new URLSearchParams(window.location.search).get("thr");
	if (raw === null) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : undefined;
}

function forcedBackendFromUrl(): HandModelBackend {
	if (typeof window === "undefined") return null;
	const requested = new URLSearchParams(window.location.search).get("ort");
	return requested === "wasm" || requested === "webgl" ? requested : null;
}

export function useHandModel(enabled = true): HandModelHandle {
	const [handle, setHandle] = useState<HandModelHandle>({ model: null, status: "loading", backend: null });

	useEffect(() => {
		if (!enabled) {
			setHandle({ model: null, status: "failed", backend: null });
			return;
		}

		let cancelled = false;
		if (!cachedLoad) cachedLoad = initHandModel(thresholdFromUrl(), forcedBackendFromUrl() ?? undefined);
		cachedLoad.then((model) => {
			if (cancelled) return;
			setHandle(
				model
					? { model, status: "ready", backend: model.backend }
					: { model: null, status: "failed", backend: null }
			);
		});

		return () => {
			cancelled = true;
		};
	}, [enabled]);

	return handle;
}

export default useHandModel;

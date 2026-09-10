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

export function useHandModel(enabled = true): HandModelHandle {
	const [handle, setHandle] = useState<HandModelHandle>({ model: null, status: "loading", backend: null });

	useEffect(() => {
		if (!enabled) {
			setHandle({ model: null, status: "failed", backend: null });
			return;
		}

		let cancelled = false;
		if (!cachedLoad) cachedLoad = initHandModel();
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

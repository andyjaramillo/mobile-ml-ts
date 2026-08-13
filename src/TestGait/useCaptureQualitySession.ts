// [Feature: Test Gait]
//
// React wrapper around captureQualitySessionState.ts: owns the session state in a ref
// (so the per-frame detect loop in TestGaitCamera can mutate it without triggering a
// render) plus the throttled aggregate state the HUD panels actually render from.
import { useCallback, useRef, useState } from "react";
import {
	createCaptureQualitySessionState,
	resetCaptureQualitySessionForNewTake,
	type CaptureQualitySessionState,
} from "./captureQualitySessionState";
import type { MarkerBoardWindowAggregate } from "../CaptureQuality/markerBoardCheck";
import type { LowLightWindowAggregate } from "../CaptureQuality/lowLightCheck";

export interface CaptureQualitySession {
	stateRef: React.MutableRefObject<CaptureQualitySessionState>;
	markerBoardAggregate: MarkerBoardWindowAggregate | null;
	setMarkerBoardAggregate: (aggregate: MarkerBoardWindowAggregate | null) => void;
	lowLightAggregate: LowLightWindowAggregate | null;
	setLowLightAggregate: (aggregate: LowLightWindowAggregate | null) => void;
	/** Resets both rolling windows and clears the HUD's frozen readout — call before starting a fresh take. */
	resetForNewTake: () => void;
}

export function useCaptureQualitySession(): CaptureQualitySession {
	const stateRef = useRef<CaptureQualitySessionState>(createCaptureQualitySessionState());
	const [markerBoardAggregate, setMarkerBoardAggregate] = useState<MarkerBoardWindowAggregate | null>(null);
	const [lowLightAggregate, setLowLightAggregate] = useState<LowLightWindowAggregate | null>(null);

	const resetForNewTake = useCallback(() => {
		resetCaptureQualitySessionForNewTake(stateRef.current);
		setMarkerBoardAggregate(null);
		setLowLightAggregate(null);
	}, []);

	return {
		stateRef,
		markerBoardAggregate,
		setMarkerBoardAggregate,
		lowLightAggregate,
		setLowLightAggregate,
		resetForNewTake,
	};
}

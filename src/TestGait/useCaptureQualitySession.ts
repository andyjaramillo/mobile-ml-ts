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
import type { SubjectPositionWindowAggregate } from "../CaptureQuality/subjectPositionCheck";
import { createTickProfiler } from "../CaptureQualityHud/tickProfiler";
import type { TickProfiler } from "../CaptureQualityHud/tickProfiler";

export interface CaptureQualitySession {
	stateRef: React.MutableRefObject<CaptureQualitySessionState>;
	/**
	 * Per-stage tick timing. Lives here rather than inside TestGaitCamera because the camera
	 * unmounts between trials and these means are worth carrying across all three - and
	 * because the HUD that renders them is mounted by the parent. Deliberately NOT reset by
	 * resetForNewTake: a cost profile is a property of the device, not of the take.
	 */
	tickProfilerRef: React.MutableRefObject<TickProfiler>;
	markerBoardAggregate: MarkerBoardWindowAggregate | null;
	setMarkerBoardAggregate: (aggregate: MarkerBoardWindowAggregate | null) => void;
	lowLightAggregate: LowLightWindowAggregate | null;
	setLowLightAggregate: (aggregate: LowLightWindowAggregate | null) => void;
	subjectPositionAggregate: SubjectPositionWindowAggregate | null;
	setSubjectPositionAggregate: (aggregate: SubjectPositionWindowAggregate | null) => void;
	/** Resets both rolling windows and clears the HUD's frozen readout — call before starting a fresh take. */
	resetForNewTake: () => void;
}

export function useCaptureQualitySession(): CaptureQualitySession {
	const stateRef = useRef<CaptureQualitySessionState>(createCaptureQualitySessionState());
	const tickProfilerRef = useRef<TickProfiler>(createTickProfiler());
	const [markerBoardAggregate, setMarkerBoardAggregate] = useState<MarkerBoardWindowAggregate | null>(null);
	const [lowLightAggregate, setLowLightAggregate] = useState<LowLightWindowAggregate | null>(null);
	const [subjectPositionAggregate, setSubjectPositionAggregate] = useState<SubjectPositionWindowAggregate | null>(null);

	const resetForNewTake = useCallback(() => {
		resetCaptureQualitySessionForNewTake(stateRef.current);
		setMarkerBoardAggregate(null);
		setLowLightAggregate(null);
		setSubjectPositionAggregate(null);
	}, []);

	return {
		stateRef,
		tickProfilerRef,
		markerBoardAggregate,
		setMarkerBoardAggregate,
		lowLightAggregate,
		setLowLightAggregate,
		subjectPositionAggregate,
		setSubjectPositionAggregate,
		resetForNewTake,
	};
}

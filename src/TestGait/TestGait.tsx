// [Feature: Test Gait]
//
// Orchestrates the full FDA gait patient-facing sequence: permission -> (camera setup +
// capture-quality checks + recording -> review) x 3 trials -> done. Owns the state that
// must span the whole session (the capture-quality windows/config pair and the harness
// recorder) so a fresh TestGaitCamera mount per take can't lose or duplicate it — see
// beginTake below.
import { useCallback, useEffect, useRef, useState } from "react";
import TestGaitPermission from "./TestGaitPermission";
import TestGaitCamera from "./TestGaitCamera";
import TestGaitReview from "./TestGaitReview";
import TestGaitDone from "./TestGaitDone";
import MarkerBoardHud from "../CaptureQualityHud/MarkerBoardHud";
import LowLightHud from "../CaptureQualityHud/LowLightHud";
import RecorderPanel from "../CaptureQualityHud/RecorderPanel";
import GuidanceBanner from "../CaptureQualityHud/GuidanceBanner";
import { createCaptureRecorderState } from "../CaptureQualityHud/captureRecorder";
import { useCaptureQualitySession } from "./useCaptureQualitySession";
import { TOTAL_TRIALS } from "./testGaitConfig";

type Phase = "permission" | "camera" | "review" | "done";

interface ReviewState {
	url: string;
	mimeType: string;
}

function TestGait() {
	const [phase, setPhase] = useState<Phase>("permission");
	const [trialNumber, setTrialNumber] = useState(1);
	// Bumped on every fresh take (initial trial 1, rerecord, or advancing to the next
	// trial) and used as TestGaitCamera's React key — a full remount matches Website's
	// own behavior (camera_display is a distinct fragment that unmounts/remounts on
	// every visit) and is what makes captureQuality.resetForNewTake below meaningful:
	// the child starts pushing into windows that are already empty, not ones it has to
	// clear itself.
	const [takeKey, setTakeKey] = useState(0);
	const [review, setReview] = useState<ReviewState | null>(null);
	// Same default-ON convention as RealTimeProcessor.tsx's identical toggle - this page's
	// existing calibration workflow relies on the debug chips being visible by default.
	const [showDebugHud, setShowDebugHud] = useState(true);

	const captureQuality = useCaptureQualitySession();
	// Session-spanning by design: created once here (not inside TestGaitCamera), so it
	// survives every remount above and a single Copy captures the whole run, even though
	// the capture-quality windows feeding it get reset every take.
	const captureRecorderStateRef = useRef(createCaptureRecorderState());

	const reviewRef = useRef<ReviewState | null>(null);
	useEffect(() => {
		reviewRef.current = review;
	}, [review]);

	// Belt-and-suspenders: if the whole session unmounts mid-review (e.g. switching
	// modes in App.tsx) rather than via a button click, still revoke the outstanding URL.
	useEffect(() => {
		return () => {
			if (reviewRef.current) URL.revokeObjectURL(reviewRef.current.url);
		};
	}, []);

	const beginTake = useCallback(() => {
		captureQuality.resetForNewTake();
		setTakeKey((k) => k + 1);
		setPhase("camera");
	}, [captureQuality]);

	const handlePermissionGranted = useCallback(() => {
		beginTake();
	}, [beginTake]);

	const handleRecorded = useCallback((blob: Blob, mimeType: string) => {
		setReview({ url: URL.createObjectURL(blob), mimeType });
		setPhase("review");
	}, []);

	// Both handlers read `review`/`trialNumber` from closure and call setState directly
	// (rather than nesting a beginTake()/URL.revokeObjectURL() side effect inside a
	// functional updater) so they stay safe under StrictMode's double-invoke of updater
	// functions - React may call an updater twice to check purity, and this app runs in
	// StrictMode (see main.tsx).
	const handleRerecord = useCallback(() => {
		if (review) URL.revokeObjectURL(review.url);
		setReview(null);
		beginTake();
	}, [review, beginTake]);

	const handleContinue = useCallback(() => {
		if (review) URL.revokeObjectURL(review.url);
		setReview(null);
		if (trialNumber < TOTAL_TRIALS) {
			setTrialNumber(trialNumber + 1);
			beginTake();
		} else {
			setPhase("done");
		}
	}, [review, trialNumber, beginTake]);

	const handleRestart = useCallback(() => {
		setTrialNumber(1);
		setPhase("permission");
	}, []);

	const showHudChecks = phase === "camera";
	const showRecorderPanel = phase === "camera" || phase === "review" || phase === "done";

	return (
		<div className="tg-root">
			{phase === "permission" && <TestGaitPermission onGranted={handlePermissionGranted} />}
			{phase === "camera" && (
				<TestGaitCamera
					key={takeKey}
					trialNumber={trialNumber}
					totalTrials={TOTAL_TRIALS}
					captureQuality={captureQuality}
					captureRecorderStateRef={captureRecorderStateRef}
					onRecorded={handleRecorded}
				/>
			)}
			{phase === "review" && review && (
				<TestGaitReview
					trialNumber={trialNumber}
					totalTrials={TOTAL_TRIALS}
					videoUrl={review.url}
					onRerecord={handleRerecord}
					onContinue={handleContinue}
				/>
			)}
			{phase === "done" && <TestGaitDone totalTrials={TOTAL_TRIALS} onRestart={handleRestart} />}

			{showHudChecks && (
				<>
					{/* Patient-facing: replaces the developer chips below as the primary
					    on-screen guidance during setup. Sits in RecorderPanel's old camera-phase
					    slot (topOffsetPx=150); RecorderPanel itself moves down to 225 to make
					    room (see below) - both clear TestGaitCamera's own tg-setup-banner at the
					    very top of the screen. */}
					<GuidanceBanner
						markerBoardAggregate={captureQuality.markerBoardAggregate}
						lowLightAggregate={captureQuality.lowLightAggregate}
						markerBoardConfig={captureQuality.stateRef.current.markerBoardConfig}
						showDebugHud={showDebugHud}
						onToggleDebugHud={() => setShowDebugHud((v) => !v)}
						topOffsetPx={150}
					/>
					{showDebugHud && (
						<>
							{/* bottomOffsetPx clears TestGaitCamera's record-button cluster, which
							    sits near the bottom of the screen (unlike RealTimeProcessor's debug
							    page, which has nothing else down there) - see MarkerBoardHud's prop doc. */}
							<MarkerBoardHud
								aggregate={captureQuality.markerBoardAggregate}
								config={captureQuality.stateRef.current.markerBoardConfig}
								bottomOffsetPx={110}
							/>
							<LowLightHud
								aggregate={captureQuality.lowLightAggregate}
								config={captureQuality.stateRef.current.lowLightConfig}
							/>
						</>
					)}
				</>
			)}
			{showRecorderPanel && (
				<RecorderPanel
					stateRef={captureRecorderStateRef}
					topOffsetPx={phase === "camera" ? 225 : 40}
				/>
			)}
		</div>
	);
}

export default TestGait;

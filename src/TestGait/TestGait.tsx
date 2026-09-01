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
import SubjectPositionHud from "../CaptureQualityHud/SubjectPositionHud";
import TickProfilerHud from "../CaptureQualityHud/TickProfilerHud";
import DebugHudStack from "../CaptureQualityHud/DebugHudStack";
import RecorderPanel from "../CaptureQualityHud/RecorderPanel";
import GuidanceBanner from "../CaptureQualityHud/GuidanceBanner";
import { DEFAULTS as CAPTURE_QUALITY_DEFAULTS } from "../CaptureQuality/captureQualityConfig";
import { createCaptureRecorderState } from "../CaptureQualityHud/captureRecorder";
import usePersonDetector from "../model/usePersonDetector";
import { useCaptureQualitySession } from "./useCaptureQualitySession";
import { SUBJECT_CHECKS_ENABLED, TOTAL_TRIALS } from "./testGaitConfig";

type Phase = "permission" | "camera" | "review" | "done";

interface TestGaitProps {
	/**
	 * Customer view: no debug panel, no recorder, no debug toggle - exactly the surface a
	 * clinician sees. Everything below the UI is identical, deliberately: the same checks run
	 * on the same frames at the same cadence, so this mode is a faithful preview rather than a
	 * separate lighter-weight flow that could behave differently from what ships.
	 *
	 * Kept as a prop on the one component rather than a forked TestGaitOfficial.tsx, because a
	 * copy would drift from the real flow the moment either side changed - and the whole point
	 * of this mode is that it is not a different flow.
	 */
	patientView?: boolean;
}

interface ReviewState {
	url: string;
	mimeType: string;
}

function TestGait({ patientView = false }: TestGaitProps) {
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
	// Patient view can never show the debug surfaces, whatever the toggle state happens to be.
	const debugVisible = showDebugHud && !patientView;

	const captureQuality = useCaptureQualitySession();
	// Owned here, not in TestGaitCamera: that component remounts at every take boundary
	// (see takeKey above), and reloading a ~4MB model from the CDN three times per session
	// would cost the user real time for no benefit. A failure to load leaves the subject
	// check silent and every other phase untouched.
	const personDetector = usePersonDetector(SUBJECT_CHECKS_ENABLED);
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
					personDetector={personDetector}
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
						subjectAggregate={captureQuality.subjectPositionAggregate}
						showDebugHud={debugVisible}
						onToggleDebugHud={() => setShowDebugHud((v) => !v)}
						hideDebugToggle={patientView}
						/* 150 in both modes: TestGaitCamera renders its own setup instructions at the
						   top of the screen regardless of mode, and raising the banner to clear the
						   (now absent) debug stack just put it on top of those instead. */
						topOffsetPx={150}
					/>
					{debugVisible && (
						/* One scrollable column instead of four edge-pinned boxes. Four panels
						   cannot each claim their own screen edge on a phone - they overlapped
						   into an unreadable pile. Bounded to clear the guidance banner above and
						   the record button below; see DebugHudStack. */
						<DebugHudStack topOffsetPx={215}>
							<RecorderPanel stateRef={captureRecorderStateRef} embedded />
							<SubjectPositionHud
								aggregate={captureQuality.subjectPositionAggregate}
								config={captureQuality.stateRef.current.subjectPositionConfig}
								detectorStatus={personDetector.status}
								embedded
							/>
							{/* Ordered by what is being actively calibrated, not by check age: the
							    subject and loop sections are the unvalidated ones, so they sit above
							    the fold and the two calibrated checks scroll. */}
							<TickProfilerHud
								profiler={captureQuality.tickProfilerRef.current}
								targetHz={CAPTURE_QUALITY_DEFAULTS.sampling.liveTickHz}
								embedded
							/>
							<MarkerBoardHud
								aggregate={captureQuality.markerBoardAggregate}
								config={captureQuality.stateRef.current.markerBoardConfig}
								embedded
							/>
							<LowLightHud
								aggregate={captureQuality.lowLightAggregate}
								config={captureQuality.stateRef.current.lowLightConfig}
								embedded
							/>
						</DebugHudStack>
					)}
				</>
			)}
			{/* The debug stack renders its own copy of the recorder as its first section, so
			    this standalone one is only for the phases the stack is not shown in (review,
			    done) - the operator still needs Copy after a take. Rendering both would give
			    two panels driving the same recorder state. */}
			{showRecorderPanel && !patientView && !(showHudChecks && debugVisible) && (
				<RecorderPanel
					stateRef={captureRecorderStateRef}
					topOffsetPx={phase === "camera" ? 225 : 40}
				/>
			)}
		</div>
	);
}

export default TestGait;

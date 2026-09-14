// [Feature: Test Motor]
//
// Orchestrates Motor: Hand (home): permission -> (camera -> review) x 3 tests -> done.
// Same shape as TestGait, with two differences that follow from the assessment itself -
// the three takes are three DIFFERENT tests rather than three trials of one, and the
// model it owns is the palm detector rather than the person detector.
//
// Session-spanning state lives here so a fresh TestMotorCamera per take cannot lose it:
// the model (a 3.9MB load, once) and the status window (explicitly reset per take, so
// take 2 never inherits take 1's frames).
import { useCallback, useEffect, useRef, useState } from "react";
import TestMotorPermission from "./TestMotorPermission";
import TestMotorCamera from "./TestMotorCamera";
import TestMotorReview from "./TestMotorReview";
import TestMotorDone from "./TestMotorDone";
import useHandModel from "./useHandModel";
import { defaultHandDelegate } from "./handLandmarker";
import type { HandDelegate } from "./handLandmarker";
import { createHandStatusWindow, resetHandStatusWindow } from "./handStatus";
import { createMotorRecorderState } from "./motorRecorder";
import { MOTOR_TESTS } from "./motorConfig";

type Phase = "permission" | "camera" | "review" | "done";

interface TestMotorProps {
	/** Patient view: no debug HUD and no debug toggle, same checks underneath. */
	patientView?: boolean;
}

interface ReviewState {
	url: string;
	mimeType: string;
}

function TestMotor({ patientView = false }: TestMotorProps) {
	const [phase, setPhase] = useState<Phase>("permission");
	const [testIndex, setTestIndex] = useState(0);
	// Forces a full remount per take, matching Website (each camera fragment is entered
	// fresh) and making the status-window reset below meaningful.
	const [takeKey, setTakeKey] = useState(0);
	const [review, setReview] = useState<ReviewState | null>(null);

	const [delegate, setDelegate] = useState<HandDelegate>(() => {
		const requested = new URLSearchParams(window.location.search).get("delegate")?.toUpperCase();
		return requested === "GPU" || requested === "CPU" ? requested : defaultHandDelegate();
	});
	const handModel = useHandModel(true, delegate);
	const statusWindowRef = useRef(createHandStatusWindow());
	// Not reset per take, unlike the status window: an operator recording a calibration
	// run wants the whole session in one Copy, not three fragments.
	const recorderStateRef = useRef(createMotorRecorderState());

	const reviewRef = useRef<ReviewState | null>(null);
	useEffect(() => {
		reviewRef.current = review;
	}, [review]);

	useEffect(() => {
		return () => {
			if (reviewRef.current) URL.revokeObjectURL(reviewRef.current.url);
		};
	}, []);

	const beginTake = useCallback(() => {
		resetHandStatusWindow(statusWindowRef.current);
		setTakeKey((k) => k + 1);
		setPhase("camera");
	}, []);

	const handleRecorded = useCallback((blob: Blob, mimeType: string) => {
		setReview({ url: URL.createObjectURL(blob), mimeType });
		setPhase("review");
	}, []);

	const handleRerecord = useCallback(() => {
		if (review) URL.revokeObjectURL(review.url);
		setReview(null);
		beginTake();
	}, [review, beginTake]);

	const handleContinue = useCallback(() => {
		if (review) URL.revokeObjectURL(review.url);
		setReview(null);
		if (testIndex < MOTOR_TESTS.length - 1) {
			setTestIndex(testIndex + 1);
			beginTake();
		} else {
			setPhase("done");
		}
	}, [review, testIndex, beginTake]);

	const handleRestart = useCallback(() => {
		setTestIndex(0);
		setPhase("permission");
	}, []);

	const test = MOTOR_TESTS[testIndex];

	return (
		<div className="tm-root">
			{phase === "permission" && <TestMotorPermission onGranted={beginTake} />}
			{phase === "camera" && (
				<TestMotorCamera
					key={takeKey}
					test={test}
					testNumber={testIndex + 1}
					totalTests={MOTOR_TESTS.length}
					handModel={handModel}
					statusWindowRef={statusWindowRef}
					recorderStateRef={recorderStateRef}
					patientView={patientView}
					onSwitchDelegate={patientView ? undefined : () => setDelegate((d) => (d === "CPU" ? "GPU" : "CPU"))}
					onRecorded={handleRecorded}
				/>
			)}
			{phase === "review" && review && (
				<TestMotorReview
					testLabel={test.label}
					testNumber={testIndex + 1}
					totalTests={MOTOR_TESTS.length}
					videoUrl={review.url}
					onRerecord={handleRerecord}
					onContinue={handleContinue}
				/>
			)}
			{phase === "done" && <TestMotorDone totalTests={MOTOR_TESTS.length} onRestart={handleRestart} />}
		</div>
	);
}

export default TestMotor;

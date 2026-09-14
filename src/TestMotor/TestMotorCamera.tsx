// [Feature: Test Motor]
//
// One take of Motor: Hand (home): mirrored front-camera preview, the hand guide overlay,
// the live hand check during setup, then the same leadIn -> go -> active recording
// machine and MediaRecorder configuration TestGaitCamera uses (both ported from
// Website's CameraRecording.tsx, so the two harness flows record identically).
//
// The check gates the LEAD-IN only, never the record button and never a recording in
// progress, per the repo's fail-open rule.
import { useCallback, useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";
import MotorTrackingGraphic from "./MotorTrackingGraphic";
import MotorGuidanceBanner from "./MotorGuidanceBanner";
import MotorHandHud from "./MotorHandHud";
import MotorRecorderPanel from "./MotorRecorderPanel";
import DebugHudStack from "../CaptureQualityHud/DebugHudStack";
import { detectHands } from "./handLandmarker";
import { recordMotorTick } from "./motorRecorder";
import type { MotorRecorderState } from "./motorRecorder";
import { evaluateHandFrame, pushHandStatus } from "./handStatus";
import type { HandFrameEvaluation, HandStatusWindow, MotorIssueCode } from "./handStatus";
import { drawHandOverlay } from "./handOverlayDraw";
import { getSupportedMimeType, calculateBitrate } from "../TestGait/cameraUtils";
import type { HandModelHandle } from "./useHandModel";
import type { MotorTest } from "./motorConfig";
import {
	CAMERA_READY_STABILITY_DELAY_MS,
	DETECT_TICK_INTERVAL_MS,
	GO_MESSAGE,
	HUD_UPDATE_EVERY_N_TICKS,
	LEAD_IN_COUNTDOWN_FROM,
	LEAD_IN_MONITOR_INTERVAL_MS,
	LEAD_IN_POSTURE_GRACE_MS,
	LEAD_IN_RESUME_HOLD_MS,
	RUN_CHECKS_WHILE_RECORDING,
} from "./motorConfig";

interface VideoDimensions {
	width: number;
	height: number;
	top: number;
	left: number;
}

type RecordingPhase = "idle" | "waiting" | "leadIn" | "go" | "active";

interface Props {
	test: MotorTest;
	testNumber: number;
	totalTests: number;
	handModel: HandModelHandle;
	statusWindowRef: React.MutableRefObject<HandStatusWindow>;
	/** Owned by the parent so one recording can span several takes. */
	recorderStateRef: React.MutableRefObject<MotorRecorderState>;
	patientView: boolean;
	onRecorded: (blob: Blob, mimeType: string) => void;
}

// Motor is authored for landscape (the overlay's own 839x520) and uses the front camera -
// the patient is looking at their own hands. Both differ from gait.
const LANDSCAPE_ASPECT_RATIO = 16 / 9;
const VIDEO_CONSTRAINTS = {
	width: { ideal: 1920 },
	height: { ideal: 1080 },
	facingMode: { ideal: "user" as const },
	aspectRatio: { ideal: LANDSCAPE_ASPECT_RATIO },
	frameRate: { ideal: 30, max: 30 },
};

const GUIDE_OK_COLOR = "#33FF00";
const GUIDE_BAD_COLOR = "#FF0000";

function TestMotorCamera({ test, testNumber, totalTests, handModel, statusWindowRef, recorderStateRef, patientView, onRecorded }: Props) {
	const webcamRef = useRef<Webcam>(null);
	const mediaStreamRef = useRef<MediaStream | null>(null);
	const overlayRef = useRef<HTMLCanvasElement>(null);
	const rafRef = useRef<number | null>(null);
	const lastTickAtRef = useRef(0);
	const tickRef = useRef(0);
	const tickHzRef = useRef(0);
	const inferenceMsRef = useRef(0);

	const [streamAttached, setStreamAttached] = useState(false);
	const [cameraReady, setCameraReady] = useState(false);
	const [videoDimensions, setVideoDimensions] = useState<VideoDimensions>({ width: 0, height: 0, top: 0, left: 0 });
	const [isLandscape, setIsLandscape] = useState(
		() => typeof window !== "undefined" && window.innerWidth > window.innerHeight
	);
	const [showDebugHud, setShowDebugHud] = useState(true);
	const debugVisible = showDebugHud && !patientView;

	const [status, setStatus] = useState<MotorIssueCode>("PENDING");
	const [evaluation, setEvaluation] = useState<HandFrameEvaluation | null>(null);


	const [isRecording, setIsRecording] = useState(false);
	const isRecordingRef = useRef(false);
	useEffect(() => {
		isRecordingRef.current = isRecording;
	}, [isRecording]);

	const [recordingPhase, setRecordingPhase] = useState<RecordingPhase>("idle");
	const [countdown, setCountdown] = useState(-1);
	const [leadInInterrupted, setLeadInInterrupted] = useState(false);
	const postureBadSinceRef = useRef<number | null>(null);
	const postureGoodSinceRef = useRef<number | null>(null);
	const [phaseMessage, setPhaseMessage] = useState<string | null>(null);
	const [recordingTime, setRecordingTime] = useState(0);
	const [showBlinkingCircle, setShowBlinkingCircle] = useState(false);

	const recordedChunksRef = useRef<BlobPart[]>([]);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const recordingMimeTypeRef = useRef<string | null>(null);
	const hasFinishedRef = useRef(false);
	const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const phaseTimersRef = useRef<Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>>([]);
	const cameraReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// The detect loop is kicked off once and reads everything that can change through a
	// ref - same convention as TestGaitCamera's `detect`.
	const handModelRef = useRef(handModel);
	useEffect(() => {
		handModelRef.current = handModel;
	}, [handModel]);

	const checkAvailableRef = useRef(handModel.status === "ready");
	useEffect(() => {
		checkAvailableRef.current = handModel.status === "ready";
	}, [handModel.status]);

	const onRecordedRef = useRef(onRecorded);
	useEffect(() => {
		onRecordedRef.current = onRecorded;
	}, [onRecorded]);

	const calculateVideoDimensions = useCallback(() => {
		const videoElement = webcamRef.current?.video;
		if (!videoElement) return;
		const containerWidth = videoElement.clientWidth;
		const containerHeight = videoElement.clientHeight;
		const videoWidth = videoElement.videoWidth;
		const videoHeight = videoElement.videoHeight;
		if (videoWidth === 0 || videoHeight === 0) return;

		const videoRect = videoElement.getBoundingClientRect();
		const containerRatio = containerWidth / containerHeight;
		const videoRatio = videoWidth / videoHeight;

		let actualWidth: number, actualHeight: number, offsetTop: number, offsetLeft: number;
		if (videoRatio > containerRatio) {
			actualWidth = containerWidth;
			actualHeight = containerWidth / videoRatio;
			offsetTop = (containerHeight - actualHeight) / 2;
			offsetLeft = 0;
		} else {
			actualHeight = containerHeight;
			actualWidth = containerHeight * videoRatio;
			offsetTop = 0;
			offsetLeft = (containerWidth - actualWidth) / 2;
		}
		offsetTop += videoRect.top;
		offsetLeft += videoRect.left;

		setVideoDimensions((prev) => {
			const threshold = 2;
			const changed =
				Math.abs(prev.width - actualWidth) > threshold ||
				Math.abs(prev.height - actualHeight) > threshold ||
				Math.abs(prev.top - offsetTop) > threshold ||
				Math.abs(prev.left - offsetLeft) > threshold;
			if (!changed && prev.width !== 0) return prev;
			return { width: actualWidth, height: actualHeight, top: offsetTop, left: offsetLeft };
		});
	}, []);

	useEffect(() => {
		let resizeTimeout: ReturnType<typeof setTimeout>;
		const handleResize = () => {
			setIsLandscape(window.innerWidth > window.innerHeight);
			if (isRecordingRef.current) return;
			clearTimeout(resizeTimeout);
			resizeTimeout = setTimeout(() => calculateVideoDimensions(), 100);
		};
		window.addEventListener("resize", handleResize);
		window.addEventListener("orientationchange", handleResize);
		calculateVideoDimensions();
		return () => {
			window.removeEventListener("resize", handleResize);
			window.removeEventListener("orientationchange", handleResize);
			clearTimeout(resizeTimeout);
		};
	}, [calculateVideoDimensions]);

	useEffect(() => {
		if (!streamAttached) return;
		const videoElement = webcamRef.current?.video;
		if (!videoElement) return;

		const scheduleCameraReady = () => {
			if (videoElement.videoWidth === 0) return;
			if (cameraReadyTimeoutRef.current) clearTimeout(cameraReadyTimeoutRef.current);
			cameraReadyTimeoutRef.current = setTimeout(() => {
				cameraReadyTimeoutRef.current = null;
				setCameraReady(true);
			}, CAMERA_READY_STABILITY_DELAY_MS);
		};

		const handleLoadedMetadata = () => {
			calculateVideoDimensions();
			if (videoElement.videoWidth > 0) scheduleCameraReady();
		};

		videoElement.addEventListener("loadedmetadata", handleLoadedMetadata);
		if (videoElement.videoWidth > 0) {
			calculateVideoDimensions();
			scheduleCameraReady();
		}

		return () => {
			videoElement.removeEventListener("loadedmetadata", handleLoadedMetadata);
			if (cameraReadyTimeoutRef.current) {
				clearTimeout(cameraReadyTimeoutRef.current);
				cameraReadyTimeoutRef.current = null;
			}
		};
	}, [streamAttached, calculateVideoDimensions]);

	// Detect loop. Cancelled on unmount, unlike Website's, which left a rAF chain running
	// after the component went away.
	useEffect(() => {
		let cancelled = false;

		const tick = async () => {
			if (cancelled) return;

			const now = performance.now();
			if (now - lastTickAtRef.current < DETECT_TICK_INTERVAL_MS) {
				rafRef.current = requestAnimationFrame(tick);
				return;
			}
			if (lastTickAtRef.current !== 0) {
				const interval = now - lastTickAtRef.current;
				tickHzRef.current = 0.9 * tickHzRef.current + 0.1 * (1000 / interval);
			}
			lastTickAtRef.current = now;

			const model = handModelRef.current.model;
			const video = webcamRef.current?.video;
			const overlay = overlayRef.current;
			const { width: frameWidth, height: frameHeight } = videoDimensions;

			const runChecks = RUN_CHECKS_WHILE_RECORDING || !isRecordingRef.current;
			if (model && video && video.readyState === 4 && overlay && frameWidth > 0 && runChecks) {
				const overlayCtx = overlay.getContext("2d");
				if (overlayCtx) {
					// MediaPipe's VIDEO mode rejects a timestamp that does not strictly
					// increase, and throws rather than returning empty - which would take the
					// whole loop down. `now` is performance.now() and monotonic.
					const inferenceStartedAt = performance.now();
					const detected = detectHands(model, video, now, frameWidth, frameHeight);
					inferenceMsRef.current = performance.now() - inferenceStartedAt;

					// null means the pass threw, which is not the same as finding no hands -
					// leave the last answer standing rather than reporting BOTH_HANDS_MISSING.
					if (detected && !cancelled) {
						const frameEvaluation = evaluateHandFrame(detected, frameWidth, frameHeight);
						const reported = pushHandStatus(statusWindowRef.current, frameEvaluation.code);
						drawHandOverlay(overlayCtx, frameEvaluation.hands, frameWidth, frameHeight, debugVisible);

						recorderStateRef.current.backend = "mediapipe-gpu";
						recordMotorTick(recorderStateRef.current, {
							code: frameEvaluation.code,
							hands: frameEvaluation.hands,
							handGap: frameEvaluation.handGap,
							frameWidth,
							frameHeight,
							inferenceMs: inferenceMsRef.current,
							tickHz: tickHzRef.current,
						});

						const poseGood = frameEvaluation.code === "HANDS_READY";
						postureBadSinceRef.current = poseGood ? null : postureBadSinceRef.current ?? now;
						postureGoodSinceRef.current = poseGood ? postureGoodSinceRef.current ?? now : null;

						tickRef.current += 1;
						if (tickRef.current % HUD_UPDATE_EVERY_N_TICKS === 0) {
							setEvaluation(frameEvaluation);
							setStatus(reported);
						}
					}
				}
			}

			if (!cancelled) rafRef.current = requestAnimationFrame(tick);
		};

		rafRef.current = requestAnimationFrame(tick);
		return () => {
			cancelled = true;
			if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		};
	}, [videoDimensions, debugVisible, statusWindowRef, recorderStateRef]);

	// Sizing the overlay's backing store to the displayed box keeps drawing coordinates
	// and check coordinates in the same space.
	useEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay || videoDimensions.width === 0) return;
		overlay.width = Math.round(videoDimensions.width);
		overlay.height = Math.round(videoDimensions.height);
	}, [videoDimensions]);

	const startTimer = useCallback(() => {
		if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
		setRecordingTime(0);
		setShowBlinkingCircle(true);
		timerIntervalRef.current = setInterval(() => setRecordingTime((t) => t + 1), 1000);
	}, []);

	const stopTimer = useCallback(() => {
		if (timerIntervalRef.current) {
			clearInterval(timerIntervalRef.current);
			timerIntervalRef.current = null;
		}
		setRecordingTime(0);
		setShowBlinkingCircle(false);
	}, []);

	const clearPhaseTimers = useCallback(() => {
		phaseTimersRef.current.forEach((id) => {
			clearTimeout(id);
			clearInterval(id);
		});
		phaseTimersRef.current = [];
	}, []);

	const handleDataAvailable = useCallback(({ data }: BlobEvent) => {
		if (data.size > 0) recordedChunksRef.current.push(data);
	}, []);

	const finishRecording = useCallback(() => {
		if (hasFinishedRef.current) return;
		if (recordedChunksRef.current.length === 0) return;
		hasFinishedRef.current = true;

		const mimeType = recordingMimeTypeRef.current || getSupportedMimeType();
		const blob = new Blob(recordedChunksRef.current, { type: mimeType });
		recordedChunksRef.current = [];
		recordingMimeTypeRef.current = null;
		onRecordedRef.current(blob, mimeType);
	}, []);

	const beginRecording = useCallback(() => {
		const stream = mediaStreamRef.current;
		if (!stream || !stream.active || stream.getVideoTracks().length === 0) {
			setRecordingPhase("idle");
			return;
		}

		try {
			const mimeType = getSupportedMimeType();
			const settings = stream.getVideoTracks()[0].getSettings();
			const bitrate = calculateBitrate(settings.width || 1920, settings.height || 1080, settings.frameRate || 30);

			recordingMimeTypeRef.current = mimeType;
			const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
			recorder.addEventListener("dataavailable", handleDataAvailable);
			recorder.addEventListener("stop", finishRecording);
			recorder.start(1000);
			mediaRecorderRef.current = recorder;
		} catch (error) {
			console.error("[TestMotorCamera] Failed to start recording:", error);
			setRecordingPhase("idle");
			return;
		}

		setIsRecording(true);
		setLeadInInterrupted(false);
		setRecordingPhase("go");
		setPhaseMessage(GO_MESSAGE);
		startTimer();

		const goTimeout = setTimeout(() => {
			setPhaseMessage(null);
			setRecordingPhase("active");
		}, 1000);
		phaseTimersRef.current.push(goTimeout);
	}, [handleDataAvailable, finishRecording, startTimer]);

	const startCountdown = useCallback(() => {
		clearPhaseTimers();
		stopTimer();
		postureBadSinceRef.current = null;

		let countdownValue = LEAD_IN_COUNTDOWN_FROM;
		setRecordingPhase("leadIn");
		setPhaseMessage(null);
		setCountdown(countdownValue);

		const countdownIntervalId = setInterval(() => {
			if (countdownValue > 1) {
				countdownValue -= 1;
				setCountdown(countdownValue);
				return;
			}
			clearInterval(countdownIntervalId);
			setCountdown(-1);
			beginRecording();
		}, 1000);

		phaseTimersRef.current.push(countdownIntervalId);
	}, [clearPhaseTimers, stopTimer, beginRecording]);

	const cancelCountdown = useCallback(() => {
		clearPhaseTimers();
		postureGoodSinceRef.current = null;
		setCountdown(-1);
		setPhaseMessage(null);
		setLeadInInterrupted(true);
		setRecordingPhase("waiting");
	}, [clearPhaseTimers]);

	// Its own interval rather than a phase timer: startCountdown calls clearPhaseTimers,
	// which would otherwise kill the monitor driving it.
	useEffect(() => {
		if (recordingPhase !== "leadIn" && recordingPhase !== "waiting") return;

		const monitorId = setInterval(() => {
			const now = performance.now();
			if (recordingPhase === "leadIn") {
				const badSince = postureBadSinceRef.current;
				if (badSince !== null && now - badSince >= LEAD_IN_POSTURE_GRACE_MS) cancelCountdown();
				return;
			}
			// Fail open: with no detector nothing can ever clear the wait.
			if (!checkAvailableRef.current) {
				startCountdown();
				return;
			}
			const goodSince = postureGoodSinceRef.current;
			if (goodSince !== null && now - goodSince >= LEAD_IN_RESUME_HOLD_MS) startCountdown();
		}, LEAD_IN_MONITOR_INTERVAL_MS);

		return () => clearInterval(monitorId);
	}, [recordingPhase, cancelCountdown, startCountdown]);

	const handleStartRecording = useCallback(() => {
		if (!cameraReady) return;
		const stream = mediaStreamRef.current;
		if (!stream || !stream.active || stream.getVideoTracks().length === 0) return;
		setLeadInInterrupted(false);
		startCountdown();
	}, [cameraReady, startCountdown]);

	const handleStopRecording = useCallback(() => {
		clearPhaseTimers();
		stopTimer();
		setShowBlinkingCircle(false);
		setPhaseMessage(null);
		setCountdown(-1);
		setLeadInInterrupted(false);

		const recorder = mediaRecorderRef.current;
		if (recorder && recorder.state === "recording") {
			try {
				recorder.stop();
			} catch (error) {
				console.error("[TestMotorCamera] Failed to stop recording:", error);
				finishRecording();
			}
		}
		setIsRecording(false);
		setRecordingPhase("idle");
	}, [clearPhaseTimers, stopTimer, finishRecording]);

	useEffect(() => {
		return () => {
			clearPhaseTimers();
			if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
			if (cameraReadyTimeoutRef.current) clearTimeout(cameraReadyTimeoutRef.current);

			const recorder = mediaRecorderRef.current;
			if (recorder) {
				recorder.removeEventListener("dataavailable", handleDataAvailable);
				recorder.removeEventListener("stop", finishRecording);
				if (recorder.state !== "inactive") {
					try {
						recorder.stop();
					} catch {
						/* stream already gone */
					}
				}
			}

			mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
			mediaStreamRef.current = null;
		};
	}, [clearPhaseTimers, handleDataAvailable, finishRecording]);

	const checkAvailable = handModel.status === "ready";
	const isArmed = recordingPhase === "leadIn" || recordingPhase === "waiting";
	const showSetupUi = !isRecording;
	const showLeadIn = recordingPhase === "leadIn";
	const showGoCue = isRecording && recordingPhase === "go" && phaseMessage;
	const showStopwatch = isRecording && (recordingPhase === "go" || recordingPhase === "active");
	const guideColor = status === "HANDS_READY" ? GUIDE_OK_COLOR : GUIDE_BAD_COLOR;

	const overlayBox = {
		position: "fixed" as const,
		top: `${videoDimensions.top}px`,
		left: `${videoDimensions.left}px`,
		width: `${videoDimensions.width}px`,
		height: `${videoDimensions.height}px`,
		pointerEvents: "none" as const,
	};

	return (
		<div className="tm-camera-root">
			<style>{CSS}</style>

			{!isLandscape && (
				<div className="tm-rotate">
					<p className="tm-rotate-text">Rotate your phone to landscape</p>
				</div>
			)}

			<Webcam
				ref={webcamRef}
				audio={false}
				mirrored
				videoConstraints={VIDEO_CONSTRAINTS}
				style={{
					position: "absolute",
					top: "50%",
					left: "50%",
					transform: "translate(-50%, -50%)",
					width: "100%",
					height: "100%",
					objectFit: "contain",
					display: "block",
				}}
				onUserMedia={(stream) => {
					mediaStreamRef.current = stream;
					setStreamAttached(true);
					setTimeout(() => calculateVideoDimensions(), 100);
				}}
				onUserMediaError={(err) => {
					console.error("[TestMotorCamera] getUserMedia error:", err);
					mediaStreamRef.current = null;
					setStreamAttached(false);
					setCameraReady(false);
				}}
			/>

			{cameraReady && videoDimensions.width > 0 && showSetupUi && (
				<MotorTrackingGraphic hex={guideColor} style={{ ...overlayBox, zIndex: 50 }} />
			)}
			<canvas ref={overlayRef} style={{ ...overlayBox, zIndex: 51, display: showSetupUi ? "block" : "none" }} />

			{showSetupUi && (
				<div className="tm-setup-banner">
					<p className="tm-setup-title">
						Test {testNumber} of {totalTests}: {test.label}
					</p>
					<p className="tm-setup-line">{cameraReady ? test.instruction : "Loading camera..."}</p>
					{leadInInterrupted && (
						<p className="tm-setup-cue" role="status">
							Countdown stopped - fix the position below and it will start again
						</p>
					)}
				</div>
			)}

			{showSetupUi && checkAvailable && (
				<MotorGuidanceBanner
					code={status}
					okMessage={isArmed ? "Hold this position" : undefined}
					showDebugHud={debugVisible}
					onToggleDebugHud={() => setShowDebugHud((v) => !v)}
					hideDebugToggle={patientView}
					topOffsetPx={110}
				/>
			)}

			{showSetupUi && debugVisible && (
				<DebugHudStack topOffsetPx={175}>
					<MotorRecorderPanel stateRef={recorderStateRef} embedded />
					<MotorHandHud
						evaluation={evaluation}
						reported={status}
						modelReady={checkAvailable}
						tickHz={tickHzRef.current}
						inferenceMs={inferenceMsRef.current}
						embedded
					/>
				</DebugHudStack>
			)}

			<div className="tm-record-layer">
				{showBlinkingCircle && <div className="blinking-circle" />}
				{showLeadIn && countdown > 0 && (
					<div className="countdown-display" key={`count-${countdown}`}>
						{countdown}
					</div>
				)}
				{showGoCue && (
					<div className="countdown-display countdown-cue" key="go">
						{phaseMessage}
					</div>
				)}

				<div className="record-button-view">
					<div className="record-button-anchor">
						{showStopwatch && (
							<div className={`stopwatch${showBlinkingCircle ? " visible" : ""}`}>
								{Math.floor(recordingTime / 60).toString().padStart(2, "0")}:
								{(recordingTime % 60).toString().padStart(2, "0")}
							</div>
						)}
						{isRecording || isArmed ? (
							<div className="record-circle">
								<button
									type="button"
									onClick={handleStopRecording}
									className="stop-button"
									aria-label={isRecording ? "Stop recording" : "Cancel countdown"}
								/>
								<span className="tm-record-caption">{isRecording ? "Press to Stop" : "Press to Cancel"}</span>
							</div>
						) : (
							<div className="record-circle">
								<button
									type="button"
									onClick={handleStartRecording}
									className="record-button"
									disabled={!cameraReady}
									aria-label="Start recording"
									aria-busy={!cameraReady}
									style={!cameraReady ? { backgroundColor: "#b8b8b8", cursor: "not-allowed" } : undefined}
								>
									<span className="countdown-number">{LEAD_IN_COUNTDOWN_FROM}</span>
								</button>
								{!cameraReady && <span className="tm-record-caption">Loading camera...</span>}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

const CSS = `
	.tm-camera-root {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100dvh;
		overflow: hidden;
		touch-action: none;
		background: #000;
	}
	.tm-rotate {
		position: fixed;
		inset: 0;
		z-index: 9999;
		background: #000;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.tm-rotate-text { color: #fff; font-size: 1.1rem; font-weight: 700; text-align: center; padding: 0 1.5rem; }
	.tm-setup-banner {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 997;
		padding: max(0.75rem, env(safe-area-inset-top, 0px)) 1rem 0.6rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		background: linear-gradient(to bottom, rgba(28, 36, 52, 0.85) 0%, rgba(28, 36, 52, 0.6) 70%, transparent 100%);
	}
	.tm-setup-title { margin: 0; color: #fff; font-weight: 700; font-size: 0.95rem; text-shadow: 0 2px 4px rgba(0,0,0,0.3); }
	.tm-setup-cue { margin: 0; color: #fde68a; font-size: 0.85rem; font-weight: 700; text-align: center; }
	.tm-setup-line { margin: 0; color: #fff; font-size: 0.9rem; text-align: center; text-shadow: 0 2px 4px rgba(0,0,0,0.3); }
	.tm-record-layer { position: absolute; inset: 0; z-index: 999; pointer-events: none; }
	.tm-record-caption {
		position: absolute;
		top: 100%;
		margin-top: 0.5rem;
		width: max-content;
		left: 50%;
		transform: translateX(-50%);
		font-weight: 700;
		color: #fff;
		font-size: 0.85rem;
		white-space: nowrap;
	}
	.record-circle {
		width: 72px;
		height: 72px;
		border-radius: 50%;
		border: 3px solid white;
		display: flex;
		justify-content: center;
		align-items: center;
		pointer-events: auto;
		position: relative;
	}
	.record-button {
		width: 50px;
		height: 50px;
		border-radius: 50%;
		background-color: red;
		color: white;
		outline: none;
		cursor: pointer;
		border: none;
		display: flex;
		justify-content: center;
		align-items: center;
		touch-action: manipulation;
	}
	.stop-button {
		width: 28px;
		height: 28px;
		background-color: red;
		border: none;
		outline: none;
		cursor: pointer;
		border-radius: 5px;
		touch-action: manipulation;
	}
	.blinking-circle {
		position: absolute;
		opacity: 0.8;
		top: 24px;
		right: 30px;
		width: 15px;
		height: 15px;
		border-radius: 50%;
		background-color: red;
		animation: tm-blink 0.8s infinite;
	}
	@keyframes tm-blink {
		0% { opacity: 1; }
		50% { opacity: 0; }
		100% { opacity: 1; }
	}
	.countdown-number { font-size: 22px; font-weight: 500; color: white; }
	.countdown-display {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		font-size: clamp(4.5rem, 18vw, 6.5rem);
		color: white;
		font-weight: bold;
		z-index: 20;
		text-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
	}
	.countdown-cue { top: 36%; font-size: clamp(2.4rem, 10vw, 3.75rem); white-space: nowrap; }
	.stopwatch {
		position: absolute;
		left: 50%;
		bottom: 100%;
		margin-bottom: 0.75rem;
		transform: translateX(-50%) scale(0.9);
		z-index: 20;
		font-size: 18px;
		color: white;
		background: red;
		padding: 5px 10px;
		border-radius: 5px;
		opacity: 0;
		width: 76px;
		box-sizing: border-box;
		text-align: center;
		transition: opacity 0.3s ease, transform 0.3s ease;
		pointer-events: none;
	}
	.stopwatch.visible { opacity: 0.6; transform: translateX(-50%) scale(1); }
	.record-button-view {
		position: absolute;
		bottom: max(6vh, calc(0.75rem + env(safe-area-inset-bottom, 0px)));
		left: 50%;
		transform: translateX(-50%);
	}
	.record-button-anchor { width: 72px; height: 72px; position: relative; }
`;

export default TestMotorCamera;

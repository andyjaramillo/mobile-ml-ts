// [Feature: Test Gait]
//
// Mirrors WebsiteCode/Website/src/pages/MobilePage/MobileComponents/CameraRecording.tsx
// for one trial/take: camera preview + alignment overlay + live capture-quality checks
// during setup, then the real leadIn -> go -> active phase machine, a manual stop
// (FDA gait sets no autoStopSeconds), and a stopwatch. Deliberately narrower than the
// source: no device-compatibility gate, no iOS-stream-recovery machinery, no restart
// control (FDA gait never sets autoStopSeconds, so showsRestartControl is always false
// there) — see the mobile-ml-ts task report for the full faithful-vs-approximated list.
import { useCallback, useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";
import { AR_Detector } from "../aruco";
import useModel from "../model/useModel";
import { MARKER_BOARD } from "../CaptureQuality/captureQualityConfig";
import {
	pushMarkerBoardFrame,
	evaluateMarkerBoardFrame,
	evaluateMarkerBoardWindowAggregate,
} from "../CaptureQuality/markerBoardCheck";
import {
	pushLowLightFrame,
	evaluateLowLightFrame,
	evaluateLowLightWindowAggregate,
} from "../CaptureQuality/lowLightCheck";
import type { LowLightFrameMetrics } from "../CaptureQuality/lowLightCheck";
import type { CaptureQualityFrameSample } from "../CaptureQuality/types";
import { recordCaptureFrame } from "../CaptureQualityHud/captureRecorder";
import type { CaptureRecorderState } from "../CaptureQualityHud/captureRecorder";
import type { CaptureQualitySession } from "./useCaptureQualitySession";
import { getSupportedMimeType, calculateBitrate } from "./cameraUtils";
import {
	LEAD_IN_COUNTDOWN_FROM,
	GO_MESSAGE,
	MANUAL_STOP_HINT_DELAY_MS,
	RUN_CAPTURE_QUALITY_CHECKS_WHILE_RECORDING,
	HUD_UPDATE_EVERY_N_FRAMES,
	CAMERA_READY_STABILITY_DELAY_MS,
} from "./testGaitConfig";
import gaitOverlaySrc from "../assets/gait-clinic-animated-overlay.apng";

const EXPECTED_MARKER_IDS = new Set(MARKER_BOARD.expectedMarkerIds);

// Same reasoning as RealTimeProcessor.tsx's identically-named helper: the ArUco path
// draws through a contrast/brightness filter that would make lighting look artificially
// good, so lighting needs its own small unfiltered canvas. Duplicated here rather than
// shared because RealTimeProcessor.tsx is the frozen fast-iteration surface (task scope
// excludes touching it) and this is ~15 lines of pure math, not worth a coupling.
const LIGHTING_CANVAS_LONG_EDGE = 128;
const LIGHTING_CANVAS_MIN_SHORT_EDGE = 32;

function computeLightingCanvasSize(videoWidth: number, videoHeight: number): { width: number; height: number } {
	if (!(videoWidth > 0) || !(videoHeight > 0)) return { width: LIGHTING_CANVAS_LONG_EDGE, height: LIGHTING_CANVAS_MIN_SHORT_EDGE };
	const aspect = videoWidth / videoHeight;
	if (aspect >= 1) {
		return { width: LIGHTING_CANVAS_LONG_EDGE, height: Math.max(LIGHTING_CANVAS_MIN_SHORT_EDGE, Math.round(LIGHTING_CANVAS_LONG_EDGE / aspect)) };
	}
	return { width: Math.max(LIGHTING_CANVAS_MIN_SHORT_EDGE, Math.round(LIGHTING_CANVAS_LONG_EDGE * aspect)), height: LIGHTING_CANVAS_LONG_EDGE };
}

interface VideoDimensions {
	width: number;
	height: number;
	top: number;
	left: number;
}

type RecordingPhase = "idle" | "leadIn" | "go" | "active";

interface Props {
	trialNumber: number;
	totalTrials: number;
	captureQuality: CaptureQualitySession;
	captureRecorderStateRef: React.MutableRefObject<CaptureRecorderState>;
	onRecorded: (blob: Blob, mimeType: string) => void;
}

// FDA gait's camera_display block sets no preferLandscapeOrientation (orientation
// unconstrained) and no useFrontCamera (defaults to the rear/environment camera — a
// clinician records the patient, this isn't a selfie assessment).
const VIDEO_CONSTRAINTS = {
	width: 1920,
	height: 1080,
	facingMode: { ideal: "environment" as const },
	frameRate: { ideal: 30, max: 30 },
};

function TestGaitCamera({ trialNumber, totalTrials, captureQuality, captureRecorderStateRef, onRecorded }: Props) {
	const webcamRef = useRef<Webcam>(null);
	// Tracked separately from webcamRef so the unmount cleanup below can stop tracks
	// without reading webcamRef.current inside a cleanup closure (the DOM node it points
	// to isn't guaranteed stable by the time cleanup runs).
	const mediaStreamRef = useRef<MediaStream | null>(null);
	const lightingCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const fpsRef = useRef(0);
	const lastTimeRef = useRef(0);
	const tickRef = useRef(0);

	const [streamAttached, setStreamAttached] = useState(false);
	const [cameraReady, setCameraReady] = useState(false);
	const [videoDimensions, setVideoDimensions] = useState<VideoDimensions>({ width: 0, height: 0, top: 0, left: 0 });
	const [showOverlay, setShowOverlay] = useState(true);

	const [isRecording, setIsRecording] = useState(false);
	const isRecordingRef = useRef(false);
	useEffect(() => {
		isRecordingRef.current = isRecording;
	}, [isRecording]);

	const [recordingPhase, setRecordingPhase] = useState<RecordingPhase>("idle");
	const [countdown, setCountdown] = useState(-1);
	const [phaseMessage, setPhaseMessage] = useState<string | null>(null);
	const [recordingTime, setRecordingTime] = useState(0);
	const [showBlinkingCircle, setShowBlinkingCircle] = useState(false);
	const [showManualStopHint, setShowManualStopHint] = useState(false);

	const recordedChunksRef = useRef<BlobPart[]>([]);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const recordingMimeTypeRef = useRef<string | null>(null);
	const hasFinishedRef = useRef(false);
	const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const phaseTimersRef = useRef<Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>>([]);
	const cameraReadyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

	// Skip recalculation during recording — same convention as Website's CameraRecording
	// resize handler ("Skip recalculation during recording for maximum performance"),
	// read from a ref rather than the isRecording state so this effect never needs to
	// resubscribe mid-take.
	useEffect(() => {
		let resizeTimeout: ReturnType<typeof setTimeout>;
		const handleResize = () => {
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

	const startTimer = useCallback(() => {
		if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
		setRecordingTime(0);
		setShowBlinkingCircle(true);
		timerIntervalRef.current = setInterval(() => {
			setRecordingTime((t) => t + 1);
		}, 1000);
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

	// leadIn -> go -> active. FDA gait sets no autoStopSeconds/completionMessage, so
	// unlike Website's general-purpose version this never reaches a "complete" phase —
	// active just runs until the user taps stop.
	const startGuidedSequence = useCallback(() => {
		clearPhaseTimers();
		stopTimer();

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
			setRecordingPhase("go");
			setPhaseMessage(GO_MESSAGE);
			startTimer();

			const goTimeout = setTimeout(() => {
				setPhaseMessage(null);
				setRecordingPhase("active");
			}, 1000);
			phaseTimersRef.current.push(goTimeout);
		}, 1000);

		phaseTimersRef.current.push(countdownIntervalId);
	}, [clearPhaseTimers, stopTimer, startTimer]);

	useEffect(() => {
		const leadInDone = recordingPhase === "go" || recordingPhase === "active";
		if (!isRecording || !leadInDone) {
			setShowManualStopHint(false);
			return;
		}
		const hintTimeout = window.setTimeout(() => setShowManualStopHint(true), MANUAL_STOP_HINT_DELAY_MS);
		return () => window.clearTimeout(hintTimeout);
	}, [isRecording, recordingPhase]);

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

	const handleStartRecording = useCallback(() => {
		if (!cameraReady) return;
		const stream = mediaStreamRef.current;
		if (!stream || !stream.active || stream.getVideoTracks().length === 0) return;

		try {
			const mimeType = getSupportedMimeType();
			const track = stream.getVideoTracks()[0];
			const settings = track.getSettings();
			const width = settings.width || VIDEO_CONSTRAINTS.width;
			const height = settings.height || VIDEO_CONSTRAINTS.height;
			const frameRate = settings.frameRate || 30;
			const bitrate = calculateBitrate(width, height, frameRate);

			recordingMimeTypeRef.current = mimeType;
			const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
			recorder.addEventListener("dataavailable", handleDataAvailable);
			recorder.addEventListener("stop", finishRecording);
			// 1s timeslice — mirrors Website's CameraRecording (avoids memory pressure / encoding lag).
			recorder.start(1000);
			mediaRecorderRef.current = recorder;

			setIsRecording(true);
			setShowOverlay(false);
			startGuidedSequence();
		} catch (error) {
			console.error("[TestGaitCamera] Failed to start recording:", error);
		}
	}, [cameraReady, handleDataAvailable, finishRecording, startGuidedSequence]);

	const handleStopRecording = useCallback(() => {
		clearPhaseTimers();
		stopTimer();
		setShowBlinkingCircle(false);
		setPhaseMessage(null);
		setCountdown(-1);

		const recorder = mediaRecorderRef.current;
		if (recorder && recorder.state === "recording") {
			try {
				recorder.stop();
			} catch (error) {
				console.error("[TestGaitCamera] Failed to stop recording:", error);
				finishRecording();
			}
		}
		setIsRecording(false);
		setRecordingPhase("idle");
	}, [clearPhaseTimers, stopTimer, finishRecording]);

	// Camera + MediaRecorder teardown on unmount (trial advance / rerecord / leaving Test
	// Gait). Every dep here is a stable (empty-array) useCallback, so this effect body
	// never re-runs mid-take — only its cleanup fires, exactly once, on unmount.
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

	// Detect loop: intentionally not memoized, matching RealTimeProcessor.tsx's own
	// convention (useModel's rAF kickoff reads whichever closure was current when
	// modelCaller first became available; everything this closure needs that can change
	// over time is read through a ref, not a render-time value). Same known rAF leak as
	// RealTimeProcessor/useModel.tsx — out of scope here (see task notes), not
	// introduced by this file.
	const detect = async () => {
		const video = webcamRef.current?.video;
		if (modelCaller && video && video.readyState === 4 && video.videoWidth > 0 && video.videoHeight > 0 && hiddenRef.current) {
			const arDetector = modelCaller as AR_Detector;
			const startTimeMs = performance.now();

			const now = performance.now();
			if (lastTimeRef.current !== 0) {
				const delta = now - lastTimeRef.current;
				fpsRef.current = Math.round(0.9 * fpsRef.current + 0.1 * (1000 / delta));
			}
			lastTimeRef.current = now;

			const hiddenInputW = Math.min(640, video.videoWidth);
			const hiddenInputH = Math.round(hiddenInputW * (video.videoHeight / video.videoWidth));
			hiddenRef.current.width = hiddenInputW;
			hiddenRef.current.height = hiddenInputH;

			const offCtx = hiddenRef.current.getContext("2d", { willReadFrequently: true });
			if (offCtx) {
				offCtx.filter = "contrast(2) brightness(1.1)";
				offCtx.drawImage(video, 0, 0, hiddenInputW, hiddenInputH);
				const imageData = offCtx.getImageData(0, 0, hiddenInputW, hiddenInputH);
				const unfilteredMarkers = await arDetector.detectImage(imageData);
				const markers = unfilteredMarkers.filter((m: { id: number }) => EXPECTED_MARKER_IDS.has(m.id));

				// Run marker-board/lighting checks only pre-recording (see
				// RUN_CAPTURE_QUALITY_CHECKS_WHILE_RECORDING in testGaitConfig.ts).
				const runChecks = RUN_CAPTURE_QUALITY_CHECKS_WHILE_RECORDING || !isRecordingRef.current;
				if (runChecks) {
					const session = captureQuality.stateRef.current;
					const captureFrame: CaptureQualityFrameSample = {
						imageData: null,
						timestampMs: startTimeMs,
						frameWidth: hiddenInputW,
						frameHeight: hiddenInputH,
						people: null,
						markers,
					};
					pushMarkerBoardFrame(session.markerBoardWindow, captureFrame);

					let lightingMetrics: LowLightFrameMetrics | null = null;
					if (!lightingCanvasRef.current) lightingCanvasRef.current = document.createElement("canvas");
					const lightingCanvas = lightingCanvasRef.current;
					const { width: lightW, height: lightH } = computeLightingCanvasSize(video.videoWidth, video.videoHeight);
					if (lightingCanvas.width !== lightW || lightingCanvas.height !== lightH) {
						lightingCanvas.width = lightW;
						lightingCanvas.height = lightH;
					}
					const lightCtx = lightingCanvas.getContext("2d", { willReadFrequently: true });
					if (lightCtx) {
						lightCtx.drawImage(video, 0, 0, lightW, lightH);
						const lightingImageData = lightCtx.getImageData(0, 0, lightW, lightH);
						const lightingFrame: CaptureQualityFrameSample = {
							imageData: lightingImageData,
							timestampMs: startTimeMs,
							frameWidth: lightW,
							frameHeight: lightH,
							people: null,
							markers: null,
						};
						pushLowLightFrame(session.lowLightWindow, lightingFrame);
						lightingMetrics = evaluateLowLightFrame(lightingFrame, session.lowLightConfig);
					}

					tickRef.current += 1;
					if (tickRef.current % HUD_UPDATE_EVERY_N_FRAMES === 0) {
						captureQuality.setMarkerBoardAggregate(
							evaluateMarkerBoardWindowAggregate(
								session.markerBoardWindow.frames,
								session.markerBoardConfig,
								session.markerBoardWindow.persistence,
								session.markerBoardWindow.hysteresis
							)
						);
						captureQuality.setLowLightAggregate(
							evaluateLowLightWindowAggregate(session.lowLightWindow.frames, session.lowLightConfig)
						);
					}

					recordCaptureFrame(captureRecorderStateRef.current, {
						fps: fpsRef.current,
						frameWidth: hiddenInputW,
						frameHeight: hiddenInputH,
						metrics: evaluateMarkerBoardFrame(captureFrame, session.markerBoardConfig),
						lighting: lightingMetrics,
					});
				}
			}
		}
		requestAnimationFrame(detect);
	};

	const { modelCaller, hiddenRef } = useModel(detect, "aruco");

	const showRecordUi = !isRecording;
	const showLeadIn = isRecording && recordingPhase === "leadIn";
	const showGoCue = isRecording && recordingPhase === "go" && phaseMessage;
	const showStopwatch = isRecording && (recordingPhase === "go" || recordingPhase === "active");

	return (
		<div className="tg-camera-root">
			<style>{CSS}</style>
			<Webcam
				ref={webcamRef}
				audio={false}
				mirrored={false}
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
					console.error("[TestGaitCamera] getUserMedia error:", err);
					mediaStreamRef.current = null;
					setStreamAttached(false);
					setCameraReady(false);
				}}
			/>
			<canvas ref={hiddenRef} style={{ display: "none" }} />

			{!isRecording && (
				<div className="tg-setup-banner">
					<p className="tg-setup-title">Trial {trialNumber} of {totalTrials}</p>
					{cameraReady ? (
						<>
							<p className="tg-setup-line">Align your camera to match the guide below</p>
							<p className="tg-setup-line tg-setup-line--muted">When aligned, press the red button to start recording</p>
						</>
					) : (
						<p className="tg-setup-line">Loading camera…</p>
					)}
					{cameraReady && (
						<button
							type="button"
							className="tg-overlay-toggle"
							onClick={() => setShowOverlay((v) => !v)}
						>
							{showOverlay ? "Hide guide" : "Show guide"}
						</button>
					)}
				</div>
			)}

			{cameraReady && videoDimensions.width > 0 && showOverlay && showRecordUi && (
				<div
					style={{
						position: "fixed",
						top: `${videoDimensions.top}px`,
						left: `${videoDimensions.left}px`,
						width: `${videoDimensions.width}px`,
						height: `${videoDimensions.height}px`,
						zIndex: 50,
						pointerEvents: "none",
					}}
				>
					<img
						src={gaitOverlaySrc}
						alt=""
						style={{
							position: "absolute",
							top: 0,
							left: "50%",
							width: "auto",
							height: "100%",
							maxWidth: "none",
							maxHeight: "100%",
							objectFit: "contain",
							pointerEvents: "none",
							transform: "translateX(-50%)",
							opacity: 0.6,
						}}
					/>
				</div>
			)}

			<div className="tg-record-layer">
				{showBlinkingCircle && <div className="blinking-circle" />}
				{showLeadIn && (
					<div className="countdown-stack">
						{countdown > 0 && <div className="countdown-display" key={`count-${countdown}`}>{countdown}</div>}
					</div>
				)}
				{showGoCue && (
					<div className="countdown-display countdown-cue" key="go">{phaseMessage}</div>
				)}

				<div className="record-button-view">
					<div className="record-button-anchor">
						{showStopwatch && (
							<div className={`stopwatch elapsed-stopwatch${showBlinkingCircle ? " visible" : ""}`}>
								{Math.floor(recordingTime / 60).toString().padStart(2, "0")}:
								{(recordingTime % 60).toString().padStart(2, "0")}
							</div>
						)}
						{isRecording ? (
							<div className="record-circle">
								<button type="button" onClick={handleStopRecording} className="stop-button" aria-label="Stop recording" />
								<span className="tg-record-caption">Press to Stop</span>
								<div className={`manual-stop-hint${showManualStopHint ? " is-visible" : ""}`} aria-hidden={!showManualStopHint}>
									<span className="manual-stop-hint__arrow" aria-hidden>&larr;</span>
									<span className="manual-stop-hint__text">Tap the button when the patient has finished walking.</span>
								</div>
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
								{!cameraReady && <span className="tg-record-caption">Loading camera…</span>}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

const CSS = `
	.tg-camera-root {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100dvh;
		overflow: hidden;
		touch-action: none;
		background: #000;
	}
	.tg-setup-banner {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 997;
		padding-top: max(1rem, env(safe-area-inset-top, 0px));
		padding-left: 1rem;
		padding-right: 1rem;
		padding-bottom: 0.75rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		background: linear-gradient(to bottom, rgba(28, 36, 52, 0.85) 0%, rgba(28, 36, 52, 0.6) 70%, transparent 100%);
	}
	.tg-setup-title { margin: 0; color: #fff; font-weight: 700; font-size: 0.95rem; text-shadow: 0 2px 4px rgba(0,0,0,0.3); }
	.tg-setup-line { margin: 0; color: #fff; font-size: 0.95rem; text-align: center; text-shadow: 0 2px 4px rgba(0,0,0,0.3); }
	.tg-setup-line--muted { color: rgba(255,255,255,0.9); font-size: 0.875rem; }
	.tg-overlay-toggle {
		margin-top: 0.25rem;
		min-height: 36px;
		padding: 0 0.75rem;
		border-radius: 8px;
		border: 1px solid rgba(255,255,255,0.3);
		background: rgba(255,255,255,0.15);
		color: #fff;
		font-size: 0.8rem;
		touch-action: manipulation;
		cursor: pointer;
	}
	.tg-record-layer {
		position: absolute;
		inset: 0;
		z-index: 999;
		pointer-events: none;
	}
	.tg-record-caption {
		position: absolute;
		top: 100%;
		margin-top: 0.5rem;
		width: max-content;
		left: 50%;
		transform: translateX(-50%);
		text-align: center;
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
		color: white;
		border: none;
		outline: none;
		cursor: pointer;
		border-radius: 5px;
		touch-action: manipulation;
	}
	.blinking-circle {
		position: absolute;
		opacity: 0.8;
		top: 100px;
		right: 30px;
		width: 15px;
		height: 15px;
		border-radius: 50%;
		background-color: red;
		animation: tg-blink 0.8s infinite;
	}
	@keyframes tg-blink {
		0% { opacity: 1; }
		50% { opacity: 0; }
		100% { opacity: 1; }
	}
	.countdown-number {
		font-size: 22px;
		font-weight: 500;
		color: white;
	}
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
		animation: tg-countdown-pop 0.4s ease;
	}
	.countdown-stack { position: absolute; inset: 0; z-index: 20; pointer-events: none; }
	.countdown-cue {
		top: 36%;
		font-size: clamp(2.4rem, 10vw, 3.75rem);
		letter-spacing: 0.02em;
		white-space: nowrap;
		animation: tg-countdown-fade 0.45s ease;
	}
	@keyframes tg-countdown-pop {
		0% { opacity: 0; transform: translate(-50%, -50%) scale(0.72); }
		55% { opacity: 1; transform: translate(-50%, -50%) scale(1.08); }
		100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
	}
	@keyframes tg-countdown-fade {
		0% { opacity: 0; transform: translate(-50%, calc(-50% + 0.35rem)); }
		100% { opacity: 1; transform: translate(-50%, -50%); }
	}
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
	.manual-stop-hint {
		position: absolute;
		left: calc(100% + 0.55rem);
		top: 50%;
		transform: translateY(-50%) translateX(0.35rem);
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: min(48vw, 11.5rem);
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.45s ease, transform 0.45s ease;
		z-index: 5;
	}
	.manual-stop-hint.is-visible { opacity: 1; transform: translateY(-50%) translateX(0); }
	.manual-stop-hint__text {
		color: #fff;
		font-size: clamp(0.95rem, 3.8vw, 1.1rem);
		font-weight: 600;
		line-height: 1.25;
		text-align: left;
		text-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
	}
	.manual-stop-hint__arrow {
		flex-shrink: 0;
		color: #fff;
		font-size: 1.35rem;
		line-height: 1;
		text-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
	}
	.record-button-view {
		position: absolute;
		top: 85%;
		left: 50%;
		transform: translate(-50%, -50%);
	}
	.record-button-anchor {
		width: 72px;
		height: 72px;
		position: relative;
	}
	@media (orientation: landscape) {
		.record-button-view {
			top: auto;
			bottom: max(14vh, calc(0.75rem + env(safe-area-inset-bottom, 0px)));
			left: 50%;
			transform: translateX(-50%);
		}
	}
`;

export default TestGaitCamera;

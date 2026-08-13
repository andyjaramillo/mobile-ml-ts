import { useRef, useEffect, useState, type ChangeEvent } from "react";
import Webcam from "react-webcam";
import { PoseLandmarker, ObjectDetector } from "@mediapipe/tasks-vision";
import { AR_Detector } from "./aruco";
import {drawArucoMarkerIds} from "./warnings/drawing_utils";
import { useNotify } from "./warnings/Notification";
import Sampler from "./detections/sampler"
import useModel from "./model/useModel";
import { DEFAULTS as CAPTURE_QUALITY_DEFAULTS, MARKER_BOARD } from "./CaptureQuality/captureQualityConfig";
import {
  createMarkerBoardFrameWindow,
  defaultMarkerBoardCheckConfig,
  evaluateMarkerBoardFrame,
  evaluateMarkerBoardWindowAggregate,
  pushMarkerBoardFrame,
  resetMarkerBoardFrameWindow,
} from "./CaptureQuality/markerBoardCheck";
import type { MarkerBoardWindowAggregate } from "./CaptureQuality/markerBoardCheck";
import {
  createLowLightFrameWindow,
  defaultLowLightCheckConfig,
  evaluateLowLightFrame,
  evaluateLowLightWindowAggregate,
  pushLowLightFrame,
  resetLowLightFrameWindow,
} from "./CaptureQuality/lowLightCheck";
import type { LowLightWindowAggregate } from "./CaptureQuality/lowLightCheck";
import type { CaptureQualityFrameSample } from "./CaptureQuality/types";
import MarkerBoardHud from "./CaptureQualityHud/MarkerBoardHud";
import LowLightHud from "./CaptureQualityHud/LowLightHud";
import RecorderPanel from "./CaptureQualityHud/RecorderPanel";
import GuidanceBanner from "./CaptureQualityHud/GuidanceBanner";
import { createCaptureRecorderState, recordCaptureFrame } from "./CaptureQualityHud/captureRecorder";

const EXPECTED_MARKER_IDS = new Set(MARKER_BOARD.expectedMarkerIds);
const HUD_UPDATE_EVERY_N_FRAMES = 3; // throttle React state updates off the ~25-30fps detect loop

// The ArUco path (below) reads its ImageData through `offCtx.filter =
// "contrast(2) brightness(1.1)"` before drawImage/getImageData - deliberately boosted to
// help marker detection. Measuring lighting on that data would report a room
// considerably brighter/higher-contrast than it actually is, defeating the point of the
// check (see lowLightCheck.ts header), so lighting needs its own UNFILTERED draw. A
// second full-resolution getImageData (~640x1138 for the recorded portrait captures) is
// too expensive to do a second time per frame on a phone - instead this draws to a tiny
// dedicated canvas. LONG_EDGE=128 keeps an 8x8 grid cell at roughly 16px on the long
// axis (and >=MIN_SHORT_EDGE/8 ~= 4px on the short axis, more realistically ~9-16px for
// the aspect ratios this camera actually produces) - enough pixels per cell for a stable
// mean/std (see evaluateLowLightFrame's numerical-stability comment), while the total
// pixel count (at most ~128*128, typically ~128*72) stays two orders of magnitude below
// the detector's own 640-wide canvas, so the extra drawImage+getImageData pair is cheap.
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

const RealTimeProcessor = () => {
  const webcamRef = useRef(null);
  const canvasRef = useRef(null);
  
  const lastTimeRef = useRef(0);
  const fpsRef = useRef(0);
  
  const [facingMode, setFacingMode] = useState("user"); // "user" or "environment"
  // Debug HUD (MarkerBoardHud/LowLightHud, the developer-chip panels) defaults ON here to
  // preserve this page's existing calibration workflow; GuidanceBanner (patient-facing,
  // always shown) carries its own toggle so it can be flipped off to see the patient view.
  const [showDebugHud, setShowDebugHud] = useState(true);

  
  const [videoDimensions, setVideoDimensions] = useState({
    width: 1920,
    height: 1080,
    top: 0, left: 0
  })

  const notif = useNotify();
  // sampler for setup checks (collects frames and runs analysis)
  const samplerRef = useRef(null);

  // marker-board capture-quality check: caller-owned bounded window + throttled HUD state
  const markerBoardConfigRef = useRef(defaultMarkerBoardCheckConfig(CAPTURE_QUALITY_DEFAULTS));
  const markerBoardWindowRef = useRef(createMarkerBoardFrameWindow(CAPTURE_QUALITY_DEFAULTS.sampling.liveWindowFrameCount));
  const markerBoardTickRef = useRef(0);
  const [markerBoardAggregate, setMarkerBoardAggregate] = useState<MarkerBoardWindowAggregate | null>(null);

  // lighting capture-quality check: same caller-owned-window pattern as marker board,
  // but its own window/config/tick counter since it runs off a separate unfiltered
  // canvas (see computeLightingCanvasSize above) rather than the detector's own frames.
  const lowLightConfigRef = useRef(defaultLowLightCheckConfig(CAPTURE_QUALITY_DEFAULTS));
  const lowLightWindowRef = useRef(createLowLightFrameWindow(CAPTURE_QUALITY_DEFAULTS.sampling.liveWindowFrameCount));
  const lightingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [lowLightAggregate, setLowLightAggregate] = useState<LowLightWindowAggregate | null>(null);

  // Capture-quality data recorder: mutated every aruco tick (recordCaptureFrame is a
  // no-op unless recording), independent of the HUD's throttled aggregate updates -
  // decimation for the size cap happens inside the recorder itself, not here.
  const captureRecorderStateRef = useRef(createCaptureRecorderState());




  function calculateVideoDimensions(videoElement) {
    const containerWidth = videoElement.clientWidth;
    const containerHeight = videoElement.clientHeight;
    const videoWidth = videoElement.videoWidth;
    const videoHeight = videoElement.videoHeight;

    //    if (videoWidth === 0 || videoHeight === 0) return;

    // Get the video element's actual position on screen
    const videoRect = videoElement.getBoundingClientRect();
    console.log('Video element rect:', videoRect);

    // Calculate the scale factor for objectFit: contain
    const containerRatio = containerWidth / containerHeight;
    const videoRatio = videoWidth / videoHeight;

    let actualWidth, actualHeight, offsetTop, offsetLeft;

    if (videoRatio > containerRatio) {
      // Video is wider - letterbox on top/bottom
      actualWidth = containerWidth;
      actualHeight = containerWidth / videoRatio;
      offsetTop = (containerHeight - actualHeight) / 2;
      offsetLeft = 0;
    } else {
      // Video is taller - letterbox on left/right
      actualHeight = containerHeight;
      actualWidth = containerHeight * videoRatio;
      offsetTop = 0;
      offsetLeft = (containerWidth - actualWidth) / 2;
    }

    // Add the video element's position to get absolute positioning
    offsetTop += videoRect.top;
    offsetLeft += videoRect.left;

    // Only update if dimensions changed significantly (> 2px threshold)
    // This prevents constant rerenders on mobile from minor video adjustments
    const threshold = 2;
    const changed =
      Math.abs(videoDimensions.width - actualWidth) > threshold ||
      Math.abs(videoDimensions.height - actualHeight) > threshold ||
      Math.abs(videoDimensions.top - offsetTop) > threshold ||
      Math.abs(videoDimensions.left - offsetLeft) > threshold;
    console.log('calculated video dimensions:', actualWidth, actualHeight, offsetTop, offsetLeft, 'changed:', changed);
    if (isNaN(actualWidth) || isNaN(actualHeight)) {
      setVideoDimensions({
        width: videoElement.clientWidth,
        height: videoElement.clientHeight,
        top: videoRect.top,
        left: videoRect.left
      });

    }
    else if (changed || videoDimensions.width === 0) {
      console.log('Setting video dimensions:', { actualWidth, actualHeight, offsetTop, offsetLeft });
      setVideoDimensions({
        width: actualWidth,
        height: actualHeight,
        top: offsetTop,
        left: offsetLeft
      });

    }
    // console.log("12",actualWidth, actualHeight)
    if (canvasRef.current.width !== actualWidth) {
      canvasRef.current.width = actualWidth;
      canvasRef.current.height = actualHeight;
    }
  }

  useEffect(() => {
    let resizeTimeout;

    const handleResize = () => {
      // Debounce to prevent excessive recalculations on mobile
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        calculateVideoDimensions(webcamRef.current.video);
      }, 100);
    };

    window.addEventListener('resize', handleResize);
    calculateVideoDimensions(webcamRef.current.video); // Initial size

    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimeout);
    };
  }, []);

  useEffect(() => {
    const videoElement = webcamRef.current?.video;
    if (!videoElement) return;

    const handleLoadedMetadata = () => {
      console.log('Video metadata loaded:', {
        clientWidth: videoElement.clientWidth,
        clientHeight: videoElement.clientHeight,
      });
      calculateVideoDimensions(webcamRef.current.video);
    };

    // videoElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    // Check if already loaded
    videoElement.addEventListener('loadeddata', handleLoadedMetadata);
    if (videoElement.videoWidth > 0) {
      calculateVideoDimensions(webcamRef.current.video);
    }

    return () => {
      videoElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      videoElement.removeEventListener('loadeddata', handleLoadedMetadata);
    };
  }, [webcamRef.current]);

  const detect = async () => {
    if (
      modelCaller &&
      webcamRef.current &&
      webcamRef.current.video.readyState === 4
    ) {
      const video = webcamRef.current.video;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        requestAnimationFrame(detect);
        return;
      }

      if (video.videoWidth === 0 || video.videoHeight === 0) {
        requestAnimationFrame(detect);
        return;
      }

     
      // --- FPS Calculation ---
      const now = performance.now();
      if (lastTimeRef.current !== 0) {
        const delta = now - lastTimeRef.current;
        // Simple smoothing: 0.9 old value, 0.1 new value
        fpsRef.current = Math.round(0.9 * fpsRef.current + 0.1 * (1000 / delta));
      }
      lastTimeRef.current = now;

      const startTimeMs = performance.now();
      if (modelType === "pose") {
        const poseLandmarker = modelCaller as PoseLandmarker;
        const results = poseLandmarker.detectForVideo(video, startTimeMs);
        results.close?.();

      } else if (modelType === "object") {
        const objectDetector = modelCaller as ObjectDetector;
        objectDetector.detectForVideo(video, startTimeMs);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } else if (modelType === "aruco") {
        const arDetector = modelCaller as AR_Detector;
        const hiddeninputW = Math.min(640, video.videoWidth);
        const hiddeninputH = Math.round(hiddeninputW * (video.videoHeight / video.videoWidth));

        hiddenRef.current.width = hiddeninputW;
        hiddenRef.current.height = hiddeninputH;

        const offCtx = hiddenRef.current.getContext('2d', { willReadFrequently: true });
        offCtx.filter = 'contrast(2) brightness(1.1)';
        // offCtx.scale(-1, 1);
        offCtx.drawImage(video, 0, 0, hiddeninputW, hiddeninputH);

        const imageData = offCtx.getImageData(0, 0, hiddeninputW, hiddeninputH);
        const unfiltered_markers = await arDetector.detectImage(imageData);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const markers = unfiltered_markers.filter((m) => EXPECTED_MARKER_IDS.has(m.id));

        // sample for lighting and multi-person checks
        try {
        if (!samplerRef.current) samplerRef.current = new Sampler(hiddenRef, () => fpsRef.current, notif, ['aruco']);
        samplerRef.current?.sampleAruco?.(imageData, video, markers);
        } catch (e) {
          console.warn('sampler (aruco) error', e);
        }

        // Capture-quality marker-board check. frameWidth/frameHeight here MUST stay in
        // the same coordinate space as marker.corners (the detector's own input
        // resolution) - mixing in the video element's CSS display size here is the
        // exact bug markerBoardCheck.ts was written to fix.
        const captureFrame: CaptureQualityFrameSample = {
          imageData: null,
          timestampMs: startTimeMs,
          frameWidth: hiddeninputW,
          frameHeight: hiddeninputH,
          people: null,
          markers,
        };
        pushMarkerBoardFrame(markerBoardWindowRef.current, captureFrame);
        markerBoardTickRef.current += 1;
        if (markerBoardTickRef.current % HUD_UPDATE_EVERY_N_FRAMES === 0) {
          setMarkerBoardAggregate(
            evaluateMarkerBoardWindowAggregate(
              markerBoardWindowRef.current.frames,
              markerBoardConfigRef.current,
              markerBoardWindowRef.current.persistence,
              markerBoardWindowRef.current.hysteresis
            )
          );
        }

        // Lighting check: unfiltered draw to its own tiny canvas - see the
        // computeLightingCanvasSize comment above for why this must not reuse offCtx
        // (which is contrast/brightness-boosted for marker detection).
        let lightingMetrics = null;
        if (!lightingCanvasRef.current) lightingCanvasRef.current = document.createElement('canvas');
        const lightingCanvas = lightingCanvasRef.current;
        const { width: lightW, height: lightH } = computeLightingCanvasSize(video.videoWidth, video.videoHeight);
        if (lightingCanvas.width !== lightW || lightingCanvas.height !== lightH) {
          lightingCanvas.width = lightW;
          lightingCanvas.height = lightH;
        }
        const lightCtx = lightingCanvas.getContext('2d', { willReadFrequently: true });
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
          pushLowLightFrame(lowLightWindowRef.current, lightingFrame);
          lightingMetrics = evaluateLowLightFrame(lightingFrame, lowLightConfigRef.current);
          if (markerBoardTickRef.current % HUD_UPDATE_EVERY_N_FRAMES === 0) {
            setLowLightAggregate(
              evaluateLowLightWindowAggregate(lowLightWindowRef.current.frames, lowLightConfigRef.current)
            );
          }
        }

        recordCaptureFrame(captureRecorderStateRef.current, {
          fps: fpsRef.current,
          frameWidth: hiddeninputW,
          frameHeight: hiddeninputH,
          metrics: evaluateMarkerBoardFrame(captureFrame, markerBoardConfigRef.current),
          lighting: lightingMetrics,
        });

       drawArucoMarkerIds(ctx, video.clientWidth, video.clientHeight, markers, hiddeninputW, hiddeninputH)
      }


      


      // 2. Draw FPS Overlay
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)"; // Semi-transparent black background
      ctx.fillRect(10, 10, 100, 40);
      ctx.font = "bold 20px Arial";
      ctx.fillStyle = "#00FF00"; // Green text
      ctx.fillText(`FPS: ${fpsRef.current}`, 20, 38);



    }
    requestAnimationFrame(detect);
  };


  const {modelType, setModelType, hiddenRef, modelCaller} = useModel(detect, "pose");

  useEffect(() => {
    // A trial/mode boundary: don't let stale marker-board frames from a previous
    // aruco session (or a different modelType entirely) leak into a fresh window.
    if (modelType === "aruco") {
      resetMarkerBoardFrameWindow(markerBoardWindowRef.current);
      markerBoardTickRef.current = 0;
      setMarkerBoardAggregate(null);
      resetLowLightFrameWindow(lowLightWindowRef.current);
      setLowLightAggregate(null);
    }
  }, [modelType]);



  return (

    <div
      style={{
        width: "100%",
        height: "100%"
      }}
    >
      {/* {!landmarker && (
        <div style={{ textAlign: "center", paddingTop: "20%" }}>
          <p>Loading Pose Model...</p>
        </div>
      )}
       */}
      <Webcam
        ref={webcamRef}
        audio={false}
        style={{
          width: "100%",
          height: "100%",

          zIndex: 1,
        }}
        mirrored={facingMode == "user"}
        videoConstraints={{
          width: 1920,
          height: 1080,
          facingMode: { ideal: facingMode },
          aspectRatio: window.innerHeight / window.innerWidth,
          frameRate: { ideal: 30, max: 30 },
        }}
        onUserMedia={() => {
          // Recalculate dimensions when camera starts
          setTimeout(() => calculateVideoDimensions(webcamRef.current.video), 100);
        }}
      />
      <select
        style={{
          zIndex: 100,
          position: "absolute",
          top: `${0}px`,
          left: `${0}px`,
        }}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => setModelType(e.target.value as "pose" | "object" | "aruco")}
        value={modelType}
      >
        <option value="pose">Pose Landmarker</option>
        <option value="object">Object Detector</option>
        <option value="aruco">ArUco Marker Detector</option>
      </select>

      <select
        style={{
          zIndex: 100,
          position: "absolute",
          top: `0px`,
          right: `0px`,
        }}
        onChange={(e) => { setFacingMode(e.target.value); setTimeout(() => calculateVideoDimensions(webcamRef.current.video), 100); }}
        value={facingMode}
      >
        <option value="environment">Environment (rear)</option>
        <option value="user">User (front)</option>
      </select>

   
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          top: `${videoDimensions.top}px`,
          left: `${videoDimensions.left}px`,
          width: `${videoDimensions.width}px`,
          height: `${videoDimensions.height}px`,
          zIndex: 2,
          pointerEvents: "none", // Allows clicking "through" the canvas if needed
       //   transform: facingMode === "user" ? "scaleX(-1)" : "none",
        }}
      />
       <canvas
         ref={hiddenRef}
         key={modelType === "pose" || modelType == "object" ? "hidden-gpu" : "hidden-cpu"}
         style={{
                display: "none",
                position: 'absolute',
                top: `${videoDimensions.top}px`,
                left: `${videoDimensions.left}px`,
                width: `${videoDimensions.width}px`,
                height: `${videoDimensions.height}px`,
            }}
       />
       {modelType === "aruco" && (
         <>
           <GuidanceBanner
             markerBoardAggregate={markerBoardAggregate}
             lowLightAggregate={lowLightAggregate}
             markerBoardConfig={markerBoardConfigRef.current}
             showDebugHud={showDebugHud}
             onToggleDebugHud={() => setShowDebugHud((v) => !v)}
             topOffsetPx={40}
           />
           {showDebugHud && (
             <>
               <MarkerBoardHud aggregate={markerBoardAggregate} config={markerBoardConfigRef.current} />
               <LowLightHud aggregate={lowLightAggregate} config={lowLightConfigRef.current} />
             </>
           )}
           <RecorderPanel stateRef={captureRecorderStateRef} topOffsetPx={104} />
         </>
       )}
    </div>

  );
};

export default RealTimeProcessor;
import React, { useRef, useEffect, useState } from "react";
import Webcam from "react-webcam";
import { PoseLandmarker, FilesetResolver, DrawingUtils, ObjectDetector } from "@mediapipe/tasks-vision";
import { AR_Detector } from "./aruco";
import {drawArucoMarkerIds, drawArucoMarkers, drawBoundingBoxes, drawPose} from "./warnings/drawing_utils";
import { useNotify } from "./warnings/Notification";
import Sampler from "./detections/sampler"



const App = () => {
  const webcamRef = useRef(null);
  const canvasRef = useRef(null);
  const drawingUtilsRef = useRef<DrawingUtils | null>(null);
  const lastTimeRef = useRef(0);
  const fpsRef = useRef(0);
  const [modelType, setModelType] = useState("pose"); // "pose" or "object"
  const [facingMode, setFacingMode] = useState("user"); // "user" or "environment"

  const [modelCaller, setModelCaller] = useState<PoseLandmarker | ObjectDetector | AR_Detector | null>(null);
  const hiddenRef = useRef(null);
  const [videoDimensions, setVideoDimensions] = useState({
    width: 1920,
    height: 1080,
    top: 0, left: 0
  })

  const notif = useNotify();
  // sampler for setup checks (collects frames and runs analysis)
  const samplerRef = useRef(null);

  useEffect(() => {
    let disposed = false;
    let activePoseLandmarker: PoseLandmarker | null = null;
    let activeObjectDetector: ObjectDetector | null = null;

    drawingUtilsRef.current?.close();
    drawingUtilsRef.current = null;
    setModelCaller(null);

    if (modelType === "pose") {
      const setupLandmarker = async () => {
        if (!hiddenRef.current) return;

        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );
        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          canvas: hiddenRef.current,
          numPoses: 1,
        });
        if (disposed) {
          poseLandmarker.close();
          return;
        }
        activePoseLandmarker = poseLandmarker;
        setModelCaller(poseLandmarker);
      };
      setupLandmarker();
    } else if (modelType === "object") {

      const setupDetector = async () => {
        if (!hiddenRef.current) return;

        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );

        const objectDetector = await ObjectDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          canvas: hiddenRef.current,
          scoreThreshold: 0.5,
        });
        if (disposed) {
          objectDetector.close();
          return;
        }
        activeObjectDetector = objectDetector;
        setModelCaller(objectDetector);
      };
      setupDetector()
    } else if (modelType === "aruco") {
      const arucoDetetor = new AR_Detector();
      setModelCaller(arucoDetetor);
    }

    return () => {
      disposed = true;
      activePoseLandmarker?.close();
      activeObjectDetector?.close();
      drawingUtilsRef.current?.close();
      drawingUtilsRef.current = null;
    };
  }, [modelType]);


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

        drawPose(ctx,canvas,hiddenRef, drawingUtilsRef, results)
        results.close?.();

      } else if (modelType === "object") {
        const objectDetector = modelCaller as ObjectDetector;
        const results = objectDetector.detectForVideo(video, startTimeMs);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        
       
        const detections = results.detections.filter((detect_) => detect_.categories[0].categoryName  == "person")
        drawBoundingBoxes(canvas, video, ctx, detections, facingMode, hiddenRef, drawingUtilsRef)
 
   
      } else if (modelType === "aruco") {
        const hiddeninputW = Math.min(640, video.videoWidth);
        const hiddeninputH = Math.round(hiddeninputW * (video.videoHeight / video.videoWidth));

        hiddenRef.current.width = hiddeninputW;
        hiddenRef.current.height = hiddeninputH;

        const offCtx = hiddenRef.current.getContext('2d', { willReadFrequently: true });
        offCtx.filter = 'contrast(2) brightness(1.1)';
        // offCtx.scale(-1, 1);
        offCtx.drawImage(video, 0, 0, hiddeninputW, hiddeninputH);

        const imageData = offCtx.getImageData(0, 0, hiddeninputW, hiddeninputH);
        const unfiltered_markers = await modelCaller.detectImage(imageData);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let markers = []
        for(let i =0; i < unfiltered_markers.length; i++){
           if (unfiltered_markers[i].id >= 0 && unfiltered_markers[i].id <= 8) {
           markers.push(unfiltered_markers[i])
          }
        }

        // sample for lighting and multi-person checks
        try {
        if (!samplerRef.current) samplerRef.current = new Sampler(hiddenRef, () => fpsRef.current, notif, ['aruco']);
        samplerRef.current && samplerRef.current.sampleAruco && samplerRef.current.sampleAruco(imageData, video, markers, canvas);
        } catch (e) {
          console.warn('sampler (aruco) error', e);
        }
      
       //drawArucoMarkers(ctx, video.clientWidth, video.clientHeight, markers, hiddeninputW, hiddeninputH);
      // drawArucoMarkerIds(ctx, video.clientWidth, video.clientHeight, markers, hiddeninputW, hiddeninputH)
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


  

  useEffect(() => {
    if (modelCaller) {
      const animationId = requestAnimationFrame(detect);
      return () => cancelAnimationFrame(animationId);
    }
  }, [modelCaller]);

  // initialize OpenCV (async)
  useEffect(() => {
    (async () => {
      try {
       // await ensureOpenCV();
        console.log('OpenCV initialized (if available)');
      } catch (e) {
        console.warn('OpenCV initialization failed', e);
      }
    })();
  }, []);

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
        onUserMedia={(stream) => {
          const track = stream.getVideoTracks()[0];
          const settings = track.getSettings();


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
        onChange={(e) => setModelType(e.target.value)}
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
    </div>

  );
};

export default App;
import { DrawingUtils, FilesetResolver, ObjectDetector, PoseLandmarker } from "@mediapipe/tasks-vision";
import { useEffect, useRef, useState } from "react";
import { AR_Detector } from "../aruco";

function useModel(onLoad, modelT: "pose" | "object" | "aruco"){
    const [modelCaller, setModelCaller] = useState<PoseLandmarker | ObjectDetector | AR_Detector | null>(null);
    const [modelType, setModelType] = useState(modelT); // "pose" or "object"
    const drawingUtilsRef = useRef<DrawingUtils | null>(null);
    const hiddenRef = useRef(null);
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
  



      

  useEffect(() => {
    if (modelCaller) {
      const animationId = requestAnimationFrame(onLoad);
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

  return {modelType, setModelType, hiddenRef, modelCaller, drawingUtilsRef}

}

export default useModel


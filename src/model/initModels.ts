import { FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";
import { AR_Detector } from "../aruco";
async function preloadWasmGlue(wasmBase: string): Promise<void> {
  const g = globalThis as Record<string, unknown>
  if (g.ModuleFactory) return
  for (const name of ['vision_wasm_internal.js', 'vision_wasm_nosimd_internal.js']) {
    try {
      const res = await fetch(`${wasmBase}/${name}`)
      if (!res.ok) continue
      const src = await res.text()
      ;(0, eval)(src) // indirect eval: global scope, sets self.ModuleFactory
      if (g.ModuleFactory) return
    } catch {
      /* try next variant */
    }
  }
}
export async function initObjectDetector(hiddenCanvas: OffscreenCanvas) {
  const res = await preloadWasmGlue("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm")
  const vision =  await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  )
  // const path = vision.wasmLoaderPath;
  // const response = await fetch(path);
  // (0, eval)(await response.text());
  // delete (vision as any).wasmLoaderPath;

    const object_detector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 
          "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite"
          ,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      canvas: hiddenCanvas,
      scoreThreshold: 0.5,
    });
    return object_detector
  

 
}

export function initArucoDetector() {
  return new AR_Detector();
}

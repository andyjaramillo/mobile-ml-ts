//imports for a worker thread
// importScripts("demuxer_mp4.js");
// importScripts("./model/initModels")
// importScripts("./warnings/2SubjectNotAtStart")
// importScripts("./processors/subject_start")
import {MP4Demuxer} from "./demuxer_mp4"
// import * as SubjectNotAtStart from "./warnings/2SubjectNotAtStart";
import SubjectNotAtStart from "./warnings/2SubjectNotAtStart";
import { initArucoDetector, initObjectDetector } from "./model/initModels";
import { subject_start } from "./processors/subject_start";

let renderer = null;
let startTime = null;
let pendingStatus = null;
let pendingFrame = null;
let frameCount = 0;

const method_map = {
  subject_start,
};

class Canvas2DRenderer {
  #canvas = null;
  #ctx = null;
  constructor(canvas) {
    this.#canvas = canvas;
    this.#ctx =canvas.getContext("2d", { willReadFrequently: true });
  }
  draw(frame) {
    // this.#canvas.width = frame.displayWidth;
    // this.#canvas.height = frame.displayHeight;
    this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    this.#ctx.translate(this.#canvas.width, 0);
    this.#ctx.rotate(Math.PI / 2);
    this.#ctx.drawImage(frame, 0, 0, this.#canvas.width, this.#canvas.height);
    this.#ctx.restore();
    frame.close();
  }
}

function setStatus(type, message) {
  if (pendingStatus) {
    pendingStatus[type] = message;
 
  } else {
    pendingStatus = { [type]: message };
    
    self.requestAnimationFrame(statusAnimationFrame);
  }
}

function statusAnimationFrame() {
  self.postMessage(pendingStatus);
  pendingStatus = null;
}

function renderFrame(frame) {

  if (!pendingFrame) {
    requestAnimationFrame(renderAnimationFrame);
    
  } else{
    pendingFrame.close();
  }
  pendingFrame = frame;
 
  
}

function renderAnimationFrame() {
  renderer.draw(pendingFrame);
  pendingFrame = null;
}

async function initPipeline(displayCanvas) {
  const objectCanvas = new OffscreenCanvas(480, 808);
 const objectDetector = await initObjectDetector(objectCanvas)   

  return {
    arDetector: initArucoDetector(),
    objectDetector: objectDetector,
    displayCanvas,
    st: new SubjectNotAtStart(),
    notif: {
      warning: (message) => self.postMessage({ type: "warning", message }),
    },
  };
}

async function start({ dataUri, canvasOff, method, hyperparameters }) {

  renderer = new Canvas2DRenderer(canvasOff);
 let pipelineCtx  = await initPipeline(canvasOff);
    const offctx = canvasOff.getContext("2d", { willReadFrequently: true });
  const runFrame = method_map[method];
  let current_frame_count = 0;
  if (!runFrame) {
    throw new Error(`Unknown processor: ${method}`);
  }

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      if (startTime == null) {
        startTime = performance.now();
      } else {
        const elapsed = (performance.now() - startTime) / 1000; // in seconds
        current_frame_count += 1
        const fps = ++frameCount / elapsed;
       //  setStatus("fps", `${elapsed},${fps}`)
        if( frame.timestamp / 1000000 >= hyperparameters.max_pre_video_check){
            frame.close();
            decoder.close(); 
            return;
        }
        //renderFrame(frame);
        runFrame({ ...pipelineCtx, frame, current_frame_count, offctx }).then((status) => {
           
        }).catch((e) =>
          setStatus("process", String(e))
        );
       
      }

      
    },
    error(e) {
      setStatus("decode", e);
    },
  });

  const demuxer = new MP4Demuxer(dataUri, {
    onConfig(config) {
      setStatus("decode", `${config.codec} @ ${config.codedWidth}x${config.codedHeight}`);
      decoder.configure(config);
    },
    onChunk(chunk) {
      decoder.decode(chunk);
    },
    onEndOfStream() {
        setStatus("end", true);
      decoder.flush();
    },
    setStatus,
  });
  
}

self.addEventListener("message", (message) => start(message.data), { once: true });

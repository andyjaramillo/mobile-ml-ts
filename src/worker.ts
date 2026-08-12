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

let startTime = null;
let pendingStatus = null;

const method_map = {
  subject_start,
};

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

 const pipelineCtx  = await initPipeline(canvasOff);
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
        current_frame_count += 1
        if( frame.timestamp / 1000000 >= hyperparameters.max_pre_video_check){
            frame.close();
            decoder.close();
            return;
        }
        runFrame({ ...pipelineCtx, frame, current_frame_count, offctx }).then((_status) => {

        }).catch((e) =>
          setStatus("process", String(e))
        );
       
      }

      
    },
    error(e) {
      setStatus("decode", e);
    },
  });

  new MP4Demuxer(dataUri, {
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

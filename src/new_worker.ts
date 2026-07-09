import { initArucoDetector, initObjectDetector } from "./model/initModels";
import { subject_start2 } from "./processors/subject_start";
import SubjectNotAtStart from "./warnings/2SubjectNotAtStart";


let canvas = null;
let videoref = null;
let hyperparameters = null;
let frame_count = 0;
let mainMethod = null;
let pipelineCtx = null;
const method_map = {
    subject_start2,
  };
  

async function initPipeline(displayCanvas) {
    const objectCanvas = new OffscreenCanvas(640, 480);
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

function frame_callback(now, metadata){
    if(metadata.mediaTime > hyperparameters.max_pre_video_check){
        self.postMessage({
            "end": true
        })
        return
    }
    canvas?.getContext("2d").drawImage(videoref.current, 0, 0, canvas.width, canvas.height);

    const offCtx = pipelineCtx.hiddenCanvas.getContext("2d", { willReadFrequently: true });
    if (!offCtx) return;
  
    offCtx.filter = "contrast(2) brightness(1.1)";
    const imageData = offCtx.getImageData(0, 0, canvas.width, canvas.height);
    mainMethod({ ...pipelineCtx, imageData, frame_count }).then((status) => {
            
    }).catch((e) =>
      setStatus("process", String(e))
    );

}
  

async function start({ pipelineCtx, imageData }) {
    let current_frame_count = 0
    mainMethod({ ...pipelineCtx, imageData, current_frame_count }).then((status) => {
            
    }).catch((e) =>
      setStatus("process", String(e))
    );
    
  }




self.addEventListener("message", (message) => start(message.data), { once: true });

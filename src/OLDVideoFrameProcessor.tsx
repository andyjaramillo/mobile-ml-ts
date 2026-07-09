import React, { useEffect, useRef, useState } from "react";
import { initArucoDetector, initObjectDetector } from "./model/initModels";
import SubjectNotAtStart from "./warnings/2SubjectNotAtStart";
import { subject_start2 } from "./processors/subject_start";


const HYPERPARAMETERS = {
    max_pre_video_check: 2 // 2 seconds
}




function VideoFrameProcessor(){

    const [file, setFile] = useState(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const videoRef = useRef<HTMLVideoElement>(null);
    const data = useRef([])
    const [numberOfValidFrames, setNumberOfValidFrames] = useState([]);
    const pipelineCtx = useRef(null);
    const canvasOffRef = useRef(null);
    const workerRef = useRef(null);
    function recordStatus(message){
        console.log(message.data)
    }

    function frame_callback(now, metadata){
        console.log("FRAME LOADED")
        canvasOffRef.current?.getContext("2d").drawImage(videoRef.current, 0, 0, canvasOffRef.current.width, canvasOffRef.current.height);
    
        const offCtx = pipelineCtx.hiddenCanvas.getContext("2d", { willReadFrequently: true });
        if (!offCtx) return;
      
        offCtx.filter = "contrast(2) brightness(1.1)";
        const imageData = offCtx.getImageData(0, 0, canvasOffRef.current.width, canvasOffRef.current.height);
        workerRef.current.postMessage({ pipelineCtx, imageData,  }, [pipelineCtx.current])
        videoRef.current.requestVideoFrameCallback(frame_callback);
    }

    useEffect(() => {
        if(file != null){
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
              initPipeline(canvasOffRef.current).then((pipeline) => {
                pipelineCtx.current = pipeline
                console.log("PIPELINE LOADED")
                const reader = new FileReader();
                reader.onload = () => {
                 canvasOffRef.current = canvasRef.current?.transferControlToOffscreen();
                 console.log("MODEL LOADED")
                  const dataUri = reader.result as string;
                 
                  videoRef.current.src = dataUri;
    
                  workerRef.current = new Worker(new URL('./new_worker.ts', import.meta.url), {type: "module"})
                  workerRef.current.addEventListener("message", recordStatus);
                  console.log("PREPARING FRAMES")
                  videoRef.current.requestVideoFrameCallback(frame_callback);
                  
                };
                reader.readAsDataURL(file);
              })
           

        }
    },[file])

    return (
        <>
        <input type="file" onChange={(e) =>  setFile(e.target.files?.[0] ?? null)}/>
        <video ref={videoRef} width={480} height={640}/>
        <canvas ref={canvasRef} style={{display: 'none'}} width={480} height={640}/>
       
        {
            numberOfValidFrames.length != 0  && numberOfValidFrames.map(json_obj => {
                <p>{json_obj}</p>
            })
            
        }

        </>
    )
}

export default VideoFrameProcessor;
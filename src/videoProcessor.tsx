import React, { useEffect, useRef, useState } from "react";
import SubjectNotAtStart from "./warnings/2SubjectNotAtStart";
import useModel from "./model/useModel";

const HYPERPARAMETERS = {
    max_pre_video_check: 2 // 2 seconds
}

function VideoProcessor(){
    const [file, setFile] = useState(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const data = useRef([])
    const [numberOfValidFrames, setNumberOfValidFrames] = useState([]);
     
    function recordStatus(message) {
        if ("end" in Object.keys(message.data)){
            //last frame. display the data
            setNumberOfValidFrames(data.current)
        }
        else if(message.data){
            data.current.push(message.data["frame_result"])
            console.log(message.data)
        } 
       
        
    }


    
    useEffect(() => {
        if(file != null){
            const reader = new FileReader();
            reader.onload = () => {
                
              const dataUri = reader.result as string;
              const canvasOff = canvasRef.current?.transferControlToOffscreen();
     
              const worker = new Worker(new URL('./worker.ts', import.meta.url), {type: "module"})
              worker.addEventListener("message", recordStatus);
              
              worker.postMessage({ dataUri, canvasOff, method: "subject_start", hyperparameters: HYPERPARAMETERS }, [canvasOff])
            };
            reader.readAsDataURL(file);
        }
    },[file])
    return (
        <>
        <input type="file" onChange={(e) =>  setFile(e.target.files?.[0] ?? null)}/>
 
        <canvas ref={canvasRef} width={480} height={808}/>
       
        {
            numberOfValidFrames.length != 0  && numberOfValidFrames.map(json_obj => {
                <p>{json_obj}</p>
            })
            
        }

        </>
    )
}

export default VideoProcessor;
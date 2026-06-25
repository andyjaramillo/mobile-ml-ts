import React, { useEffect, useRef, useState } from "react";



function VideoProcessor(){
    const [file, setFile] = useState(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [data,setData] = useState(null)
    function setStatus(message) {
        console.log(message.data)
        setData(message.data)
    }
    useEffect(() => {
        if(file != null){
            const reader = new FileReader();
            reader.onload = () => {
                
              const dataUri = reader.result as string;
              const canvasOff = canvasRef.current?.transferControlToOffscreen();
             
              const worker = new Worker(new URL('./worker.ts', import.meta.url))
              worker.addEventListener("message", setStatus);
              worker.postMessage({dataUri, canvasOff}, [canvasOff])
            };
            reader.readAsDataURL(file);
        }
    },[file])
    return (
        <>
        <input type="file" onChange={(e) =>  setFile(e.target.files?.[0] ?? null)}/>

        <canvas ref={canvasRef} width={480} height={640}/>
       

        </>
    )
}

export default VideoProcessor;
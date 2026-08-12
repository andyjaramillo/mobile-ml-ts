
import { useState, type ChangeEvent } from 'react';
import RealTimeProcessor from './RealTimeProcessor.tsx'
import VideoProcessor from './videoProcessor.tsx'


function App(){
    const [camera_orientation, setCameraOrientation] = useState<"user" |"environment">("user")
    const [pre_or_real, setPreOrReal] = useState<"pre" | "real">("pre")

    return (
     <div style={{ display: "flex", flexDirection: "column", gap: "16px", alignItems: "left" }}>

    <select style={{ display: "flex", flexDirection: "column" }} value={camera_orientation} onChange={(e: ChangeEvent<HTMLSelectElement>) => {setCameraOrientation(e.target.value as "user" | "environment")}}>
        <option value={"user"}>Front</option>
        <option value={"environment"}>Back</option>
    </select>

    <select style={{ display: "flex", flexDirection: "column" }} value={pre_or_real} onChange={(e: ChangeEvent<HTMLSelectElement>) => {setPreOrReal(e.target.value as "pre" | "real")}}>
        <option value={"pre"}>Upload Video</option>
        <option value={"real"}>Real Time Detection</option>
    </select>

    {
       pre_or_real == "real" &&
       <div style={{ display: "flex", flexDirection: "column" }}>
            <RealTimeProcessor/>
        </div>
    }
    {
        pre_or_real == "pre" && 
        <div style={{ display: "flex", flexDirection: "column" }}>
            <VideoProcessor/>
        </div>
    }

</div>
    )
}

export default App;
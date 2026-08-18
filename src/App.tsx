
import { useState, type ChangeEvent } from 'react';
import RealTimeProcessor from './RealTimeProcessor.tsx'
import VideoProcessor from './videoProcessor.tsx'
import TestGait from './TestGait/TestGait.tsx'


function App(){
    const [camera_orientation, setCameraOrientation] = useState<"user" |"environment">("user")
    const [pre_or_real, setPreOrReal] = useState<"pre" | "real" | "testgait" | "testgait-official">("pre")

    return (
     <div style={{ display: "flex", flexDirection: "column", gap: "16px", alignItems: "left" }}>

    {pre_or_real !== "testgait" && pre_or_real !== "testgait-official" && (
    <select style={{ display: "flex", flexDirection: "column" }} value={camera_orientation} onChange={(e: ChangeEvent<HTMLSelectElement>) => {setCameraOrientation(e.target.value as "user" | "environment")}}>
        <option value={"user"}>Front</option>
        <option value={"environment"}>Back</option>
    </select>
    )}

    <select style={{ display: "flex", flexDirection: "column" }} value={pre_or_real} onChange={(e: ChangeEvent<HTMLSelectElement>) => {setPreOrReal(e.target.value as "pre" | "real" | "testgait" | "testgait-official")}}>
        <option value={"pre"}>Upload Video</option>
        <option value={"real"}>Real Time Detection</option>
        <option value={"testgait"}>Test Gait (debug)</option>
        <option value={"testgait-official"}>Test Gait Official</option>
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
    {
        pre_or_real == "testgait" &&
        <TestGait/>
    }
    {
        /* Exactly what a clinician sees: same checks, same cadence, no debug surfaces.
           Same component as above so the two can never drift apart. */
        pre_or_real == "testgait-official" &&
        <TestGait patientView/>
    }

</div>
    )
}

export default App;
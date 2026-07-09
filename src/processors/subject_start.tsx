import SubjectNotAtStart from "../warnings/2SubjectNotAtStart";
import { AR_Detector } from "../aruco";
import { ObjectDetector } from "@mediapipe/tasks-vision";
import { drawArucoMarkerIds } from "../warnings/drawing_utils";

export type SubjectStartCtx = {
  current_frame_count: number;
  frame: VideoFrame;
  arDetector: AR_Detector;
  objectDetector: ObjectDetector;
  offctx;
  st: SubjectNotAtStart;
  notif: { warning: (message: string) => void };
};

export async function subject_start(ctx: SubjectStartCtx) {
  const { current_frame_count, frame, arDetector, objectDetector,offctx, st, notif } = ctx;


  
  if (!offctx) return;
 
//   offCtx.filter = "contrast(2) brightness(1.1)";
offctx.save();
offctx.clearRect(0, 0, 480, 808);
offctx.translate(480, 0);
offctx.rotate(Math.PI / 2);
// After 90° CW, draw as H×W so the full frame scales into the 480×808 canvas
offctx.drawImage(frame, 0, 0, 808, 480);
offctx.restore();
 

  const imageData = offctx.getImageData(0, 0, 480, 808);
  const unfiltered_markers = await arDetector.detectImage(imageData);

  const markers = [];
  for (let i = 0; i < unfiltered_markers.length; i++) {
    if (unfiltered_markers[i].id >= 0 && unfiltered_markers[i].id <= 8) {
      markers.push(unfiltered_markers[i]);
    }
  }
  

  const results = objectDetector.detectForVideo(imageData, performance.now());
  const detections = results.detections.filter(
    (detect_) => detect_.categories[0].categoryName === "person"
  );

  return st.trigger(
    offctx,
    detections,
    notif,
    arDetector.findCentroidFromMarkers(markers),
    current_frame_count
  );
}


export async function subject_start2(ctx: SubjectStartCtx) {
    const { frame_count,imageData, arDetector, objectDetector, displayCanvas, st, notif } = ctx;
    const unfiltered_markers = await arDetector.detectImage(imageData);
  
    const markers = [];
    for (let i = 0; i < unfiltered_markers.length; i++) {
      if (unfiltered_markers[i].id >= 0 && unfiltered_markers[i].id <= 8) {
        markers.push(unfiltered_markers[i]);
      }
    }
    
  
    const results = objectDetector.detectForVideo(imageData, performance.now());
    const detections = results.detections.filter(
      (detect_) => detect_.categories[0].categoryName === "person"
    );
  
    return st.trigger(
      { width: displayCanvas.width, height: displayCanvas.height },
      detections,
      notif,
      arDetector.findCentroidFromMarkers(markers),
      frame_count
    );
  }
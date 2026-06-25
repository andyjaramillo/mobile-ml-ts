import { DrawingUtils, PoseLandmarker } from "@mediapipe/tasks-vision";


function drawArucoMarkers(canvasContext: CanvasRenderingContext2D, videoWidth: number, videoHeight: number, markers: any[], inputW: number, inputH: number) {
  for (let i = 0; i < markers.length; i++) {
    console.log("Marker ID: " + markers[i].id + ", Hamming Distance: " + markers[i].hammingDistance);

    const marker = markers[i];
    canvasContext.beginPath();
    //scale corners to the new width and height 

    marker.corners = marker.corners.map(corner => {
      return {
        x: (corner.x / inputW) * videoWidth,
        y: (corner.y / inputH) * videoHeight
      }
    });


    canvasContext.beginPath();
    canvasContext.moveTo(marker.corners[0].x, marker.corners[0].y);
    for (let j = 1; j < marker.corners.length; j++) {
      canvasContext.lineTo(marker.corners[j].x, marker.corners[j].y);
    }
    canvasContext.closePath();
    canvasContext.lineWidth = 4;
    canvasContext.strokeStyle = "red";
    canvasContext.stroke();

  }


}

function drawArucoMarkerIds(
  canvasContext: CanvasRenderingContext2D,
  videoWidth: number,
  videoHeight: number,
  markers: any[],
  inputW: number,
  inputH: number
) {
  for (const marker of markers) {
    const corners = marker.corners;
    let cx = 0;
    let cy = 0;
    for (const corner of corners) {
      cx += corner.x;
      cy += corner.y;
    }
    cx = ((cx / corners.length) / inputW) * videoWidth;
    cy = ((cy / corners.length) / inputH) * videoHeight;

    const label = String(marker.id);
    canvasContext.font = "bold 18px Arial";
    canvasContext.textAlign = "center";
    canvasContext.textBaseline = "middle";

    const metrics = canvasContext.measureText(label);
    const pad = 4;
    canvasContext.fillStyle = "rgba(0, 0, 0, 0.55)";
    canvasContext.fillRect(
      cx - metrics.width / 2 - pad,
      cy - 9 - pad,
      metrics.width + pad * 2,
      18 + pad * 2
    );

    canvasContext.fillStyle = "yellow";
    canvasContext.fillText(label, cx, cy);
  }
}

function drawLineWithArrow(canvas, x1, y1, x2, y2, label?: string) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const headLength = 12;
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.strokeStyle = 'lime';
    ctx.fillStyle = 'lime';
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
        x2 - headLength * Math.cos(angle - Math.PI / 6),
        y2 - headLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
        x2 - headLength * Math.cos(angle + Math.PI / 6),
        y2 - headLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();

    if (label) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        ctx.font = 'bold 16px Arial';
        ctx.fillStyle = 'lime';
        ctx.fillText(label, mx + 8, my - 8);
    }
}

function ensureDrawingUtils(ctx: CanvasRenderingContext2D, hiddenRef, drawingUtilsRef) {
  const gpuGl = hiddenRef.current?.getContext("webgl2") as WebGL2RenderingContext | null;
  if (!drawingUtilsRef.current && gpuGl) {
    drawingUtilsRef.current = new DrawingUtils(ctx, gpuGl);
  } else if (!drawingUtilsRef.current) {
    drawingUtilsRef.current = new DrawingUtils(ctx);
  }
  return drawingUtilsRef.current;
}



function drawBoundingBoxes(canvas, video, ctx, detections, facingMode, hiddenRef, drawingUtilsRef){
  const scaleX = canvas.width / video.videoWidth;
  const scaleY = canvas.height / video.videoHeight;
  const drawingUtils = ensureDrawingUtils(ctx, hiddenRef, drawingUtilsRef);
  const mirrorX = facingMode === "user";

  for (const detection of detections) {
    if(detection.categories[0].categoryName  != "person") continue;
    const { originX, originY, width, height, angle } = detection.boundingBox;
    const box = {
      originX: originX * scaleX,
      originY: originY * scaleY,
      width: width * scaleX,
      height: height * scaleY,
      angle,
    };

    ctx.save();
    if (mirrorX) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    drawingUtils.drawBoundingBox(box, {
      color: "#00FF00",
      lineWidth: 3,
      fillColor: "transparent",
    });
    ctx.restore();

    const category = detection.categories[0];
    const score = Math.round(category.score * 100);
    const labelText = `${category.categoryName} - ${score}%`;
    const labelX = mirrorX ? canvas.width - box.originX - box.width : box.originX;

    ctx.font = "bold 16px Arial";
    const textWidth = ctx.measureText(labelText).width;
    ctx.fillStyle = "rgba(0, 255, 0, 0.8)";
    ctx.fillRect(labelX, box.originY - 25, textWidth + 10, 25);
    ctx.fillStyle = "#000000";
    ctx.fillText(labelText, labelX + 5, box.originY - 7);
  }
}

function drawPose(ctx,canvas,hiddenRef, drawingUtilsRef, results){
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width, 0); 
  ctx.scale(-1, 1);

  const drawingUtils = ensureDrawingUtils(ctx,hiddenRef, drawingUtilsRef);
  if (results.landmarks) {
    for (const landmark of results.landmarks) {
      drawingUtils.drawLandmarks(landmark, {
        radius: (data) => DrawingUtils.lerp(data.from.z, -0.15, 0.1, 5, 1),
      });
      drawingUtils.drawConnectors(landmark, PoseLandmarker.POSE_CONNECTIONS);
    }
  }
  ctx.restore();
}

export { drawArucoMarkers, drawArucoMarkerIds, drawLineWithArrow, drawBoundingBoxes, drawPose };

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

export { drawArucoMarkerIds, drawLineWithArrow };

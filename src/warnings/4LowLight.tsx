


function analyzeLightingAcrossFrames(imageData: ImageData){
  
}


function LowLightChecks(canvas: HTMLCanvasElement | null, frame: any, notif: { warning: (msg: string, tag?: string) => void }, frameWidth: number, frameHeight: number) {
  try {
    const ctx = canvas?.getContext("2d");
    ctx?.drawImage(frame, 0, 0 ,frameWidth, frameHeight)
    const imageData = ctx?.getImageData(0, 0 ,frameWidth, frameHeight)
    const res = analyzeLightingAcrossFrames(imageData);

    const threshold = 0.05; // warn if >5% of sampled frames failing
    if (res.pct_frames_failing > threshold) {
      notif.warning('Low light/low contrast detected in setup window', 'issue4');
    }

    // Optionally display representative stats
    if (canvas && res.perFrame && res.perFrame.length) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.fillStyle = 'cyan';
        ctx.font = '14px Arial';
        ctx.fillText(`Bad frames: ${(res.pct_frames_failing * 100).toFixed(0)}%`, 10, 60);
        ctx.restore();
      }
    }
  } catch (e) {
    console.warn('LowLightChecks error', e);
  }
}

export { LowLightChecks };
export default LowLightChecks;

import setupChecks from "../detections/setupChecks";

function LowLightChecks(canvas: HTMLCanvasElement | null, frames: any[], notif: { warning: (msg: string, tag?: string) => void }, frameWidth: number, frameHeight: number) {
  try {
    const res = setupChecks.analyzeLightingAcrossFrames(frames);

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

import setupChecks from "../detections/setupChecks";

function MultiPersonChecks(canvas: HTMLCanvasElement | null, frames: any[], notif: { warning: (msg: string, tag?: string) => void }, frameWidth: number, frameHeight: number) {
  try {
    const res = setupChecks.analyzeMultiPerson(frames);

    if (res.max_person_count === 0) {
      // no persons detected — sampler or other checks will warn elsewhere
      return;
    }

    // Warn if multiple people in meaningful fraction
    const threshold = 0.05; // 5% by default
    if (res.pct_frames_multi_person > threshold) {
      notif.warning(`Multiple people detected in ${(res.pct_frames_multi_person * 100).toFixed(0)}% of frames`, "issue3");
    }

    // Draw simple overlay if canvas provided
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.fillStyle = 'yellow';
        ctx.font = '14px Arial';
        ctx.fillText(`People: ${res.max_person_count}`, 10, 40);
        ctx.restore();
      }
    }
  } catch (e) {
    console.warn('MultiPersonChecks error', e);
  }
}

export { MultiPersonChecks };
export default MultiPersonChecks;

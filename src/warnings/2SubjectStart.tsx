import setupChecks from "../detections/setupChecks";
import { NotifyTypes } from "./Notification";

// Issue 2: Subject not at start line / not stationary at video start
// Keep interface similar to 1NonVisibleMarkers: (canvas, frames, notif, frameWidth, frameHeight)

function SubjectStartChecks(canvas: HTMLCanvasElement | null, frames: any[], notif: { warning: (msg: string, tag?: string) => void }, frameWidth: number, frameHeight: number) {
  try {
    const res = setupChecks.analyzeStartWindow(frames, frameWidth, frameHeight);

    // Warnings aligned with proposed logic
    if (res.num_frames === 0 || res.num_bbox_first_frame === 0) {
      notif.warning("No subject detected in setup window", "issue2");
      return;
    }

    if (!res.stationary) {
      notif.warning("Subject moving at start", "issue2");
    }

    if (res.subject_at_start_line === 'no') {
      notif.warning("Subject not at start line", "issue2");
    }

    // Optionally: draw recommended start frame indicator on canvas (non-intrusive)
    if (canvas && res.recommended_start_frame != null) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.strokeStyle = 'orange';
        ctx.lineWidth = 2;
        // Draw a small notice top-left
        ctx.font = '16px Arial';
        ctx.fillStyle = 'orange';
        ctx.fillText(`Start OK? ${res.subject_at_start_line}`, 10, 20);
        ctx.restore();
      }
    }

  } catch (e) {
    console.warn('SubjectStartChecks error', e);
  }
}

export { SubjectStartChecks };
export default SubjectStartChecks;

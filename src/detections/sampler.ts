import { DEFAULTS } from "./setupChecks";
import { NonVisibleMarks } from "../warnings/1NonVisibleMarkers";

export default class Sampler {
  hiddenRef: any; // React ref to hidden canvas
  fpsGetter: () => number;
  notif: any;
  frames: any[];
  opts: any;
  enabledWarnings: string[];

  constructor(hiddenRef: any, fpsGetter: () => number, notif: any, enabledWarnings: string[] = [], opts = {}) {
    this.hiddenRef = hiddenRef;
    this.fpsGetter = fpsGetter;
    this.notif = notif;
    this.frames = [];
    this.enabledWarnings = enabledWarnings || [];
    this.opts = { ...DEFAULTS, ...opts };
  }


  sampleAruco(imageData: ImageData, videoEl: HTMLVideoElement, markers: any[] | null = null, displayCanvas: HTMLCanvasElement | null = null) {
    try {
      // imageData is expected to already be a sampled image from video
      this._pushSample({ bboxes: [], markers: markers || [], imageData, timestamp: performance.now(), videoWidth: videoEl.clientWidth, videoHeight: videoEl.clientHeight });

      // call immediate per-frame marker-specific check if enabled
      if (this.enabledWarnings.includes('aruco') || this.enabledWarnings.includes('NonVisible')) {
        try {
          const hidden = this.hiddenRef && this.hiddenRef.current ? this.hiddenRef.current : null;
          const canvas = displayCanvas ?? hidden;
          if (markers && markers.length > 0) {
            NonVisibleMarks(canvas, markers, this.notif, videoEl.clientWidth, videoEl.clientHeight
              , hidden.width, hidden.height
            );
          }
        } catch (e) {
          console.warn('NonVisibleMarks invocation failed', e);
        }
      }

    } catch (e) {
      console.warn('Sampler.sampleAruco error', e);
    }
  }

  _pushSample(sample: any) {
    this.frames.push(sample);
    const fps = Math.max(1, Math.round(this.fpsGetter() || 30));
    // DEFAULTS has no setup_window_sec key - deferred bug, deliberately left as-is; cast only satisfies tsc.
    const requiredFrames = Math.max(1, Math.round((this.opts.setup_window_sec || (DEFAULTS as Record<string, number>).setup_window_sec) * fps));

    // keep buffer bounded
    const maxKeep = requiredFrames * 3;
    if (this.frames.length > maxKeep) this.frames = this.frames.slice(-maxKeep);

    
    // run analyses once when enough frames collected
     if (this.frames.length >= requiredFrames) {
      this.frames = []

    }

  }
}

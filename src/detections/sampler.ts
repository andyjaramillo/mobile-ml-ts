import setupChecks, { DEFAULTS } from "./setupChecks";
import { SubjectStartChecks } from "../warnings/2SubjectStart";
import { MultiPersonChecks } from "../warnings/3MultiPerson";
import { LowLightChecks } from "../warnings/4LowLight";
import { NonVisibleMarks } from "../warnings/1NonVisibleMarkers";

type BBox = { x: number; y: number; width: number; height: number };

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

  sampleObject(results: any, videoEl: HTMLVideoElement) {
    try {
      const hidden = this.hiddenRef && this.hiddenRef.current;
      if (!hidden) return;
      const off = hidden.getContext('2d', { willReadFrequently: true });
      const inputW = 640;
      const inputH = Math.round(inputW * (videoEl.clientHeight / videoEl.clientWidth));
      hidden.width = inputW;
      hidden.height = inputH;
      off.drawImage(videoEl, 0, 0, inputW, inputH);
      const imageData = off.getImageData(0, 0, inputW, inputH);

      const sampleBboxes: BBox[] = [];
      if (results && results.detections) {
        for (const detection of results.detections) {
          const category = detection.categories && detection.categories[0];
          const catName = category && String(category.categoryName || '').toLowerCase();
          if (catName.includes('person') || catName.includes('human')) {
            // assume boundingBox in pixel coords relative to video canvas
            sampleBboxes.push({ x: detection.boundingBox.originX, y: detection.boundingBox.originY, width: detection.boundingBox.width, height: detection.boundingBox.height });
          }
        }
      }

      this._pushSample({ bboxes: sampleBboxes, imageData, timestamp: performance.now(), videoWidth: videoEl.clientWidth, videoHeight: videoEl.clientHeight });

    } catch (e) {
      console.warn('Sampler.sampleObject error', e);
    }
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
    const requiredFrames = Math.max(1, Math.round((this.opts.setup_window_sec || DEFAULTS.setup_window_sec) * fps));

    // keep buffer bounded
    const maxKeep = requiredFrames * 3;
    if (this.frames.length > maxKeep) this.frames = this.frames.slice(-maxKeep);

    
    // run analyses once when enough frames collected
     if (this.frames.length >= requiredFrames) {
      this.frames = []

    }
    //   const canvas = this.hiddenRef && this.hiddenRef.current ? this.hiddenRef.current : null;

    //   // Run checks depending on enabledWarnings (map model types to checks)
    //   // If enabledWarnings includes 'object' or 'pose' we'll run start/multi-person/lighting checks
    //   if (this.enabledWarnings.includes('object') || this.enabledWarnings.includes('pose')) {
    //     try { SubjectStartChecks(canvas, this.frames, this.notif, sample.videoWidth, sample.videoHeight); } catch (e) { console.warn('SubjectStartChecks failed', e); }
    //     try { MultiPersonChecks(canvas, this.frames, this.notif, sample.videoWidth, sample.videoHeight); } catch (e) { console.warn('MultiPersonChecks failed', e); }
    //     try { LowLightChecks(canvas, this.frames, this.notif, sample.videoWidth, sample.videoHeight); } catch (e) { console.warn('LowLightChecks failed', e); }
    //   }

    //   // If enabledWarnings includes 'aruco' run marker visibility and lighting
    //   if (this.enabledWarnings.includes('aruco')) {
    //     try { LowLightChecks(canvas, this.frames, this.notif, sample.videoWidth, sample.videoHeight); } catch (e) { console.warn('LowLightChecks failed', e); }
    //   }

    //   // optionally clear frames to avoid repeated notifications; keep last requiredFrames
    //   this.frames = this.frames.slice(-requiredFrames);
    // }
  }
}

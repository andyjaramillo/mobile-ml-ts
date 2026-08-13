import { DEFAULTS } from "./setupChecks";
import { DEFAULTS as CAPTURE_QUALITY_DEFAULTS } from "../CaptureQuality/captureQualityConfig";

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


  // Marker-board-specific analysis (formerly NonVisibleMarks) has moved to
  // src/CaptureQuality/markerBoardCheck.ts, called directly from RealTimeProcessor
  // against its own bounded frame window. This method now only buffers samples for
  // the lighting/multi-person checks that are still pending implementation.
  sampleAruco(imageData: ImageData, videoEl: HTMLVideoElement, markers: any[] | null = null) {
    try {
      // imageData is expected to already be a sampled image from video
      this._pushSample({ bboxes: [], markers: markers || [], imageData, timestamp: performance.now(), videoWidth: videoEl.clientWidth, videoHeight: videoEl.clientHeight });
    } catch (e) {
      console.warn('Sampler.sampleAruco error', e);
    }
  }

  _pushSample(sample: any) {
    this.frames.push(sample);
    // Bounded by frame count (matches CaptureQuality's own live-window sizing), not a
    // derived FPS*duration figure - the previous version divided by a key
    // (setup_window_sec) that DEFAULTS never defined, producing NaN, which made both
    // the trim and reset branches unreachable and let this.frames (holding full
    // ImageData per entry) grow without bound - an OOM on a phone.
    const maxKeep = CAPTURE_QUALITY_DEFAULTS.sampling.liveWindowFrameCount;
    if (this.frames.length > maxKeep) this.frames = this.frames.slice(-maxKeep);
  }
}

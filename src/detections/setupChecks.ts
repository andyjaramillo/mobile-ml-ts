// Setup and quality checks: Issue 2 (start-line/stationary), Issue 3 (multi-person), Issue 4 (low light / low contrast)

export type BBox = { x: number; y: number; width: number; height: number }; // pixel coords
export type FrameSample = {
  bboxes: BBox[]; // person bboxes detected in this frame
  imageData?: ImageData; // optional for lighting analysis
  timestamp?: number; // seconds or ms (optional)
  videoWidth?: number;
  videoHeight?: number;
};

// Tunable defaults (normalized units where noted)
export const DEFAULTS = {
  T_disp_norm: 0.01, // normalized mean frame-to-frame centroid displacement (fraction of diag)
  T_drift_norm: 0.02, // normalized total drift from first (fraction of diag)
  T_area: 0.10, // max area change pct from first
  T_area_cv: 0.12, // area coefficient of variation
};



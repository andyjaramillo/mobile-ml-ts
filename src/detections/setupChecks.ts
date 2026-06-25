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
  setup_window_sec: 2.0,
  T_disp_norm: 0.01, // normalized mean frame-to-frame centroid displacement (fraction of diag)
  T_drift_norm: 0.02, // normalized total drift from first (fraction of diag)
  T_area: 0.10, // max area change pct from first
  T_area_cv: 0.12, // area coefficient of variation
  stationary_sustain_frames: 10,
  movement_sustain_frames: 5,
  start_zone_roi: { x: 0.33, y: 0.6, width: 0.34, height: 0.3 }, // normalized, lower-center third by default
  grid_M: 8,
  grid_N: 8,
  L_min: 40, // luminance threshold (0-255)
  C_min: 10, // local contrast (stddev) threshold
  P_lum: 0.8,
  P_con: 0.8,
};

function centroidFromBBox(b: BBox) {
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
}

function distance(a: { cx: number; cy: number }, b: { cx: number; cy: number }) {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return Math.sqrt(dx * dx + dy * dy);
}

function mean(values: number[]) {
  if (!values || values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values: number[]) {
  if (!values || values.length === 0) return 0;
  const m = mean(values);
  const v = mean(values.map(x => (x - m) * (x - m)));
  return Math.sqrt(v);
}

// Linear slope (simple least-squares) for numeric y over index x=0..n-1
function slope(values: number[]) {
  const n = values.length;
  if (n < 2) return 0;
  const xs = Array.from({ length: n }, (_, i) => i);
  const xm = mean(xs);
  const ym = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xm) * (values[i] - ym);
    den += (xs[i] - xm) * (xs[i] - xm);
  }
  return den === 0 ? 0 : num / den;
}

// Issue 2: analyze start-of-video stationary & start-zone
export function analyzeStartWindow(frames: FrameSample[], videoWidth: number, videoHeight: number, opts = {}) {
  const O = { ...DEFAULTS, ...opts } as typeof DEFAULTS & any;
  const diag = Math.sqrt(videoWidth * videoWidth + videoHeight * videoHeight);

  const firstWindow = frames;
  const result: any = {
    num_frames: firstWindow.length,
    num_bbox_first_frame: firstWindow.length > 0 ? (firstWindow[0].bboxes || []).length : 0,
    warnings: [] as string[],
  };

  if (firstWindow.length === 0) {
    result.subject_at_start_line = 'unknown';
    result.stationary = false;
    result.warnings.push('No frames sampled');
    return result;
  }

  // choose subject bbox per frame: if >1, pick largest; if 0, mark
  const centroids: ( { cx: number; cy: number } | null)[] = [];
  const areas: number[] = [];
  const frameBboxCounts: number[] = [];

  for (let f of firstWindow) {
    const bboxes = f.bboxes || [];
    frameBboxCounts.push(bboxes.length);
    if (bboxes.length === 0) {
      centroids.push(null);
      areas.push(0);
      continue;
    }
    // largest bbox by area
    let largest = bboxes[0];
    let largestArea = largest.width * largest.height;
    for (let b of bboxes) {
      const a = b.width * b.height;
      if (a > largestArea) {
        largest = b;
        largestArea = a;
      }
    }
    const c = centroidFromBBox(largest);
    centroids.push(c);
    areas.push(largestArea);
  }

  const numZeroBboxes = frameBboxCounts.filter(n => n === 0).length;
  if (numZeroBboxes > 0) {
    result.subject_at_start_line = 'unknown';
    result.warnings.push('No person detected in some frames of the setup window');
  }

  const validIndices = centroids.map((c, i) => (c ? i : -1)).filter(i => i >= 0);
  if (validIndices.length === 0) {
    result.stationary = false;
    result.warnings.push('No person bbox available to analyze');
    return result;
  }

  // compute centroid distances frame-to-frame for valid frames
  const frameToFrame: number[] = [];
  const pathLenArr: number[] = [];
  let prev: {cx:number;cy:number} | null = null;
  for (let i = 0; i < centroids.length; i++) {
    const c = centroids[i];
    if (!c) {
      prev = null;
      continue;
    }
    if (prev) {
      const d = distance(prev, c);
      frameToFrame.push(d);
      pathLenArr.push(d);
    }
    prev = c;
  }

  const meanFrameDisp_px = mean(frameToFrame);
  const meanFrameDisp_norm = meanFrameDisp_px / diag; // normalized

  // total drift from first valid centroid to last valid
  const firstIdx = validIndices[0];
  const lastIdx = validIndices[validIndices.length - 1];
  const totalDrift_px = distance(centroids[firstIdx] as any, centroids[lastIdx] as any);
  const totalDrift_norm = totalDrift_px / diag;

  // path length
  const pathLength_px = pathLenArr.reduce((s, v) => s + v, 0);
  const pathLength_norm = pathLength_px / diag;

  // area metrics
  const validAreas = validIndices.map(i => areas[i]);
  const area0 = validAreas[0] || 1;
  const areaChangesPct = validAreas.map(a => Math.abs(a - area0) / (area0 || 1));
  const max_area_change_pct = Math.max(...areaChangesPct, 0);
  const area_cv = stddev(validAreas) / (mean(validAreas) || 1);
  const area_slope = slope(validAreas);

  // thresholds
  const stationary_disp_ok = meanFrameDisp_norm < O.T_disp_norm && totalDrift_norm < O.T_drift_norm;
  const stationary_area_ok = max_area_change_pct < O.T_area && area_cv < O.T_area_cv;
  const stationary = stationary_disp_ok && stationary_area_ok;

  result.metrics = {
    mean_frame_disp_px: meanFrameDisp_px,
    mean_frame_disp_norm: meanFrameDisp_norm,
    total_drift_px: totalDrift_px,
    total_drift_norm: totalDrift_norm,
    path_length_px: pathLength_px,
    path_length_norm: pathLength_norm,
    max_area_change_pct: max_area_change_pct,
    area_cv: area_cv,
    area_slope: area_slope,
  };

  result.stationary = !!stationary;
  if (!stationary) {
    result.warnings.push('Subject moving at start');
  }

  // start zone check (normalized ROI)
  const roi = O.start_zone_roi;
  let inZoneCount = 0;
  for (let i of validIndices) {
    const c = centroids[i] as any;
    const normx = c.cx / videoWidth;
    const normy = c.cy / videoHeight;
    if (normx >= roi.x && normx <= roi.x + roi.width && normy >= roi.y && normy <= roi.y + roi.height) {
      inZoneCount++;
    }
  }
  const pctInZone = inZoneCount / validIndices.length;
  result.pct_in_start_zone = pctInZone;

  if (stationary) {
    result.subject_at_start_line = pctInZone >= 0.5 ? 'yes' : 'no';
    if (pctInZone < 0.5) result.warnings.push('Subject stationary but not in start zone');
  } else {
    result.subject_at_start_line = 'unknown';
  }

  // recommended_start_frame: first index where sustained stationary + in zone
  const sustainedReq = Math.max(1, O.stationary_sustain_frames);
  let recommended_start_frame: number | null = null;
  // check windows of sustainedReq frames for stationary and in-zone
  for (let i = 0; i + sustainedReq <= centroids.length; i++) {
    const windowIdx = Array.from({ length: sustainedReq }, (_, k) => i + k);
    const windowValid = windowIdx.every(idx => centroids[idx] !== null);
    if (!windowValid) continue;
    // compute local mean disp and area change inside window
    const localFrameToFrame: number[] = [];
    for (let k = 1; k < windowIdx.length; k++) {
      localFrameToFrame.push(distance(centroids[windowIdx[k - 1]] as any, centroids[windowIdx[k]] as any));
    }
    const localMeanDisp = mean(localFrameToFrame) / diag;
    const localAreas = windowIdx.map(idx => areas[idx]);
    const localMaxAreaChange = Math.max(...localAreas.map(a => Math.abs(a - localAreas[0]) / (localAreas[0] || 1)));
    const allInZone = windowIdx.every(idx => {
      const c = centroids[idx] as any;
      const nx = c.cx / videoWidth;
      const ny = c.cy / videoHeight;
      return nx >= roi.x && nx <= roi.x + roi.width && ny >= roi.y && ny <= roi.y + roi.height;
    });
    if (localMeanDisp < O.T_disp_norm && localMaxAreaChange < O.T_area && allInZone) {
      recommended_start_frame = i;
      break;
    }
  }
  result.recommended_start_frame = recommended_start_frame;

  // recommended_end_frame: first sustained movement after start
  let recommended_end_frame: number | null = null;
  const movementReq = Math.max(1, O.movement_sustain_frames || O.movement_sustain_frames);
  for (let i = 0; i + movementReq <= centroids.length; i++) {
    const windowIdx = Array.from({ length: movementReq }, (_, k) => i + k);
    const valid = windowIdx.every(idx => centroids[idx] !== null);
    if (!valid) continue;
    const localFrameToFrame: number[] = [];
    for (let k = 1; k < windowIdx.length; k++) {
      localFrameToFrame.push(distance(centroids[windowIdx[k - 1]] as any, centroids[windowIdx[k]] as any));
    }
    const localMeanDisp = mean(localFrameToFrame) / diag;
    const localAreas = windowIdx.map(idx => areas[idx]);
    const localMaxAreaChange = Math.max(...localAreas.map(a => Math.abs(a - localAreas[0]) / (localAreas[0] || 1)));
    if (localMeanDisp > O.T_disp_norm || localMaxAreaChange > O.T_area) {
      recommended_end_frame = i;
      break;
    }
  }
  result.recommended_end_frame = recommended_end_frame === null ? centroids.length - 1 : recommended_end_frame;

  return result;
}

// Issue 3: multi-person detection across samples
export function analyzeMultiPerson(frames: FrameSample[]) {
  const counts = frames.map(f => (f.bboxes || []).length);
  const max_person_count = Math.max(...counts, 0);
  const pct_frames_multi_person = counts.filter(n => n > 1).length / Math.max(frames.length, 1);

  // dominant bbox stability: track largest bbox centroid across frames and compute its centroid variance
  const largestCentroids: ( {cx:number;cy:number} | null)[] = [];
  for (let f of frames) {
    const b = (f.bboxes || []).slice();
    if (b.length === 0) {
      largestCentroids.push(null);
      continue;
    }
    // pick largest
    let largest = b[0];
    let a0 = largest.width * largest.height;
    for (let bb of b) {
      const a = bb.width * bb.height;
      if (a > a0) {
        largest = bb;
        a0 = a;
      }
    }
    largestCentroids.push(centroidFromBBox(largest));
  }
  const valid = largestCentroids.filter(c => !!c) as {cx:number;cy:number}[];
  const cxArr = valid.map(c => c.cx);
  const cyArr = valid.map(c => c.cy);
  const cxVar = stddev(cxArr);
  const cyVar = stddev(cyArr);
  const dominant_bbox_stable = (cxVar + cyVar) < 10; // 10 px variance heuristic; caller can tune

  return {
    max_person_count,
    pct_frames_multi_person,
    dominant_bbox_stable,
    counts,
  };
}

// Issue 4: low light / low contrast detection per frame and aggregate
export function analyzeLighting(frame: FrameSample, opts = {}) {
  const O = { ...DEFAULTS, ...opts } as typeof DEFAULTS & any;
  if (!frame.imageData) {
    return { ok: true, reason: 'no imageData' };
  }
  const img = frame.imageData;
  const w = img.width;
  const h = img.height;
  const M = O.grid_M;
  const N = O.grid_N;
  const cellW = Math.floor(w / M);
  const cellH = Math.floor(h / N);

  const lowLumCells: { x: number; y: number; meanLum: number }[] = [];
  const lowConCells: { x: number; y: number; contrast: number }[] = [];

  // compute luminance and local contrast per cell (use RGB->lum formula)
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < M; gx++) {
      const sx = gx * cellW;
      const sy = gy * cellH;
      const ex = gx === M - 1 ? w : sx + cellW;
      const ey = gy === N - 1 ? h : sy + cellH;
      let pxCount = 0;
      const lums: number[] = [];
      for (let yy = sy; yy < ey; yy++) {
        for (let xx = sx; xx < ex; xx++) {
          const idx = (yy * w + xx) * 4;
          const r = img.data[idx];
          const g = img.data[idx + 1];
          const b = img.data[idx + 2];
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          lums.push(lum);
          pxCount++;
        }
      }
      const meanLum = mean(lums);
      const localStd = stddev(lums);
      if (meanLum < O.L_min) {
        lowLumCells.push({ x: gx, y: gy, meanLum });
      }
      if (localStd < O.C_min) {
        lowConCells.push({ x: gx, y: gy, contrast: localStd });
      }
    }
  }

  const totalCells = M * N;
  const low_luminance_cell_pct = lowLumCells.length / totalCells;
  const low_contrast_cell_pct = lowConCells.length / totalCells;

  const rep_low_luminance = lowLumCells.length ? mean(lowLumCells.map(c => c.meanLum)) : null;
  const rep_low_contrast = lowConCells.length ? mean(lowConCells.map(c => c.contrast)) : null;

  const frameFails = (low_luminance_cell_pct > O.P_lum) || (low_contrast_cell_pct > O.P_con);

  return {
    low_luminance_cell_pct,
    low_contrast_cell_pct,
    rep_low_luminance,
    rep_low_contrast,
    lowLumCells,
    lowConCells,
    frameFails,
  };
}

// Convenience aggregator for multiple frames
export function analyzeLightingAcrossFrames(frames: FrameSample[], opts = {}) {
  const perFrame = frames.map(f => ({ frame: f, res: analyzeLighting(f, opts) }));
  const failing = perFrame.filter(p => p.res.frameFails);
  return {
    perFrame: perFrame.map(p => p.res),
    pct_frames_failing: failing.length / Math.max(perFrame.length, 1),
    failing_count: failing.length,
  };
}


// Export default object for easy import
export default {
  analyzeStartWindow,
  analyzeMultiPerson,
  analyzeLighting,
  analyzeLightingAcrossFrames,
};

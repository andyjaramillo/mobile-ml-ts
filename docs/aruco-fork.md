# aruco.ts fork inventory

Compared:
- prototype: `src/aruco.ts` (this repo)
- Website: `WebsiteCode/Website/src/pages/MobilePage/MobileComponents/ArucoDetection/aruco.ts`

`cv.js` is byte-identical between the two repos and out of scope. Everything in
`aruco.ts` outside the `AR_Detector.detectImage`/constructor region (dictionary
data, `AR_Dictionary`, `detect()`, `detectStream*`, `drawNumber`) is also
byte-identical; the only differences are in the block below.

Decision: prototype's aruco.ts is canonical. Website's `ArucoDetection.tsx` is
dead there (registered only via `registerStringToBlock`, never `registerBlock`-ed,
no assessment schema references it), so adopting the prototype file wholesale
later has near-zero blast radius. The table below is the disposition for that
future port.

| Difference | Website (old) | Prototype (before this change) | Disposition |
|---|---|---|---|
| Byte-order mark | none | `﻿` prepended to file | Accidental artifact from an editor save. Stripped — no functional difference, just hygiene. |
| `findCentroidFromMarkers(markers)` | absent | added, returns centroid of marker corners 1/3 midpoint | Genuine addition (used for pose/position calibration work). Kept as-is. |
| `detectImage` signature | `(width, height, data, canvasContext, inputW=256, inputH=256)` only | dual dispatch: single `(imageData: ImageData)` for the new call site, falls through to the legacy 6-arg signature otherwise | Genuine improvement — this is what makes the prototype call-compatible with Website's existing `ArucoDetection.tsx` caller (`detectImage(dims.width, dims.height, imageData, canvasContext, inputW, inputH)`) while also serving the prototype's new single-arg caller in `RealTimeProcessor.tsx`. Kept as-is. |
| Per-frame `console.log("Marker ID: ...")` | present (legacy path only) | present (legacy path only, unchanged going in) | Removed in this change. Per-frame console output is intercepted and shipped to CloudWatch RUM in Website (`src/utils/consoleInterceptor.ts`) — logging marker IDs/hamming distance per camera frame is a HIPAA problem in the regulated product. No caller in either repo used the returned data from this log; deletion is safe. |
| `perfLogs` array (per-marker inference/fps timing pushed in the legacy canvas-draw path) | present | **dropped** — array still declared/initialized in the constructor but never populated | Genuine capability loss. Re-added, verbatim (same per-marker push semantics as Website), to keep the prototype a superset. Does not log to console, so it carries no compliance issue — it is an in-memory timing buffer only. |
| `exportPerformanceLogs()` method (CSV download of `perfLogs`) | present, but unused — no caller in Website's `ArucoDetection.tsx` or anywhere else in Website's `src/` | **dropped** entirely | Genuine capability loss even though currently uncalled in both repos — it is public debug tooling on the class, useful for calibration work in this repo. Re-added verbatim. Its one `console.log("Performance log exported successfully.")` is a one-time completion message tied to an explicit user-triggered CSV download, not per-frame frame data, so it stays under the "one-time logs are fine" rule. |

## Net result

Prototype `src/aruco.ts` is now a strict superset of Website's version:
everything Website's `aruco.ts` can do, the prototype's can also do (including
the legacy 6-arg `detectImage` call signature Website's `ArucoDetection.tsx`
actually uses), plus `findCentroidFromMarkers` and the ImageData-only
`detectImage` call path, minus the per-frame `console.log` (removed for HIPAA
compliance — see "Remove per-frame logging" in the task this doc was written
for).

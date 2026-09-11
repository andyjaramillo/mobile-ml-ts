# Test Motor model assets

Committed to this repo rather than CDN-loaded, so a fresh clone (which is what Amplify
builds) can serve the harness with no external dependency and no referer-gated bucket.
Website self-hosts its models for a stricter reason - its CSP allows connections from
`'self'` only - so keeping the harness self-hosted keeps the port honest.

| Asset | Source | Pinned at |
|---|---|---|
| `hand_landmarker.task` | `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` | model version 1, sha256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |

Served from `public/`, so Vite exposes it at `/models/...` in dev and copies it verbatim
into `dist/` on build. `handLandmarker.ts` references that path as a string - do NOT
convert it to a build-time import, which would put a 7.8MB asset through the bundler for
no gain.

The MediaPipe **wasm runtime** is still loaded from the CDN, matching `src/model/initModels.ts`
(including its `preloadWasmGlue` workaround). Website cannot do that - its CSP blocks the
CDN - so a port back has to self-host that directory the way Website already does for the
gait models. That is the one thing in this file that does not transfer as-is.

`palm_detection_mediapipe_2023feb.onnx` was removed on 2026-09-10 along with the ONNX palm
detector it fed. HandLandmarker runs palm detection and landmark regression in one pass,
so it replaced that model rather than joining it; see git history if it is needed again.

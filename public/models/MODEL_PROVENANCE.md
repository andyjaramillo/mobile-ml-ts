# Test Motor model assets

Committed to this repo rather than CDN-loaded, so a fresh clone (which is what Amplify
builds) can serve the harness with no external dependency and no referer-gated bucket.
Website self-hosts the same file for a stricter reason - its CSP allows connections from
`'self'` only - so keeping the harness self-hosted keeps the port honest.

| Asset | Source | Pinned at |
|---|---|---|
| `palm_detection_mediapipe_2023feb.onnx` | copied from `WebsiteCode/Website/public/models/`, originally OpenCV Model Zoo's ONNX export of MediaPipe Palm Detection (2023 Feb) | sha256 `78ff51c38496b7fc8b8ebdb6cc8c1abb02fa6c38427c6848254cdaba57fcce7c` |

Served from `public/`, so Vite exposes it at `/models/...` in dev and copies it verbatim
into `dist/` on build. `handModel.ts` references that path as a string - do NOT convert it
to a build-time import, which would put a 3.9MB asset through the bundler for no gain.

Website's copy of this file is 3905734 bytes and byte-identical; if the two ever diverge,
Website's is the one that ships.

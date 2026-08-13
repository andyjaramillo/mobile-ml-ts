# mobile-ml-ts

Calibration and tuning harness for CurveAssure's mobile "capture quality" CV
checks (ArUco floor-marker detection, subject positioning, pose/object
detection) ahead of porting them into the Website patient/clinician app. It is
a throwaway prototyping surface, not a shipped product - deployed to Amplify
at https://main.d3a9d67zla937q.amplifyapp.com/ purely so the calibration work
can be exercised on a real phone camera over HTTPS.

`src/CaptureQuality/` is the one exception: it is written to be portable and
is copied verbatim into
`WebsiteCode/Website/src/pages/MobilePage/MobileComponents/CaptureQuality/`.
Keep it framework-free (no React, no imports outside its own folder) so the
copy stays a straight file copy with no adaptation.

## Running locally

```bash
npm install
npm run dev
```

Vite serves over HTTPS (`@vitejs/plugin-basic-ssl`) because `getUserMedia`
requires a secure context. The certificate is self-signed - your browser will
warn on first load; accept it to continue. `npm run dev` also prints a network
URL; open that from a phone on the same LAN to test against a real camera.

### Assets and the referer allowlist

The Test Gait alignment overlay is a CurveAssure product asset, so it is not in
this (public) repo - `TestGaitCamera` loads it from the `curveassure-redirect`
bucket at runtime. That bucket grants public reads only when the request's
`Referer` matches an allowlist on its bucket policy, so the overlay renders as
a broken image from any origin not on it. Currently allowed, for this harness:
the Amplify deployment and `localhost:5173`. Serve on a different port or host
and you must add it to the policy first.

## Checks

```bash
npm run typing    # tsc, no emit - must be clean before porting code to Website
npm run lint      # eslint
npm run unittest  # vitest
npm run build     # production build
```

`tsconfig.json` mirrors `WebsiteCode/Website/tsconfig.json`'s compiler options
(`strict: false`, `noUnusedLocals`/`noUnusedParameters` on, etc.) so anything
that compiles here is expected to compile there too. `eslint.config.js` and
`vitest.config.ts` are likewise modeled on Website's.

`src/cv.js`, `src/mp4box.all.min.js`, and `src/demuxer_mp4.js` are vendored
third-party JS - left untyped and unlinted on purpose, do not modify them
here.

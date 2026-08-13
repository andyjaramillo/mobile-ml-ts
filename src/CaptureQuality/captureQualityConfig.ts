// [Feature: Capture Quality Warnings]
//
// Tunable thresholds for every capture-quality check, with per-assessment overrides.
// Modeled on Website's DEVICE_COMPATIBILITY_REQUIREMENTS constant style
// (src/pages/MobilePage/MobileComponents/CameraUtils/deviceCompatibilityService.ts):
// one flat, readonly defaults object plus small helpers, no class.
//
// UNIT CONVENTION: prefer normalized units (fraction of frame width/height, or of the
// frame diagonal) over raw pixels, so a threshold means the same thing on a phone and
// a tablet. Any value below marked "UNCALIBRATED" is a placeholder guess pending
// calibration against a real ArUco marker board, not a tuned figure — do not treat
// these as ground truth. Any value marked "PIXEL UNIT BUG" is a known-wrong carryover
// from the prototype that must be converted to a normalized unit during calibration.
//
// MARKER_BOARD below is the one exception to "everything here is a guess": its LAYOUT
// (which IDs exist, which corner each sits at, which pair is the forward axis) is
// VERIFIED AGAINST HARDWARE from a live phone capture of the real board (2026-08-12).
// That is a different claim from "calibrated" — MarkerBoardThresholds (the numeric
// pass/fail values) are still UNCALIBRATED guesses even though the layout they're
// measured against is now known-correct. Don't conflate the two.

import type { CaptureQualityIssueCode } from "./types";

/**
 * Describes marker IDENTITY and ROLE on a physical board — which IDs exist and which
 * physical corner/axis each one occupies — as opposed to MarkerBoardThresholds, which
 * says what counts as pass/fail once you know where the markers are. Kept as an
 * interface (rather than inlining hardware assumptions into the check) so a future
 * board with a different layout is a new value of this type, not a rewrite.
 */
export interface MarkerBoardLayout {
	boardDictionary: string;
	boardSize: number;
	expectedMarkerCount: number;
	/** Every ID that must be present, and distinct, for a frame to count as a complete board. */
	expectedMarkerIds: readonly number[];
	/** The four outer-corner marker IDs, keyed by their role in-frame when the board is laid corner-forward (diamond). */
	diamondCornerIds: {
		readonly top: number;
		readonly right: number;
		readonly bottom: number;
		readonly left: number;
	};
	/** [tail, head] marker IDs whose center-to-center line is the forward walk axis. */
	forwardAxisMarkerIds: readonly [tail: number, head: number];
}

/**
 * VERIFIED AGAINST HARDWARE (2026-08-12, live phone capture of the real board): a 3x3
 * DICT_5X5_50 grid, IDs 0-8 laid out row-major descending (id = row*3 + (2 - col)),
 * flat on the floor, used CORNER-FORWARD. The printed forward arrow points out of the
 * corner where marker 2 sits, and the walk direction runs along the 6->2 grid
 * DIAGONAL — not an edge — so forwardAxisMarkerIds is intentionally a diagonal pair,
 * not two adjacent corners. Do not "fix" this into an edge without re-checking the
 * hardware.
 *
 * This diverges from the Notion marker spec (corner IDs 0/1/2/3 plus five interior
 * design-ID markers): that board does not exist. MarkerBoardLayout stays generic so
 * the spec board is reachable as a second layout value later; this one is the default
 * because it's the board that exists today.
 */
export const MARKER_BOARD: MarkerBoardLayout = {
	boardDictionary: "DICT_5X5_50",
	boardSize: 3,
	expectedMarkerCount: 9,
	expectedMarkerIds: [0, 1, 2, 3, 4, 5, 6, 7, 8],
	diamondCornerIds: { top: 2, right: 0, bottom: 6, left: 8 },
	forwardAxisMarkerIds: [6, 2],
};

export interface MarkerBoardThresholds {
	/**
	 * Four-boundary size model (2026-08-13 "viable range" revision, reintroducing
	 * sizeWarnUpperNorm/MARKER_TOO_LARGE behind a measured human-demonstrated limit - see
	 * git history for the intervening "widened ideal band" revision that removed it, and
	 * the REINTRODUCED note on sizeWarnUpperNorm below for why that removal doesn't apply
	 * to this number). Size is still not an independent pass/fail gate - full-set rate
	 * (minimumFullSetWeight) owns whether the board is visible at all. Once that gate is
	 * cleared and orientation is in range, normalizedArea (the full nine-marker mean,
	 * full-set frames only) is read against four boundaries, low to high:
	 *   area <  sizeWarnLowerNorm                        -> MARKER_TOO_SMALL ("move closer")
	 *   sizeWarnLowerNorm  <= area <  sizeIdealLowerNorm  -> acceptable, silent (no code)
	 *   sizeIdealLowerNorm <= area <= sizeIdealUpperNorm  -> ideal, silent at the check layer
	 *     (the HUD layer surfaces a positive confirmation here - see
	 *     CaptureQualityHud/captureQualityGuidance.ts; this module stays code-only)
	 *   sizeIdealUpperNorm <  area <  sizeWarnUpperNorm   -> acceptable, silent (no code)
	 *   area >= sizeWarnUpperNorm                         -> MARKER_TOO_LARGE ("step back")
	 * Also used, in the incomplete-set branch, for a persistent single-marker miss's
	 * TOO_CLOSE/OBSTRUCTED/INCOMPLETE split - see tooCloseDetectedAreaNorm below, which
	 * pairs with sizeWarnLowerNorm there the same way it pairs with the size-nudge branch
	 * above (that split is unrelated to, and not superseded by, sizeWarnUpperNorm).
	 */
	sizeWarnLowerNorm: number;
	/**
	 * Hysteresis clear level for sizeWarnLowerNorm (MARKER_TOO_SMALL): once "too small" is
	 * active, normalizedArea must rise above THIS level, not just back over
	 * sizeWarnLowerNorm, before the nudge clears. Gap (0.00015) is exactly the drift
	 * recording's own measured normalizedArea std at a clean, held setup - see
	 * DEFAULTS.markerBoard's comment for why that std is the right yardstick here.
	 */
	sizeWarnLowerClearNorm: number;
	sizeIdealLowerNorm: number;
	sizeIdealUpperNorm: number;
	/**
	 * REINTRODUCED 2026-08-13 (see the prior REMOVED note in git history - it explained
	 * why the OLD number, 0.0028, was wrong; it does not argue against having a boundary
	 * here at all). The distinction that matters: this is NOT a re-measured detection
	 * limit. Marker detection keeps improving well past this value (d-3p5ft at
	 * normalizedArea=0.00389 measures 99.1% full-set, the best in the whole dataset) - so
	 * nothing about marker legibility argues for a ceiling. What changed is that the human
	 * has now explicitly demonstrated and stated a FRAMING limit and its cause (a
	 * deliberate range sweep - see calibration/2026-08-13-gait-viable-range-sweep.cq2.txt
	 * and DEFAULTS.markerBoard's comment for the measured numbers): "any closer and the
	 * board would be out of frame or the person would be out of frame" - a walk-path/
	 * subject-framing constraint, not a marker-detection one. This boundary remains a
	 * PROXY for that real check (this codebase still cannot see where the subject is in
	 * frame - person/subject detection does not exist yet); supersede it with an actual
	 * walk-path-framing check (e.g. subject bounding box proximity to frame edges) once
	 * that exists, rather than tightening this number further.
	 */
	sizeWarnUpperNorm: number;
	/**
	 * Hysteresis clear level for sizeWarnUpperNorm (MARKER_TOO_LARGE): once "too large" is
	 * active, normalizedArea must drop below THIS level, not just back under
	 * sizeWarnUpperNorm, before the nudge clears. Gap (0.00015) matches
	 * sizeWarnLowerClearNorm's own gap - the same held-setup EWMA noise sample
	 * (good-place-drift's std) is the only real noise measurement this codebase has near a
	 * real threshold, and nothing suggests the noise floor differs at the opposite
	 * boundary.
	 */
	sizeWarnUpperClearNorm: number;
	diagonalRatioMin: number;
	diagonalRatioMax: number;
	orientationMarginRad: number;
	/**
	 * Hysteresis clear level for orientationMarginRad (MARKER_WRONG_ORIENTATION): once
	 * triggered, orientationAngleRad must drop below THIS level, not just back under
	 * orientationMarginRad, before the warning clears. See DEFAULTS.markerBoard's comment
	 * for the gap derivation.
	 */
	orientationClearMarginRad: number;
	/** Minimum recency-weighted fraction of the live window that must show the complete board before geometry/orientation are considered trustworthy; below this the guidance falls to one of MARKER_INCOMPLETE/MARKER_TOO_CLOSE/MARKER_OBSTRUCTED depending on persistence + detected size (see aggregateMarkerBoardMetrics). Orientation is evaluated independent of this gate - see aggregateMarkerBoardMetrics's priority-order comment. */
	minimumFullSetWeight: number;
	/**
	 * Hysteresis clear level for minimumFullSetWeight: once the visibility gate has
	 * failed, weightedFullSetScore must climb above THIS level, not just back over
	 * minimumFullSetWeight, before geometry/orientation are trusted again. Gap (0.07)
	 * matches the roughly +/-7-point noise band measured on weightedFullSetScore's EWMA
	 * at alpha=0.08 (the value in effect when this gap was derived - see
	 * sampling.liveWindowRecencyWeight for why the shipped default is now 0.15) - see
	 * DEFAULTS.markerBoard's comment for the derivation.
	 */
	minimumFullSetClearWeight: number;
	/**
	 * Recency-weighted mean normalized area of whatever markers ARE detected (see
	 * MarkerBoardFrameMetrics.detectedMarkerAreaNorm), used ONLY when the set is
	 * incomplete AND a single marker has been persistently missing (see
	 * MarkerPersistenceResult) - never applied to a full-set frame. Paired with
	 * sizeWarnLowerNorm (not the ideal boundaries, which only mean anything on a full
	 * nine-marker average) to split a persistent incomplete set into three remedies:
	 *   - above this ceiling -> MARKER_TOO_CLOSE (board doesn't fit the frame - step back/tilt down)
	 *   - between sizeWarnLowerNorm and this ceiling -> MARKER_OBSTRUCTED (something covering it)
	 *   - below sizeWarnLowerNorm -> MARKER_INCOMPLETE (too far to resolve - move closer)
	 * A scattered (non-persistent) incomplete set always reports MARKER_INCOMPLETE
	 * regardless of size - see the DEFAULTS comment for calibration status of this value.
	 * null disables the whole split: every incomplete set reports MARKER_INCOMPLETE,
	 * matching pre-MARKER_TOO_CLOSE behavior.
	 */
	tooCloseDetectedAreaNorm: number | null;
	/**
	 * How long (wall-clock, not frame count - measured fps ranges 28-43 across real
	 * recordings, so a fixed frame count would mean a different duration on different
	 * devices) a single marker must be continuously absent before it counts as a
	 * structural miss rather than noise. Compared against MarkerPersistenceResult, which
	 * is tracked over the FULL take, not the ~15-frame EWMA recency window used for
	 * full-set-rate/geometry above - at the fps actually measured on real hardware, that
	 * window only spans 0.35-0.54s, which straddles this threshold, so a persistent miss
	 * would sometimes fail to register as "long enough" for no reason other than the
	 * window being too short to see it. See markerBoardCheck.ts's MarkerPersistenceTracker.
	 */
	persistentMissThresholdMs: number;
}

export interface SubjectPositionThresholds {
	displacementNormThreshold: number;
	driftThresholdNorm: number;
	areaChangeMaxPct: number;
	areaCoefficientOfVariationMax: number;
	startLineDistanceNorm: number;
}

export interface MultiPersonThresholds {
	proximatePeopleMinGapNorm: number;
}

/**
 * Grid resolution and pixel-sampling stride for the lighting pre-check - a structural
 * choice (how finely the ROI is diced), not a pass/fail number, so it is kept apart from
 * LightingThresholds the same way MARKER_BOARD (layout) is kept apart from
 * MarkerBoardThresholds (numbers) above.
 *
 * 4x4 rather than a finer dice because the grid covers the ROI (a fraction of the
 * ~128-long-edge lighting canvas), not the whole frame: over the default ROI that lands
 * ~150-165 raw pixels per cell, and an 8x8 dice would starve most cells.
 */
export interface LightingGrid {
	cols: number;
	rows: number;
	/** Every Nth pixel within a cell is sampled, in both axes; 1 means every pixel. */
	cellSampleStride: number;
	/** Minimum sampled pixels before a cell counts as computable; below it the cell is left null. Guards a tightly-cropped ROI whose cells are too small for a stable mean/std. */
	minPixelsPerCell: number;
}

export const LIGHTING_GRID: LightingGrid = {
	cols: 4,
	rows: 4,
	cellSampleStride: 1,
	minPixelsPerCell: 25,
};

/** Normalized [0,1] rectangle, expressed as fractions of a frame's own width/height - same unit convention as every other threshold in this file. */
export interface LightingRoiRect {
	xNorm: number;
	yNorm: number;
	widthNorm: number;
	heightNorm: number;
}

/**
 * Which region of the frame the lighting check measures - feeds resolveLowLightRoi's
 * three-path selection in lowLightCheck.ts. "Where to look", not "what counts as bad",
 * so it is kept apart from LightingThresholds the same way LightingGrid is.
 */
export interface LightingRoiConfig {
	/** Padding added to a detected-marker bounding box on each side, as a fraction of that bbox's OWN size. UNCALIBRATED - no measured data on how tightly the nine-marker bbox hugs the physical board edge. */
	marginFrac: number;
	/** Absolute floor for the same padding, as a fraction of the FRAME - guards a near-degenerate bbox (one or two closely-spaced markers) that marginFrac alone would barely pad. */
	minMarginNorm: number;
	/**
	 * Fallback region when no marker has been seen at all. UNCALIBRATED: the board lies
	 * flat on the floor and every recording here frames it in the lower half, so this
	 * spans that band generously rather than guessing exact framing. Replace once an
	 * overlay-guide component exists to source a real box from.
	 */
	defaultRoi: LightingRoiRect;
}

export const LIGHTING_ROI: LightingRoiConfig = {
	marginFrac: 0.25,
	minMarginNorm: 0.04,
	defaultRoi: { xNorm: 0.15, yNorm: 0.5, widthNorm: 0.7, heightNorm: 0.45 },
};

export interface LightingThresholds {
	/** BT.601 luma (0-255) at/below which a grid cell counts as dark. UNCALIBRATED. */
	cellDarkLumaMax: number;
	/** Recency-weighted fraction of ROI grid cells reading dark before LOW_LIGHT fires. UNCALIBRATED. */
	darkCellFractionThreshold: number;
	/** Hysteresis clear level for LOW_LIGHT: once triggered, the fraction must drop to/below THIS, not just back under darkCellFractionThreshold, before the warning clears. UNCALIBRATED - no ROI-scoped recording exists yet to measure a real noise band, so the gap is a placeholder. */
	darkCellFractionClearThreshold: number;
	/** Per-cell luma standard deviation (0-255) at/below which a cell counts as flat/washed-out. UNCALIBRATED. */
	cellFlatContrastMax: number;
	/** Recency-weighted fraction of ROI grid cells reading flat before LOW_CONTRAST fires. UNCALIBRATED. */
	flatCellFractionThreshold: number;
	/** Hysteresis clear level for LOW_CONTRAST - same convention and same UNCALIBRATED caveat as darkCellFractionClearThreshold above. */
	flatCellFractionClearThreshold: number;
}

export interface DurationThresholds {
	minimumDurationSec: number;
	maximumDurationSec: number;
}

export interface SamplingConfig {
	liveWindowFrameCount: number;
	liveWindowRecencyWeight: number;
	/** Tick rate at which liveWindowRecencyWeight is the effective EWMA alpha; the checks rescale from it to each real inter-frame gap (see markerBoardCheck.ts's resolveEwmaAlpha), so that a per-frame weight describes a fixed wall-clock smoothing speed rather than drifting with tick rate. */
	ewmaReferenceTickHz: number;
	/** Rate the live detect loop is throttled to, decoupled from the display refresh. */
	liveTickHz: number;
	postRecordingSampleFraction: number;
	postRecordingSampleWindow: "middle" | "start" | "end";
}

export interface CaptureQualityConfig {
	markerBoard: MarkerBoardThresholds;
	subjectPosition: SubjectPositionThresholds;
	multiPerson: MultiPersonThresholds;
	lighting: LightingThresholds;
	duration: DurationThresholds;
	sampling: SamplingConfig;
}

// Every numeric value below is a starting point, not a tuned figure, unless the
// comment says otherwise. Values carried over from the prototype (1NonVisibleMarkers.tsx,
// 2SubjectNotAtStart.tsx) are "currently in use" there but were never validated against
// a real marker board either — carrying a value forward is not the same as calibrating it.
export const DEFAULTS: CaptureQualityConfig = {
	markerBoard: {
		// 2026-08-13 "viable range" revision (supersedes the intervening "widened ideal
		// band" revision's own comment below, now trimmed - that widening still stands,
		// only the sizeWarnLowerNorm/sizeWarnUpperNorm numbers and rationale change here).
		// The human recorded a deliberate range sweep -
		// calibration/2026-08-13-gait-viable-range-sweep.cq2.txt - starting at optimal
		// framing, moving closer to the point the board or the person would leave frame,
		// then further to the point the board (and the person) would read too small: n=277,
		// normalizedArea min=0.00149 p5=0.00155 median=0.00278 p95=0.00340 max=0.00344
		// std=0.00068, 75.5% full-set rate across the whole sweep (movement included, not a
		// held-setup number). Everything inside that measured range is framing the human
		// explicitly judged viable. Four boundaries, low to high - see
		// MarkerBoardThresholds's doc for the zone table:
		//
		// sizeWarnLowerNorm=0.0014 - MOVED (was 0.0015, which sat almost exactly ON the
		// sweep's own demonstrated minimum viable, 0.00149 - it would have warned at
		// framing the human called fine). 0.0014 sits just below that measured floor.
		sizeWarnLowerNorm: 0.0014,
		// HYSTERESIS gap = 0.00015, unchanged derivation: good-place-drift's own measured
		// normalizedArea std at a clean, HELD setup (n=262) - the one full-set EWMA noise
		// sample this codebase actually has near a real threshold. The sweep recording's
		// own std (0.00068) reflects the sweep's deliberate movement, not measurement
		// noise, so it is not the right yardstick for a noise margin. Clears at 0.00155 -
		// which lands, coincidentally, almost exactly on the sweep's own measured p5
		// (0.00155).
		sizeWarnLowerClearNorm: 0.00155,
		// sizeIdealLowerNorm=0.0018 - MOVED (was 0.00177) to keep clear daylight above the
		// tightened sizeWarnLowerNorm/sizeWarnLowerClearNorm pair; still a comfortable
		// interior value, not statistically fitted.
		//
		// sizeIdealUpperNorm=0.0032 - UNCHANGED from the 2026-08-13 "widened ideal band"
		// revision: it spans every distance the human has demonstrated as a good setup,
		// not just a single overlay-matched take: ideal-overlay-match (0.00197, 78.3% full-
		// set) through good-place-drift's full range (0.00262-0.00308, 93.6%) through d-mid
		// 1.5m's own median (0.00316, 93.0%). Full picture across all size-bearing
		// recordings (area / full-set rate): d-far 0.00106/26%, ideal-overlay 0.00197/78%,
		// baseline 0.00229/79%, good-place-drift 0.00275/94%, d-mid 0.00316/93%, d-3p5ft
		// 0.00389/99% - detection improves monotonically with size across this entire
		// range, so there is no measured point within it that argues for a narrower band.
		// Deliberately NOT wired into aggregateMarkerBoardMetrics's pass/fail branch (see
		// field doc) - the ideal band exists so the HUD layer
		// (CaptureQualityHud/captureQualityGuidance.ts) can show a positive "looks good"
		// confirmation distinct from silent-acceptable, not so the check can fire a code
		// here.
		sizeIdealLowerNorm: 0.0018,
		sizeIdealUpperNorm: 0.0032,
		// REINTRODUCED 2026-08-13: sizeWarnUpperNorm / MARKER_TOO_LARGE, at 0.0038 (was
		// 0.0028 under the retired "overlay match" model - see the REMOVED note that used
		// to sit here, now trimmed; its reasoning is why 0.0028 was wrong, not an argument
		// against having a boundary here at all). The distinction that matters: this is NOT
		// a re-measured detection limit - marker detection keeps improving past this value
		// (d-3p5ft at normalizedArea=0.00389 measures 99.1% full-set, the best in the whole
		// dataset). What changed is that the human has now explicitly demonstrated and
		// stated a FRAMING limit and its cause (see the sweep recording described above):
		// "any closer and the board would be out of frame or the person would be out of
		// frame" - a walk-path/subject-framing constraint, not a marker-detection one. The
		// sweep's own measured maximum viable normalizedArea is 0.00344; 0.0038 sits above
		// that with margin. This boundary remains a PROXY for the real check (this codebase
		// still cannot see where the subject is in frame - person/subject detection does
		// not exist yet); supersede it with an actual walk-path-framing check (e.g. subject
		// bounding box proximity to frame edges) once that exists, rather than tightening
		// this number further. Unrelated to, and does not affect, tooCloseDetectedAreaNorm
		// below (that boundary only ever applies to a persistent INCOMPLETE set, never a
		// full-set frame - see that field's doc).
		sizeWarnUpperNorm: 0.0038,
		// HYSTERESIS gap = 0.00015, same derivation and same caveat as
		// sizeWarnLowerClearNorm above (good-place-drift's held-setup std; the sweep
		// recording's own std is movement, not noise, so it is not used here). Clears at
		// 0.00365.
		sizeWarnUpperClearNorm: 0.00365,
		// WIDENED (2026-08-12) so this check can never fire. NOT calibrated - diagonalRatio
		// is confounded by three things at once in the six recordings, none isolated:
		// distance (0.238 at 1.5m -> 0.178 at 6ft), rotation (0.238 aligned -> 0.639 at
		// rot-90), and frame aspect ratio (it divides a height-normalized diagonal by a
		// width-normalized one, so it scales with frameWidth/frameHeight, not just skew - see
		// computeDiagonalRatio). A valid skew metric would need to be measured perpendicular
		// to the board's own forward axis (not raw image height/width), and normalized by a
		// distance-invariant reference (e.g. the two diagonals corrected by the known scale
		// from normalizedArea) before it means anything. The metric stays computed and
		// reported (weightedDiagonalRatio/latestDiagonalRatio in details) for future work -
		// only the pass/fail check is disabled. Max is a large finite sentinel rather than
		// Infinity so this config round-trips through JSON (used by callers/tests) - the
		// ratio is mathematically bounded to (0, 1] by construction (min/max of two
		// distances), so anything above 1 already can never fire. Do not tighten these two
		// without building that corrected metric first.
		diagonalRatioMin: 0,
		diagonalRatioMax: 1000,
		// CALIBRATED 2026-08-12 (was 0.3 UNCALIBRATED). Three-point yaw curve, orientationRad
		// median: aligned board 0.152 (max seen across all aligned recordings: 0.160),
		// rot-slight (~43 deg intentional yaw) 0.822 (min seen: 0.774), rot-90 (90 deg yaw)
		// 1.566. 0.45 clears the aligned ceiling and stays well under the misaligned floor.
		// The >0.6 rad gap between aligned and misaligned means most of this margin is
		// headroom for handheld PHONE ROLL, not board tolerance: orientationAngleRad is
		// measured against image up, not the board's own frame (see
		// computeOrientationAngleRad), so a board that IS placed dead-on reads 0.152 rad
		// (8.7 deg) in every single recording - almost certainly the phone being held
		// slightly tilted, not the board. Do not tighten this margin without separating
		// phone roll from board yaw first (e.g. a device-orientation/gravity reading).
		orientationMarginRad: 0.45,
		// HYSTERESIS gap = 0.05 rad. No recording in this dataset sits near the 0.45
		// boundary itself (aligned readings run 0.11-0.28 rad including the noisiest
		// aligned recording, back-away; misaligned readings start at 0.77) so there is no
		// direct "noise straddling this exact threshold" sample the way there is for size
		// and full-set rate. Instead the gap is sized off the largest orientationAngleRad
		// std measured on any clean, full-set-dominant recording - baseline's 0.01628 rad
		// - at roughly 3x that value: enough to absorb realistic phone-roll jitter near the
		// boundary without eating meaningfully into the >0.6 rad separation between aligned
		// and misaligned readings that orientationMarginRad itself relies on (see that
		// field's doc). Revisit if a future recording actually sits near 0.40-0.45 rad.
		orientationClearMarginRad: 0.4,
		// SPEC-GIVEN 2026-08-13 (down from 0.90, itself SPEC-GIVEN 2026-08-12 - see git
		// history). 0.90 produced 18 flaps replaying the overlay-match recording (a GOOD
		// setup by the product's own framing spec) because its raw full-set rate is only
		// 78.3% - nowhere near 0.90. 78.3% full-set is the DESIGNED OPERATING POINT at this
		// framing, not a user error: only nine markers packed tightly at the overlay's
		// specified distance, so momentary single-marker dropout (see marker 2's 18.5%
		// miss rate, longest run 3 frames) is expected, not a defect. 0.60 clears the ideal
		// recording's 78.3% raw rate by ~18 points - comfortably outside the +/-7-point
		// EWMA noise band alpha=0.08 produces on that recording - while d-far 6ft's 26.2%
		// still fails decisively. This also fixes a real regression at 0.90: rot-90 (80.0%
		// raw full-set rate) failed the visibility gate before orientation was ever
		// evaluated, so a rotated board reported as a visibility problem instead of an
		// orientation one. See aggregateMarkerBoardMetrics's priority-order comment for the
		// fix (orientation now evaluated independent of this gate, not behind it).
		minimumFullSetWeight: 0.6,
		// HYSTERESIS gap = 0.07 (7 points), directly matching the +/-7-point EWMA noise
		// band on weightedFullSetScore that minimumFullSetWeight's own doc above already
		// measured. Once the visibility gate fails, weightedFullSetScore must climb to 0.67
		// before geometry/orientation are trusted again. MEASURED CONTRIBUTION (replaying
		// ideal-overlay-match, the file this gap most directly affects): most of the flap
		// reduction here comes from liveWindowRecencyWeight going back to 0.15 (see that
		// field's doc - 42 flaps at the old alpha with no hysteresis down to 14 at the new
		// alpha with no hysteresis), with this gap contributing a further, smaller cut on
		// top (14 -> 13) once alpha is fixed. Both matter and neither alone reaches the
		// other's result - see sampling.liveWindowRecencyWeight's doc for the full
		// alpha-sweep numbers this claim is based on.
		minimumFullSetClearWeight: 0.67,
		// UNCALIBRATED (interpolated 2026-08-13) - a good full board at 3.5ft reads
		// detectedMarkerAreaNorm ~0.0039; the 3ft-cropped recording (which never reaches a
		// full set) reads ~0.0052. 0.0045 sits between them. Paired with sizeWarnLowerNorm
		// (0.0015, not the ideal boundaries - see that field's doc) as the other
		// end of the split: only applies when the set is incomplete AND persistent (see
		// MarkerPersistenceResult) -
		//   > 0.0045                  -> MARKER_TOO_CLOSE (board doesn't fit the frame)
		//   between 0.0015 and this   -> MARKER_OBSTRUCTED (something covering it) - this
		//                                middle band is UNCALIBRATED and effectively
		//                                interpolated air: no recording in this repo shows
		//                                a partially-occluded board at good distance, so
		//                                nothing here has been measured against a real
		//                                occlusion. Treat MARKER_OBSTRUCTED as a reasonable
		//                                guess, not a validated boundary, until that
		//                                recording exists.
		//   < 0.0015                  -> MARKER_INCOMPLETE (too far to resolve)
		tooCloseDetectedAreaNorm: 0.0045,
		// SPEC-GIVEN 2026-08-13 ("~0.5 seconds" per task). Not fitted to a specific
		// boundary recording - chosen because the measured separation is wide either side
		// of it: good setups (d-mid, d-3p5ft-good) peak at 1-2 consecutive frames missing
		// for any single marker (including marker 2, the weakest - see MARKER_BOARD's
		// corners-are-weakest note), while the structural failures (d-3ft-cropped,
		// d-near-2ft) run 200+ consecutive frames missing - effectively permanent for the
		// take. 500ms comfortably clears the former and is trivially cleared by the
		// latter; nothing in this dataset pins down a tighter number.
		persistentMissThresholdMs: 500,
	},
	subjectPosition: {
		displacementNormThreshold: 0.01, // UNCALIBRATED - carried from T_disp_norm (fraction of frame diagonal)
		driftThresholdNorm: 5.0, // UNCALIBRATED, PIXEL UNIT BUG - prototype's T_drift_norm is named as if normalized but is compared directly against raw pixel displacement in 2SubjectNotAtStart.tsx; the value 5.0 is meaningless as a [0,1] fraction. Carried as-is so the bug is visible here rather than silently "fixed" with a guessed conversion; must be re-derived in normalized units during calibration.
		areaChangeMaxPct: 0.5, // UNCALIBRATED - carried from T_area
		areaCoefficientOfVariationMax: 0.12, // UNCALIBRATED - carried from T_area_cv
		startLineDistanceNorm: 500, // UNCALIBRATED, PIXEL UNIT BUG - prototype's distance_from_start (500) is raw pixels, not normalized; needs conversion (e.g. divide by frame diagonal) during calibration, not a resolution-independent value as-is
	},
	multiPerson: {
		proximatePeopleMinGapNorm: 0.05, // UNCALIBRATED GUESS - no prototype precedent; minimum gap between two person bboxes (fraction of frame width) before flagging PROXIMATE_PEOPLE instead of MULTIPLE_PEOPLE
	},
	// UNCALIBRATED GUESSES - no prototype precedent, and no ROI-scoped recording exists
	// yet to fit these against. They are deliberately not tuned to suppress false
	// LOW_CONTRAST warnings; scoping the grid to the board (see lowLightCheck.ts's header)
	// is what addresses those. A dark-but-uniform room and a bright-but-flat one are
	// different failure modes with different remedies (add light vs. reduce glare), hence
	// two independent thresholds rather than one combined "lighting is bad" number.
	lighting: {
		cellDarkLumaMax: 40,
		darkCellFractionThreshold: 0.2,
		darkCellFractionClearThreshold: 0.15,
		cellFlatContrastMax: 10,
		flatCellFractionThreshold: 0.2,
		flatCellFractionClearThreshold: 0.15,
	},
	duration: {
		minimumDurationSec: 1.0, // UNCALIBRATED GUESS - no prototype precedent; see per-assessment overrides below for why this needs to vary by assessment
		maximumDurationSec: 120, // UNCALIBRATED GUESS - no prototype precedent
	},
	sampling: {
		liveWindowFrameCount: 15, // UNCALIBRATED GUESS - rolling recency-weighted window size for pre-recording (live preview) checks
		// REVERTED 2026-08-13 (back to 0.15, was LOOSENED to 0.08 earlier the same day - see
		// git history) now that hysteresis (see MarkerBoardHysteresisState /
		// applyHysteresis) is the mechanism actually responsible for flapping resistance.
		// The 0.08 loosening was reasoned about backwards: a SMALLER alpha means MORE
		// smoothing (longer effective averaging span), and at this window length that
		// longer span lets marker 2's frequent-but-short dropouts (see the ideal-overlay
		// recording's 18.5% miss rate, scattered in bursts up to 3 frames) compound within
		// the average instead of being smoothed away - measured directly: replaying
		// ideal-overlay-match with hysteresis held constant, alpha=0.08 produces 40 flaps,
		// alpha=0.15 produces 13 (alpha=0.2 is worse again, at 21 - this is a real optimum,
		// not "more alpha is always better"). The same reversal shows on good-place-drift
		// (3 flaps at 0.08, 1 at 0.15) and baseline (47 at 0.08, 16 at 0.15), with no
		// classification change on any recording that must still warn (d-far, d-near,
		// 3ft-cropped, rot-slight, rot-90 all keep the same dominant code and flap count).
		// See markerBoardCheck.test.ts's end-to-end classification suite for the pinned,
		// measured flap counts this combination produces. Do not change either this or the
		// hysteresis clear-level fields without re-running that replay.
		liveWindowRecencyWeight: 0.15,
		// The thirteen calibration recordings averaged 28-43fps, so 30 is a nominal midpoint
		// rather than a measured constant: alpha=0.15 was fitted per-frame across that whole
		// spread, and no single rate is "the" rate it was fitted at. Changing this rescales
		// every EWMA and invalidates the pinned replay expectations.
		ewmaReferenceTickHz: 30,
		liveTickHz: 8, // UNCALIBRATED - no measurement of how slow the checks can tick before guidance feels laggy
		postRecordingSampleFraction: 0.5, // spec-given: sample the middle 50% of the recorded video for most post-recording checks
		postRecordingSampleWindow: "middle", // spec-given positioning convention; not every check will use it (e.g. VIDEO_TOO_SHORT/VIDEO_TOO_LONG need the full timeline, not a sampled window)
	},
};

/**
 * Which check codes VIDEO_TOO_SHORT/VIDEO_TOO_LONG apply duration.* thresholds to is
 * assessment-dependent (a TUG trial and a 4M gait trial have different expected
 * lengths). Listed here only for documentation; the orchestrator decides which codes
 * a given assessment runs.
 */
export const DURATION_SENSITIVE_CODES: readonly CaptureQualityIssueCode[] = [
	"VIDEO_TOO_SHORT",
	"VIDEO_TOO_LONG",
];

type ConfigOverride = {
	[K in keyof CaptureQualityConfig]?: Partial<CaptureQualityConfig[K]>;
};

/**
 * Per-assessment threshold overrides, keyed by the exact backend ASSESSMENTS key from
 * WebsiteCode/Website/src/components/Common/Globals.ts (not invented names). Only the
 * marker/start-line assessments (gait, TUG, sit-to-stand) are listed: those are the
 * ones that record against the floor ArUco board and a start line. Hand/grip
 * assessments don't use a floor marker board, so they're left on DEFAULTS entirely
 * until a use case for overriding them shows up.
 *
 * The duration overrides below are illustrative of the mechanism, not measured
 * numbers - flagged the same as everything else in DEFAULTS.
 */
export const ASSESSMENT_CONFIG_OVERRIDES: Partial<Record<string, ConfigOverride>> = {
	"Gait: 4M (home)": {
		duration: { minimumDurationSec: 2.0, maximumDurationSec: 30 }, // UNCALIBRATED GUESS
	},
	"Gait: 4M (clinic)": {
		duration: { minimumDurationSec: 2.0, maximumDurationSec: 30 }, // UNCALIBRATED GUESS
	},
	"Gait: 4M One-Way (clinic)": {
		duration: { minimumDurationSec: 1.5, maximumDurationSec: 20 }, // UNCALIBRATED GUESS
	},
	"TUG (home)": {
		duration: { minimumDurationSec: 5.0, maximumDurationSec: 60 }, // UNCALIBRATED GUESS
	},
	"TUG (clinic)": {
		duration: { minimumDurationSec: 5.0, maximumDurationSec: 60 }, // UNCALIBRATED GUESS
	},
	"Sit-to-Stand: 5x (home)": {
		duration: { minimumDurationSec: 5.0, maximumDurationSec: 60 }, // UNCALIBRATED GUESS
	},
	"Sit-to-Stand: 5x (clinic)": {
		duration: { minimumDurationSec: 5.0, maximumDurationSec: 60 }, // UNCALIBRATED GUESS
	},
	"Sit-to-Stand: 30s (clinic)": {
		duration: { minimumDurationSec: 25.0, maximumDurationSec: 40 }, // UNCALIBRATED GUESS
	},
	"Sit-to-Stand: 10x (clinic)": {
		duration: { minimumDurationSec: 8.0, maximumDurationSec: 90 }, // UNCALIBRATED GUESS
	},
};

function mergeCategory<T extends object>(base: T, override: Partial<T> | undefined): T {
	if (!override) return base;
	return { ...base, ...override };
}

/** Resolves the effective config for an assessment: DEFAULTS with that assessment's overrides applied, one category at a time. */
export function resolveCaptureQualityConfig(assessmentKey: string): CaptureQualityConfig {
	const override = ASSESSMENT_CONFIG_OVERRIDES[assessmentKey];
	return {
		markerBoard: mergeCategory(DEFAULTS.markerBoard, override?.markerBoard),
		subjectPosition: mergeCategory(DEFAULTS.subjectPosition, override?.subjectPosition),
		multiPerson: mergeCategory(DEFAULTS.multiPerson, override?.multiPerson),
		lighting: mergeCategory(DEFAULTS.lighting, override?.lighting),
		duration: mergeCategory(DEFAULTS.duration, override?.duration),
		sampling: mergeCategory(DEFAULTS.sampling, override?.sampling),
	};
}

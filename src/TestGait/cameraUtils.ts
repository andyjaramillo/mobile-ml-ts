// [Feature: Test Gait]
//
// Ported from WebsiteCode/Website/src/pages/MobilePage/MobileComponents/CameraUtils/
// {codecUtils,bitrateUtils}.ts — the MediaRecorder configuration is part of what this
// harness is testing, so it must match, not be reinvented. The only change from the
// source is inlining the VIDEO_MP4/VIDEO_WEBM literals instead of importing Website's
// src/components/Common/Globals.ts, which pulls in far more than these two constants.

const VIDEO_MP4 = "video/mp4";
const VIDEO_WEBM = "video/webm";

function isMobileDevice(): boolean {
	const userAgent = window.navigator.userAgent || window.navigator.vendor || "";
	if (/android|iphone|ipad|ipod|blackberry|windows phone|iemobile|opera mini/i.test(userAgent)) {
		return true;
	}
	if (/macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1) {
		return true;
	}
	return window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Detects the best supported MIME type for video recording. Prioritizes H.264 High
 * Profile for best quality, with fallbacks — see bitrateUtils' calculateBitrate for why
 * the fallback chain matters (Baseline-only encoders need much more bitrate).
 */
export function getSupportedMimeType(): string {
	const codecs = [
		"video/mp4;codecs=avc1.640028",
		"video/mp4;codecs=avc1.64001f",
		"video/mp4;codecs=avc1.4d001f",
		"video/mp4;codecs=avc1.4d001e",
		"video/mp4;codecs=avc1.42001e",
		"video/mp4;codecs=avc1.42e01e",
		"video/mp4",
		"video/webm;codecs=vp9",
		"video/webm;codecs=vp8",
		"video/webm",
	];

	for (const codec of codecs) {
		if (MediaRecorder.isTypeSupported(codec)) {
			return codec;
		}
	}

	return isMobileDevice() ? VIDEO_MP4 : VIDEO_WEBM;
}

/**
 * Calculates appropriate bitrate based on resolution and frame rate. Base is high
 * (~16Mbps at 1080p30) because many mobile browsers (notably Android Chrome) can only
 * RECORD Constrained Baseline H.264 via MediaRecorder regardless of the codec preference
 * above — extra bitrate compensates for that encoder's lower efficiency.
 */
export function calculateBitrate(width: number, height: number, frameRate: number): number {
	const pixels = width * height;
	const baseBitrate = 16_000_000;
	const basePixels = 1920 * 1080;
	const baseFrameRate = 30;

	const bitrate = Math.round((baseBitrate * pixels / basePixels) * (frameRate / baseFrameRate));

	const minBitrate = 4_000_000;
	const maxBitrate = 24_000_000;

	return Math.max(minBitrate, Math.min(maxBitrate, bitrate));
}

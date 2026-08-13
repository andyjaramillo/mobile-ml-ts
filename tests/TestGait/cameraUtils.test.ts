import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateBitrate, getSupportedMimeType } from "../../src/TestGait/cameraUtils";

describe("calculateBitrate", () => {
	it("returns ~16Mbps at 1080p30 (the documented baseline)", () => {
		expect(calculateBitrate(1920, 1080, 30)).toBe(16_000_000);
	});

	it("scales down for a smaller resolution", () => {
		expect(calculateBitrate(1280, 720, 30)).toBeLessThan(16_000_000);
	});

	it("never drops below the 4Mbps floor", () => {
		expect(calculateBitrate(160, 120, 5)).toBe(4_000_000);
	});

	it("never exceeds the 24Mbps ceiling", () => {
		expect(calculateBitrate(3840, 2160, 60)).toBe(24_000_000);
	});
});

describe("getSupportedMimeType", () => {
	const originalMediaRecorder = (globalThis as any).MediaRecorder;
	const originalMatchMedia = window.matchMedia;

	afterEach(() => {
		(globalThis as any).MediaRecorder = originalMediaRecorder;
		window.matchMedia = originalMatchMedia;
	});

	it("returns the first codec MediaRecorder reports as supported", () => {
		(globalThis as any).MediaRecorder = {
			isTypeSupported: vi.fn((codec: string) => codec === "video/mp4;codecs=avc1.4d001f"),
		};
		expect(getSupportedMimeType()).toBe("video/mp4;codecs=avc1.4d001f");
	});

	it("falls back to a bare mime type when no codec string is supported", () => {
		(globalThis as any).MediaRecorder = { isTypeSupported: vi.fn(() => false) };
		window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
		const result = getSupportedMimeType();
		expect(["video/mp4", "video/webm"]).toContain(result);
	});
});

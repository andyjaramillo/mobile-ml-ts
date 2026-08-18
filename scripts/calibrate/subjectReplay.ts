// Replays a CQ4 recording's person samples through the REAL subject-position check, the
// same way replay.ts does for markers and lightingReplay.ts does for lighting. Nothing here
// reimplements a threshold or a metric: it reconstructs SubjectPositionFrameMetrics from the
// raw fields the recorder stored and hands them to aggregateSubjectPositionMetrics.
//
// Timestamps are reconstructed from each sample's own tickIndex and the recording's mean
// fps, because CQ4 stores no clock. That is why the format carries tickIndex per sample
// rather than assuming an even spacing - person detection is round-robined, so the gaps
// between stored samples are not uniform with the marker samples.
import { aggregateSubjectPositionMetrics } from "../../src/CaptureQuality/subjectPositionCheck";
import type {
	SubjectPositionCheckConfig,
	SubjectPositionFrameMetrics,
	SubjectPositionWindowAggregate,
} from "../../src/CaptureQuality/subjectPositionCheck";
import type { ParsedCaptureRecording } from "./parse";

export function reconstructSubjectMetrics(recording: ParsedCaptureRecording): SubjectPositionFrameMetrics[] {
	const { frameWidth: W, frameHeight: H, fpsMean } = recording;
	const tickMs = fpsMean > 0 ? 1000 / fpsMean : 1000 / 3;
	return (recording.personSamples ?? []).map((s) => {
		const subjectCentroid =
			s.subjectCentroidXNorm === null || s.subjectCentroidYNorm === null
				? null
				: { x: s.subjectCentroidXNorm * W, y: s.subjectCentroidYNorm * H };
		const boardCentroid =
			s.boardCentroidXNorm === null || s.boardCentroidYNorm === null
				? null
				: { x: s.boardCentroidXNorm * W, y: s.boardCentroidYNorm * H };
		const boardLengthPx = s.boardLengthNorm === null ? null : s.boardLengthNorm * W;
		const startLineDistanceBoardLengths =
			subjectCentroid && boardCentroid && boardLengthPx
				? Math.hypot(subjectCentroid.x - boardCentroid.x, subjectCentroid.y - boardCentroid.y) / boardLengthPx
				: null;
		return {
			timestampMs: s.tickIndex * tickMs,
			personCount: s.personCount,
			// The bbox itself is not stored - only its centroid and area, which is everything
			// the aggregation reads. subjectBBox stays null rather than being invented.
			subjectBBox: null,
			subjectCentroid,
			subjectAreaNorm: s.subjectAreaNorm,
			boardCentroid,
			boardLengthPx,
			startLineDistanceBoardLengths,
			boardToSubjectGapNorm:
				subjectCentroid && boardCentroid ? (boardCentroid.y - subjectCentroid.y) / H : null,
		};
	});
}

export function replaySubjectRecording(
	recording: ParsedCaptureRecording,
	config: SubjectPositionCheckConfig
): SubjectPositionWindowAggregate {
	return aggregateSubjectPositionMetrics(reconstructSubjectMetrics(recording), config);
}

import type { Project } from './session';
import { transcriptForSource } from './review-source.ts';
import { transcriptFillerMarks } from './transcript-fillers.ts';

export function fillerTimelineMarks(project: Project, segments: readonly { uri: string; t0: number; t1: number }[]) {
  let offset = 0;
  const sourceOccurrences = new Map<string, number>();
  return segments.flatMap((segment, index) => {
    if (!Number.isFinite(segment.t0) || !Number.isFinite(segment.t1) || segment.t0 < 0 || segment.t1 <= segment.t0) return [];
    const start = offset;
    offset += segment.t1 - segment.t0;
    const sourceOccurrence = sourceOccurrences.get(segment.uri) ?? 0;
    sourceOccurrences.set(segment.uri, sourceOccurrence + 1);
    return transcriptFillerMarks(transcriptForSource(project, segment.uri)).flatMap(mark => {
      const t0 = Math.max(mark.t0, segment.t0);
      const t1 = Math.min(mark.t1, segment.t1);
      if (t1 <= t0) return [];
      return [{ ...mark, id: `${index}:${mark.id}`, t0: start + t0 - segment.t0, t1: start + t1 - segment.t0,
        sourceUri: segment.uri, sourceTime: t0, sourceEnd: t1, sourceSegmentIndex: index, sourceOccurrence }];
    });
  });
}

export type TranscriptTimelineMark = ReturnType<typeof fillerTimelineMarks>[number];

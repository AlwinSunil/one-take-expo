import type { Project } from './session';

export type ReviewSegment = NonNullable<Project['reviewSegments']>[number];
export type TimelineFields = Pick<Project, 'cuts' | 'reviewSegments' | 'cutsReviewed'>;

export interface FillerRemovalTarget {
  sourceUri: string;
  sourceStart: number;
  sourceEnd: number;
  /** Index in the exact clean sequence used to show the marker. */
  sourceSegmentIndex?: number;
  /** Occurrence among segments from sourceUri, used when an index is unavailable. */
  sourceOccurrence?: number;
}

export interface FillerRemovalSnapshot {
  before: TimelineFields;
  after: TimelineFields;
}

const MIN_RANGE = 0.001;
const MAX_SEGMENTS = 100;

function copyTimeline(fields: TimelineFields): TimelineFields {
  return {
    cuts: fields.cuts?.map(cut => ({ ...cut })),
    reviewSegments: fields.reviewSegments?.map(segment => segment.captions === undefined
      ? { ...segment }
      : { ...segment, captions: segment.captions.map(caption => ({ ...caption })) }),
    cutsReviewed: fields.cutsReviewed,
  };
}

export function timelineFields(project: Pick<Project, 'cuts' | 'reviewSegments' | 'cutsReviewed'>): TimelineFields {
  return copyTimeline(project);
}

function sameTimeline(a: TimelineFields, b: TimelineFields): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clippedCaptions(segment: ReviewSegment, start: number, end: number) {
  if (!segment.captions) return undefined;
  return segment.captions.flatMap(caption => {
    const t0 = Math.max(start, caption.t0);
    const t1 = Math.min(end, caption.t1);
    return t1 - t0 > MIN_RANGE ? [{ ...caption, t0, t1 }] : [];
  });
}

function copySegment(segment: ReviewSegment): ReviewSegment {
  if (!segment.captions) return { ...segment };
  return { ...segment, captions: segment.captions.map(caption => ({ ...caption })) };
}

function copySegmentWithRange(segment: ReviewSegment, t0: number, t1: number): ReviewSegment {
  const captions = clippedCaptions(segment, t0, t1);
  if (captions === undefined) return { ...segment, t0, t1 };
  return { ...segment, t0, t1, captions };
}

function splitSegment(segment: ReviewSegment, start: number, end: number): ReviewSegment[] {
  const result: ReviewSegment[] = [];
  if (start - segment.t0 > MIN_RANGE) {
    result.push(copySegmentWithRange(segment, segment.t0, start));
  }
  if (segment.t1 - end > MIN_RANGE) {
    result.push(copySegmentWithRange(segment, end, segment.t1));
  }
  return result;
}

function findTargetIndex(segments: readonly ReviewSegment[], target: FillerRemovalTarget): number {
  if (typeof target.sourceSegmentIndex === 'number') {
    const index = target.sourceSegmentIndex;
    const segment = segments[index];
    if (!segment || segment.uri !== target.sourceUri) throw new Error('This filler belongs to a different source segment.');
    return index;
  }

  const sourceIndexes = segments.flatMap((segment, index) => segment.uri === target.sourceUri ? [index] : []);
  if (typeof target.sourceOccurrence === 'number') {
    const index = sourceIndexes[target.sourceOccurrence];
    if (index === undefined) throw new Error('This filler occurrence is no longer in the clean sequence.');
    return index;
  }
  const candidates = sourceIndexes.filter(index => {
    const segment = segments[index];
    return segment.t0 < target.sourceEnd && segment.t1 > target.sourceStart;
  });
  if (candidates.length !== 1) throw new Error('This filler occurrence is ambiguous. Reopen the editor and preview it again.');
  return candidates[0];
}

/** Remove one source-relative filler range while retaining every other segment and its metadata. */
export function removeFillerFromSegments(
  segments: readonly ReviewSegment[], target: FillerRemovalTarget,
): ReviewSegment[] {
  if (!Array.isArray(segments) || !segments.length) throw new Error('The clean sequence is empty.');
  if (typeof target.sourceUri !== 'string' || !target.sourceUri
    || !Number.isFinite(target.sourceStart) || !Number.isFinite(target.sourceEnd)
    || target.sourceEnd <= target.sourceStart) throw new Error('The filler range is invalid.');

  const targetIndex = findTargetIndex(segments, target);
  const segment = segments[targetIndex];
  if (!Number.isFinite(segment.t0) || !Number.isFinite(segment.t1) || segment.t1 <= segment.t0) {
    throw new Error('The selected source segment is invalid.');
  }
  const start = Math.max(segment.t0, target.sourceStart);
  const end = Math.min(segment.t1, target.sourceEnd);
  if (end - start <= MIN_RANGE) throw new Error('The filler range no longer overlaps this source segment.');

  const result = segments.flatMap((item, index) => index === targetIndex ? splitSegment(item, start, end) : [copySegment(item)]);
  if (!result.length) throw new Error('Keep at least one video segment.');
  if (result.length > MAX_SEGMENTS) throw new Error('This edit would create too many video segments.');
  return result;
}

export function createFillerRemovalSnapshot(before: TimelineFields, after: TimelineFields): FillerRemovalSnapshot {
  return { before: copyTimeline(before), after: copyTimeline(after) };
}

/** Restore only the timeline changed by this removal when no later timeline edit replaced it. */
export function restoreFillerRemoval<T extends Pick<Project, 'cuts' | 'reviewSegments' | 'cutsReviewed'>>(
  current: T, snapshot: FillerRemovalSnapshot,
): T | null {
  if (!sameTimeline(timelineFields(current), snapshot.after)) return null;
  return { ...current, ...copyTimeline(snapshot.before) };
}

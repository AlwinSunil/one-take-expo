import type { TranscriptSeg } from './session';

export interface FillerTextPart {
  text: string;
  isFiller: boolean;
}

export interface TranscriptFillerMark {
  id: string;
  label: string;
  t0: number;
  t1: number;
  segmentId: string;
  recordingId?: string;
}

interface FillerMatch {
  token: string;
  start: number;
  end: number;
}

// Keep this list deliberately small.  Words such as "like", "so" and
// "well" depend on sentence context and should remain ordinary transcript
// text until a contextual detector exists.
const FILLER_PATTERN = /umm|uhh|hmm|erm|um|uh|er/giu;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Split caption text around unambiguous vocal fillers without changing any
 * character, whitespace, or punctuation in the supplied text.
 */
export function splitFillerText(text: string): FillerTextPart[] {
  if (typeof text !== 'string') throw new TypeError('transcript text must be a string');

  const parts: FillerTextPart[] = [];
  let cursor = 0;
  for (const match of fillerMatches(text)) {
    if (match.start > cursor) parts.push({ text: text.slice(cursor, match.start), isFiller: false });
    parts.push({ text: text.slice(match.start, match.end), isFiller: true });
    cursor = match.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), isFiller: false });
  return parts;
}

/**
 * Turn saved transcript segments into source-local review markers.
 *
 * Recognition gives us utterance timing rather than word timing, so token
 * positions are only proportional estimates within each valid segment.  The
 * ranges are clamped to the segment and optional source duration, and never
 * authorize a cut.
 */
export function transcriptFillerMarks(
  segments: readonly TranscriptSeg[],
  duration?: number,
): TranscriptFillerMark[] {
  if (!Array.isArray(segments)) throw new TypeError('transcript segments must be an array');
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) return [];

  const marks: TranscriptFillerMark[] = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    if (!segment || typeof segment !== 'object') continue;
    if (!Number.isFinite(segment.t0) || !Number.isFinite(segment.t1) || segment.t1 <= segment.t0) continue;
    if (typeof segment.text !== 'string') continue;

    const text = effectiveSegmentText(segment);
    if (!text) continue;

    const t0 = Math.max(0, segment.t0);
    const t1 = Math.min(segment.t1, duration ?? segment.t1);
    if (!(t1 > t0)) continue;

    const segmentId = typeof segment.id === 'string' && segment.id.trim()
      ? segment.id
      : `segment-${segmentIndex}`;
    const recordingId = typeof segment.recordingId === 'string' && segment.recordingId.trim()
      ? segment.recordingId
      : undefined;
    const span = t1 - t0;
    for (const match of fillerMatches(text)) {
      const start = t0 + (match.start / text.length) * span;
      const end = t0 + (match.end / text.length) * span;
      const markerStart = Math.max(t0, Math.min(t1, start));
      const markerEnd = Math.max(t0, Math.min(t1, end));
      if (!(markerEnd > markerStart)) continue;
      const label = match.token.toLocaleLowerCase();
      marks.push({
        id: `${recordingId ?? 'transcript'}:${segmentId}:filler:${match.start}:${label}`,
        label,
        t0: markerStart,
        t1: markerEnd,
        segmentId,
        ...(recordingId ? { recordingId } : {}),
      });
    }
  }
  return marks;
}

function effectiveSegmentText(segment: TranscriptSeg): string {
  const text = segment.manualCorrection ?? segment.correctedText ?? segment.text;
  return typeof text === 'string' ? text : '';
}

function fillerMatches(text: string): FillerMatch[] {
  const matches: FillerMatch[] = [];
  for (const match of text.matchAll(FILLER_PATTERN)) {
    const token = match[0];
    const start = match.index ?? 0;
    const end = start + token.length;
    if (isWordCharacterAt(text, start - 1) || isWordCharacterAt(text, end)) continue;
    matches.push({ token, start, end });
  }
  return matches;
}

function isWordCharacterAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) return false;
  return WORD_CHARACTER.test(String.fromCodePoint(codePoint));
}

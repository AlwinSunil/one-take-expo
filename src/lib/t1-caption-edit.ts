/**
 * Pure word-level caption editing for the Tier 1 review surface.
 *
 * The recognizer's `text`, timing and revision remain immutable evidence.
 * A saved correction is carried only in `manualCorrection`, which existing
 * project persistence and caption export already prefer for display.
 */

export interface CaptionSegmentLike {
  id: string;
  text: string;
  manualCorrection?: string | null;
  correctedText?: string | null;
  revision?: number;
}

export interface CaptionWord {
  index: number;
  text: string;
  start: number;
  end: number;
}

export interface CaptionWordEditDraft {
  segmentId: string;
  wordIndex: number;
  expectedRevision: number;
  expectedRawText: string;
  expectedCorrectedText: string | null | undefined;
  beforeDisplayText: string;
  beforeManualCorrection: string | null | undefined;
  beforeWord: string;
}

export interface CaptionWordEdit extends CaptionWordEditDraft {
  afterWord: string;
  afterDisplayText: string;
  afterManualCorrection: string;
}

export class StaleCaptionEditError extends Error {
  readonly code = 'STALE_SEGMENT';
  readonly segmentId: string;

  constructor(segmentId: string, reason: string) {
    super(`Caption segment ${segmentId} changed while it was being edited: ${reason}.`);
    this.name = 'StaleCaptionEditError';
    this.segmentId = segmentId;
  }
}

/** Return the text a creator sees while retaining raw recognition separately. */
export function captionDisplayText(segment: CaptionSegmentLike): string {
  assertSegment(segment);
  return segment.manualCorrection ?? segment.correctedText ?? segment.text;
}

/**
 * Find word ranges without consuming adjacent punctuation or whitespace.
 * Ranges are source-text offsets, so replacing a word keeps the original
 * spacing and punctuation intact.
 */
export function splitCaptionWords(text: string): CaptionWord[] {
  if (typeof text !== 'string') throw new TypeError('caption text must be a string');

  const words: CaptionWord[] = [];
  const pattern = /[A-Za-zÀ-ÖØ-öø-ÿ0-9]+(?:['’‑-][A-Za-zÀ-ÖØ-öø-ÿ0-9]+)*/gu;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const start = match.index;
    words.push({ index: words.length, text: value, start, end: start + value.length });
  }
  return words;
}

/** Replace exactly one word while leaving punctuation and spacing untouched. */
export function replaceCaptionWord(text: string, wordIndex: number, replacement: string): string {
  if (typeof text !== 'string') throw new TypeError('caption text must be a string');
  const normalized = normalizeReplacement(replacement);
  const word = wordAt(text, wordIndex);
  return `${text.slice(0, word.start)}${normalized}${text.slice(word.end)}`;
}

/** Capture the immutable segment state required for an explicit word save. */
export function beginCaptionWordEdit(
  segment: CaptionSegmentLike,
  wordIndex: number,
): CaptionWordEditDraft {
  assertSegment(segment);
  const displayText = captionDisplayText(segment);
  const word = wordAt(displayText, wordIndex);
  return {
    segmentId: segment.id,
    wordIndex,
    expectedRevision: segmentRevision(segment),
    expectedRawText: segment.text,
    expectedCorrectedText: segment.correctedText,
    beforeDisplayText: displayText,
    beforeManualCorrection: segment.manualCorrection,
    beforeWord: word.text,
  };
}

/**
 * Commit one explicit word correction.
 *
 * The returned edit record is intentionally small and can be retained by a
 * review screen for an immediate undo.  The record also validates that the
 * same evidence is still current before mutating anything.
 */
export function saveCaptionWordEdit<T extends CaptionSegmentLike>(
  segments: readonly T[],
  draft: CaptionWordEditDraft,
  replacement: string,
): { segments: T[]; edit: CaptionWordEdit } {
  const normalized = normalizeReplacement(replacement);
  const index = findSegmentIndex(segments, draft.segmentId);
  const current = segments[index];
  assertDraftIsCurrent(current, draft);

  const afterDisplayText = replaceCaptionWord(draft.beforeDisplayText, draft.wordIndex, normalized);
  const edit: CaptionWordEdit = {
    ...draft,
    afterWord: normalized,
    afterDisplayText,
    afterManualCorrection: afterDisplayText,
  };
  const next = segments.slice();
  next[index] = { ...current, manualCorrection: afterDisplayText };
  return { segments: next, edit };
}

/**
 * Undo a previously saved edit if no newer evidence or correction replaced it.
 * The original recognition text and timing are carried through untouched.
 */
export function undoCaptionWordEdit<T extends CaptionSegmentLike>(
  segments: readonly T[],
  edit: CaptionWordEdit,
): T[] {
  const index = findSegmentIndex(segments, edit.segmentId);
  const current = segments[index];
  assertEvidenceIsCurrent(current, edit);
  if (current.manualCorrection !== edit.afterManualCorrection
    || captionDisplayText(current) !== edit.afterDisplayText) {
    throw new StaleCaptionEditError(edit.segmentId, 'display text changed');
  }

  const next = segments.slice();
  next[index] = {
    ...current,
    manualCorrection: edit.beforeManualCorrection ?? null,
  };
  return next;
}

/**
 * Reset a persisted correction to the current recognized display.
 * This is the reopen-safe fallback when an in-memory edit history no longer
 * exists.  It does not alter raw text, timing, revision or refined text.
 */
export function clearCaptionCorrection<T extends CaptionSegmentLike>(
  segments: readonly T[],
  segmentId: string,
  expectedDisplayText?: string,
): T[] {
  const index = findSegmentIndex(segments, segmentId);
  const current = segments[index];
  if (expectedDisplayText !== undefined && captionDisplayText(current) !== expectedDisplayText) {
    throw new StaleCaptionEditError(segmentId, 'display text changed');
  }

  const next = segments.slice();
  next[index] = { ...current, manualCorrection: null };
  return next;
}

function assertSegment(segment: CaptionSegmentLike): void {
  if (!segment || typeof segment !== 'object') throw new TypeError('caption segment is required');
  if (typeof segment.id !== 'string' || !segment.id.trim()) {
    throw new TypeError('caption segment id must be a non-empty string');
  }
  if (typeof segment.text !== 'string') throw new TypeError('caption segment text must be a string');
  segmentRevision(segment);
}

function segmentRevision(segment: CaptionSegmentLike): number {
  const revision = segment.revision ?? 0;
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RangeError('caption segment revision must be a non-negative integer');
  }
  return revision;
}

function wordAt(text: string, wordIndex: number): CaptionWord {
  if (!Number.isInteger(wordIndex) || wordIndex < 0) throw new RangeError('word index must be a non-negative integer');
  const word = splitCaptionWords(text)[wordIndex];
  if (!word) throw new RangeError(`word index ${wordIndex} is outside the caption`);
  return word;
}

function normalizeReplacement(replacement: string): string {
  if (typeof replacement !== 'string' || !replacement.trim()) {
    throw new TypeError('caption correction must be non-empty');
  }
  const normalized = replacement.trim();
  if (/\s/u.test(normalized)) throw new TypeError('caption correction must be a single word');
  return normalized;
}

function findSegmentIndex<T extends CaptionSegmentLike>(segments: readonly T[], segmentId: string): number {
  if (!Array.isArray(segments)) throw new TypeError('caption segments must be an array');
  const indexes = segments
    .map((segment, index) => segment.id === segmentId ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length === 0) throw new Error(`unknown caption segment: ${segmentId}`);
  if (indexes.length > 1) throw new Error(`ambiguous caption segment: ${segmentId}`);
  return indexes[0];
}

function assertDraftIsCurrent(
  segment: CaptionSegmentLike,
  draft: Pick<CaptionWordEditDraft, 'segmentId' | 'expectedRevision' | 'expectedRawText' | 'expectedCorrectedText' | 'beforeDisplayText'>,
): void {
  assertEvidenceIsCurrent(segment, draft);
  if (captionDisplayText(segment) !== draft.beforeDisplayText) {
    throw new StaleCaptionEditError(draft.segmentId, 'display text changed');
  }
}

function assertEvidenceIsCurrent(
  segment: CaptionSegmentLike,
  draft: Pick<CaptionWordEditDraft, 'segmentId' | 'expectedRevision' | 'expectedRawText' | 'expectedCorrectedText'>,
): void {
  assertSegment(segment);
  if (segmentRevision(segment) !== draft.expectedRevision) {
    throw new StaleCaptionEditError(draft.segmentId, 'recognition revision changed');
  }
  if (segment.text !== draft.expectedRawText || segment.correctedText !== draft.expectedCorrectedText) {
    throw new StaleCaptionEditError(draft.segmentId, 'raw evidence changed');
  }
}

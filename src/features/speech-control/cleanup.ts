/**
 * Evidence-first Assisted Mode cleanup.
 *
 * This module only describes review candidates.  It never changes a
 * transcript, cuts a media file, or treats an ASR timestamp as a splice
 * boundary.  Callers can persist the returned decisions beside their project
 * and ask the creator to listen before preparing a reversible removal.
 */

export type CleanupBoundarySource =
  | 'independent-silence'
  | 'saved-audio'
  | 'manual-review'
  | 'recognition-only'
  | 'unknown';

export interface CleanupBoundaryEvidence {
  source?: CleanupBoundarySource;
  verified?: boolean;
  detail?: string;
}

export interface CleanupInterval {
  t0: number;
  t1: number;
}

/** The minimum observation needed by the cleanup adapter. */
export interface CleanupTranscriptSegment {
  id: string;
  /** Stable recording identity; segments from different recordings are never compared. */
  recordingId?: string;
  t0: number;
  t1: number;
  text: string;
  isFinal?: boolean;
  confidence?: number;
  /** A recognizer or reviewer marked this text as uncertain. */
  uncertain?: boolean;
  /** Deliberate repeats are retained and do not create automatic candidates. */
  intentionalRepeat?: boolean;
}

export interface CleanupSilence extends CleanupInterval {
  id: string;
  recordingId?: string;
  /** A pause explicitly retained by the creator. */
  deliberate?: boolean;
  /** Legacy boolean is retained as an unverified marker without provenance. */
  verifiedBoundary?: boolean;
  boundarySource?: CleanupBoundarySource;
  startBoundary?: CleanupBoundaryEvidence;
  endBoundary?: CleanupBoundaryEvidence;
}

export type CleanupMarkKind = 'filler' | 'mumble' | 'uncertain';

export interface CleanupMark extends CleanupInterval {
  id: string;
  recordingId?: string;
  kind: CleanupMarkKind;
  text: string;
  segmentId?: string;
  confidence?: number;
  /** Mid-sentence filler removal is intentionally disabled by default. */
  isMidSentence?: boolean;
  safeBoundary?: boolean;
  boundarySource?: CleanupBoundarySource;
  startBoundary?: CleanupBoundaryEvidence;
  endBoundary?: CleanupBoundaryEvidence;
}

export interface CleanupOptions {
  minSilenceSeconds?: number;
  restartGapSeconds?: number;
  repeatGapSeconds?: number;
  minRestartPrefixWords?: number;
  uncertaintyThreshold?: number;
}

export interface CleanupInput extends CleanupOptions {
  recordingId?: string;
  segments: readonly CleanupTranscriptSegment[];
  silences?: readonly CleanupSilence[];
  marks?: readonly CleanupMark[];
  /** Convenience inputs for native and saved-audio adapters. */
  fillerMarks?: readonly CleanupMarkInput[];
  mumbleMarks?: readonly CleanupMarkInput[];
  uncertainMarks?: readonly CleanupMarkInput[];
}

export type CleanupMarkInput = Omit<CleanupMark, 'kind'> & { kind?: CleanupMarkKind };

export type CleanupSuggestionKind =
  | 'long-silence'
  | 'restarted-attempt'
  | 'suitable-repeat'
  | 'filler'
  | 'mumble'
  | 'uncertain';

export type CleanupSuggestionAction = 'review-removal' | 'mark';
export type CleanupBoundaryStatus = 'safe' | 'uncertain';

export interface CleanupEvidence {
  type: 'silence' | 'transcript' | 'speech-mark' | 'uncertainty';
  source: string;
  segmentIds: string[];
  detail: string;
}

export interface CleanupBoundaryAssessment {
  source: CleanupBoundarySource;
  verified: boolean;
}

export interface CleanupSuggestion {
  id: string;
  recordingId?: string;
  kind: CleanupSuggestionKind;
  t0: number;
  t1: number;
  /** All observations involved, including the preferred later repeat. */
  segmentIds: string[];
  sourceSegmentIds: string[];
  /** Null for an uncertainty marker, which is never a removal candidate. */
  removalInterval: CleanupInterval | null;
  /** Alias useful to review consumers that call candidates removals. */
  removal: CleanupInterval | null;
  preferredSegmentId?: string;
  /** Immutable evidence identity used to reject stale persisted decisions. */
  fingerprint: string;
  reason: string;
  evidence: CleanupEvidence[];
  startBoundary: CleanupBoundaryAssessment;
  endBoundary: CleanupBoundaryAssessment;
  safeBoundary: CleanupBoundaryStatus;
  /** This is false for every recognition-only segment boundary. */
  safeToRemove: boolean;
  canPrepareRemoval: boolean;
  /** Every suggestion requires an explicit creator decision. */
  requiresReview: true;
  reversible: true;
  status: 'suggested';
  action: CleanupSuggestionAction;
}

export type CleanupDecisionAction = 'accept' | 'dismiss';

export interface CleanupDecision {
  id: string;
  suggestionId: string;
  action: CleanupDecisionAction;
  recordingId?: string;
  fingerprint?: string;
}

export interface CleanupPlan {
  /** A copied snapshot in caller order. It is never edited by this module. */
  originalSegments: CleanupTranscriptSegment[];
  suggestions: CleanupSuggestion[];
  decisions: CleanupDecision[];
}

const DEFAULTS: Required<CleanupOptions> = {
  minSilenceSeconds: 1.2,
  restartGapSeconds: 2.5,
  repeatGapSeconds: 3.5,
  minRestartPrefixWords: 2,
  uncertaintyThreshold: 0.55,
};

/**
 * Generate deterministic, review-only cleanup candidates.
 *
 * Repeated and restarted observations use recognizer timing only, so their
 * boundaries are always `uncertain`.  Filler and mumble removals become
 * preparable only when both boundaries come from independently verified audio
 * silence or an explicit manual review.  A mid-sentence filler remains a mark
 * even when a recognizer supplied a plausible interval.
 */
export function generateCleanupSuggestions(input: CleanupInput): CleanupSuggestion[] {
  const options = resolveOptions(input);
  const segments = validateSegments(input.segments, input.recordingId);
  const suggestions: CleanupSuggestion[] = [];

  for (const silence of input.silences ?? []) {
    validateInterval(silence, `silence ${silence.id}`);
    if (silence.deliberate || silence.t1 - silence.t0 < options.minSilenceSeconds) continue;
    const boundaries = assessBoundaries(silence);
    suggestions.push(makeSuggestion({
      id: `silence:${silence.id}`,
      recordingId: silence.recordingId ?? input.recordingId,
      kind: 'long-silence',
      t0: silence.t0,
      t1: silence.t1,
      segmentIds: [],
      removal: { t0: silence.t0, t1: silence.t1 },
      reason: `A ${(silence.t1 - silence.t0).toFixed(1)} second quiet interval may be reviewable. Listen for meaningful pauses before accepting it.`,
      evidence: [{
        type: 'silence',
        source: boundaries.start.source,
        segmentIds: [],
        detail: boundaries.start.verified && boundaries.end.verified
          ? 'An independent detector or manual review supplied both boundary records.'
          : silence.verifiedBoundary
            ? 'A legacy quiet marker did not include boundary provenance, so both boundaries still need review.'
            : 'Quiet audio was reported, but both cut boundaries still need listening review.',
      }],
      boundaries,
      action: 'review-removal',
    }));
  }

  const finalSegments = segments
    .filter((segment) => segment.isFinal === true)
    .slice()
    .sort(byTime);
  for (let index = 1; index < finalSegments.length; index += 1) {
    const previous = finalSegments[index - 1];
    const current = finalSegments[index];
    const gap = current.t0 - previous.t1;
    if (gap < 0) continue;
    if (previous.intentionalRepeat || current.intentionalRepeat) continue;
    if (!sameRecording(previous, current)) continue;
    if (current.uncertain || isLowConfidence(current.confidence, options.uncertaintyThreshold)) continue;

    const before = canonicalTokens(previous.text);
    const after = canonicalTokens(current.text);
    if (before.length < 2 || after.length < 2) continue;

    if (sameTokens(before, after) && gap <= options.repeatGapSeconds) {
      suggestions.push(makeSuggestion({
        id: `repeat:${previous.id}:${current.id}`,
        recordingId: current.recordingId ?? previous.recordingId,
        kind: 'suitable-repeat',
        t0: previous.t0,
        t1: current.t1,
        segmentIds: [previous.id, current.id],
        preferredSegmentId: current.id,
        removal: { t0: previous.t0, t1: previous.t1 },
        reason: 'The same final phrase appears twice. The later attempt is a possible clean repeat; listen before removing the earlier one.',
        evidence: [{
          type: 'transcript',
          source: 'recognizer',
          segmentIds: [previous.id, current.id],
          detail: 'The normalized final token sequences are identical and close together.',
        }],
        boundaries: recognitionBoundaries(),
        action: 'review-removal',
      }));
      continue;
    }

    const prefixLength = Math.min(before.length, after.length);
    const restarted = before.length < after.length
      && prefixLength >= options.minRestartPrefixWords
      && sameTokens(before, after.slice(0, before.length))
      && gap <= options.restartGapSeconds
      && !endsLikeCompleteUtterance(previous.text);
    if (restarted) {
      suggestions.push(makeSuggestion({
        id: `restart:${previous.id}:${current.id}`,
        recordingId: current.recordingId ?? previous.recordingId,
        kind: 'restarted-attempt',
        t0: previous.t0,
        t1: current.t1,
        segmentIds: [previous.id, current.id],
        preferredSegmentId: current.id,
        removal: { t0: previous.t0, t1: previous.t1 },
        reason: 'The later final phrase starts with the earlier unfinished attempt and continues it. Listen before keeping the later attempt.',
        evidence: [{
          type: 'transcript',
          source: 'recognizer',
          segmentIds: [previous.id, current.id],
          detail: `The later phrase repeats the earlier ${before.length}-word prefix within ${gap.toFixed(2)} seconds.`,
        }],
        boundaries: recognitionBoundaries(),
        action: 'review-removal',
      }));
    }
  }

  for (const segment of segments) {
    if (segment.isFinal !== true || segment.uncertain || isLowConfidence(segment.confidence, options.uncertaintyThreshold)) {
      suggestions.push(makeSuggestion({
        id: `uncertain:${segment.id}`,
        kind: 'uncertain',
        t0: segment.t0,
        t1: segment.t1,
        segmentIds: [segment.id],
        removal: null,
        recordingId: segment.recordingId,
        reason: segment.isFinal !== true
          ? 'This transcript is provisional. Keep the audio and confirm it after recording.'
          : 'This transcript has low or explicitly uncertain recognition evidence. Listen before editing the caption.',
        evidence: [{
          type: 'uncertainty',
          source: 'recognizer',
          segmentIds: [segment.id],
          detail: segment.isFinal === false
            ? 'The recognizer has not finalized this text.'
            : `Recognition confidence is ${formatConfidence(segment.confidence)}.`,
        }],
        boundaries: recognitionBoundaries(),
        action: 'mark',
      }));
    }
  }

  for (const mark of collectMarks(input)) {
    validateInterval(mark, `${mark.kind} mark ${mark.id}`);
    if (mark.recordingId !== undefined && (typeof mark.recordingId !== 'string' || !mark.recordingId.trim())) {
      throw new TypeError(`${mark.kind} mark ${mark.id} recordingId must be a non-empty string`);
    }
    const boundaries = assessBoundaries(mark);
    const isMidSentence = mark.isMidSentence === true;
    const placementConfirmed = mark.isMidSentence === false;
    const removalAllowed = mark.kind !== 'uncertain'
      && placementConfirmed
      && !isMidSentence
      && boundaries.start.verified
      && boundaries.end.verified;
    const segmentIds = mark.segmentId ? [mark.segmentId] : [];
    const reason = mark.kind === 'uncertain'
      ? `The ${mark.kind} mark needs listening review. It will not create a removal candidate.`
        : isMidSentence
        ? `The marked ${mark.kind} occurs mid-sentence. Keep it in place; mid-sentence cleanup is off by default.`
        : !placementConfirmed
          ? `The marked ${mark.kind} has no confirmed sentence-boundary placement. Keep it until a reviewer verifies the interval.`
        : removalAllowed
          ? `The marked ${mark.kind} has independently verified quiet boundaries. Listen before accepting a reversible removal.`
          : `The marked ${mark.kind} needs boundary review. Recognition timestamps alone cannot define a safe splice.`;
    suggestions.push(makeSuggestion({
      id: `${mark.kind}:${mark.id}`,
      recordingId: mark.recordingId ?? input.recordingId,
      kind: mark.kind,
      t0: mark.t0,
      t1: mark.t1,
      segmentIds,
      removal: removalAllowed ? { t0: mark.t0, t1: mark.t1 } : null,
      reason,
      evidence: [{
        type: 'speech-mark',
        source: boundaries.start.source,
        segmentIds,
        detail: mark.text.trim() || `Marked ${mark.kind} interval`,
      }],
      boundaries,
      action: removalAllowed ? 'review-removal' : 'mark',
    }));
  }

  return suggestions.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1 || a.id.localeCompare(b.id));
}

/** Build a plan that can be serialized without losing original observations. */
export function createCleanupPlan(input: CleanupInput & { decisions?: readonly CleanupDecision[] }): CleanupPlan {
  return {
    originalSegments: validateSegments(input.segments, input.recordingId),
    suggestions: generateCleanupSuggestions(input),
    decisions: [...(input.decisions ?? [])],
  };
}

/** Record an explicit creator choice without changing the suggestion or media. */
export function applyCleanupDecision(
  decisions: readonly CleanupDecision[],
  suggestion: CleanupSuggestion | string,
  action: CleanupDecisionAction,
): CleanupDecision[] {
  const suggestionId = typeof suggestion === 'string' ? suggestion : suggestion.id;
  if (!suggestionId.trim()) throw new Error('cleanup suggestion id is required');
  const recordingId = typeof suggestion === 'string' ? undefined : suggestion.recordingId;
  const next = decisions.filter((decision) => !(
    decision.suggestionId === suggestionId && decision.recordingId === recordingId
  ));
  const decision: CleanupDecision = {
    id: `cleanup:${recordingId ?? 'unknown'}:${suggestionId}`,
    suggestionId,
    action,
  };
  if (typeof suggestion !== 'string') {
    decision.recordingId = recordingId;
    decision.fingerprint = suggestion.fingerprint;
  }
  next.push(decision);
  return next;
}

export function restoreCleanupDecision(
  decisions: readonly CleanupDecision[],
  decisionId: string,
): CleanupDecision[] {
  return decisions.filter((decision) => decision.id !== decisionId && decision.suggestionId !== decisionId);
}

/**
 * Return a removal interval only after an explicit accept and verified audio
 * boundaries.  This is still a review handoff, not a media splice operation.
 */
export function prepareCleanupRemoval(
  suggestion: CleanupSuggestion,
  decisions: readonly CleanupDecision[],
): CleanupInterval | null {
  const decision = [...decisions].reverse().find((candidate) =>
    candidate.suggestionId === suggestion.id
      && suggestion.recordingId !== undefined
      && candidate.recordingId === suggestion.recordingId
      && candidate.fingerprint === suggestion.fingerprint,
  );
  if (!decision || decision.action !== 'accept' || !suggestion.canPrepareRemoval) return null;
  return suggestion.removalInterval ? { ...suggestion.removalInterval } : null;
}

export function canPrepareCleanupRemoval(suggestion: CleanupSuggestion): boolean {
  return suggestion.canPrepareRemoval && suggestion.removalInterval !== null;
}

function makeSuggestion(input: {
  id: string;
  recordingId?: string;
  kind: CleanupSuggestionKind;
  t0: number;
  t1: number;
  segmentIds: string[];
  preferredSegmentId?: string;
  removal: CleanupInterval | null;
  reason: string;
  evidence: CleanupEvidence[];
  boundaries: { start: CleanupBoundaryAssessment; end: CleanupBoundaryAssessment };
  action: CleanupSuggestionAction;
}): CleanupSuggestion {
  const safeToRemove = input.action === 'review-removal'
    && input.removal !== null
    && input.recordingId !== undefined
    && input.boundaries.start.verified
    && input.boundaries.end.verified;
  return {
    id: input.id,
    recordingId: input.recordingId,
    kind: input.kind,
    t0: input.t0,
    t1: input.t1,
    segmentIds: [...input.segmentIds],
    sourceSegmentIds: [...input.segmentIds],
    removalInterval: input.removal ? { ...input.removal } : null,
    removal: input.removal ? { ...input.removal } : null,
    preferredSegmentId: input.preferredSegmentId,
    fingerprint: makeFingerprint(input, input.boundaries),
    reason: input.reason,
    evidence: input.evidence.map((evidence) => ({ ...evidence, segmentIds: [...evidence.segmentIds] })),
    startBoundary: { ...input.boundaries.start },
    endBoundary: { ...input.boundaries.end },
    safeBoundary: safeToRemove ? 'safe' : 'uncertain',
    safeToRemove,
    canPrepareRemoval: safeToRemove,
    requiresReview: true,
    reversible: true,
    status: 'suggested',
    action: input.action,
  };
}

function makeFingerprint(
  input: Pick<CleanupSuggestion, 'id' | 'recordingId' | 'kind' | 't0' | 't1' | 'segmentIds' | 'removal' | 'preferredSegmentId' | 'evidence' | 'action'>,
  boundaries: { start: CleanupBoundaryAssessment; end: CleanupBoundaryAssessment },
) {
  return JSON.stringify({
    id: input.id,
    recordingId: input.recordingId ?? null,
    kind: input.kind,
    t0: input.t0,
    t1: input.t1,
    segmentIds: input.segmentIds,
    preferredSegmentId: input.preferredSegmentId ?? null,
    removal: input.removal,
    boundaries: {
      start: boundaries.start,
      end: boundaries.end,
    },
    action: input.action,
    evidence: input.evidence.map((evidence) => ({
      type: evidence.type,
      source: evidence.source,
      segmentIds: evidence.segmentIds,
      detail: evidence.detail,
    })),
  });
}

function collectMarks(input: CleanupInput): CleanupMark[] {
  return [
    ...(input.marks ?? []),
    ...(input.fillerMarks ?? []).map((mark) => ({ ...mark, kind: 'filler' as const })),
    ...(input.mumbleMarks ?? []).map((mark) => ({ ...mark, kind: 'mumble' as const })),
    ...(input.uncertainMarks ?? []).map((mark) => ({ ...mark, kind: 'uncertain' as const })),
  ];
}

function assessBoundaries(input: {
  verifiedBoundary?: boolean;
  boundarySource?: CleanupBoundarySource;
  safeBoundary?: boolean;
  startBoundary?: CleanupBoundaryEvidence;
  endBoundary?: CleanupBoundaryEvidence;
}): { start: CleanupBoundaryAssessment; end: CleanupBoundaryAssessment } {
  // `verifiedBoundary` was present in the first quiet-interval adapter, but
  // it contains no provenance. Treat it as unverified until an explicit
  // independent detector or manual review supplies both boundary records.
  const fallbackSource = input.boundarySource ?? 'unknown';
  return {
    start: assessBoundary(input.startBoundary, fallbackSource),
    end: assessBoundary(input.endBoundary, fallbackSource),
  };
}

function assessBoundary(
  evidence: CleanupBoundaryEvidence | undefined,
  fallbackSource: CleanupBoundarySource,
): CleanupBoundaryAssessment {
  const source = evidence?.source ?? fallbackSource;
  const explicitlyVerified = evidence?.verified === true;
  const verified = explicitlyVerified && (source === 'independent-silence' || source === 'manual-review');
  return { source, verified };
}

function recognitionBoundaries() {
  return {
    start: { source: 'recognition-only' as const, verified: false },
    end: { source: 'recognition-only' as const, verified: false },
  };
}

function resolveOptions(input: CleanupOptions): Required<CleanupOptions> {
  const options: Required<CleanupOptions> = {
    minSilenceSeconds: input.minSilenceSeconds ?? DEFAULTS.minSilenceSeconds,
    restartGapSeconds: input.restartGapSeconds ?? DEFAULTS.restartGapSeconds,
    repeatGapSeconds: input.repeatGapSeconds ?? DEFAULTS.repeatGapSeconds,
    minRestartPrefixWords: input.minRestartPrefixWords ?? DEFAULTS.minRestartPrefixWords,
    uncertaintyThreshold: input.uncertaintyThreshold ?? DEFAULTS.uncertaintyThreshold,
  };
  for (const [name, value] of Object.entries(options) as [keyof CleanupOptions, number][]) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  }
  if (!Number.isInteger(options.minRestartPrefixWords)) {
    throw new RangeError('minRestartPrefixWords must be an integer');
  }
  return options;
}

function validateSegments(input: readonly CleanupTranscriptSegment[], defaultRecordingId?: string): CleanupTranscriptSegment[] {
  if (!Array.isArray(input)) throw new TypeError('cleanup segments must be an array');
  if (defaultRecordingId !== undefined && (typeof defaultRecordingId !== 'string' || !defaultRecordingId.trim())) {
    throw new TypeError('cleanup recordingId must be a non-empty string');
  }
  const ids = new Set<string>();
  return input.map((segment) => {
    if (!segment || typeof segment.id !== 'string' || !segment.id.trim()) throw new TypeError('cleanup segment id is required');
    if (ids.has(segment.id)) throw new Error(`duplicate cleanup segment id: ${segment.id}`);
    ids.add(segment.id);
    validateInterval(segment, `segment ${segment.id}`);
    if (typeof segment.text !== 'string') throw new TypeError(`segment ${segment.id} text must be a string`);
    if (segment.recordingId !== undefined && (typeof segment.recordingId !== 'string' || !segment.recordingId.trim())) {
      throw new TypeError(`segment ${segment.id} recordingId must be a non-empty string`);
    }
    if (segment.isFinal !== undefined && typeof segment.isFinal !== 'boolean') throw new TypeError(`segment ${segment.id} isFinal must be boolean`);
    if (segment.confidence !== undefined && (!Number.isFinite(segment.confidence) || segment.confidence < 0 || segment.confidence > 1)) {
      throw new RangeError(`segment ${segment.id} confidence must be between zero and one`);
    }
    return { ...segment, recordingId: segment.recordingId ?? defaultRecordingId };
  });
}

function validateInterval(interval: CleanupInterval, label: string) {
  if (!Number.isFinite(interval.t0) || !Number.isFinite(interval.t1) || interval.t0 < 0 || interval.t1 <= interval.t0) {
    throw new RangeError(`${label} must have finite positive seconds`);
  }
}

function byTime(a: CleanupInterval & { id: string }, b: CleanupInterval & { id: string }) {
  return a.t0 - b.t0 || a.t1 - b.t1 || a.id.localeCompare(b.id);
}

function canonicalTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function sameTokens(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

function sameRecording(a: CleanupTranscriptSegment, b: CleanupTranscriptSegment) {
  // A missing identity means the caller supplied one isolated recording. If
  // either side carries an identity, both must carry the same one before
  // adjacency can be used as cleanup evidence.
  return (a.recordingId === undefined && b.recordingId === undefined)
    || (a.recordingId !== undefined && a.recordingId === b.recordingId);
}

function endsLikeCompleteUtterance(text: string) {
  return /[.!?]$/.test(text.trim());
}

function isLowConfidence(confidence: number | undefined, threshold: number) {
  return confidence !== undefined && confidence < threshold;
}

function formatConfidence(confidence: number | undefined) {
  return confidence === undefined ? 'unavailable' : `${Math.round(confidence * 100)}%`;
}

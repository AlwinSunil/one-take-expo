/**
 * Durable take identity, take explanations, and creator scratch decisions.
 *
 * This module is deliberately independent of the camera and storage layers.
 * Capture allocates a take id at the attempt boundary, then supplies the
 * source-local observations here.  Recognition segment ids are evidence only;
 * they never become take ids and never become media cut boundaries.
 */

export type EvidenceStatus = 'pending' | 'available' | 'uncertain' | 'unavailable' | 'failed';

export type RecognitionState = 'final' | 'provisional' | 'uncertain' | 'partial' | 'noisy' | 'unavailable';

/** Context supplied by an endpointing/command adapter, never inferred from a segment id. */
export type CommandContext = 'standalone' | 'continuation' | 'quoted' | 'ambiguous';

export type TranscriptQuality = 'clear' | 'noisy';

export type TakeVerdict = 'clean' | 'flagged' | 'pending' | 'scratched';
export type TakeBaseVerdict = Exclude<TakeVerdict, 'scratched'>;
export type TakeLifecycle = 'open' | 'complete';
export type ScratchSource = 'manual' | 'voice';

export interface TakeScope {
  /** Capture/session lifecycle identity.  Recognition retries stay in this scope. */
  sessionId: string;
  /** Original recording identity.  This is not a transcript segment id. */
  sourceId: string;
}

export interface ScriptEvidence {
  lineId: string;
  text: string;
}

export interface ScriptEvidenceInput {
  /** Existing script parsers call this `id`; durable reasons normalize it to `lineId`. */
  lineId?: string;
  id?: string;
  /** Legacy/raw script text.  Bracketed action cues are removed when spokenText is supplied. */
  text?: string;
  /** Cue-free spoken text from createScriptLine; preferred over raw text. */
  spokenText?: string;
}

export interface TranscriptSegmentInput {
  id: string;
  sessionId: string;
  sourceId: string;
  /** Recognition job identity, separate from the capture/session scope. */
  recognitionSessionId?: string;
  t0: number;
  t1: number;
  /** Raw recognizer text.  Caption corrections are intentionally not accepted. */
  text: string;
  isFinal?: boolean;
  state?: RecognitionState;
  /** `standalone` is required before an exact phrase can become a command. */
  commandContext?: CommandContext;
  quality?: TranscriptQuality;
  confidence?: number;
  /** Optional creator confirmation, kept separate from recognizer output. */
  restartConfirmed?: boolean;
}

export interface TranscriptSegmentEvidence {
  id: string;
  sessionId: string;
  sourceId: string;
  recognitionSessionId?: string;
  t0: number;
  t1: number;
  text: string;
  /** Explicit alias retained in the durable snapshot for review consumers. */
  rawText: string;
  isFinal: boolean;
  state: RecognitionState;
  commandContext: CommandContext;
  quality: TranscriptQuality;
  confidence?: number;
  restartConfirmed?: boolean;
}

export interface TranscriptReasonEvidence {
  segmentId: string;
  /** Recognition job namespace; capture sessionId remains the durable scope. */
  recognitionSessionId?: string;
  rawText: string;
  t0: number;
  t1: number;
  status: EvidenceStatus;
}

export type TakeReasonCode =
  | 'missing-words'
  | 'restart'
  | 'uncertain-speech'
  | 'manual-scratch'
  | 'voice-scratch';

export interface TakeReason {
  id: string;
  takeId: string;
  code: TakeReasonCode;
  /** Plain language that can be displayed without recomputing speech evidence. */
  message: string;
  status: EvidenceStatus;
  scriptEvidence: ScriptEvidence[];
  transcriptEvidence: TranscriptReasonEvidence[];
}

export interface TakeInput {
  /** Allocated once when capture starts.  It must survive recognition retries. */
  id: string;
  scope: TakeScope;
  attempt?: number;
  t0: number;
  t1: number;
  lifecycle?: TakeLifecycle;
  lineIds?: readonly string[];
  transcriptSegmentIds?: readonly string[];
  transcriptSegments?: readonly TranscriptSegmentInput[];
  rawTranscript?: readonly TranscriptSegmentInput[];
  verdict?: TakeBaseVerdict;
  reasons?: readonly TakeReason[];
}

export interface TakeRecord {
  /** Stable capture identity, independent of all recognition segment ids. */
  id: string;
  scope: TakeScope;
  attempt: number;
  t0: number;
  t1: number;
  lifecycle: TakeLifecycle;
  /** Current verdict after applying the append-only scratch event log. */
  verdict: TakeVerdict;
  /** Verdict before scratch overlays, used to make restore deterministic. */
  baseVerdict: TakeBaseVerdict;
  lineIds: string[];
  transcriptSegmentIds: string[];
  /** Immutable raw recognition snapshots, including provisional/failure evidence. */
  rawTranscript: TranscriptSegmentEvidence[];
  reasons: TakeReason[];
  /** Active scratch event ids targeting this take. */
  scratchEventIds: string[];
}

export interface TakeReasonInput {
  take: TakeRecord;
  scriptLines?: readonly ScriptEvidenceInput[];
  transcriptSegments?: readonly TranscriptSegmentInput[];
  /** Creator-confirmed restart evidence.  ASR alone remains uncertain. */
  confirmedRestartSegmentIds?: readonly string[];
}

export interface CommandInterval {
  id: string;
  segmentId: string;
  /** Optional recognizer-job namespace for retry-safe segment identity. */
  recognitionSessionId?: string;
  sessionId: string;
  sourceId: string;
  /** Source-relative recognition times in seconds. */
  t0: number;
  t1: number;
  rawText: string;
  /** Caption consumers can omit this interval without touching raw evidence. */
  excludeFromCaptions: true;
  /** Playback consumers can carry this exclusion intent into review. */
  excludeFromPlayback: true;
  /** Exclusion is an intent until a human/native boundary check completes. */
  playbackExclusion: 'pending-review';
  /** Recognition timing is not proof of a splice-safe media boundary. */
  boundaryProvenance: 'recognition';
  safeForSplice: false;
}

export interface ScratchCommand {
  segmentId: string;
  recognitionSessionId?: string;
  sessionId: string;
  sourceId: string;
  rawText: string;
  commandInterval: CommandInterval;
}

export interface ScratchEvent {
  id: string;
  type: 'scratch';
  scope: TakeScope;
  takeId: string;
  source: ScratchSource;
  /** Null for a manual event. */
  commandSegmentId: string | null;
  /** Recognition job namespace for the command segment, when available. */
  commandRecognitionSessionId?: string;
  commandInterval: CommandInterval | null;
  createdAt?: number;
}

export interface RestoreScratchEvent {
  id: string;
  type: 'restore-scratch';
  scope: TakeScope;
  scratchEventId: string;
  createdAt?: number;
}

export type TakeDecisionEvent = ScratchEvent | RestoreScratchEvent;
export type ScratchHistoryState = 'proposed' | 'applied' | 'restored';

export interface ScratchHistoryEntry extends ScratchEvent {
  state: ScratchHistoryState;
}

export interface TakeDecisionState {
  version: 1;
  scope: TakeScope;
  takes: TakeRecord[];
  /** Append-only raw event history.  Restore never deletes an earlier event. */
  events: TakeDecisionEvent[];
  /** Projectable scratch history with current applied/restored state. */
  scratchHistory: ScratchHistoryEntry[];
  /** Voice-command intervals retained for caption/playback exclusion review. */
  commandIntervals: CommandInterval[];
}

export interface TakeDecisionStateInput {
  scope: TakeScope;
  takes?: readonly TakeRecord[];
  events?: readonly TakeDecisionEvent[];
}

export interface ScratchCommandOptions {
  /** Spoken script text, including action brackets when available. */
  scriptText?: string;
  /** Equivalent line-level input for callers that already parsed the script. */
  scriptLines?: readonly string[];
  /** Low confidence is not a voice command. */
  minConfidence?: number;
}

export const MIN_SCRATCH_COMMAND_CONFIDENCE = 0.8;

const SCRATCH_TOKENS = ['scratch', 'that'];
const RESTART_PATTERN = /\b(?:(?:sorry,?\s+)?let\s+me\s+(?:start\s+again|try\s+(?:that\s+)?again)|(?:i\s+need\s+to\s+)?restart(?:ed|ing)?|start\s+over|from\s+the\s+top)\b/i;

export function createTake(input: TakeInput): TakeRecord {
  validateId(input.id, 'take id');
  const scope = validateScope(input.scope);
  validateRange(input.t0, input.t1, 'take');

  const attempt = input.attempt ?? 0;
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError('take attempt must be a non-negative integer');

  const lineIds = uniqueIds(input.lineIds ?? [], 'line id');
  const transcriptSegments = (input.rawTranscript ?? input.transcriptSegments ?? [])
    .map(createTranscriptSegmentEvidence);
  if (transcriptSegments.some((segment) => !sameScope(segment, scope))) {
    throw new Error(`take ${input.id} transcript evidence belongs to another source or session`);
  }
  // A caller may persist the segment ids separately while also supplying the
  // raw snapshots.  Union those collections instead of treating their
  // intentional overlap as a duplicate identity.
  const explicitTranscriptSegmentIds = uniqueIds(input.transcriptSegmentIds ?? [], 'transcript segment id');
  const observedTranscriptSegmentIds = uniqueIds(
    transcriptSegments.map((segment) => segment.id),
    'transcript segment id',
  );
  const transcriptSegmentIds = [...explicitTranscriptSegmentIds];
  for (const segmentId of observedTranscriptSegmentIds) {
    if (!transcriptSegmentIds.includes(segmentId)) transcriptSegmentIds.push(segmentId);
  }
  const reasons = [...(input.reasons ?? [])].map((reason) => validateReason(reason, input.id));
  // A persisted flag without a reason cannot be shown as an explained take.
  // Keep it pending until the caller supplies validated evidence.
  const baseVerdict = input.verdict === 'flagged' && reasons.length === 0
    ? 'pending'
    : input.verdict ?? 'pending';

  return {
    id: input.id,
    scope,
    attempt,
    t0: input.t0,
    t1: input.t1,
    lifecycle: input.lifecycle ?? 'complete',
    verdict: baseVerdict,
    baseVerdict,
    lineIds,
    transcriptSegmentIds,
    rawTranscript: transcriptSegments,
    reasons,
    scratchEventIds: [],
  };
}

/** Normalize an incoming native segment while retaining only raw recognition text. */
export function createTranscriptSegmentEvidence(input: TranscriptSegmentInput): TranscriptSegmentEvidence {
  validateId(input.id, 'transcript segment id');
  const scope = validateScope({ sessionId: input.sessionId, sourceId: input.sourceId });
  if (input.recognitionSessionId !== undefined) validateId(input.recognitionSessionId, 'recognition session id');
  validateRange(input.t0, input.t1, 'transcript segment');
  if (typeof input.text !== 'string') throw new TypeError('transcript segment text must be a string');
  const isFinal = input.isFinal ?? false;
  const state = input.state ?? (isFinal ? 'final' : 'provisional');
  const commandContext = input.commandContext ?? 'ambiguous';
  const quality = input.quality ?? 'clear';
  if (quality === 'noisy' && state === 'final') {
    // Keep both observations.  Command gating treats either as unsafe.
  }
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new RangeError('transcript confidence must be between 0 and 1');
  }
  return {
    id: input.id,
    sessionId: scope.sessionId,
    sourceId: scope.sourceId,
    ...(input.recognitionSessionId === undefined ? {} : { recognitionSessionId: input.recognitionSessionId }),
    t0: input.t0,
    t1: input.t1,
    text: input.text,
    rawText: input.text,
    isFinal,
    state,
    commandContext,
    quality,
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.restartConfirmed === undefined ? {} : { restartConfirmed: input.restartConfirmed }),
  };
}

/**
 * Explain a flagged or pending take using only source transcript evidence.
 * A caption correction cannot enter this function as a substitute for raw
 * recognition text, so it cannot manufacture coverage or erase a reason.
 */
export function deriveTakeReasons(input: TakeReasonInput): TakeReason[] {
  const scriptLines = (input.scriptLines ?? [])
    .map(normalizeScriptEvidence)
    .filter((line): line is ScriptEvidence => line !== null)
    .filter((line) => input.take.lineIds.length === 0 || input.take.lineIds.includes(line.lineId));
  const transcriptSegments = (input.transcriptSegments ?? input.take.rawTranscript)
    .map((segment) => createTranscriptSegmentEvidence(segment));
  const linkedSegmentIds = new Set(input.take.transcriptSegmentIds);
  const scopedSegments = transcriptSegments.filter((segment) =>
    sameScope(segment, input.take.scope)
    && (linkedSegmentIds.size === 0 || linkedSegmentIds.has(segment.id)),
  );
  const reasonEvidence = scopedSegments.map(toTranscriptReasonEvidence);
  const reasons: TakeReason[] = [];
  const combinedTokens = tokenizeReasonText(scopedSegments.map((segment) => segment.text).join(' '));
  const wholeScriptTokens = scriptLines.flatMap((line) => tokenizeReasonText(line.text));
  const wholeReadMatches = wholeScriptTokens.length > 0 && hasTokenSequence(combinedTokens, wholeScriptTokens);
  const scriptContainsRestartPhrase = scriptLines.some((line) => RESTART_PATTERN.test(line.text));
  const confirmedRestartSegmentIds = new Set(input.confirmedRestartSegmentIds ?? []);

  for (const line of scriptLines) {
    const expectedTokens = tokenizeReasonText(line.text);
    if (expectedTokens.length === 0) continue;
    if (wholeReadMatches || hasTokenSequence(combinedTokens, expectedTokens)) continue;

    const missing = missingTokenDisplays(expectedTokens, combinedTokens);
    const status = transcriptEvidenceStatus(scopedSegments);
    const detail = missing.length > 0
      ? `Missing words: ${missing.join(' ')}.`
      : 'The spoken words did not match the required line.';
    reasons.push({
      id: `${input.take.id}:reason:missing-words:${line.lineId}`,
      takeId: input.take.id,
      code: 'missing-words',
      message: `Line “${line.text}” was not found in the transcript. ${detail} Listen before choosing a replacement.`,
      status,
      scriptEvidence: [{ lineId: line.lineId, text: line.text }],
      transcriptEvidence: reasonEvidence,
    });
  }

  for (const segment of scopedSegments) {
    if (!RESTART_PATTERN.test(segment.text)) continue;
    // A line that deliberately says "let me start again" or "restart the
    // device" is dialogue.  Do not turn a perfect read of that line into a
    // self-contradictory restart reason.
    if (wholeReadMatches && scriptContainsRestartPhrase && !segment.restartConfirmed && !confirmedRestartSegmentIds.has(segment.id)) {
      continue;
    }
    const explicitlyConfirmed = segment.restartConfirmed === true || confirmedRestartSegmentIds.has(segment.id);
    const lineEvidence = scriptLines.length === 1 ? scriptLines : [];
    reasons.push({
      id: `${input.take.id}:reason:restart:${segment.id}`,
      takeId: input.take.id,
      code: 'restart',
      message: explicitlyConfirmed
        ? `The creator marked a restart in this attempt: “${segment.text}”.`
        : `Possible restart in the attempt: “${segment.text}”. Listen before deciding.`,
      status: explicitlyConfirmed ? evidenceStatusForSegment(segment) : 'uncertain',
      scriptEvidence: lineEvidence.map((line) => ({ lineId: line.lineId, text: line.text })),
      transcriptEvidence: [toTranscriptReasonEvidence(segment)],
    });
  }

  const uncertainSegments = scopedSegments.filter((segment) =>
    segment.quality === 'noisy' || ['uncertain', 'partial', 'unavailable'].includes(segment.state),
  );
  if (uncertainSegments.length > 0 && !reasons.some((reason) => reason.code === 'missing-words')) {
    reasons.push({
      id: `${input.take.id}:reason:uncertain-speech`,
      takeId: input.take.id,
      code: 'uncertain-speech',
      message: 'Speech evidence is uncertain or noisy. Listen before deciding whether this take is usable.',
      status: 'uncertain',
      scriptEvidence: scriptLines.map((line) => ({ lineId: line.lineId, text: line.text })),
      transcriptEvidence: uncertainSegments.map(toTranscriptReasonEvidence),
    });
  }

  if (scriptLines.length > 0 && scopedSegments.length === 0 && reasons.length === 0) {
    reasons.push({
      id: `${input.take.id}:reason:missing-words:no-evidence`,
      takeId: input.take.id,
      code: 'missing-words',
      message: 'No spoken transcript evidence is available for this line yet.',
      status: 'unavailable',
      scriptEvidence: scriptLines.map((line) => ({ lineId: line.lineId, text: line.text })),
      transcriptEvidence: [],
    });
  }

  return reasons;
}

/** Mark a take as flagged while preserving its raw transcript snapshot. */
export function flagTake(take: TakeRecord, reasons: readonly TakeReason[]): TakeRecord {
  const checked = reasons.map((reason) => validateReason(reason, take.id));
  if (checked.length === 0) {
    const baseVerdict: TakeBaseVerdict = 'pending';
    return {
      ...take,
      baseVerdict,
      verdict: take.scratchEventIds.length > 0 ? 'scratched' : baseVerdict,
      reasons: [],
    };
  }
  return {
    ...take,
    baseVerdict: 'flagged',
    verdict: take.scratchEventIds.length > 0 ? 'scratched' : 'flagged',
    reasons: checked,
  };
}

/**
 * Recognize only an exact, final, clear, standalone “scratch that”.
 *
 * The script guard is intentionally broad: if the current spoken script
 * contains those two words anywhere, the phrase belongs to dialogue until the
 * creator changes the script or uses the manual scratch control.
 */
export function detectScratchCommand(
  segment: TranscriptSegmentInput,
  options: ScratchCommandOptions = {},
): ScratchCommand | null {
  if (!isValidScopeValue(segment.sessionId) || !isValidScopeValue(segment.sourceId)) return null;
  if (!Number.isFinite(segment.t0) || !Number.isFinite(segment.t1) || segment.t0 < 0 || segment.t1 <= segment.t0) return null;
  if (segment.isFinal !== true) return null;
  const state = segment.state ?? 'final';
  if (state !== 'final' || segment.quality === 'noisy' || segment.commandContext !== 'standalone') return null;
  if (segment.confidence !== undefined && (
    !Number.isFinite(segment.confidence) || segment.confidence < (options.minConfidence ?? MIN_SCRATCH_COMMAND_CONFIDENCE)
  )) return null;
  if (!sameTokens(tokenizeCommandText(segment.text), SCRATCH_TOKENS)) return null;

  const scriptText = options.scriptText ?? options.scriptLines?.join(' ');
  if (scriptText !== undefined && containsCommandPhrase(scriptText)) return null;

  const commandInterval: CommandInterval = {
    id: `command:${segment.sessionId}:${segment.sourceId}:${segment.recognitionSessionId ?? 'recognition-default'}:${segment.id}`,
    segmentId: segment.id,
    ...(segment.recognitionSessionId === undefined ? {} : { recognitionSessionId: segment.recognitionSessionId }),
    sessionId: segment.sessionId,
    sourceId: segment.sourceId,
    t0: segment.t0,
    t1: segment.t1,
    rawText: segment.text,
    excludeFromCaptions: true,
    excludeFromPlayback: true,
    playbackExclusion: 'pending-review',
    boundaryProvenance: 'recognition',
    safeForSplice: false,
  };
  return {
    segmentId: segment.id,
    ...(segment.recognitionSessionId === undefined ? {} : { recognitionSessionId: segment.recognitionSessionId }),
    sessionId: segment.sessionId,
    sourceId: segment.sourceId,
    rawText: segment.text,
    commandInterval,
  };
}

/** Select the latest take that was active at the source time of a command. */
export function findScratchTarget(
  takes: readonly TakeRecord[],
  command: Pick<CommandInterval, 'sessionId' | 'sourceId' | 't0' | 't1'>,
): TakeRecord | null {
  const candidates = takes.filter((take) => {
    if (!sameScope(take.scope, command)) return false;
    if (take.t0 > command.t0) return false;
    if (take.lifecycle === 'open') return true;
    // A completed take either ended before the command or contains the command
    // in its source interval.  In both cases source time beats event arrival.
    return take.t1 <= command.t0 || (take.t0 <= command.t0 && take.t1 >= command.t0);
  });
  const latest = candidates
    .slice()
    .sort((a, b) => b.t0 - a.t0 || b.attempt - a.attempt || b.id.localeCompare(a.id))[0] ?? null;
  // A repeated/delayed command must not skip a scratched latest attempt and
  // reach back to an earlier valid take.  The creator can still use manual
  // selection to change history deliberately.
  return latest?.verdict === 'scratched' ? null : latest;
}

/** Build a voice event only after command and source-time target checks pass. */
export function createVoiceScratchEvent(input: {
  id: string;
  scope: TakeScope;
  commandSegment: TranscriptSegmentInput;
  takes: readonly TakeRecord[];
  scriptText?: string;
  scriptLines?: readonly string[];
  minConfidence?: number;
  createdAt?: number;
}): ScratchEvent | null {
  validateId(input.id, 'scratch event id');
  const scope = validateScope(input.scope);
  if (!sameScope(input.commandSegment, scope)) return null;
  const command = detectScratchCommand(input.commandSegment, {
    scriptText: input.scriptText,
    scriptLines: input.scriptLines,
    minConfidence: input.minConfidence,
  });
  if (!command) return null;
  const target = findScratchTarget(input.takes, command.commandInterval);
  if (!target) return null;
  return {
    id: input.id,
    type: 'scratch',
    scope,
    takeId: target.id,
    source: 'voice',
    commandSegmentId: command.segmentId,
    ...(command.recognitionSessionId === undefined ? {} : { commandRecognitionSessionId: command.recognitionSessionId }),
    commandInterval: command.commandInterval,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  };
}

/** Build the same event shape for an explicit creator control. */
export function createManualScratchEvent(input: {
  id: string;
  scope: TakeScope;
  takeId: string;
  createdAt?: number;
}): ScratchEvent {
  validateId(input.id, 'scratch event id');
  validateId(input.takeId, 'take id');
  return {
    id: input.id,
    type: 'scratch',
    scope: validateScope(input.scope),
    takeId: input.takeId,
    source: 'manual',
    commandSegmentId: null,
    commandInterval: null,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  };
}

export function createRestoreScratchEvent(input: {
  id: string;
  scope: TakeScope;
  scratchEventId: string;
  createdAt?: number;
}): RestoreScratchEvent {
  validateId(input.id, 'restore event id');
  validateId(input.scratchEventId, 'scratch event id');
  return {
    id: input.id,
    type: 'restore-scratch',
    scope: validateScope(input.scope),
    scratchEventId: input.scratchEventId,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  };
}

/** Rehydrate a durable state and replay each unique in-scope event once. */
export function createTakeDecisionState(input: TakeDecisionStateInput): TakeDecisionState {
  const scope = validateScope(input.scope);
  const takeIds = new Set<string>();
  const takes = (input.takes ?? []).map((take) => {
    validateId(take.id, 'take id');
    if (takeIds.has(take.id)) throw new Error(`duplicate take id: ${take.id}`);
    takeIds.add(take.id);
    return normalizeTakeForState(take, scope);
  });
  const initial: TakeDecisionState = {
    version: 1,
    scope,
    takes,
    events: [],
    scratchHistory: [],
    commandIntervals: [],
  };
  return (input.events ?? []).reduce(reduceTakeDecision, initial);
}

/** Apply one append-only decision. Foreign scope and duplicate ids are no-ops. */
export function reduceTakeDecision(
  state: TakeDecisionState,
  event: TakeDecisionEvent,
): TakeDecisionState {
  if (!sameScope(state.scope, event.scope)) return state;
  if (state.events.some((candidate) => candidate.id === event.id)) return state;
  if (event.type === 'restore-scratch') {
    const referencedScratch = state.events.find((candidate) =>
      candidate.type === 'scratch' && candidate.id === event.scratchEventId,
    );
    if (!referencedScratch || state.events.some((candidate) =>
      candidate.type === 'restore-scratch' && candidate.scratchEventId === event.scratchEventId,
    )) return state;
  }
  if (event.type === 'scratch' && event.source === 'voice' && event.commandSegmentId !== null
    && state.events.some((candidate) => candidate.type === 'scratch'
      && candidate.source === 'voice'
      && candidate.scope.sessionId === event.scope.sessionId
      && candidate.scope.sourceId === event.scope.sourceId
      && candidate.commandSegmentId === event.commandSegmentId
      && candidate.commandRecognitionSessionId === event.commandRecognitionSessionId)) {
    // Native retries can deliver the same final command with a new wrapper
    // event id.  Segment identity is the replay key for voice commands.
    return state;
  }
  const events = [...state.events, event];
  return deriveDecisionState(state.scope, state.takes, events);
}

/** Replay an event log by the same reducer used during capture. */
export function replayTakeDecisionEvents(
  input: TakeDecisionStateInput,
): TakeDecisionState {
  return createTakeDecisionState(input);
}

/** Return command exclusions without presenting them as safe media cuts. */
export function commandIntervalsForPlayback(state: TakeDecisionState): CommandInterval[] {
  return state.commandIntervals.map((interval) => ({ ...interval }));
}

function deriveDecisionState(
  scope: TakeScope,
  sourceTakes: readonly TakeRecord[],
  events: readonly TakeDecisionEvent[],
): TakeDecisionState {
  const restoredIds = new Set(events
    .filter((event): event is RestoreScratchEvent => event.type === 'restore-scratch')
    .map((event) => event.scratchEventId));
  const scratchEvents = events.filter((event): event is ScratchEvent => event.type === 'scratch');
  const activeByTake = new Map<string, string[]>();
  for (const event of scratchEvents) {
    if (restoredIds.has(event.id)) continue;
    const ids = activeByTake.get(event.takeId) ?? [];
    ids.push(event.id);
    activeByTake.set(event.takeId, ids);
  }

  const takes = sourceTakes.map((take) => {
    const scratchEventIds = activeByTake.get(take.id) ?? [];
    return {
      ...take,
      lineIds: [...take.lineIds],
      transcriptSegmentIds: [...take.transcriptSegmentIds],
      rawTranscript: take.rawTranscript.map((segment) => ({ ...segment })),
      reasons: take.reasons.map(cloneReason),
      scratchEventIds: [...scratchEventIds],
      verdict: scratchEventIds.length > 0 ? 'scratched' as const : take.baseVerdict,
    };
  });

  const takeIds = new Set(takes.map((take) => take.id));
  const scratchHistory = scratchEvents.map((event) => ({
    ...event,
    scope: { ...event.scope },
    commandInterval: event.commandInterval ? { ...event.commandInterval } : null,
    state: !takeIds.has(event.takeId)
      ? 'proposed' as const
      : restoredIds.has(event.id)
        ? 'restored' as const
        : 'applied' as const,
  }));
  const commandIntervals = uniqueCommandIntervals(scratchEvents
    .filter((event) => event.source === 'voice' && event.commandInterval !== null)
    .map((event) => event.commandInterval!));

  return {
    version: 1,
    scope: { ...scope },
    takes,
    events: events.map(cloneEvent),
    scratchHistory,
    commandIntervals,
  };
}

function normalizeTakeForState(take: TakeRecord, scope: TakeScope): TakeRecord {
  if (!sameScope(take.scope, scope)) throw new Error(`take ${take.id} belongs to another source or session`);
  const currentVerdict = take.verdict as TakeVerdict;
  const storedReasons = take.reasons.map((reason) => validateReason(reason, take.id));
  const rawTranscript = take.rawTranscript.map((segment) => createTranscriptSegmentEvidence(segment));
  if (rawTranscript.some((segment) => !sameScope(segment, scope))) {
    throw new Error(`take ${take.id} transcript evidence belongs to another source or session`);
  }
  const storedBaseVerdict: TakeBaseVerdict = take.baseVerdict ?? (currentVerdict === 'scratched' ? 'flagged' : currentVerdict);
  const baseVerdict: TakeBaseVerdict = storedBaseVerdict === 'flagged' && storedReasons.length === 0
    ? 'pending'
    : storedBaseVerdict;
  return {
    ...take,
    scope: { ...take.scope },
    baseVerdict,
    verdict: baseVerdict,
    lineIds: [...take.lineIds],
    transcriptSegmentIds: [...take.transcriptSegmentIds],
    rawTranscript,
    reasons: storedReasons,
    scratchEventIds: [],
  };
}

function cloneReason(reason: TakeReason): TakeReason {
  return {
    ...reason,
    scriptEvidence: reason.scriptEvidence.map((evidence) => ({ ...evidence })),
    transcriptEvidence: reason.transcriptEvidence.map((evidence) => ({ ...evidence })),
  };
}

function cloneEvent(event: TakeDecisionEvent): TakeDecisionEvent {
  if (event.type === 'restore-scratch') return { ...event, scope: { ...event.scope } };
  return {
    ...event,
    scope: { ...event.scope },
    commandInterval: event.commandInterval ? { ...event.commandInterval } : null,
  };
}

function uniqueCommandIntervals(intervals: readonly CommandInterval[]): CommandInterval[] {
  const seen = new Set<string>();
  return intervals.filter((interval) => {
    const key = `${interval.sessionId}:${interval.sourceId}:${interval.recognitionSessionId ?? ''}:${interval.segmentId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((interval) => ({ ...interval }));
}

function validateReason(reason: TakeReason, takeId: string): TakeReason {
  if (!reason || typeof reason !== 'object' || reason.takeId !== takeId) throw new Error(`take reason does not belong to ${takeId}`);
  validateId(reason.id, 'take reason id');
  if (typeof reason.message !== 'string' || !reason.message.trim()) throw new TypeError('take reason message must be non-empty');
  return cloneReason(reason);
}

function normalizeScriptEvidence(input: ScriptEvidenceInput): ScriptEvidence | null {
  const lineId = input.lineId ?? input.id;
  const spokenText = input.spokenText ?? input.text;
  if (!isValidScopeValue(lineId) || typeof spokenText !== 'string' || !spokenText.trim()) return null;
  return { lineId, text: spokenText };
}

function toTranscriptReasonEvidence(segment: TranscriptSegmentEvidence): TranscriptReasonEvidence {
  return {
    segmentId: segment.id,
    ...(segment.recognitionSessionId === undefined ? {} : { recognitionSessionId: segment.recognitionSessionId }),
    rawText: segment.rawText,
    t0: segment.t0,
    t1: segment.t1,
    status: evidenceStatusForSegment(segment),
  };
}

function evidenceStatusForSegment(segment: Pick<TranscriptSegmentEvidence, 'isFinal' | 'state' | 'quality'>): EvidenceStatus {
  if (segment.quality === 'noisy' || ['uncertain', 'partial', 'unavailable'].includes(segment.state)) return 'uncertain';
  return segment.isFinal && segment.state === 'final' ? 'available' : 'pending';
}

function transcriptEvidenceStatus(segments: readonly TranscriptSegmentEvidence[]): EvidenceStatus {
  if (segments.length === 0) return 'unavailable';
  if (segments.some((segment) => evidenceStatusForSegment(segment) === 'uncertain')) return 'uncertain';
  if (segments.some((segment) => evidenceStatusForSegment(segment) === 'pending')) return 'pending';
  return 'available';
}

interface ReasonToken {
  key: string;
  display: string;
}

function tokenizeReasonText(text: string): ReasonToken[] {
  const raw = text.toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  return raw.map((token) => ({ key: NUMBER_WORDS[token] ?? token, display: token }));
}

function tokenizeCommandText(text: string): string[] {
  return (text.toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []);
}

function hasTokenSequence(actual: readonly ReasonToken[] | readonly string[], expected: readonly ReasonToken[] | readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((token, index) => (typeof token === 'string' ? token : token.key) === (typeof expected[index] === 'string' ? expected[index] : expected[index].key));
}

function missingTokenDisplays(expected: readonly ReasonToken[], actual: readonly ReasonToken[]): string[] {
  const remaining = new Map<string, number>();
  for (const token of actual) remaining.set(token.key, (remaining.get(token.key) ?? 0) + 1);
  const missing: string[] = [];
  for (const token of expected) {
    const count = remaining.get(token.key) ?? 0;
    if (count > 0) remaining.set(token.key, count - 1);
    else missing.push(token.display);
  }
  return missing;
}

function containsCommandPhrase(text: string): boolean {
  const tokens = tokenizeCommandText(text);
  return tokens.some((_token, index) => tokens[index] === SCRATCH_TOKENS[0] && tokens[index + 1] === SCRATCH_TOKENS[1]);
}

function sameTokens(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((token, index) => token === expected[index]);
}

function sameScope(a: { sessionId: string; sourceId: string }, b: { sessionId: string; sourceId: string }): boolean {
  return a.sessionId === b.sessionId && a.sourceId === b.sourceId;
}

function validateScope(scope: TakeScope): TakeScope {
  validateId(scope.sessionId, 'session id');
  validateId(scope.sourceId, 'source id');
  return { sessionId: scope.sessionId, sourceId: scope.sourceId };
}

function isValidScopeValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateId(value: unknown, name: string): asserts value is string {
  if (!isValidScopeValue(value)) throw new TypeError(`${name} must be a non-empty string`);
}

function uniqueIds(values: readonly string[], name: string): string[] {
  const result: string[] = [];
  for (const value of values) {
    validateId(value, name);
    if (result.includes(value)) throw new Error(`duplicate ${name}: ${value}`);
    result.push(value);
  }
  return result;
}

function validateRange(t0: number, t1: number, name: string) {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 < 0 || t1 <= t0) {
    throw new RangeError(`${name} times must be finite source-relative seconds with t1 > t0`);
  }
}

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

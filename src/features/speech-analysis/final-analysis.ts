import {
  generateCleanupSuggestions,
  type CleanupInput,
  type CleanupMark,
  type CleanupSilence,
  type CleanupSuggestion,
} from '../speech-control/cleanup.ts';
import { matchEnglish } from './alignment.ts';
import {
  sameAnalysisScope,
  type AnalysisScope,
  type EvidenceState,
  type RangeProposal,
  type ScriptSpan,
  type SpeechObservation,
  type SourceTiming,
} from './contracts.ts';

/**
 * Final analysis is deliberately a producer module.  It retains evidence and
 * describes a review proposal; the editor owns persistence and timeline edits.
 */

export type FinalAnalysisStatus = 'ready' | 'pending' | 'unavailable' | 'cancelled' | 'stale' | 'failed';
export type AttemptKind = 'partial' | 'fuzzy' | 'complete' | 'mismatch' | 'unknown';
export type FinalSignalKind = 'gaze' | 'delivery' | 'silence';
export const FINAL_ANALYSIS_PRODUCER_VERSION = 'speech-analysis-baseline-v1';

export interface FinalAnalysisObservation extends SpeechObservation {
  /** Optional recognizer revision used to join partial and final snapshots. */
  revision?: number;
  /** Capture may supply a stable utterance identity across recognizer revisions. */
  utteranceId?: string;
  revisionOf?: string;
  /** A creator or capture adapter can explicitly protect a meaningful pause. */
  deliberatePause?: boolean;
  confidence?: number;
}

export interface FinalSignalInput {
  state?: EvidenceState;
  score?: number | null;
  reason?: string;
  observationIds?: readonly string[];
}

export interface FinalSignalEvidence {
  kind: FinalSignalKind;
  state: EvidenceState;
  score: number | null;
  reason: string;
  observationIds: string[];
}

export interface FinalAnalysisControls {
  /** An AbortSignal or a small test double with the same `aborted` property. */
  signal?: { readonly aborted: boolean };
  /** Called between producer phases so a job can observe cancellation. */
  yieldControl?: () => void | Promise<void>;
  checkCancelled?: () => boolean;
  /** A changing current scope invalidates a result before it can be consumed. */
  currentScope?: AnalysisScope;
  getCurrentScope?: () => AnalysisScope;
}

export interface FinalAnalysisInput {
  scope: AnalysisScope & { transcriptRevision: string };
  jobId: string;
  /** Monotonic result revision allocated by the job owner. */
  revision?: number;
  /** Source duration in seconds.  It lets the proposal retain trailing media. */
  sourceDuration?: number;
  /** Complete source transcript history, including provisional revisions. */
  observations: readonly FinalAnalysisObservation[];
  /** Stable script spans captured with the job.  Omit for Assisted Mode. */
  scriptSpans?: readonly ScriptSpan[];
  /** Convenience for callers that have script text but not span metadata. */
  scriptText?: string;
  /** #24 cleanup observations are fed through its review-only generator. */
  silences?: readonly CleanupSilence[];
  marks?: readonly CleanupMark[];
  /** Optional signal evidence.  Omitted signals remain explicitly unknown. */
  signals?: Partial<Record<FinalSignalKind, FinalSignalInput>>;
}

export interface AttemptEvidence {
  observationIds: string[];
  cleanupSuggestionIds: string[];
  reasons: string[];
}

export interface FinalAttempt {
  id: string;
  sourceId: string;
  takeId: string;
  /** All raw observations belonging to this attempt, including revisions. */
  observationIds: string[];
  t0: number;
  t1: number;
  text: string;
  kind: AttemptKind;
  state: EvidenceState;
  isComplete: boolean;
  intentionalRepeat: boolean;
  deliberatePause: boolean;
  scriptSpanIds: string[];
  adherenceScore: number | null;
  completenessScore: number;
  /** Optional signal scores are used only when the signal is available. */
  signalScore: number | null;
  overallScore: number;
  evidence: AttemptEvidence;
  timing: SourceTiming;
}

export interface RelatedAttemptGroup {
  id: string;
  sourceId: string;
  attemptIds: string[];
  observationIds: string[];
  scriptSpanIds: string[];
  kinds: AttemptKind[];
  rankedAttemptIds: string[];
  reason: string;
}

export interface FinalAnalysisReason {
  code:
    | 'no-speech'
    | 'no-complete-attempt'
    | 'recommended-attempt'
    | 'related-repeats'
    | 'retained-alternative'
    | 'excluded-weaker-attempt'
    | 'unsafe-boundary'
    | 'deliberate-repeat'
    | 'unknown-signal'
    | 'pending-source-duration'
    | 'stale-scope'
    | 'cancelled';
  message: string;
  attemptIds?: string[];
  observationIds?: string[];
}

export interface FinalAnalysisResult {
  producerVersion: typeof FINAL_ANALYSIS_PRODUCER_VERSION;
  status: FinalAnalysisStatus;
  state: EvidenceState;
  scope: AnalysisScope;
  jobId: string;
  revision: number;
  /** This is never bounded to the live-caption display window. */
  transcriptHistory: FinalAnalysisObservation[];
  attempts: FinalAttempt[];
  relatedAttemptGroups: RelatedAttemptGroup[];
  rankedAttempts: FinalAttempt[];
  recommendedAttemptId: string | null;
  recommendation: { attemptId: string; reason: string } | null;
  signals: Record<FinalSignalKind, FinalSignalEvidence>;
  cleanupSuggestions: CleanupSuggestion[];
  reasons: FinalAnalysisReason[];
  /** Null for a cancelled or stale job; no consumer should apply it then. */
  rangeProposal: RangeProposal | null;
}

export class FinalAnalysisStaleError extends Error {
  readonly code = 'analysis-stale';

  constructor(message = 'Final analysis scope is stale.') {
    super(message);
    this.name = 'FinalAnalysisStaleError';
  }
}

interface ScopeWithTranscriptRevision extends AnalysisScope {
  transcriptRevision?: string;
}

interface NormalizedInput {
  scope: ScopeWithTranscriptRevision;
  jobId: string;
  revision: number;
  sourceDuration: number | null;
  observations: FinalAnalysisObservation[];
  scriptSpans: ScriptSpan[];
  scriptText: string | null;
  silences: CleanupSilence[];
  marks: CleanupMark[];
  signals: Record<FinalSignalKind, FinalSignalInput | undefined>;
}

interface MatchResult {
  verdict: 'matched' | 'partial' | 'mismatch' | 'unknown';
  score: number;
  reason: string;
}

interface ScriptMatch extends MatchResult {
  spanIds: string[];
  expectedText: string;
}

interface SpanCandidate {
  id: string;
  text: string;
  spanIds: string[];
  order: number;
}

type AttemptWorking = FinalAttempt;

const MATCH_RANK: Record<MatchResult['verdict'], number> = {
  matched: 4,
  partial: 3,
  mismatch: 1,
  unknown: 0,
};

const KIND_RANK: Record<AttemptKind, number> = {
  complete: 4,
  fuzzy: 3,
  partial: 2,
  mismatch: 1,
  unknown: 0,
};

const PROTECTED_NEGATIONS = new Set([
  'no', 'not', 'never', 'none', 'neither', 'nor', 'without',
  'cannot', 'cant', 'dont', 'doesnt', 'isnt', 'wasnt', 'werent',
  'wont', 'wouldnt', 'shouldnt', 'couldnt', 'didnt', 'havent', 'hasnt',
]);

const INCOMPLETE_TRAILING_WORDS = new Set([
  'and', 'because', 'but', 'for', 'if', 'or', 'so', 'that', 'though', 'to',
  'when', 'which', 'while', 'who', 'with',
]);
const INCOMPLETE_LEADING_WORDS = new Set(['although', 'because', 'if', 'since', 'unless', 'when', 'while']);

const ALLOWED_PROVENANCE = new Set<SourceTiming['provenance']>([
  'recognition', 'saved-audio', 'independent-silence', 'manual-review',
]);

/**
 * Build a result synchronously.  This is useful for deterministic replays and
 * is intentionally free of storage, media, recognizer, and timeline writes.
 */
export function createFinalAnalysis(input: FinalAnalysisInput): FinalAnalysisResult {
  const normalized = normalizeInput(input);
  return buildResult(normalized);
}

/**
 * Run the same producer in cancellable cooperative phases.  Cancellation and stale
 * scope are returned as terminal producer states so a job owner can persist
 * them without catching an exception and accidentally applying partial output.
 */
export async function analyzeFinalTake(
  input: FinalAnalysisInput,
  controls: FinalAnalysisControls = {},
): Promise<FinalAnalysisResult> {
  const normalized = normalizeInput(input);
  const cancelled = () => controls.signal?.aborted === true
    || controls.checkCancelled?.() === true;

  const stale = () => {
    const current = controls.getCurrentScope?.() ?? controls.currentScope;
    return current !== undefined && !sameScopeIncludingTranscript(normalized.scope, current);
  };

  const checkpoint = async (): Promise<'cancelled' | 'stale' | null> => {
    if (cancelled()) return 'cancelled';
    if (stale()) return 'stale';
    if (controls.yieldControl) await controls.yieldControl();
    else await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (cancelled()) return 'cancelled';
    if (stale()) return 'stale';
    return null;
  };

  const initial = await checkpoint();
  if (initial) return terminalResult(normalized, initial);
  const cleanup = buildCleanupPlan(normalized);
  const afterCleanup = await checkpoint();
  if (afterCleanup) return terminalResult(normalized, afterCleanup);
  const classified = classifyAttempts(normalized, cleanup);
  const afterClassification = await checkpoint();
  if (afterClassification) return terminalResult(normalized, afterClassification);
  const groups = groupAttempts(classified, cleanup);
  const afterGrouping = await checkpoint();
  if (afterGrouping) return terminalResult(normalized, afterGrouping);
  return finishResult(normalized, cleanup, classified, groups);
}

/**
 * Throwing scope validation is available to durable consumers that prefer a
 * guard before starting work.  The async producer itself returns `stale`.
 */
export function validateFinalAnalysisScope(
  scope: AnalysisScope,
  currentScope: AnalysisScope,
): void {
  if (!sameScopeIncludingTranscript(scope as ScopeWithTranscriptRevision, currentScope)) {
    throw new FinalAnalysisStaleError();
  }
}

function buildResult(normalized: NormalizedInput): FinalAnalysisResult {
  const cleanup = buildCleanupPlan(normalized);
  const attempts = classifyAttempts(normalized, cleanup);
  const groups = groupAttempts(attempts, cleanup);
  return finishResult(normalized, cleanup, attempts, groups);
}

function finishResult(
  normalized: NormalizedInput,
  cleanup: CleanupSuggestion[],
  attempts: AttemptWorking[],
  groups: RelatedAttemptGroup[],
): FinalAnalysisResult {
  const rankedAttempts = attempts.slice().sort(compareAttempts);
  const recommendation = rankedAttempts.find(attempt => attempt.isComplete && attempt.state === 'available') ?? null;
  const recommendedAttemptId = recommendation?.id ?? null;
  const reasons: FinalAnalysisReason[] = [];

  if (attempts.length === 0) {
    reasons.push({
      code: 'no-speech',
      message: 'No speech observations were captured. The original source remains available for review or retry.',
    });
  } else if (!recommendation) {
    reasons.push({
      code: 'no-complete-attempt',
      message: 'No final, supported complete attempt was found. Keep the original and ask for another take or review.',
      observationIds: normalized.observations.map(observation => observation.id),
    });
  } else {
    const reason = recommendation.kind === 'fuzzy'
      ? 'This complete paraphrased attempt has the strongest supported script adherence and available evidence.'
      : 'This complete attempt has the strongest supported adherence and available evidence.';
    reasons.push({ code: 'recommended-attempt', message: reason, attemptIds: [recommendation.id] });
  }

  if (normalized.sourceDuration === null) {
    reasons.push({
      code: 'pending-source-duration',
      message: 'The source duration is unavailable, so no complete range proposal was emitted. Supply media duration before review.',
    });
  }

  for (const group of groups) {
    if (group.attemptIds.length > 1) {
      reasons.push({
        code: 'related-repeats',
        message: group.reason,
        attemptIds: group.attemptIds,
        observationIds: group.observationIds,
      });
    }
  }

  if (recommendation) {
    for (const attempt of attempts) {
      if (attempt.id === recommendation.id) continue;
      if (sameGroup(recommendation.id, attempt.id, groups)) {
        reasons.push({
          code: 'retained-alternative',
          message: `Alternative attempt ${attempt.id} remains available for creator review.`,
          attemptIds: [attempt.id],
          observationIds: attempt.observationIds,
        });
      }
    }
  }

  const state = attempts.length === 0
    ? 'unavailable'
    : normalized.sourceDuration === null
      ? 'pending'
      : analysisState(normalized.observations, attempts);
  const rangeProposal = normalized.sourceDuration === null
    ? null
    : buildRangeProposal(normalized, attempts, groups, reasons);
  return {
    producerVersion: FINAL_ANALYSIS_PRODUCER_VERSION,
    status: attempts.length === 0
      ? 'unavailable'
      : attempts.every(attempt => attempt.state !== 'available')
        ? 'pending'
        : normalized.sourceDuration === null ? 'pending' : 'ready',
    state,
    scope: cloneScope(normalized.scope),
    jobId: normalized.jobId,
    revision: normalized.revision,
    transcriptHistory: normalized.observations.map(cloneObservation),
    attempts: attempts.map(cloneAttempt),
    relatedAttemptGroups: groups.map(cloneGroup),
    rankedAttempts: rankedAttempts.map(cloneAttempt),
    recommendedAttemptId,
    recommendation: recommendation ? {
      attemptId: recommendation.id,
      reason: recommendation.kind === 'fuzzy'
        ? 'Strongest complete paraphrased attempt with supported protected facts.'
        : 'Strongest supported complete attempt; selection is a creator-review proposal.',
    } : null,
    signals: buildSignals(normalized, reasons),
    cleanupSuggestions: cleanup.map(cloneCleanupSuggestion),
    reasons,
    rangeProposal,
  };
}

function terminalResult(normalized: NormalizedInput, terminal: 'cancelled' | 'stale'): FinalAnalysisResult {
  const message = terminal === 'cancelled'
    ? 'Final analysis was cancelled before a proposal was produced. The saved source and transcript remain available.'
    : 'Final analysis is stale because the project, source, script, edit, or transcript revision changed.';
  const reason: FinalAnalysisReason = {
    code: terminal === 'cancelled' ? 'cancelled' : 'stale-scope',
    message,
  };
  return {
    producerVersion: FINAL_ANALYSIS_PRODUCER_VERSION,
    status: terminal,
    state: terminal === 'cancelled' ? 'pending' : 'unavailable',
    scope: cloneScope(normalized.scope),
    jobId: normalized.jobId,
    revision: normalized.revision,
    transcriptHistory: normalized.observations.map(cloneObservation),
    attempts: [],
    relatedAttemptGroups: [],
    rankedAttempts: [],
    recommendedAttemptId: null,
    recommendation: null,
    signals: unknownSignals(),
    cleanupSuggestions: [],
    reasons: [reason],
    rangeProposal: null,
  };
}

function normalizeInput(input: FinalAnalysisInput): NormalizedInput {
  if (!input || typeof input !== 'object') throw new TypeError('final analysis input is required');
  const scope = validateScope(input.scope);
  if (scope.transcriptRevision === undefined) {
    throw new TypeError('final analysis requires a transcriptRevision in its scope');
  }
  const jobId = validateId(input.jobId, 'analysis job id');
  const revision = input.revision ?? 1;
  if (!Number.isInteger(revision) || revision < 1) throw new RangeError('analysis revision must be a positive integer');
  if (!Array.isArray(input.observations)) throw new TypeError('final analysis observations must be an array');

  const observations = input.observations.map((observation) => ({ ...observation }));
  const ids = new Set<string>();
  for (const observation of observations) {
    validateObservation(observation, scope, ids);
  }
  validateRevisionChains(observations);

  const sourceDuration = input.sourceDuration === undefined ? null : input.sourceDuration;
  if (sourceDuration !== null && (!Number.isFinite(sourceDuration) || sourceDuration < 0)) throw new RangeError('source duration must be non-negative and finite');
  if (sourceDuration !== null && observations.some(observation => observation.t1 > sourceDuration)) {
    throw new RangeError('observation interval exceeds source duration');
  }

  if (input.scriptSpans !== undefined && !Array.isArray(input.scriptSpans)) throw new TypeError('final analysis script spans must be an array');
  const scriptSpans = (input.scriptSpans ?? []).map(span => ({ ...span }));
  validateScriptSpans(scriptSpans, scope.scriptRevision);
  const scriptText = input.scriptText === undefined ? null : validateText(input.scriptText, 'script text');

  if (input.silences !== undefined && !Array.isArray(input.silences)) throw new TypeError('final analysis silences must be an array');
  if (input.marks !== undefined && !Array.isArray(input.marks)) throw new TypeError('final analysis marks must be an array');
  const silences = [...(input.silences ?? [])].map(silence => ({ ...silence }));
  const marks = [...(input.marks ?? [])].map(mark => ({ ...mark }));
  validateCleanupIds(silences, marks);
  validateCleanupIntervals(silences, marks, sourceDuration);

  const signals: Record<FinalSignalKind, FinalSignalInput | undefined> = {
    gaze: input.signals?.gaze,
    delivery: input.signals?.delivery,
    silence: input.signals?.silence,
  };
  for (const kind of ['gaze', 'delivery', 'silence'] as const) validateSignal(signals[kind], kind);

  return {
    scope,
    jobId,
    revision,
    sourceDuration,
    observations,
    scriptSpans,
    scriptText,
    silences,
    marks,
    signals,
  };
}

function validateScope(input: AnalysisScope): ScopeWithTranscriptRevision {
  if (!input || typeof input !== 'object') throw new TypeError('analysis scope is required');
  for (const key of ['projectId', 'sourceId', 'scriptRevision', 'editRevision'] as const) {
    validateId(input[key], `analysis scope ${key}`);
  }
  const transcriptRevision = (input as ScopeWithTranscriptRevision).transcriptRevision;
  if (transcriptRevision !== undefined) validateId(transcriptRevision, 'analysis scope transcriptRevision');
  return { ...input };
}

function validateObservation(
  observation: FinalAnalysisObservation,
  scope: ScopeWithTranscriptRevision,
  ids: Set<string>,
): void {
  if (!observation || typeof observation !== 'object') throw new TypeError('speech observation is required');
  const id = validateId(observation.id, 'speech observation id');
  if (ids.has(id)) throw new Error(`duplicate speech observation id: ${id}`);
  ids.add(id);
  if (observation.sourceId !== scope.sourceId) {
    throw new Error(`speech observation ${id} belongs to another source`);
  }
  validateId(observation.takeId, `speech observation ${id} takeId`);
  validateInterval(observation.t0, observation.t1, `speech observation ${id}`);
  validateText(observation.text, `speech observation ${id} text`);
  if (typeof observation.isFinal !== 'boolean') throw new TypeError(`speech observation ${id} isFinal must be boolean`);
  if (observation.uncertain !== undefined && typeof observation.uncertain !== 'boolean') {
    throw new TypeError(`speech observation ${id} uncertain must be boolean`);
  }
  if (observation.intentionalRepeat !== undefined && typeof observation.intentionalRepeat !== 'boolean') {
    throw new TypeError(`speech observation ${id} intentionalRepeat must be boolean`);
  }
  if (observation.deliberatePause !== undefined && typeof observation.deliberatePause !== 'boolean') {
    throw new TypeError(`speech observation ${id} deliberatePause must be boolean`);
  }
  if (observation.revision !== undefined && (!Number.isInteger(observation.revision) || observation.revision < 0)) {
    throw new RangeError(`speech observation ${id} revision must be a non-negative integer`);
  }
  for (const key of ['utteranceId', 'revisionOf'] as const) {
    if (observation[key] !== undefined) validateId(observation[key], `speech observation ${id} ${key}`);
  }
  if (observation.confidence !== undefined && (!Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1)) {
    throw new RangeError(`speech observation ${id} confidence must be between zero and one`);
  }
  if (!ALLOWED_PROVENANCE.has(observation.provenance)) {
    throw new TypeError(`speech observation ${id} has an unknown timing provenance`);
  }
  if (observation.uncertaintySeconds !== null
    && (!Number.isFinite(observation.uncertaintySeconds) || observation.uncertaintySeconds < 0)) {
    throw new RangeError(`speech observation ${id} uncertainty must be null or non-negative`);
  }
  if (typeof observation.verifiedBoundary !== 'boolean') {
    throw new TypeError(`speech observation ${id} verifiedBoundary must be boolean`);
  }
}

function validateRevisionChains(observations: readonly FinalAnalysisObservation[]): void {
  const byId = new Map(observations.map(observation => [observation.id, observation]));
  for (const observation of observations) {
    if (!observation.revisionOf) continue;
    const predecessor = byId.get(observation.revisionOf);
    if (!predecessor) throw new Error(`speech observation ${observation.id} revisionOf points to unknown observation`);
    if (predecessor.takeId !== observation.takeId) throw new Error('speech revisionOf crosses take identities');
    if (predecessor.utteranceId && observation.utteranceId && predecessor.utteranceId !== observation.utteranceId) {
      throw new Error('speech revisionOf crosses utterance identities');
    }
    if (predecessor.revision !== undefined && observation.revision !== undefined && observation.revision <= predecessor.revision) {
      throw new Error('speech revision chain must increase');
    }
    const visited = new Set([observation.id]);
    let cursor: FinalAnalysisObservation | undefined = predecessor;
    while (cursor) {
      if (visited.has(cursor.id)) throw new Error('cyclic speech revision chain');
      visited.add(cursor.id);
      cursor = cursor.revisionOf ? byId.get(cursor.revisionOf) : undefined;
    }
  }
  for (const members of makeRevisionGroups(observations)) {
    if (members.length < 2) continue;
    const revisions = members.map(member => member.revision);
    if (revisions.every(revision => revision !== undefined)) {
      if (new Set(revisions).size !== revisions.length) throw new Error('ambiguous duplicate speech revision chain');
      continue;
    }
    // Without numeric revisions, only one explicit linear predecessor chain
    // can establish which text is current. Array arrival order is not evidence.
    const ids = new Set(members.map(member => member.id));
    const roots = members.filter(member => !member.revisionOf || !ids.has(member.revisionOf));
    const predecessors = members.flatMap(member => member.revisionOf ? [member.revisionOf] : []);
    if (roots.length !== 1 || predecessors.length !== members.length - 1 || new Set(predecessors).size !== predecessors.length) {
      throw new Error('ambiguous missing speech revision chain');
    }
  }
}

function validateScriptSpans(spans: readonly ScriptSpan[], scriptRevision: string): void {
  const ids = new Set<string>();
  for (const span of spans) {
    if (!span || typeof span !== 'object') throw new TypeError('script span is required');
    validateId(span.id, 'script span id');
    if (ids.has(span.id)) throw new Error(`duplicate script span id: ${span.id}`);
    ids.add(span.id);
    validateId(span.lineId, `script span ${span.id} lineId`);
    if (span.scriptRevision !== scriptRevision) throw new Error(`script span ${span.id} belongs to another script revision`);
    if (!Number.isInteger(span.start) || span.start < 0 || !Number.isInteger(span.end) || span.end <= span.start) {
      throw new RangeError(`script span ${span.id} has invalid offsets`);
    }
    validateText(span.text, `script span ${span.id} text`);
    if (!Number.isInteger(span.order) || span.order < 0) throw new RangeError(`script span ${span.id} order must be non-negative`);
  }
}

function validateCleanupIds(silences: readonly CleanupSilence[], marks: readonly CleanupMark[]): void {
  const ids = new Set<string>();
  for (const signal of [...silences, ...marks]) {
    if (!signal || typeof signal !== 'object') throw new TypeError('cleanup observation is required');
    validateId(signal.id, 'cleanup observation id');
    if (ids.has(signal.id)) throw new Error(`duplicate cleanup observation id: ${signal.id}`);
    ids.add(signal.id);
  }
}

function validateCleanupIntervals(
  silences: readonly CleanupSilence[],
  marks: readonly CleanupMark[],
  sourceDuration: number | null,
): void {
  for (const signal of [...silences, ...marks]) {
    if (!signal || typeof signal !== 'object') throw new TypeError('cleanup observation is required');
    validateInterval(signal.t0, signal.t1, `cleanup observation ${signal.id}`);
    if (sourceDuration !== null && signal.t1 > sourceDuration) {
      throw new RangeError(`cleanup observation ${signal.id} exceeds source duration`);
    }
  }
}

function validateSignal(signal: FinalSignalInput | undefined, kind: FinalSignalKind): void {
  if (!signal) return;
  if (typeof signal !== 'object') throw new TypeError(`${kind} signal must be an object`);
  const state = signal.state ?? 'available';
  if (!(['unknown', 'provisional', 'pending', 'available', 'unavailable'] as EvidenceState[]).includes(state)) {
    throw new TypeError(`${kind} signal has an unknown evidence state`);
  }
  if (signal.score !== undefined && signal.score !== null
    && (!Number.isFinite(signal.score) || signal.score < 0 || signal.score > 1)) {
    throw new RangeError(`${kind} signal score must be between zero and one`);
  }
  if (signal.observationIds !== undefined && !Array.isArray(signal.observationIds)) {
    throw new TypeError(`${kind} signal observationIds must be an array`);
  }
  const ids = new Set<string>();
  for (const id of signal.observationIds ?? []) {
    validateId(id, `${kind} signal observation id`);
    if (ids.has(id)) throw new Error(`duplicate ${kind} signal observation id: ${id}`);
    ids.add(id);
  }
}

function validateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function validateText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function validateInterval(t0: number, t1: number, label: string): void {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 < 0 || t1 <= t0) {
    throw new RangeError(`${label} must have finite positive seconds`);
  }
}

function buildCleanupPlan(normalized: NormalizedInput): CleanupSuggestion[] {
  const input: CleanupInput = {
    recordingId: normalized.scope.sourceId,
    segments: normalized.observations.map(observation => ({
      id: observation.id,
      recordingId: normalized.scope.sourceId,
      t0: observation.t0,
      t1: observation.t1,
      text: observation.text,
      isFinal: observation.isFinal,
      uncertain: observation.uncertain,
      intentionalRepeat: observation.intentionalRepeat,
      confidence: observation.confidence,
    })),
    silences: normalized.silences,
    marks: normalized.marks,
  };
  return generateCleanupSuggestions(input);
}

function classifyAttempts(normalized: NormalizedInput, cleanup: readonly CleanupSuggestion[]): AttemptWorking[] {
  const groups = makeRevisionGroups(normalized.observations);
  const spans = makeSpanCandidates(normalized.scriptSpans, normalized.scriptText);
  const cleanupByObservation = new Map<string, CleanupSuggestion[]>();
  for (const suggestion of cleanup) {
    for (const id of suggestion.segmentIds) {
      cleanupByObservation.set(id, [...(cleanupByObservation.get(id) ?? []), suggestion]);
    }
  }

  return groups.map((observationGroup) => {
    // Revision history is retained, but semantic classification follows the
    // latest declared final snapshot.  A late provisional update cannot undo a
    // final decision, and an earlier clean phrase cannot hide a newer changed
    // fact or negation.
    const bestObservation = latestSemanticObservation(observationGroup);
    const primary = bestObservation;
    const bestMatch = bestScriptMatch(bestObservation.text, spans);
    const bestSpanIds = bestMatch?.spanIds ?? [];

    const kind = classifyKind(bestObservation, bestMatch, spans.length > 0 || normalized.scriptText !== null);
    const isComplete = (kind === 'complete' || kind === 'fuzzy')
      && bestObservation.isFinal && bestObservation.uncertain !== true;
    const state: EvidenceState = bestObservation.uncertain === true
      ? 'provisional'
      : bestObservation.isFinal ? 'available' : 'provisional';
    const observationIds = observationGroup.map(observation => observation.id);
    const suggestions = observationGroup.flatMap(observation => cleanupByObservation.get(observation.id) ?? []);
    const uniqueSuggestions = [...new Map(suggestions.map(suggestion => [suggestion.id, suggestion])).values()];
    const t0 = Math.min(...observationGroup.map(observation => observation.t0));
    const t1 = Math.max(...observationGroup.map(observation => observation.t1));
    const timingObservation = bestObservation;
    const adherenceScore = bestMatch && bestMatch.verdict !== 'unknown'
      ? clamp(bestMatch.score)
      : null;
    const completenessScore = completeScore(kind, bestMatch, bestObservation);
    // Source-wide optional evidence is reported separately.  It is not
    // attributed to an individual attempt without per-attempt provenance.
    const signalScore = null;
    const evidenceReasons = uniqueSuggestions.map(suggestion => suggestion.reason);
    if (bestMatch?.reason) evidenceReasons.unshift(bestMatch.reason);
    if (!bestMatch && spans.length === 0 && normalized.scriptText === null) {
      evidenceReasons.unshift('No script was supplied; completeness uses a final-sentence punctuation heuristic only, not semantic coverage.');
    }
    const overallScore = scoreAttempt({
      kind,
      isComplete,
      adherenceScore,
      completenessScore,
      signalScore,
      evidenceReasons,
      confidence: bestObservation.confidence,
    });
    return {
      id: attemptIdentity(normalized.scope.sourceId, observationGroup),
      sourceId: normalized.scope.sourceId,
      takeId: primary.takeId,
      observationIds,
      t0,
      t1,
      text: bestObservation.text,
      kind,
      state,
      isComplete,
      intentionalRepeat: observationGroup.some(observation => observation.intentionalRepeat === true),
      deliberatePause: observationGroup.some(observation => observation.deliberatePause === true),
      scriptSpanIds: [...bestSpanIds],
      adherenceScore,
      completenessScore,
      signalScore,
      overallScore,
      evidence: {
        observationIds,
        cleanupSuggestionIds: uniqueSuggestions.map(suggestion => suggestion.id),
        reasons: evidenceReasons,
      },
      timing: {
        t0,
        t1,
        provenance: timingObservation.provenance,
        uncertaintySeconds: maxUncertainty(observationGroup),
        verifiedBoundary: observationGroup.length === 1 && timingObservation.verifiedBoundary,
      },
    };
  });
}

function makeRevisionGroups(observations: readonly FinalAnalysisObservation[]): FinalAnalysisObservation[][] {
  const parent = observations.map((_observation, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent[right] = left;
  };
  const byExplicitKey = new Map<string, number>();
  observations.forEach((observation, index) => {
    const explicit = observation.utteranceId;
    if (explicit) {
      const prior = byExplicitKey.get(`${observation.takeId}:${explicit}`);
      if (prior !== undefined) union(prior, index);
      else byExplicitKey.set(`${observation.takeId}:${explicit}`, index);
    }
  });
  const byId = new Map(observations.map((observation, index) => [observation.id, index]));
  observations.forEach((observation, index) => {
    if (observation.revisionOf) {
      const prior = byId.get(observation.revisionOf);
      if (prior !== undefined && observations[prior].takeId === observation.takeId) union(prior, index);
    }
  });
  const buckets = new Map<number, FinalAnalysisObservation[]>();
  observations.forEach((observation, index) => {
    const root = find(index);
    buckets.set(root, [...(buckets.get(root) ?? []), observation]);
  });
  return [...buckets.values()].sort((a, b) => Math.min(...a.map(o => o.t0)) - Math.min(...b.map(o => o.t0)));
}

function latestSemanticObservation(observations: readonly FinalAnalysisObservation[]): FinalAnalysisObservation {
  if (observations.every(observation => observation.revision !== undefined)) {
    return observations.reduce((latest, candidate) => candidate.revision! > latest.revision! ? candidate : latest);
  }
  const predecessorIds = new Set(observations.flatMap(observation => observation.revisionOf ? [observation.revisionOf] : []));
  return observations.find(observation => !predecessorIds.has(observation.id))!;
}

function makeSpanCandidates(spans: readonly ScriptSpan[], scriptText: string | null): SpanCandidate[] {
  const ordered = spans.slice().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const candidates: SpanCandidate[] = [];
  for (let start = 0; start < ordered.length; start += 1) {
    let text = '';
    const spanIds: string[] = [];
    for (let end = start; end < Math.min(ordered.length, start + 8); end += 1) {
      if (end > start && ordered[end].order !== ordered[end - 1].order + 1) break;
      text = text ? `${text} ${ordered[end].text}` : ordered[end].text;
      spanIds.push(ordered[end].id);
      candidates.push({ id: `window:${spanIds.join('|')}`, text, spanIds: [...spanIds], order: ordered[start].order });
    }
  }
  if (scriptText !== null && scriptText.trim() && ordered.length === 0) {
    candidates.push({ id: 'script:full', text: scriptText, spanIds: [], order: 0 });
  }
  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates: readonly SpanCandidate[]): SpanCandidate[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function bestScriptMatch(text: string, spans: readonly SpanCandidate[]): ScriptMatch | null {
  if (!spans.length) return null;
  let best: ScriptMatch | null = null;
  for (const span of spans) {
    const raw = matchEnglish(span.text, text) as MatchResult;
    const candidate = protectedMatch(span.text, text, raw);
    const withSpans: ScriptMatch = { ...candidate, spanIds: [...span.spanIds], expectedText: span.text };
    if (!best || compareMatches(withSpans, best) > 0) best = withSpans;
  }
  return best;
}

function protectedMatch(expected: string, observed: string, raw: MatchResult): MatchResult {
  if (raw.verdict === 'matched' && !preservesProtectedFacts(expected, observed)) {
    return {
      verdict: 'mismatch',
      score: Math.min(raw.score, 0.49),
      reason: 'A name, fact, number, or negation changed, so this is not supported as a complete match.',
    };
  }
  return raw;
}

function preservesProtectedFacts(expected: string, observed: string): boolean {
  const expectedNumbers = protectedNumbers(expected);
  const observedNumbers = protectedNumbers(observed);
  if (!sameMultiset(expectedNumbers, observedNumbers)) return false;
  const expectedNegations = canonicalTokens(expected).filter(token => PROTECTED_NEGATIONS.has(token));
  const observedNegations = canonicalTokens(observed).filter(token => PROTECTED_NEGATIONS.has(token));
  if (!sameMultiset(expectedNegations, observedNegations)) return false;
  const expectedNames = properNameTokens(expected);
  const observedTokens = new Set(canonicalTokens(observed));
  return expectedNames.every(name => observedTokens.has(name.toLocaleLowerCase()));
}

function protectedNumbers(text: string): string[] {
  return (text.match(/\b\d+(?:[.,]\d+)?%?\b/g) ?? []).map(value => value.replace(/,/g, ''));
}

function properNameTokens(text: string): string[] {
  const tokens = text.match(/[A-Za-z][A-Za-z0-9'’-]*/g) ?? [];
  return tokens.filter((token, index) => index > 0 && /^[A-Z][A-Za-z0-9'’-]{2,}$/.test(token));
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const value of right) {
    const count = counts.get(value) ?? 0;
    if (count === 0) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return counts.size === 0;
}

function classifyKind(
  observation: FinalAnalysisObservation,
  match: ScriptMatch | null,
  hasScript: boolean,
): AttemptKind {
  if (!observation.text.trim()) return 'unknown';
  if (!observation.isFinal || observation.uncertain === true) return 'partial';
  if (hasScript && match) {
    if (match.verdict === 'matched') return canonicalText(observation.text) === canonicalText(match.expectedText) ? 'complete' : 'fuzzy';
    if (match.verdict === 'partial') return 'partial';
    if (match.verdict === 'unknown') return 'unknown';
    return 'mismatch';
  }
  return looksLikeCompleteUtterance(observation.text) ? 'complete' : 'partial';
}

function looksLikeCompleteUtterance(text: string): boolean {
  const trimmed = text.trim();
  if (!/[.!?]$/.test(trimmed) || /(?:\.{2,}|…)$/.test(trimmed)) return false;
  const tokens = canonicalTokens(trimmed);
  return tokens.length >= 2
    && !INCOMPLETE_TRAILING_WORDS.has(tokens.at(-1) ?? '')
    && !(tokens.length <= 4 && INCOMPLETE_LEADING_WORDS.has(tokens[0]));
}

function completeScore(kind: AttemptKind, match: MatchResult | null, observation: FinalAnalysisObservation): number {
  if (kind === 'complete') return 1;
  if (kind === 'fuzzy') return clamp(match?.score ?? 0.85);
  if (kind === 'partial') return clamp((match?.score ?? 0.35) * 0.65);
  if (kind === 'mismatch') return clamp((match?.score ?? 0) * 0.2);
  return observation.isFinal ? 0.1 : 0;
}

function scoreAttempt(input: {
  kind: AttemptKind;
  isComplete: boolean;
  adherenceScore: number | null;
  completenessScore: number;
  signalScore: number | null;
  evidenceReasons: readonly string[];
  confidence?: number;
}): number {
  let score = input.isComplete ? 0.65 : 0.2;
  score += input.completenessScore * 0.2;
  if (input.adherenceScore !== null) score += input.adherenceScore * 0.15;
  if (input.signalScore !== null) score += input.signalScore * 0.05;
  if (input.kind === 'mismatch') score -= 0.2;
  if (input.kind === 'partial') score -= 0.08;
  if (input.confidence !== undefined) score += (input.confidence - 0.5) * 0.08;
  if (input.evidenceReasons.some(reason => /uncertain|provisional|boundary review/i.test(reason))) score -= 0.04;
  return clamp(score);
}

function compareMatches(left: MatchResult, right: MatchResult): number {
  return MATCH_RANK[left.verdict] - MATCH_RANK[right.verdict] || left.score - right.score;
}

function attemptIdentity(sourceId: string, observations: readonly FinalAnalysisObservation[]): string {
  const explicit = observations.map(observation => observation.utteranceId).find(Boolean);
  const takeId = observations[0].takeId;
  if (explicit) return `attempt:${sourceId}:${takeId}:${explicit}`;
  return `attempt:${sourceId}:${takeId}:${observations.map(observation => observation.id).sort().join('+')}`;
}

function groupAttempts(attempts: readonly AttemptWorking[], cleanup: readonly CleanupSuggestion[]): RelatedAttemptGroup[] {
  const parent = attempts.map((_attempt, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent[right] = left;
  };
  const byObservation = new Map<string, number>();
  attempts.forEach((attempt, index) => attempt.observationIds.forEach(id => byObservation.set(id, index)));
  for (const suggestion of cleanup) {
    const linked = [...new Set(suggestion.segmentIds.map(id => byObservation.get(id)).filter((index): index is number => index !== undefined))];
    for (let index = 1; index < linked.length; index += 1) union(linked[0], linked[index]);
  }
  for (let left = 0; left < attempts.length; left += 1) {
    for (let right = left + 1; right < attempts.length; right += 1) {
      const a = attempts[left];
      const b = attempts[right];
      const sharedSpan = isSupportedAttempt(a)
        && isSupportedAttempt(b)
        && a.scriptSpanIds.some(id => b.scriptSpanIds.includes(id));
      const compared = safePairMatch(a.text, b.text);
      if (sharedSpan || compared.verdict === 'matched' || (compared.verdict === 'partial' && compared.score >= 0.78)
        || prefixRelated(a.text, b.text)) union(left, right);
    }
  }
  const buckets = new Map<number, AttemptWorking[]>();
  attempts.forEach((attempt, index) => {
    const root = find(index);
    buckets.set(root, [...(buckets.get(root) ?? []), attempt]);
  });
  return [...buckets.values()]
    .map(members => {
      const sorted = members.slice().sort(compareAttempts);
      const attemptIds = sorted.map(attempt => attempt.id);
      const observationIds = [...new Set(members.flatMap(attempt => attempt.observationIds))];
      const scriptSpanIds = [...new Set(members.flatMap(attempt => attempt.scriptSpanIds))];
      const kinds = [...new Set(members.map(attempt => attempt.kind))].sort((a, b) => KIND_RANK[b] - KIND_RANK[a]);
      return {
        id: `attempt-group:${members[0].sourceId}:${attemptIds.slice().sort().join('|')}`,
        sourceId: members[0].sourceId,
        attemptIds,
        observationIds,
        scriptSpanIds,
        kinds,
        rankedAttemptIds: attemptIds,
        reason: `Related source attempts were grouped by supported wording, script-span evidence, or cleanup repeat/restart evidence. ${attemptIds.length} alternatives remain available.`,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function isSupportedAttempt(attempt: FinalAttempt): boolean {
  return attempt.kind === 'complete' || attempt.kind === 'fuzzy' || attempt.kind === 'partial';
}

function safePairMatch(left: string, right: string): MatchResult {
  if (!left.trim() || !right.trim()) return { verdict: 'unknown', score: 0, reason: 'Empty text cannot establish a relation.' };
  const raw = matchEnglish(left, right) as MatchResult;
  return protectedMatch(left, right, raw);
}

function prefixRelated(left: string, right: string): boolean {
  const leftTokens = canonicalTokens(left);
  const rightTokens = canonicalTokens(right);
  if (leftTokens.length < 2 || rightTokens.length < 2 || leftTokens.length === rightTokens.length) return false;
  const shorter = leftTokens.length < rightTokens.length ? leftTokens : rightTokens;
  const longer = leftTokens.length < rightTokens.length ? rightTokens : leftTokens;
  if (!shorter.every((token, index) => token === longer[index])) return false;
  const compared = safePairMatch(longer.join(' '), shorter.join(' '));
  return compared.verdict === 'partial' && compared.score >= 0.25;
}

function compareAttempts(left: FinalAttempt, right: FinalAttempt): number {
  return right.overallScore - left.overallScore
    || Number(right.isComplete) - Number(left.isComplete)
    || KIND_RANK[right.kind] - KIND_RANK[left.kind]
    || left.t0 - right.t0
    || left.id.localeCompare(right.id);
}

function sameGroup(first: string, second: string, groups: readonly RelatedAttemptGroup[]): boolean {
  return groups.some(group => group.attemptIds.includes(first) && group.attemptIds.includes(second));
}

function buildRangeProposal(
  normalized: NormalizedInput,
  attempts: readonly AttemptWorking[],
  groups: readonly RelatedAttemptGroup[],
  reasons: FinalAnalysisReason[],
): RangeProposal {
  const excludedIds = new Set<string>();
  const byId = new Map(attempts.map(attempt => [attempt.id, attempt]));
  for (const group of groups) {
    const preferred = group.attemptIds
      .map(id => byId.get(id))
      .filter((attempt): attempt is AttemptWorking => attempt !== undefined && attempt.isComplete && attempt.state === 'available')
      .sort(compareAttempts)[0];
    if (!preferred) continue;
    for (const member of group.attemptIds
      .map(id => byId.get(id))
      .filter((attempt): attempt is AttemptWorking => attempt !== undefined && (attempt.intentionalRepeat || attempt.deliberatePause))) {
      reasons.push({
        code: 'deliberate-repeat',
        message: `Deliberate repeat or pause ${member.id} is retained as an alternative.`,
        attemptIds: [member.id],
      });
    }
    for (const candidate of group.attemptIds
      .map(id => byId.get(id))
      .filter((attempt): attempt is AttemptWorking => attempt !== undefined)) {
      if (candidate.id === preferred.id) continue;
      if (!contentReplacedBy(candidate, preferred)) continue;
      if (candidate.overallScore >= preferred.overallScore || candidate.intentionalRepeat || candidate.deliberatePause) {
        continue;
      }
      const observation = candidate.observationIds.length === 1
        ? normalized.observations.find(item => item.id === candidate.observationIds[0])
        : undefined;
      if (!observation || !safeWholeUtteranceBoundary(observation) || overlapsAnotherObservation(observation, normalized.observations)) {
        reasons.push({
          code: 'unsafe-boundary',
          message: `The weaker attempt ${candidate.id} remains retained because a whole-utterance independently verified boundary is unavailable.`,
          attemptIds: [candidate.id],
          observationIds: candidate.observationIds,
        });
        continue;
      }
      excludedIds.add(observation.id);
      reasons.push({
        code: 'excluded-weaker-attempt',
        message: `The whole utterance ${candidate.id} is proposed for exclusion because ${preferred.id} is a stronger complete alternative. Creator acceptance is required.`,
        attemptIds: [candidate.id, preferred.id],
        observationIds: [observation.id],
      });
    }
  }
  const ranges = coverageRanges(normalized, excludedIds, attempts);
  return {
    id: `${normalized.jobId}:proposal:${normalized.revision}`,
    scope: cloneScope(normalized.scope),
    jobId: normalized.jobId,
    revision: normalized.revision,
    state: analysisState(normalized.observations, attempts),
    ranges,
    requiresCreatorAcceptance: true,
  };
}

function contentReplacedBy(candidate: FinalAttempt, preferred: FinalAttempt): boolean {
  if (candidate.scriptSpanIds.length > 0 || preferred.scriptSpanIds.length > 0) {
    if (candidate.scriptSpanIds.length === 0 || preferred.scriptSpanIds.length === 0) return false;
    if (!candidate.scriptSpanIds.every(id => preferred.scriptSpanIds.includes(id))) return false;
    // Treat the stronger attempt as the expected content.  A short partial
    // reread may therefore be replaced by the complete utterance, while a
    // changed fact/negation remains a protected mismatch.
    const compared = safePairMatch(preferred.text, candidate.text);
    return compared.verdict === 'matched'
      || (compared.verdict === 'partial' && compared.score >= 0.4);
  }
  const compared = safePairMatch(preferred.text, candidate.text);
  return compared.verdict === 'matched'
    || (compared.verdict === 'partial' && compared.score >= 0.4);
}

function safeWholeUtteranceBoundary(observation: FinalAnalysisObservation): boolean {
  return observation.verifiedBoundary
    && (observation.provenance === 'independent-silence' || observation.provenance === 'manual-review');
}

function overlapsAnotherObservation(
  candidate: FinalAnalysisObservation,
  observations: readonly FinalAnalysisObservation[],
): boolean {
  return observations.some(other => other.id !== candidate.id
    && candidate.t0 < other.t1 && other.t0 < candidate.t1);
}

function coverageRanges(
  normalized: NormalizedInput,
  excludedIds: ReadonlySet<string>,
  attempts: readonly AttemptWorking[],
): RangeProposal['ranges'] {
  const observations = normalized.observations.slice().sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1 || a.id.localeCompare(b.id));
  const ranges: RangeProposal['ranges'] = [];
  let cursor = 0;
  const addGap = (t0: number, t1: number) => {
    if (t1 <= t0) return;
    ranges.push({
      id: `${normalized.scope.sourceId}:gap:${formatTime(t0)}-${formatTime(t1)}`,
      sourceId: normalized.scope.sourceId,
      t0,
      t1,
      provenance: 'saved-audio',
      uncertaintySeconds: null,
      verifiedBoundary: false,
      observationIds: [],
      disposition: 'retained',
      reason: 'Source coverage gap retained because no speech evidence authorizes removing it.',
    });
  };
  let index = 0;
  while (index < observations.length) {
    const first = observations[index];
    if (first.t0 > cursor) addGap(cursor, first.t0);
    const cluster = [first];
    let end = first.t1;
    index += 1;
    while (index < observations.length && observations[index].t0 < end) {
      cluster.push(observations[index]);
      end = Math.max(end, observations[index].t1);
      index += 1;
    }
    const clusterIds = cluster.map(observation => observation.id);
    const excluded = cluster.length === 1 && excludedIds.has(first.id);
    const relatedAttempts = attempts.filter(attempt => attempt.observationIds.some(id => clusterIds.includes(id)));
    const recommended = relatedAttempts.find(attempt => attempt.isComplete && attempt.overallScore >= 0.65);
    const disposition = excluded ? 'excluded' : 'retained';
    const reason = excluded
      ? 'AI proposes excluding this complete source utterance in favor of a stronger complete alternative; creator acceptance is required.'
      : cluster.some(observation => observation.intentionalRepeat)
        ? 'Deliberate repeat retained as an alternative take.'
        : recommended
          ? `Source utterance retained for review alongside ${recommended.id}; alternatives remain reversible.`
          : 'Original source utterance retained; evidence is not sufficient for an automatic exclusion.';
    const source = cluster[0];
    ranges.push({
      id: `${normalized.scope.sourceId}:utterance:${clusterIds.join('+')}`,
      sourceId: normalized.scope.sourceId,
      t0: Math.min(...cluster.map(observation => observation.t0)),
      t1: Math.max(...cluster.map(observation => observation.t1)),
      provenance: source.provenance,
      uncertaintySeconds: maxUncertainty(cluster),
      verifiedBoundary: cluster.length === 1 && source.verifiedBoundary,
      observationIds: clusterIds,
      disposition,
      reason,
    });
    cursor = end;
  }
  if (normalized.sourceDuration !== null && normalized.sourceDuration > cursor) addGap(cursor, normalized.sourceDuration);
  return ranges;
}

function analysisState(observations: readonly FinalAnalysisObservation[], attempts: readonly FinalAttempt[]): EvidenceState {
  if (observations.length === 0) return 'unavailable';
  if (attempts.some(attempt => attempt.state === 'available')) return 'available';
  if (attempts.some(attempt => attempt.state === 'provisional')) return 'provisional';
  return 'unknown';
}

function buildSignals(normalized: NormalizedInput, reasons: FinalAnalysisReason[]): Record<FinalSignalKind, FinalSignalEvidence> {
  const result = unknownSignals();
  for (const kind of ['gaze', 'delivery', 'silence'] as const) {
    const supplied = normalized.signals[kind];
    if (!supplied && kind === 'silence' && normalized.silences.length > 0) {
      result.silence = {
        kind: 'silence',
        state: 'available',
        score: null,
        reason: 'Timestamped silence observations were supplied by the cleanup adapter; they are review signals, not deletion authority.',
        observationIds: [],
      };
      continue;
    }
    if (!supplied) {
      reasons.push({ code: 'unknown-signal', message: `No ${kind} evidence was supplied; its state remains unknown.` });
      continue;
    }
    result[kind] = {
      kind,
      state: supplied.state ?? 'available',
      score: supplied.state === 'unknown' || supplied.state === 'unavailable' || supplied.state === 'pending'
        ? null
        : supplied.score ?? null,
      reason: supplied.reason ?? `${kind[0].toUpperCase()}${kind.slice(1)} evidence was supplied for this source.`,
      observationIds: [...(supplied.observationIds ?? [])],
    };
  }
  return result;
}

function unknownSignals(): Record<FinalSignalKind, FinalSignalEvidence> {
  return {
    gaze: { kind: 'gaze', state: 'unknown', score: null, reason: 'Gaze was not collected for this analysis.', observationIds: [] },
    delivery: { kind: 'delivery', state: 'unknown', score: null, reason: 'Delivery quality was not collected for this analysis.', observationIds: [] },
    silence: { kind: 'silence', state: 'unknown', score: null, reason: 'Independent silence evidence was not supplied for this analysis.', observationIds: [] },
  };
}

function maxUncertainty(observations: readonly FinalAnalysisObservation[]): number | null {
  const values = observations.map(observation => observation.uncertaintySeconds).filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
}

function canonicalText(text: string): string {
  return canonicalTokens(text).join(' ');
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

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatTime(value: number): string {
  return value.toFixed(3).replace(/\.000$/, '');
}

function sameScopeIncludingTranscript(a: ScopeWithTranscriptRevision, b: AnalysisScope): boolean {
  if (!sameAnalysisScope(a, b)) return false;
  const left = a.transcriptRevision;
  const right = (b as ScopeWithTranscriptRevision).transcriptRevision;
  return left === right;
}

function cloneScope(scope: ScopeWithTranscriptRevision): AnalysisScope {
  return { ...scope };
}

function cloneObservation(observation: FinalAnalysisObservation): FinalAnalysisObservation {
  return { ...observation };
}

function cloneAttempt(attempt: FinalAttempt): FinalAttempt {
  return {
    ...attempt,
    observationIds: [...attempt.observationIds],
    scriptSpanIds: [...attempt.scriptSpanIds],
    evidence: {
      observationIds: [...attempt.evidence.observationIds],
      cleanupSuggestionIds: [...attempt.evidence.cleanupSuggestionIds],
      reasons: [...attempt.evidence.reasons],
    },
    timing: { ...attempt.timing },
  };
}

function cloneGroup(group: RelatedAttemptGroup): RelatedAttemptGroup {
  return {
    ...group,
    attemptIds: [...group.attemptIds],
    observationIds: [...group.observationIds],
    scriptSpanIds: [...group.scriptSpanIds],
    kinds: [...group.kinds],
    rankedAttemptIds: [...group.rankedAttemptIds],
  };
}

function cloneCleanupSuggestion(suggestion: CleanupSuggestion): CleanupSuggestion {
  return {
    ...suggestion,
    segmentIds: [...suggestion.segmentIds],
    sourceSegmentIds: [...suggestion.sourceSegmentIds],
    removalInterval: suggestion.removalInterval ? { ...suggestion.removalInterval } : null,
    removal: suggestion.removal ? { ...suggestion.removal } : null,
    evidence: suggestion.evidence.map(evidence => ({ ...evidence, segmentIds: [...evidence.segmentIds] })),
    startBoundary: { ...suggestion.startBoundary },
    endBoundary: { ...suggestion.endBoundary },
  };
}

import {
  deserializeMustSayMetadata,
  evaluateMustSay,
  normalizeMustSayText,
  type MustSayMetadata,
  type MustSayTranscriptSegment,
} from '../features/speech-control/must-say.ts';
import {
  prepareCleanupRemoval,
  type CleanupDecision as ProducerCleanupDecision,
  type CleanupPlan,
  type CleanupSuggestion,
} from '../features/speech-control/cleanup.ts';
import {
  createTakeDecisionState,
  type TakeDecisionState,
  type TakeRecord,
} from '../features/speech-control/take-decisions.ts';
import type {
  CleanupDecision,
  EvidenceStatus,
  FootageReference,
  MustSayResult,
  ScratchEvent,
  TakeReason,
  Tier1Evidence,
  Tier1ScriptLineSnapshot,
} from './t1-contracts.ts';

/** Durable envelope version owned by the merged speech-control producers. */
export const T1_SPEECH_PROVIDER_VERSION = 1 as const;

export interface T1SpeechRecordingProvenance {
  /** Original recording identity, never a recognition segment id. */
  recordingId: string;
  /** The URI captured with this snapshot. A missing URI is explicit. */
  mediaUri: string | null;
  /** Source duration in seconds from capture/media metadata. */
  duration: number;
  /** Explicit availability at capture handoff time. */
  mediaAvailable: boolean;
}

export interface T1SpeechCaptureSnapshot {
  recordings: T1SpeechRecordingProvenance[];
  /** Replayed append-only take/scratch state, one scope per capture source. */
  takeDecisions: TakeDecisionState[];
  /** Epoch milliseconds from the capture clock. Omit when unavailable. */
  firstTakeStartedAt?: number;
  wrapRequestedAt?: number;
}

export interface T1SpeechMustSaySnapshot {
  metadata: MustSayMetadata;
  /** Raw producer segments. Caption corrections are deliberately not accepted here. */
  segments: MustSayTranscriptSegment[];
  recognitionStatus?: string;
  recognitionMessage?: string;
  /** Source-level media state supplied by capture, never inferred here. */
  mediaAvailable: boolean;
}

export interface T1SpeechCleanupSnapshot {
  recordingId: string;
  plan: CleanupPlan;
}

/**
 * JSON-safe handoff from capture speech control to review/wrap.
 *
 * The producer owns the meaning of recognition, must-say and cleanup verdicts.
 * This envelope carries those explicit snapshots together with the source
 * identities needed to review them. The adapter below never refreshes a
 * requirement revision, allocates a take id, or turns recognition timing into
 * a splice boundary.
 */
export interface T1SpeechProviderEnvelope {
  version: typeof T1_SPEECH_PROVIDER_VERSION;
  projectId: string;
  provider: 'fixture' | 'integrated';
  /** New immutable identity whenever producer evidence changes. */
  revision: string;
  status: EvidenceStatus;
  /** Exact ordered cue-free script snapshot used by the producer. */
  scriptSnapshot: Tier1ScriptLineSnapshot[];
  capture: T1SpeechCaptureSnapshot;
  mustSay: T1SpeechMustSaySnapshot;
  cleanup: T1SpeechCleanupSnapshot[];
}

export interface T1SpeechProviderContext {
  projectId: string;
  /** Current cue-free spoken script, in current project order. */
  scriptSnapshot: readonly Tier1ScriptLineSnapshot[];
}

export type T1SpeechProviderErrorCode =
  | 'malformed'
  | 'project-mismatch'
  | 'script-mismatch'
  | 'stale'
  | 'missing-provenance';

export interface T1SpeechProviderError {
  code: T1SpeechProviderErrorCode;
  message: string;
  path?: string;
}

export type T1SpeechProviderResult =
  | { ok: true; evidence: Tier1Evidence; warnings: string[] }
  | { ok: false; evidence: null; error: T1SpeechProviderError };

const EVIDENCE_STATUSES: readonly EvidenceStatus[] = [
  'pending',
  'available',
  'uncertain',
  'unavailable',
  'failed',
];

/**
 * Adapt a validated producer snapshot to the small review contract.
 *
 * `context` is required so a saved producer envelope cannot be treated as
 * current merely because its project id matches. Missing or stale source,
 * script, take, segment, or requirement provenance returns an explicit error.
 */
export function adaptT1SpeechProviderEnvelope(
  input: unknown,
  context: T1SpeechProviderContext,
): T1SpeechProviderResult {
  try {
    const envelope = validateEnvelope(input);
    validateContext(context);
    if (envelope.projectId !== context.projectId) {
      throw providerError(
        'project-mismatch',
        `Speech evidence belongs to project ${envelope.projectId}, not ${context.projectId}.`,
        'projectId',
      );
    }
    if (!sameScriptSnapshot(envelope.scriptSnapshot, context.scriptSnapshot)) {
      throw providerError(
        'script-mismatch',
        'Speech evidence was captured for a different spoken script snapshot.',
        'scriptSnapshot',
      );
    }

    const metadata = validateMetadataForScript(envelope.mustSay.metadata, envelope.scriptSnapshot);
    validateCaptureTimestamps(envelope.capture);
    const recordings = validateRecordings(envelope.capture.recordings);
    const recordingById = new Map(recordings.map((recording) => [recording.recordingId, recording]));
    const knownScriptIds = new Set([
      ...envelope.scriptSnapshot.map((line) => line.lineId),
      ...metadata.requirements
        .filter((requirement) => !requirement.enabled && normalizeMustSayText(requirement.requiredText) === '')
        .map((requirement) => requirement.lineId),
    ]);
    const takeStates = validateTakeStates(envelope.capture.takeDecisions, recordingById, knownScriptIds);
    const takes = indexTakes(takeStates);
    const segments = validateMustSaySegments(
      envelope.mustSay.segments,
      metadata,
      takes,
      recordingById,
    );
    const mustSay = buildMustSayResults(
      metadata,
      envelope.mustSay,
      envelope.scriptSnapshot,
      segments,
      takes,
      recordingById,
    );
    const reasons = buildReasons(takeStates, recordingById, knownScriptIds);
    const scratchHistory = buildScratchHistory(takeStates, takes);
    const cleanup = buildCleanupDecisions(envelope.cleanup, recordingById);

    return {
      ok: true,
      warnings: [],
      evidence: {
        version: 1,
        projectId: envelope.projectId,
        revision: envelope.revision,
        provider: envelope.provider,
        status: envelope.status,
        scriptSnapshot: envelope.scriptSnapshot.map((line) => ({ ...line })),
        reasons,
        mustSay,
        scratchHistory,
        cleanup,
        ...(envelope.capture.firstTakeStartedAt === undefined
          ? {}
          : { firstTakeStartedAt: envelope.capture.firstTakeStartedAt }),
        ...(envelope.capture.wrapRequestedAt === undefined
          ? {}
          : { wrapRequestedAt: envelope.capture.wrapRequestedAt }),
      },
    };
  } catch (error) {
    return { ok: false, evidence: null, error: asProviderError(error) };
  }
}

function validateEnvelope(input: unknown): T1SpeechProviderEnvelope {
  const envelope = asRecord(input, 'speech envelope');
  if (envelope.version !== T1_SPEECH_PROVIDER_VERSION) {
    throw providerError('malformed', 'Unsupported speech provider envelope version.', 'version');
  }
  const projectId = nonEmptyString(envelope.projectId, 'projectId');
  if (envelope.provider !== 'fixture' && envelope.provider !== 'integrated') {
    throw providerError('malformed', 'Speech provider must be fixture or integrated.', 'provider');
  }
  const revision = nonEmptyString(envelope.revision, 'revision');
  if (!EVIDENCE_STATUSES.includes(envelope.status as EvidenceStatus)) {
    throw providerError('malformed', 'Speech evidence status is invalid.', 'status');
  }
  const scriptSnapshot = validateScriptSnapshot(envelope.scriptSnapshot, 'scriptSnapshot');
  const capture = asRecord(envelope.capture, 'capture');
  const mustSay = asRecord(envelope.mustSay, 'mustSay');
  if (!Array.isArray(envelope.cleanup)) {
    throw providerError('malformed', 'cleanup must be an array.', 'cleanup');
  }
  return {
    version: T1_SPEECH_PROVIDER_VERSION,
    projectId,
    provider: envelope.provider,
    revision,
    status: envelope.status as EvidenceStatus,
    scriptSnapshot,
    capture: capture as unknown as T1SpeechCaptureSnapshot,
    mustSay: mustSay as unknown as T1SpeechMustSaySnapshot,
    cleanup: envelope.cleanup as T1SpeechCleanupSnapshot[],
  };
}

function validateContext(context: T1SpeechProviderContext): void {
  if (!context || typeof context !== 'object') {
    throw providerError('malformed', 'A current project context is required.', 'context');
  }
  nonEmptyString(context.projectId, 'context.projectId');
  validateScriptSnapshot(context.scriptSnapshot, 'context.scriptSnapshot');
}

function validateMetadataForScript(
  metadataInput: unknown,
  scriptSnapshot: readonly Tier1ScriptLineSnapshot[],
): MustSayMetadata {
  let metadata: MustSayMetadata | null;
  try {
    const serialized = JSON.stringify(metadataInput);
    metadata = deserializeMustSayMetadata(serialized);
  } catch (error) {
    throw providerError('malformed', errorMessage(error, 'Must-say metadata is unreadable.'), 'mustSay.metadata');
  }
  if (!metadata) {
    throw providerError('malformed', 'Must-say metadata is required.', 'mustSay.metadata');
  }

  const currentIds = new Set(scriptSnapshot.map((line) => line.lineId));
  const requirements = new Map(metadata.requirements.map((entry) => [entry.lineId, entry]));
  for (const line of scriptSnapshot) {
    const requirement = requirements.get(line.lineId);
    if (!requirement) {
      throw providerError(
        'stale',
        `Must-say metadata has no requirement snapshot for current line ${line.lineId}.`,
        `mustSay.metadata.requirements.${line.lineId}`,
      );
    }
    if (normalizeMustSayText(requirement.requiredText) !== normalizeMustSayText(line.spokenText)) {
      throw providerError(
        'stale',
        `Must-say wording for ${line.lineId} does not match the current script.`,
        `mustSay.metadata.requirements.${line.lineId}`,
      );
    }
    if (!normalizeMustSayText(requirement.requiredText) && requirement.enabled) {
      throw providerError(
        'malformed',
        `Action-only line ${line.lineId} cannot be enabled as must-say.`,
        `mustSay.metadata.requirements.${line.lineId}`,
      );
    }
  }
  for (const requirement of metadata.requirements) {
    if (!currentIds.has(requirement.lineId)) {
      // The spoken snapshot intentionally omits action-only lines. Their
      // disabled, empty metadata remains durable but cannot become speech
      // coverage or a must-say blocker here.
      if (!requirement.enabled && normalizeMustSayText(requirement.requiredText) === '') continue;
      throw providerError(
        'stale',
        `Must-say metadata contains an active line not present in the current script: ${requirement.lineId}.`,
        `mustSay.metadata.requirements.${requirement.lineId}`,
      );
    }
  }
  return metadata;
}

function validateRecordings(
  input: unknown,
): T1SpeechRecordingProvenance[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw providerError('missing-provenance', 'At least one captured recording provenance row is required.', 'capture.recordings');
  }
  const ids = new Set<string>();
  return input.map((value, index) => {
    const row = asRecord(value, `capture.recordings[${index}]`);
    const recordingId = nonEmptyString(row.recordingId, `capture.recordings[${index}].recordingId`);
    if (ids.has(recordingId)) {
      throw providerError('malformed', `Duplicate recording provenance id ${recordingId}.`, `capture.recordings[${index}]`);
    }
    ids.add(recordingId);
    if (!(typeof row.mediaUri === 'string' || row.mediaUri === null)) {
      throw providerError('missing-provenance', 'mediaUri must be a string or explicit null.', `capture.recordings[${index}].mediaUri`);
    }
    if (typeof row.mediaUri === 'string' && !row.mediaUri.trim()) {
      throw providerError('missing-provenance', 'mediaUri cannot be empty.', `capture.recordings[${index}].mediaUri`);
    }
    const duration = finitePositive(row.duration, `capture.recordings[${index}].duration`);
    if (typeof row.mediaAvailable !== 'boolean') {
      throw providerError('missing-provenance', 'mediaAvailable must be explicit.', `capture.recordings[${index}].mediaAvailable`);
    }
    if (row.mediaAvailable && row.mediaUri === null) {
      throw providerError('missing-provenance', 'Available media must have a URI.', `capture.recordings[${index}]`);
    }
    return {
      recordingId,
      mediaUri: row.mediaUri,
      duration,
      mediaAvailable: row.mediaAvailable,
    };
  });
}

function validateCaptureTimestamps(capture: T1SpeechCaptureSnapshot): void {
  for (const [key, value] of [
    ['firstTakeStartedAt', capture.firstTakeStartedAt],
    ['wrapRequestedAt', capture.wrapRequestedAt],
  ] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw providerError('missing-provenance', `${key} must be a finite epoch timestamp when supplied.`, `capture.${key}`);
    }
  }
}

function validateTakeStates(
  input: unknown,
  recordings: ReadonlyMap<string, T1SpeechRecordingProvenance>,
  knownScriptIds: ReadonlySet<string>,
): TakeDecisionState[] {
  if (!Array.isArray(input)) {
    throw providerError('malformed', 'capture.takeDecisions must be an array.', 'capture.takeDecisions');
  }
  const states: TakeDecisionState[] = [];
  const scopes = new Set<string>();
  for (const [index, value] of input.entries()) {
    const state = asRecord(value, `capture.takeDecisions[${index}]`);
    if (state.version !== 1) {
      throw providerError('malformed', 'Take decision state version is unsupported.', `capture.takeDecisions[${index}].version`);
    }
    const scope = asRecord(state.scope, `capture.takeDecisions[${index}].scope`);
    const sessionId = nonEmptyString(scope.sessionId, `capture.takeDecisions[${index}].scope.sessionId`);
    const sourceId = nonEmptyString(scope.sourceId, `capture.takeDecisions[${index}].scope.sourceId`);
    if (!recordings.has(sourceId)) {
      throw providerError(
        'missing-provenance',
        `Take scope ${sourceId} has no captured recording provenance.`,
        `capture.takeDecisions[${index}].scope.sourceId`,
      );
    }
    const scopeKey = `${sessionId}\u0000${sourceId}`;
    if (scopes.has(scopeKey)) {
      throw providerError('malformed', `Duplicate take decision scope ${sourceId}.`, `capture.takeDecisions[${index}]`);
    }
    scopes.add(scopeKey);
    if (!Array.isArray(state.takes) || !Array.isArray(state.events)) {
      throw providerError('malformed', 'Take decision state must include takes and events arrays.', `capture.takeDecisions[${index}]`);
    }
    let replayed: TakeDecisionState;
    try {
      replayed = createTakeDecisionState({
        scope: { sessionId, sourceId },
        takes: state.takes as TakeRecord[],
        events: state.events as TakeDecisionState['events'],
      });
    } catch (error) {
      throw providerError(
        'malformed',
        errorMessage(error, 'Take decision state is unreadable.'),
        `capture.takeDecisions[${index}]`,
      );
    }
    const recording = recordings.get(sourceId)!;
    for (const take of replayed.takes) {
      validateRangeWithin(take.t0, take.t1, recording.duration, `take ${take.id}`);
      for (const lineId of take.lineIds) {
        if (!knownScriptIds.has(lineId)) {
          throw providerError('stale', `Take ${take.id} references line ${lineId} outside the current script.`, `take ${take.id}.lineIds`);
        }
      }
      for (const segment of take.rawTranscript) {
        validateRangeWithin(segment.t0, segment.t1, recording.duration, `take ${take.id} transcript ${segment.id}`);
      }
      for (const reason of take.reasons) {
        if (reason.takeId !== take.id) {
          throw providerError('malformed', `Reason ${reason.id} targets another take.`, `take ${take.id}.reasons`);
        }
        for (const evidence of reason.scriptEvidence) {
          if (!knownScriptIds.has(evidence.lineId)) {
            throw providerError('stale', `Reason ${reason.id} references line ${evidence.lineId} outside the current script.`, `reason ${reason.id}`);
          }
        }
        for (const evidence of reason.transcriptEvidence) {
          validateRangeWithin(evidence.t0, evidence.t1, recording.duration, `reason ${reason.id} transcript evidence`);
        }
      }
    }
    for (const event of replayed.events) {
      if (event.type !== 'scratch' || !event.commandInterval) continue;
      const interval = event.commandInterval;
      if (interval.sourceId !== sourceId || interval.sessionId !== sessionId) {
        throw providerError('missing-provenance', `Scratch command ${event.id} has foreign source provenance.`, `scratch ${event.id}`);
      }
      validateRangeWithin(interval.t0, interval.t1, recording.duration, `scratch ${event.id} command interval`);
    }
    states.push(replayed);
  }
  return states;
}

function validateMustSaySegments(
  input: unknown,
  metadata: MustSayMetadata,
  takes: ReadonlyMap<string, TakeRecord>,
  recordings: ReadonlyMap<string, T1SpeechRecordingProvenance>,
): MustSayTranscriptSegment[] {
  if (!Array.isArray(input)) {
    throw providerError('malformed', 'mustSay.segments must be an array.', 'mustSay.segments');
  }
  const segmentIds = new Set<string>();
  return input.map((value, index) => {
    const segment = asRecord(value, `mustSay.segments[${index}]`);
    const id = nonEmptyString(segment.id, `mustSay.segments[${index}].id`);
    if (segmentIds.has(id)) throw providerError('malformed', `Duplicate speech segment ${id}.`, `mustSay.segments[${index}]`);
    segmentIds.add(id);
    if (typeof segment.text !== 'string' || typeof segment.isFinal !== 'boolean') {
      throw providerError('malformed', `Speech segment ${id} text and isFinal are required.`, `mustSay.segments[${index}]`);
    }
    const t0 = finiteNonNegative(segment.t0, `mustSay.segments[${index}].t0`);
    const t1 = finiteGreater(segment.t1, t0, `mustSay.segments[${index}].t1`);
    if (typeof segment.takeId !== 'string' || !segment.takeId.trim()) {
      throw providerError('missing-provenance', `Speech segment ${id} needs a durable take id.`, `mustSay.segments[${index}].takeId`);
    }
    const takeId = segment.takeId;
    const take = takes.get(takeId);
    if (!take) {
      throw providerError('missing-provenance', `Speech segment ${id} has no durable take ${takeId}.`, `mustSay.segments[${index}].takeId`);
    }
    if (t0 < take.t0 || t1 > take.t1) {
      throw providerError('missing-provenance', `Speech segment ${id} is outside take ${takeId}.`, `mustSay.segments[${index}]`);
    }
    const recording = recordings.get(take.scope.sourceId)!;
    if (!(typeof segment.mediaUri === 'string' || segment.mediaUri === null)) {
      throw providerError('missing-provenance', `Speech segment ${id} needs an explicit mediaUri.`, `mustSay.segments[${index}].mediaUri`);
    }
    if (segment.mediaUri !== recording.mediaUri) {
      throw providerError('stale', `Speech segment ${id} points at a different media URI.`, `mustSay.segments[${index}].mediaUri`);
    }
    if (typeof segment.playable !== 'boolean') {
      throw providerError('missing-provenance', `Speech segment ${id} needs an explicit playable state.`, `mustSay.segments[${index}].playable`);
    }
    if (!['clean', 'flub', 'scratched'].includes(segment.quality as string)) {
      throw providerError('missing-provenance', `Speech segment ${id} needs an explicit quality state.`, `mustSay.segments[${index}].quality`);
    }
    if (segment.playable && (!recording.mediaAvailable || recording.mediaUri === null)) {
      throw providerError('missing-provenance', `Speech segment ${id} is playable while its source is unavailable.`, `mustSay.segments[${index}]`);
    }
    const requirementRevisions = validateRequirementRevisions(
      segment.requirementRevisions,
      metadata,
      `mustSay.segments[${index}].requirementRevisions`,
    );
    const lineIds = validateOptionalIdArray(segment.lineIds, `mustSay.segments[${index}].lineIds`);
    const scriptContext = validateScriptContext(segment.scriptContext, `mustSay.segments[${index}].scriptContext`);
    return {
      ...(segment as unknown as MustSayTranscriptSegment),
      id,
      text: segment.text,
      isFinal: segment.isFinal,
      t0,
      t1,
      takeId,
      requirementRevisions,
      playable: segment.playable,
      mediaUri: segment.mediaUri,
      quality: segment.quality as MustSayTranscriptSegment['quality'],
      ...(lineIds === undefined ? {} : { lineIds }),
      ...(scriptContext === undefined ? {} : { scriptContext }),
    };
  });
}

function validateRequirementRevisions(
  input: unknown,
  metadata: MustSayMetadata,
  path: string,
): Readonly<Record<string, number>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw providerError('missing-provenance', 'Requirement revisions must be captured for every speech segment.', path);
  }
  const revisions = asRecord(input, path);
  for (const requirement of metadata.requirements.filter((entry) => normalizeMustSayText(entry.requiredText) !== '')) {
    if (!Object.prototype.hasOwnProperty.call(revisions, requirement.lineId)
      || !Number.isSafeInteger(revisions[requirement.lineId])
      || (revisions[requirement.lineId] as number) < 0) {
      throw providerError('missing-provenance', `Requirement revision for ${requirement.lineId} is missing.`, path);
    }
  }
  return Object.fromEntries(Object.entries(revisions).map(([key, value]) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw providerError('missing-provenance', `Requirement revision for ${key} is invalid.`, path);
    }
    return [key, value as number];
  }));
}

function buildMustSayResults(
  metadata: MustSayMetadata,
  snapshot: T1SpeechMustSaySnapshot,
  scriptSnapshot: readonly Tier1ScriptLineSnapshot[],
  segments: readonly MustSayTranscriptSegment[],
  takes: ReadonlyMap<string, TakeRecord>,
  recordings: ReadonlyMap<string, T1SpeechRecordingProvenance>,
): MustSayResult[] {
  if (typeof snapshot.mediaAvailable !== 'boolean') {
    throw providerError('missing-provenance', 'mustSay.mediaAvailable must be explicit.', 'mustSay.mediaAvailable');
  }
  const requirements = new Map(metadata.requirements.map((requirement) => [requirement.lineId, requirement]));
  const segmentsById = new Map(segments.map((segment) => [segment.id, segment]));
  return scriptSnapshot.map((line) => {
    const requirement = requirements.get(line.lineId)!;
    const evaluation = evaluateMustSay(requirement, {
      segments,
      recognitionStatus: snapshot.recognitionStatus,
      recognitionMessage: snapshot.recognitionMessage,
      mediaAvailable: snapshot.mediaAvailable,
    });
    const evidence = evidenceFootage(evaluation.evidence, segmentsById, takes, recordings);
    if (evaluation.status === 'covered' && evidence.length === 0) {
      throw providerError('missing-provenance', `Covered must-say line ${line.lineId} has no supporting source footage.`, `mustSay.${line.lineId}`);
    }
    return {
      lineId: line.lineId,
      required: requirement.enabled,
      status: requirement.enabled ? mapMustSayStatus(evaluation.status) : 'satisfied',
      evidence,
    };
  });
}

function evidenceFootage(
  evidence: ReturnType<typeof evaluateMustSay>['evidence'],
  segmentsById: ReadonlyMap<string, MustSayTranscriptSegment>,
  takes: ReadonlyMap<string, TakeRecord>,
  recordings: ReadonlyMap<string, T1SpeechRecordingProvenance>,
): FootageReference[] {
  if (!evidence) return [];
  const ranges = new Map<string, { t0: number; t1: number }>();
  for (const segmentId of evidence.segmentIds) {
    const segment = segmentsById.get(segmentId);
    if (!segment || typeof segment.takeId !== 'string' || segment.t0 === undefined || segment.t1 === undefined) {
      throw providerError('missing-provenance', `Must-say evidence references unknown segment ${segmentId}.`, 'mustSay.evidence');
    }
    const take = segment.takeId;
    const recordingId = findRecordingIdForTake(segment.takeId, takes, recordings, segmentId);
    const current = ranges.get(recordingId);
    if (current) {
      current.t0 = Math.min(current.t0, segment.t0);
      current.t1 = Math.max(current.t1, segment.t1);
    } else {
      ranges.set(recordingId, { t0: segment.t0, t1: segment.t1 });
    }
    if (evidence.takeIds.length > 0 && !evidence.takeIds.includes(take)) {
      throw providerError('malformed', `Must-say evidence segment ${segmentId} is missing from its take list.`, 'mustSay.evidence');
    }
  }
  return [...ranges.entries()].map(([recordingId, range]) => ({ recordingId, ...range }));
}

/** Resolve the source without using a recognition segment id as recording identity. */
function findRecordingIdForTake(
  takeId: string,
  takes: ReadonlyMap<string, TakeRecord>,
  recordings: ReadonlyMap<string, T1SpeechRecordingProvenance>,
  segmentId: string,
): string {
  const candidate = takes.get(takeId)?.scope.sourceId;
  if (candidate && recordings.has(candidate)) return candidate;
  throw providerError('missing-provenance', `Must-say segment ${segmentId} has no recording source.`, 'mustSay.evidence');
}

function buildReasons(
  states: readonly TakeDecisionState[],
  recordings: ReadonlyMap<string, T1SpeechRecordingProvenance>,
  knownScriptIds: ReadonlySet<string>,
): TakeReason[] {
  const reasons: TakeReason[] = [];
  const ids = new Set<string>();
  for (const state of states) {
    const recording = recordings.get(state.scope.sourceId)!;
    for (const take of state.takes) {
      for (const reason of take.reasons) {
        if (ids.has(reason.id)) throw providerError('malformed', `Duplicate take reason ${reason.id}.`, 'capture.takeDecisions');
        ids.add(reason.id);
        for (const evidence of reason.scriptEvidence) {
          if (!knownScriptIds.has(evidence.lineId)) {
            throw providerError('stale', `Reason ${reason.id} references an old script line.`, `reason ${reason.id}`);
          }
        }
        reasons.push({
          id: reason.id,
          takeId: reason.takeId,
          message: reason.message,
          status: reason.status,
          footage: { recordingId: recording.recordingId, t0: take.t0, t1: take.t1 },
        });
      }
    }
  }
  return reasons;
}

function buildScratchHistory(
  states: readonly TakeDecisionState[],
  takes: ReadonlyMap<string, TakeRecord>,
): ScratchEvent[] {
  const output: ScratchEvent[] = [];
  const ids = new Set<string>();
  for (const state of states) {
    for (const event of state.scratchHistory) {
      if (ids.has(event.id)) throw providerError('malformed', `Duplicate scratch event ${event.id}.`, 'capture.takeDecisions');
      ids.add(event.id);
      if (!takes.has(event.takeId) && event.state !== 'proposed') {
        throw providerError('missing-provenance', `Scratch event ${event.id} targets missing take ${event.takeId}.`, `scratch ${event.id}`);
      }
      output.push({
        id: event.id,
        takeId: event.takeId,
        commandSegmentId: event.commandSegmentId,
        source: event.source,
        state: event.state,
      });
    }
  }
  return output;
}

function buildCleanupDecisions(
  input: unknown,
  recordings: ReadonlyMap<string, T1SpeechRecordingProvenance>,
): CleanupDecision[] {
  if (!Array.isArray(input)) throw providerError('malformed', 'cleanup must be an array.', 'cleanup');
  const result: CleanupDecision[] = [];
  const decisionIds = new Set<string>();
  for (const [planIndex, value] of input.entries()) {
    const snapshot = asRecord(value, `cleanup[${planIndex}]`);
    const recordingId = nonEmptyString(snapshot.recordingId, `cleanup[${planIndex}].recordingId`);
    const recording = recordings.get(recordingId);
    if (!recording) throw providerError('missing-provenance', `Cleanup source ${recordingId} has no media provenance.`, `cleanup[${planIndex}]`);
    const plan = validateCleanupPlan(snapshot.plan, recording, `cleanup[${planIndex}].plan`);
    const suggestions = new Map(plan.suggestions.map((suggestion) => [suggestion.id, suggestion]));
    for (const decision of plan.decisions) {
      const suggestion = suggestions.get(decision.suggestionId);
      if (!suggestion) throw providerError('stale', `Cleanup decision ${decision.id} references a missing suggestion.`, `cleanup[${planIndex}].plan.decisions`);
      if (decisionIds.has(decision.id)) throw providerError('malformed', `Duplicate cleanup decision ${decision.id}.`, 'cleanup');
      decisionIds.add(decision.id);
      if (decision.recordingId !== recordingId || suggestion.recordingId !== recordingId) {
        throw providerError('missing-provenance', `Cleanup decision ${decision.id} has a foreign recording identity.`, `cleanup[${planIndex}].plan.decisions`);
      }
      if (decision.fingerprint !== suggestion.fingerprint) {
        throw providerError('stale', `Cleanup decision ${decision.id} no longer matches its suggestion.`, `cleanup[${planIndex}].plan.decisions`);
      }
      const removal = prepareCleanupRemoval(suggestion, [decision]);
      const boundariesReviewed = suggestion.startBoundary.verified && suggestion.endBoundary.verified;
      result.push({
        id: decision.id,
        suggestionId: decision.suggestionId,
        footage: { recordingId, t0: suggestion.t0, t1: suggestion.t1 },
        state: decision.action === 'accept' && removal !== null ? 'removed' : 'kept',
        boundariesReviewed,
      });
    }
  }
  return result;
}

function validateCleanupPlan(
  input: unknown,
  recording: T1SpeechRecordingProvenance,
  path: string,
): CleanupPlan {
  const plan = asRecord(input, path);
  if (!Array.isArray(plan.originalSegments) || !Array.isArray(plan.suggestions) || !Array.isArray(plan.decisions)) {
    throw providerError('malformed', 'Cleanup plan must retain originalSegments, suggestions, and decisions.', path);
  }
  const originalIds = new Set<string>();
  for (const [index, value] of plan.originalSegments.entries()) {
    const segment = asRecord(value, `${path}.originalSegments[${index}]`);
    const id = nonEmptyString(segment.id, `${path}.originalSegments[${index}].id`);
    if (originalIds.has(id)) throw providerError('malformed', `Duplicate cleanup segment ${id}.`, path);
    originalIds.add(id);
    if (segment.recordingId !== recording.recordingId) throw providerError('missing-provenance', `Cleanup segment ${id} has foreign recording identity.`, path);
    const t0 = finiteNonNegative(segment.t0, `${path}.originalSegments[${index}].t0`);
    const t1 = finiteGreater(segment.t1, t0, `${path}.originalSegments[${index}].t1`);
    validateRangeWithin(t0, t1, recording.duration, `cleanup segment ${id}`);
    if (typeof segment.text !== 'string') throw providerError('malformed', `Cleanup segment ${id} text is required.`, path);
  }
  const suggestions = plan.suggestions.map((value, index) => validateCleanupSuggestion(value, recording, `${path}.suggestions[${index}]`));
  const suggestionIds = new Set(suggestions.map((suggestion) => suggestion.id));
  const decisions: ProducerCleanupDecision[] = plan.decisions.map((value, index) => {
    const decision = asRecord(value, `${path}.decisions[${index}]`);
    const id = nonEmptyString(decision.id, `${path}.decisions[${index}].id`);
    const suggestionId = nonEmptyString(decision.suggestionId, `${path}.decisions[${index}].suggestionId`);
    if (decision.action !== 'accept' && decision.action !== 'dismiss') throw providerError('malformed', `Cleanup decision ${id} action is invalid.`, path);
    if (!suggestionIds.has(suggestionId)) throw providerError('stale', `Cleanup decision ${id} references a missing suggestion.`, path);
    if (decision.recordingId !== recording.recordingId || typeof decision.fingerprint !== 'string' || !decision.fingerprint) {
      throw providerError('missing-provenance', `Cleanup decision ${id} needs recording and fingerprint provenance.`, path);
    }
    return {
      id,
      suggestionId,
      action: decision.action,
      recordingId: decision.recordingId,
      fingerprint: decision.fingerprint,
    };
  });
  return {
    originalSegments: plan.originalSegments as CleanupPlan['originalSegments'],
    suggestions,
    decisions,
  };
}

function validateCleanupSuggestion(
  input: unknown,
  recording: T1SpeechRecordingProvenance,
  path: string,
): CleanupSuggestion {
  const suggestion = asRecord(input, path);
  const id = nonEmptyString(suggestion.id, `${path}.id`);
  if (suggestion.recordingId !== recording.recordingId) throw providerError('missing-provenance', `Cleanup suggestion ${id} has foreign recording identity.`, path);
  const t0 = finiteNonNegative(suggestion.t0, `${path}.t0`);
  const t1 = finiteGreater(suggestion.t1, t0, `${path}.t1`);
  validateRangeWithin(t0, t1, recording.duration, `cleanup suggestion ${id}`);
  if (typeof suggestion.fingerprint !== 'string' || !suggestion.fingerprint) throw providerError('missing-provenance', `Cleanup suggestion ${id} fingerprint is required.`, path);
  if (suggestion.requiresReview !== true || suggestion.reversible !== true || suggestion.status !== 'suggested') {
    throw providerError('malformed', `Cleanup suggestion ${id} is not a review-only reversible suggestion.`, path);
  }
  if (suggestion.action !== 'review-removal' && suggestion.action !== 'mark') throw providerError('malformed', `Cleanup suggestion ${id} action is invalid.`, path);
  validateOptionalInterval(suggestion.removalInterval, recording.duration, `${path}.removalInterval`);
  validateOptionalInterval(suggestion.removal, recording.duration, `${path}.removal`);
  const startBoundary = validateBoundary(suggestion.startBoundary, `${path}.startBoundary`);
  const endBoundary = validateBoundary(suggestion.endBoundary, `${path}.endBoundary`);
  if (typeof suggestion.safeToRemove !== 'boolean' || typeof suggestion.canPrepareRemoval !== 'boolean') {
    throw providerError('malformed', `Cleanup suggestion ${id} needs explicit safety fields.`, path);
  }
  if (suggestion.canPrepareRemoval && (suggestion.removalInterval === null || !suggestion.safeToRemove)) {
    throw providerError('malformed', `Cleanup suggestion ${id} has inconsistent removal safety.`, path);
  }
  if (!Array.isArray(suggestion.segmentIds) || !Array.isArray(suggestion.sourceSegmentIds)) {
    throw providerError('malformed', `Cleanup suggestion ${id} needs segment provenance arrays.`, path);
  }
  return suggestion as unknown as CleanupSuggestion;
}

function validateBoundary(input: unknown, path: string): { source: CleanupSuggestion['startBoundary']['source']; verified: boolean } {
  const boundary = asRecord(input, path);
  if (typeof boundary.source !== 'string' || typeof boundary.verified !== 'boolean') throw providerError('missing-provenance', 'Cleanup boundary provenance is incomplete.', path);
  return { source: boundary.source as CleanupSuggestion['startBoundary']['source'], verified: boundary.verified };
}

function validateOptionalInterval(input: unknown, duration: number, path: string): void {
  if (input === null) return;
  const interval = asRecord(input, path);
  const t0 = finiteNonNegative(interval.t0, `${path}.t0`);
  const t1 = finiteGreater(interval.t1, t0, `${path}.t1`);
  validateRangeWithin(t0, t1, duration, path);
}

function validateScriptSnapshot(input: unknown, path: string): Tier1ScriptLineSnapshot[] {
  if (!Array.isArray(input)) throw providerError('malformed', 'scriptSnapshot must be an array.', path);
  const ids = new Set<string>();
  return input.map((value, index) => {
    const line = asRecord(value, `${path}[${index}]`);
    const lineId = nonEmptyString(line.lineId, `${path}[${index}].lineId`);
    if (ids.has(lineId)) throw providerError('malformed', `Duplicate script line ${lineId}.`, path);
    ids.add(lineId);
    if (typeof line.spokenText !== 'string') throw providerError('malformed', `Script line ${lineId} spokenText is required.`, path);
    return { lineId, spokenText: line.spokenText };
  });
}

function validateScriptContext(input: unknown, path: string): MustSayTranscriptSegment['scriptContext'] | undefined {
  if (input === undefined) return undefined;
  const context = asRecord(input, path);
  const lineIds = validateOptionalIdArray(context.lineIds, `${path}.lineIds`);
  if (!lineIds || lineIds.length === 0 || typeof context.normalizedText !== 'string') {
    throw providerError('malformed', 'Script context needs line ids and normalized text.', path);
  }
  return { lineIds, normalizedText: context.normalizedText };
}

function validateOptionalIdArray(input: unknown, path: string): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw providerError('malformed', 'Expected an id array.', path);
  const ids = input.map((value, index) => nonEmptyString(value, `${path}[${index}]`));
  if (new Set(ids).size !== ids.length) throw providerError('malformed', 'Duplicate ids are not allowed.', path);
  return ids;
}

function indexTakes(states: readonly TakeDecisionState[]): Map<string, TakeRecord> {
  const takes = new Map<string, TakeRecord>();
  for (const state of states) {
    for (const take of state.takes) {
      if (takes.has(take.id)) throw providerError('malformed', `Duplicate durable take ${take.id}.`, 'capture.takeDecisions');
      takes.set(take.id, take);
    }
  }
  return takes;
}

function mapMustSayStatus(status: ReturnType<typeof evaluateMustSay>['status']): MustSayResult['status'] {
  if (status === 'covered') return 'satisfied';
  if (status === 'needed') return 'missing';
  if (status === 'pending') return 'pending';
  if (status === 'unavailable') return 'unavailable';
  return 'uncertain';
}

function sameScriptSnapshot(
  first: readonly Tier1ScriptLineSnapshot[],
  second: readonly Tier1ScriptLineSnapshot[],
): boolean {
  return first.length === second.length
    && first.every((line, index) => line.lineId === second[index]?.lineId && line.spokenText === second[index]?.spokenText);
}

function validateRangeWithin(t0: number, t1: number, duration: number, label: string): void {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 < 0 || t1 <= t0 || t1 > duration) {
    throw providerError('missing-provenance', `${label} is outside its captured source duration.`, label);
  }
}

function finitePositive(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw providerError('missing-provenance', `${path} must be a positive finite number.`, path);
  return value;
}

function finiteNonNegative(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw providerError('missing-provenance', `${path} must be a non-negative finite number.`, path);
  return value;
}

function finiteGreater(value: unknown, lower: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= lower) throw providerError('missing-provenance', `${path} must be finite and greater than its start.`, path);
  return value;
}

function asRecord(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerError('malformed', `${path} must be an object.`, path);
  return value as Record<string, any>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw providerError('malformed', `${path} must be a non-empty string.`, path);
  return value;
}

function providerError(code: T1SpeechProviderErrorCode, message: string, path?: string): ProviderValidationError {
  return new ProviderValidationError(code, message, path);
}

class ProviderValidationError extends Error {
  readonly code: T1SpeechProviderErrorCode;
  readonly path?: string;

  constructor(code: T1SpeechProviderErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'ProviderValidationError';
    this.code = code;
    this.path = path;
  }
}

function asProviderError(error: unknown): T1SpeechProviderError {
  if (error instanceof ProviderValidationError) {
    return { code: error.code, message: error.message, ...(error.path === undefined ? {} : { path: error.path }) };
  }
  return { code: 'malformed', message: errorMessage(error, 'Speech provider envelope is unreadable.') };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

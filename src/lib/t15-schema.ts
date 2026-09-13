import type { Project, TranscriptSeg } from './session';

/** The first additive durable foundation envelope. */
export const T15_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TimingClock = 'source-presentation' | 'capture-clock' | 'unknown';
export type Availability = 'available' | 'missing' | 'unknown';
export type EvidenceStatus =
  | 'unknown'
  | 'not-collected'
  | 'pending'
  | 'partial'
  | 'observed'
  | 'complete'
  | 'empty'
  | 'failed'
  | 'cancelled';

/**
 * Every persisted revision check uses the same vector.
 * `transcriptRevision` is per durable source because pickup clocks and jobs are
 * independent from the root recording.
 */
export interface RevisionVector {
  projectRevision: number;
  scriptRevision: number;
  timelineRevision: number;
  captionRevision: number;
  transcriptRevision: Record<string, number>;
}

export interface TimingProvenance {
  /** Where the timing was produced, for example `legacy-migration` or `fixture`. */
  origin: string;
  /** The producer name, retained even when the producer is unavailable later. */
  producer: string;
  /** Producer contract version, never inferred from a timestamp. */
  version: string;
  clock: TimingClock;
  timingMethod: string;
  /** The unit at the adapter boundary, while persisted ranges remain seconds. */
  inputUnit: 'seconds' | 'milliseconds' | 'unknown';
  /** `null` means the producer did not measure uncertainty. */
  uncertaintySeconds: number | null;
  processor: string;
  monotonicOriginMs?: number | null;
  sourceZeroOffsetSeconds?: number | null;
  captureGeneration?: string | null;
}

export interface SourceInterval {
  sourceId: string;
  /** Half-open source-relative presentation seconds. */
  t0: number;
  t1: number;
  provenance: TimingProvenance;
}

export interface FramingIntervalMsInput {
  sourceId?: string;
  /** Existing framing producers call this identity `sourceMediaId`. */
  sourceMediaId?: string;
  startMs: number;
  endMs: number;
  sourceDurationMs?: number | null;
  uncertaintyMs?: number | null;
  provenance?: Partial<TimingProvenance>;
}

/** A source identity outlives a file relocation and aliases legacy IDs. */
export interface SourceRecord {
  id: string;
  kind: 'original' | 'pickup' | 'unknown';
  mediaUri: string | null;
  aliases: string[];
  durationSeconds: number | null;
  durationProvenance: TimingProvenance | null;
  availability: Availability;
  timing: TimingProvenance;
  registeredAssetId?: string | null;
}

export interface ScriptSpan {
  id: string;
  lineId: string;
  text: string;
  actionCueIds?: string[];
}

export interface ScriptSnapshot {
  id: string;
  revision: number;
  rawText: string;
  spans: ScriptSpan[];
  previousSnapshotId?: string | null;
}

export interface ImportantPoint {
  id: string;
  scriptRevision: number;
  spanIds: string[];
  label?: string;
  producer?: {
    status: EvidenceStatus;
    reasonIds: string[];
    payload?: JsonValue;
  };
  creator?: {
    importance: 'required' | 'optional' | 'excluded' | 'unknown';
    selected: boolean | null;
    note?: string;
  };
  coverage?: {
    status: EvidenceStatus;
    evidenceIds: string[];
  };
  action?: {
    required: boolean;
    resolved: boolean;
  };
}

export interface ChunkReference {
  id: string;
  ordinal: number;
  total: number;
  /** A registered app-private asset or a separately journaled page. */
  assetId?: string | null;
  byteLength?: number | null;
  sha256?: string | null;
}

export interface TranscriptSegmentRecord {
  id: string;
  sourceId: string;
  t0: number;
  t1: number;
  /** Recognizer text is immutable evidence; creator corrections live elsewhere. */
  text: string;
  isFinal: boolean;
  revision: number;
  timing: TimingProvenance;
  rawText?: string | null;
}

export interface TranscriptRevision {
  id: string;
  sourceId: string;
  revision: number;
  status: EvidenceStatus;
  /** A complete revision may be represented by pages when memory is bounded. */
  segments?: TranscriptSegmentRecord[];
  chunks?: ChunkReference[];
  provenance: TimingProvenance;
}

export interface Observation {
  id: string;
  sourceId: string;
  /** Null is uncollected timing; equal endpoints represent an instantaneous sample, never a clip. */
  t0: number | null;
  t1: number | null;
  kind: string;
  status: EvidenceStatus;
  provenance: TimingProvenance;
  payload?: JsonValue;
  chunks?: ChunkReference[];
}

export interface ReasonRecord {
  id: string;
  /** B consumes these exact fields for timeline display/reason persistence. */
  kind: string;
  text: string;
  actor: 'creator' | 'analysis';
  /** A producer may add an origin/code without changing the shared seam. */
  origin?: 'producer' | 'creator' | 'system' | 'legacy';
  code?: string;
  detail?: string;
  sourceId?: string;
  payload?: JsonValue;
}

/** Exact minimal reason envelope published to the timeline owner. */
export interface TimelineReason {
  id: string;
  kind: string;
  text: string;
  actor: 'creator' | 'analysis';
}

export interface TakeRecord {
  /** Existing take IDs are carried unchanged through migration. */
  id: string;
  sourceId: string;
  t0: number;
  t1: number;
  mediaUri: string | null;
  playable: boolean | null;
  quality: 'clean' | 'scratched' | 'flub' | 'unknown';
  inFrame: boolean | null;
  transcriptSegmentIds: string[];
  eligibleLineIds: string[] | null;
  groupId: string | null;
  pointIds: string[];
  reasonIds: string[];
}

export interface TakeGroup {
  id: string;
  takeIds: string[];
  sourceIds: string[];
  observationIds: string[];
  pointIds: string[];
  reasonIds: string[];
  status: EvidenceStatus;
}

/**
 * This is the only timeline shape shared with the editor owner.
 * It stores source-local intervals and keeps excluded rows addressable.
 */
export interface TimelineClip {
  id: string;
  sourceId: string;
  t0: number;
  t1: number;
  spanIds: string[];
  pointIds: string[];
  utteranceIds: string[];
  included: boolean;
  reasonIds: string[];
  takeId?: string;
  parentClipId?: string;
  /** Availability is independent from creator exclusion. */
  availability?: Availability;
  label?: string;
  recommended?: boolean;
}

export interface TimelineSnapshot {
  revision: number;
  clips: TimelineClip[];
}

/** Minimal B-owned command data.  A stores these records without defining command behavior. */
export interface TimelineCommand {
  id: string;
  kind: string;
  baseRevision: number;
  revision: number;
  before: TimelineClip[];
  after: TimelineClip[];
  reasonIds: string[];
  operationId?: string;
  decisionId?: string | null;
  baseRevisions?: RevisionVector;
  afterRevisions?: RevisionVector;
}

/** The exact history shape consumed by B, including abandoned redo branches. */
export interface TimelineHistory {
  entries: TimelineCommand[];
  cursor: number;
  abandonedEntries: TimelineCommand[];
  initialSnapshot?: TimelineSnapshot;
  /** Optional page pointer for histories moved to the existing evidence ledger. */
  archive?: { kind: 'timeline-command'; pageIds: string[] };
}

export interface ProposalConflict {
  id: string;
  code: string;
  clipIds?: string[];
  spanIds?: string[];
  detail?: string;
}

export interface TimelineProposal {
  id: string;
  jobId?: string | null;
  resultId?: string | null;
  base: RevisionVector;
  clips: TimelineClip[];
  reasonIds: string[];
  conflicts: ProposalConflict[];
  status: 'pending' | 'accepted' | 'rejected' | 'stale' | 'unknown';
}

export interface CreatorDecision {
  id: string;
  operationId: string;
  actor: 'creator';
  kind: string;
  base: RevisionVector;
  after?: RevisionVector;
  proposalId?: string | null;
  clipIds: string[];
  takeIds: string[];
  reasonIds: string[];
  createdAt?: number;
}

/** Backwards name retained for callers that describe timeline history generically. */
export type HistoryState = TimelineHistory;
export type HistoryEntry = TimelineCommand;

export interface CaptionPreferences {
  showInEditor: boolean;
  burnIntoExport: boolean;
}

export interface CaptionCorrection {
  id: string;
  segmentId: string;
  sourceId: string;
  revision: number;
  text: string;
  baseTranscriptRevision: number;
  origin: 'creator' | 'legacy';
}

export interface ExtensionRecord {
  /** Namespaced keys prevent unrelated producers from interpreting each other. */
  key: string;
  version: number;
  availability: Availability | 'unsupported' | 'failed';
  payload?: JsonValue;
  assetIds: string[];
}

export interface AssetReference {
  id: string;
  /** Null means the registration is pending, missing, or intentionally unavailable. */
  registeredUri: string | null;
  mediaType: string | null;
  byteSize: number | null;
  sha256: string | null;
  availability: Availability | 'pending' | 'failed';
  chunks?: ChunkReference[];
}

export interface AnalysisJobReferences {
  /** Jobs/results are durable rows in the existing database, not unbounded Project arrays. */
  jobIds: string[];
  resultIds: string[];
}

export interface LegacyProjectPreservation {
  videoUri: string | null;
  duration: number | null;
  trim: Project['trim'] | null;
  mediaMissing: boolean;
}

/** Add this value as `Project.v15`; legacy Project fields remain untouched. */
export interface DurableFoundation {
  version: typeof T15_SCHEMA_VERSION;
  projectId: string;
  revisions: RevisionVector;
  sources: SourceRecord[];
  scriptSnapshots: ScriptSnapshot[];
  points: ImportantPoint[];
  transcriptRevisions: TranscriptRevision[];
  observations: Observation[];
  reasons: ReasonRecord[];
  takes: TakeRecord[];
  takeGroups: TakeGroup[];
  proposals: TimelineProposal[];
  decisions: CreatorDecision[];
  timeline: TimelineSnapshot;
  captions: CaptionPreferences;
  captionCorrections: CaptionCorrection[];
  history: TimelineHistory;
  extensions: ExtensionRecord[];
  assets: AssetReference[];
  jobRefs?: AnalysisJobReferences;
  /** Optional compact migration marker; the untouched Project owns full legacy arrays. */
  legacy?: LegacyProjectPreservation;
}

/** The job owner is canonical; these re-exports keep the exact envelope discoverable from the schema seam. */
export type {
  AnalysisRequest,
  AnalysisResult,
  AnalysisStatus,
  AnalysisJob,
  StoredAnalysisResult,
} from './t15-jobs';

const EMPTY_PROVENANCE = (): TimingProvenance => ({
  origin: 'legacy-migration',
  producer: 'legacy-project',
  version: 'project-v2',
  clock: 'source-presentation',
  timingMethod: 'legacy-source-relative',
  inputUnit: 'seconds',
  uncertaintySeconds: null,
  processor: 'unknown',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function requireId(value: unknown, label: string): asserts value is string {
  if (!isNonEmptyString(value)) throw new TypeError(`${label} must be a non-empty string.`);
}

function requireRevision(value: unknown, label: string): asserts value is number {
  if (!isRevision(value)) throw new RangeError(`${label} must be a non-negative safe integer.`);
}

function requireRange(t0: unknown, t1: unknown, label: string, duration: number | null): void {
  if (!isFiniteNumber(t0) || !isFiniteNumber(t1) || t0 < 0 || t1 <= t0) {
    throw new RangeError(`${label} must be a finite non-empty source-relative interval.`);
  }
  if (duration !== null && t1 > duration) throw new RangeError(`${label} exceeds its source duration.`);
}

function requireOptionalNullableFinite(value: unknown, label: string): void {
  if (value !== null && value !== undefined && !isFiniteNumber(value)) {
    throw new RangeError(`${label} must be finite or null.`);
  }
  if (isFiniteNumber(value) && value < 0) throw new RangeError(`${label} must be non-negative.`);
}

function validateProvenance(value: unknown, label: string): asserts value is TimingProvenance {
  if (!isRecord(value)
    || !isNonEmptyString(value.origin)
    || !isNonEmptyString(value.producer)
    || !isNonEmptyString(value.version)
    || !['source-presentation', 'capture-clock', 'unknown'].includes(value.clock as string)
    || !isNonEmptyString(value.timingMethod)
    || !['seconds', 'milliseconds', 'unknown'].includes(value.inputUnit as string)
    || !isNonEmptyString(value.processor)
    || (value.uncertaintySeconds !== null && !isFiniteNumber(value.uncertaintySeconds))) {
    throw new TypeError(`${label} provenance is unreadable.`);
  }
  requireOptionalNullableFinite(value.uncertaintySeconds, `${label} uncertaintySeconds`);
  requireOptionalNullableFinite(value.monotonicOriginMs, `${label} monotonicOriginMs`);
  requireOptionalNullableFinite(value.sourceZeroOffsetSeconds, `${label} sourceZeroOffsetSeconds`);
  if (value.captureGeneration !== undefined && value.captureGeneration !== null) requireId(value.captureGeneration, `${label} captureGeneration`);
}

function validateRevisionVector(value: unknown, label = 'revision vector'): asserts value is RevisionVector {
  if (!isRecord(value)) throw new TypeError(`${label} is unreadable.`);
  for (const key of ['projectRevision', 'scriptRevision', 'timelineRevision', 'captionRevision']) {
    requireRevision(value[key], `${label}.${key}`);
  }
  if (!isRecord(value.transcriptRevision)) throw new TypeError(`${label}.transcriptRevision is unreadable.`);
  for (const [sourceId, revision] of Object.entries(value.transcriptRevision)) {
    requireId(sourceId, `${label}.transcriptRevision source id`);
    requireRevision(revision, `${label}.transcriptRevision.${sourceId}`);
  }
}

function validateChunkReferences(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new TypeError(`${label} chunks are unreadable.`);
  const ids = new Set<string>();
  let total: number | null = null;
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) throw new TypeError(`${label} chunk ${index + 1} is unreadable.`);
    requireId(item.id, `${label} chunk id`);
    requireRevision(item.ordinal, `${label} chunk ordinal`);
    requireRevision(item.total, `${label} chunk total`);
    if (item.total === 0 || item.ordinal >= item.total) throw new RangeError(`${label} chunk ordinal is outside its page count.`);
    if (total === null) total = item.total;
    if (total !== item.total) throw new RangeError(`${label} chunks disagree on total page count.`);
    if (ids.has(item.id)) throw new Error(`${label} chunk identity is duplicated.`);
    ids.add(item.id);
    requireOptionalNullableFinite(item.byteLength, `${label} chunk byteLength`);
    if (item.sha256 !== undefined && item.sha256 !== null) requireId(item.sha256, `${label} chunk sha256`);
    if (item.assetId !== undefined && item.assetId !== null) requireId(item.assetId, `${label} chunk assetId`);
  }
}

function mapLegacySourceId(project: Project, recordingId: string | undefined, mediaUri: string | null, sourceIds: Set<string>): string {
  if (recordingId === `${project.id}:original` && mediaUri === project.videoUri) return project.id;
  if (recordingId && sourceIds.has(recordingId)) return recordingId;
  if (mediaUri === project.videoUri || mediaUri === null) return project.id;
  const recording = project.recordings?.find(item => item.id === recordingId || item.mediaUri === mediaUri);
  if (recording && sourceIds.has(recording.id)) return recording.id;
  return `${project.id}:legacy-source:${recordingId || 'unknown'}`;
}

function sourceForUri(project: Project, uri: string | null, sources: SourceRecord[], sourceIds: Set<string>, takeId?: string): string {
  if (uri === null || uri === project.videoUri) return project.id;
  const known = project.recordings?.find(recording => recording.mediaUri === uri);
  if (known && sourceIds.has(known.id)) return known.id;
  const generated = `${project.id}:legacy-source:${takeId || encodeURIComponent(uri)}`;
  if (!sourceIds.has(generated)) {
    const provenance = EMPTY_PROVENANCE();
    sources.push({
      id: generated,
      kind: 'unknown',
      mediaUri: uri,
      aliases: [],
      durationSeconds: null,
      durationProvenance: null,
      availability: 'unknown',
      timing: provenance,
    });
    sourceIds.add(generated);
  }
  return generated;
}

function legacyScriptLines(project: Project): Array<{ id: string; text: string; actionCueIds: string[] }> {
  if (project.scriptLines?.length) {
    return project.scriptLines.map((line, index) => ({
      id: isNonEmptyString(line.id) ? line.id : `${project.id}:line:${index}`,
      text: typeof line.spokenText === 'string' ? line.spokenText : '',
      actionCueIds: Array.isArray(line.actionCues) ? line.actionCues.map(cue => cue.id).filter(isNonEmptyString) : [],
    }));
  }
  if (typeof project.script !== 'string' || !project.script.trim()) return [];
  return (project.script.match(/[^.!?\n]+[.!?]?/g) ?? []).map((text, index) => ({
    id: `${project.id}:line:${index}`,
    text: text.trim(),
    actionCueIds: [],
  }));
}

function uniqueLegacyId(used: Set<string>, preferred: string, fallback: string): string {
  const candidate = isNonEmptyString(preferred) && !used.has(preferred) ? preferred : fallback;
  let id = candidate;
  let suffix = 1;
  while (used.has(id)) id = `${candidate}:${suffix++}`;
  used.add(id);
  return id;
}

function buildSources(project: Project): { sources: SourceRecord[]; sourceIds: Set<string> } {
  const sources: SourceRecord[] = [];
  const sourceIds = new Set<string>();
  const legacy = EMPTY_PROVENANCE();
  const rootDuration = isFiniteNumber(project.duration) && project.duration >= 0 ? project.duration : null;
  const root: SourceRecord = {
    id: project.id,
    kind: 'original',
    mediaUri: typeof project.videoUri === 'string' ? project.videoUri : null,
    aliases: [],
    durationSeconds: rootDuration,
    durationProvenance: rootDuration === null ? null : legacy,
    availability: project.mediaMissing ? 'missing' : 'unknown',
    timing: legacy,
  };
  sources.push(root);
  sourceIds.add(root.id);
  for (const recording of project.recordings ?? []) {
    if (!isNonEmptyString(recording.id) || typeof recording.mediaUri !== 'string') continue;
    if (recording.id === `${project.id}:original` && recording.mediaUri === project.videoUri) {
      if (!root.aliases.includes(recording.id)) root.aliases.push(recording.id);
      continue;
    }
    if (sourceIds.has(recording.id)) continue;
    const duration = isFiniteNumber(recording.duration) && recording.duration >= 0 ? recording.duration : null;
    sources.push({
      id: recording.id,
      kind: 'pickup',
      mediaUri: recording.mediaUri,
      aliases: [],
      durationSeconds: duration,
      durationProvenance: duration === null ? null : legacy,
      availability: 'unknown',
      timing: legacy,
    });
    sourceIds.add(recording.id);
  }
  return { sources, sourceIds };
}

function buildScript(project: Project): { snapshots: ScriptSnapshot[]; spans: ScriptSpan[] } {
  const lines = legacyScriptLines(project);
  const spans = lines.map(line => ({
    id: `${line.id}:span:0`,
    lineId: line.id,
    text: line.text,
    actionCueIds: line.actionCueIds,
  }));
  const rawText = typeof project.script === 'string' ? project.script : lines.map(line => line.text).join('\n');
  const snapshot: ScriptSnapshot = {
    id: `${project.id}:script:0`,
    revision: 0,
    rawText,
    spans,
    previousSnapshotId: null,
  };
  return { snapshots: [snapshot], spans };
}

function segmentSourceId(project: Project, segment: TranscriptSeg, sourceIds: Set<string>): string {
  if (segment.recordingId === `${project.id}:original` && segment.recordingId && sourceIds.has(project.id)) return project.id;
  if (segment.recordingId && sourceIds.has(segment.recordingId)) return segment.recordingId;
  return project.id;
}

function toTranscriptSegment(project: Project, segment: TranscriptSeg, index: number, sourceId: string): TranscriptSegmentRecord {
  const id = isNonEmptyString(segment.id) ? segment.id : `${project.id}:legacy:transcript:${index}`;
  const provenance = EMPTY_PROVENANCE();
  return {
    id,
    sourceId,
    t0: segment.t0,
    t1: segment.t1,
    text: segment.text,
    isFinal: segment.isFinal !== false,
    revision: isRevision(segment.revision) ? segment.revision : 0,
    timing: {
      ...provenance,
      timingMethod: segment.timingSource ?? provenance.timingMethod,
      origin: segment.source ?? provenance.origin,
    },
    rawText: segment.rawText ?? null,
  };
}

function buildTranscriptState(project: Project, sourceIds: Set<string>): {
  revisions: TranscriptRevision[];
  corrections: CaptionCorrection[];
  perSource: Record<string, number>;
} {
  const grouped = new Map<string, TranscriptSegmentRecord[]>();
  const corrections: CaptionCorrection[] = [];
  project.transcript.forEach((segment, index) => {
    const sourceId = segmentSourceId(project, segment, sourceIds);
    const record = toTranscriptSegment(project, segment, index, sourceId);
    const rows = grouped.get(sourceId) ?? [];
    rows.push(record);
    grouped.set(sourceId, rows);
    const correction = segment.manualCorrection ?? segment.correctedText;
    if (correction !== undefined && correction !== null) {
      corrections.push({
        id: `${record.id}:caption:${record.revision}`,
        segmentId: record.id,
        sourceId,
        revision: record.revision,
        text: correction,
        baseTranscriptRevision: record.revision,
        origin: 'legacy',
      });
    }
  });
  const revisions: TranscriptRevision[] = [];
  const perSource: Record<string, number> = {};
  for (const [sourceId, segments] of grouped) {
    const revision = isRevision(project.captionRevision) ? project.captionRevision : Math.max(0, ...segments.map(segment => segment.revision));
    perSource[sourceId] = revision;
    const provenance = EMPTY_PROVENANCE();
    revisions.push({
      id: `${project.id}:transcript:${sourceId}:${revision}`,
      sourceId,
      revision,
      status: segments.some(segment => !segment.isFinal) ? 'partial' : 'complete',
      segments,
      provenance,
    });
  }
  if (!revisions.length) {
    perSource[project.id] = isRevision(project.captionRevision) ? project.captionRevision : 0;
    revisions.push({
      id: `${project.id}:transcript:${project.id}:unknown`,
      sourceId: project.id,
      revision: perSource[project.id],
      status: 'unknown',
      chunks: [],
      provenance: EMPTY_PROVENANCE(),
    });
  }
  if (project.rawTranscript?.length) {
    const rawBySource = new Map<string, TranscriptSegmentRecord[]>();
    project.rawTranscript.forEach((segment, index) => {
      const sourceId = segmentSourceId(project, segment, sourceIds);
      const rows = rawBySource.get(sourceId) ?? [];
      rows.push(toTranscriptSegment(project, segment, index, sourceId));
      rawBySource.set(sourceId, rows);
    });
    for (const [sourceId, segments] of rawBySource) {
      const revision = Math.max(0, (perSource[sourceId] ?? 0) - 1);
      revisions.push({
        id: `${project.id}:transcript:${sourceId}:raw:${revision}`,
        sourceId,
        revision,
        status: 'complete',
        segments,
        provenance: { ...EMPTY_PROVENANCE(), origin: 'legacy-raw-transcript' },
      });
    }
  }
  return { revisions, corrections, perSource };
}

function buildTakes(project: Project, sources: SourceRecord[], sourceIds: Set<string>): TakeRecord[] {
  return (project.takes ?? []).map((take, index) => {
    const sourceId = sourceForUri(project, take.mediaUri ?? null, sources, sourceIds, take.id || `take:${index}`);
    return {
      id: take.id,
      sourceId,
      t0: take.t0,
      t1: take.t1,
      mediaUri: take.mediaUri ?? null,
      playable: typeof take.playable === 'boolean' ? take.playable : null,
      quality: ['clean', 'scratched', 'flub'].includes(take.quality) ? take.quality : 'unknown',
      inFrame: typeof take.inFrame === 'boolean' ? take.inFrame : null,
      transcriptSegmentIds: [...take.transcriptSegmentIds],
      eligibleLineIds: take.eligibleLineIds ? [...take.eligibleLineIds] : take.lineIds ? [...take.lineIds] : null,
      groupId: null,
      pointIds: [],
      reasonIds: [],
    };
  });
}

function buildTimeline(project: Project, sources: SourceRecord[], sourceIds: Set<string>): TimelineSnapshot {
  const clips: TimelineClip[] = [];
  const ids = new Set<string>();
  const takeIds = new Set((project.takes ?? []).map(take => take.id));
  const add = (candidate: TimelineClip, index: number) => {
    const id = uniqueLegacyId(ids, candidate.id, `${project.id}:legacy-clip:${index}`);
    clips.push({ ...candidate, id });
  };
  // Existing `clips` are review/recommendation metadata and must not be
  // silently promoted into an accepted V1 timeline.  An explicit prepared
  // review segment, including an explicit empty array, is authoritative.
  if (Array.isArray(project.reviewSegments)) {
    project.reviewSegments.forEach((segment, index) => {
      const sourceId = sourceForUri(project, segment.uri, sources, sourceIds, segment.takeId ?? `review:${index}`);
      add({
        id: segment.takeId ?? `${project.id}:review-clip:${index}`,
        sourceId,
        t0: segment.t0,
        t1: segment.t1,
        spanIds: [],
        pointIds: [],
        utteranceIds: [],
        included: true,
        reasonIds: [],
        takeId: segment.takeId && takeIds.has(segment.takeId) ? segment.takeId : undefined,
        availability: sources.find(source => source.id === sourceId)?.availability ?? 'unknown',
      }, index);
    });
  } else if (project.cutsReviewed === true && Array.isArray(project.cuts)) {
    project.cuts.forEach((cut, index) => {
      if (!isFiniteNumber(cut.t0) || !isFiniteNumber(cut.t1) || cut.t1 <= cut.t0 || cut.t0 < 0) throw new RangeError(`Legacy cut ${index + 1} is invalid.`);
      add({
        id: `${project.id}:legacy-cut:${index}`,
        sourceId: project.id,
        t0: cut.t0,
        t1: cut.t1,
        spanIds: [],
        pointIds: [],
        utteranceIds: [],
        included: true,
        reasonIds: [],
        availability: sources.find(source => source.id === project.id)?.availability ?? 'unknown',
      }, index);
    });
  } else if (project.trim && isFiniteNumber(project.trim.start) && isFiniteNumber(project.trim.end)
    && project.trim.start >= 0 && project.trim.end > project.trim.start) {
    add({
      id: `${project.id}:legacy-trim`,
      sourceId: project.id,
      t0: project.trim.start,
      t1: project.trim.end,
      spanIds: [],
      pointIds: [],
      utteranceIds: [],
      included: true,
      reasonIds: [],
      availability: sources.find(source => source.id === project.id)?.availability ?? 'unknown',
    }, 0);
  } else {
    const duration = sources.find(source => source.id === project.id)?.durationSeconds ?? null;
    if (duration !== null && duration > 0) add({
      id: `${project.id}:legacy-full`,
      sourceId: project.id,
      t0: 0,
      t1: duration,
      spanIds: [],
      pointIds: [],
      utteranceIds: [],
      included: true,
      reasonIds: [],
      availability: sources.find(source => source.id === project.id)?.availability ?? 'unknown',
    }, 0);
  }
  const revision = isRevision((project as Project & { timelineRevision?: unknown }).timelineRevision)
    ? (project as Project & { timelineRevision: number }).timelineRevision
    : 0;
  return { revision, clips };
}

/**
 * Build the additive envelope once for a legacy project.
 * An already-attached valid envelope is cloned so reopen never regenerates IDs.
 */
export function createFoundation(project: Project): DurableFoundation {
  if (!isRecord(project) || !isNonEmptyString(project.id)) throw new TypeError('Project identity is invalid.');
  const existing = (project as Project & { v15?: unknown }).v15;
  if (existing !== undefined) {
    validateFoundation(existing, project);
    return cloneJson(existing);
  }

  const { sources, sourceIds } = buildSources(project);
  const script = buildScript(project);
  const transcript = buildTranscriptState(project, sourceIds);
  const takes = buildTakes(project, sources, sourceIds);
  const timeline = buildTimeline(project, sources, sourceIds);
  // A source with no collected transcript still gets an explicit revision key.
  // This distinguishes "not collected" from an empty verified transcript and
  // lets a later pickup checkpoint advance only its own source scope.
  for (const source of sources) if (transcript.perSource[source.id] === undefined) transcript.perSource[source.id] = 0;
  const revisions: RevisionVector = {
    projectRevision: 0,
    scriptRevision: script.snapshots[0]?.revision ?? 0,
    timelineRevision: timeline.revision,
    captionRevision: isRevision(project.captionRevision) ? project.captionRevision : 0,
    transcriptRevision: transcript.perSource,
  };
  const initialSnapshot = cloneJson(timeline);
  const state: DurableFoundation = {
    version: T15_SCHEMA_VERSION,
    projectId: project.id,
    revisions,
    sources,
    scriptSnapshots: script.snapshots,
    points: [],
    transcriptRevisions: transcript.revisions,
    observations: [],
    reasons: [],
    takes,
    takeGroups: [],
    proposals: [],
    decisions: [],
    timeline,
    captions: { showInEditor: true, burnIntoExport: true },
    captionCorrections: transcript.corrections,
    history: { initialSnapshot, entries: [], cursor: 0, abandonedEntries: [] },
    extensions: [],
    assets: [],
    jobRefs: { jobIds: [], resultIds: [] },
  };
  validateFoundation(state, project);
  return state;
}

/**
 * Refresh source identities after a pickup checkpoint without rebuilding any
 * existing metadata or changing a source identity when its URI is relocated.
 * New recordings become sources; the legacy root-original row remains an alias.
 */
export function synchronizeSources(project: Project, foundation: DurableFoundation): DurableFoundation {
  if (!isRecord(project) || !isNonEmptyString(project.id)) throw new TypeError('Project identity is invalid.');
  validateFoundation(foundation, project);
  const next = cloneJson(foundation);
  const knownIds = new Set(next.sources.map(source => source.id));
  const generated = buildSources(project);
  const root = next.sources.find(source => source.id === project.id);
  const generatedRoot = generated.sources.find(source => source.id === project.id);
  if (root && generatedRoot) {
    for (const alias of generatedRoot.aliases) if (!root.aliases.includes(alias)) root.aliases.push(alias);
  }
  for (const source of generated.sources) {
    if (source.id === project.id || knownIds.has(source.id)) continue;
    next.sources.push(source);
    knownIds.add(source.id);
    next.revisions.transcriptRevision[source.id] ??= 0;
  }
  return next;
}

function validateSource(value: unknown, index: number): asserts value is SourceRecord {
  const label = `source ${index + 1}`;
  if (!isRecord(value) || !isNonEmptyString(value.id)
    || !['original', 'pickup', 'unknown'].includes(value.kind as string)
    || (value.mediaUri !== null && !isNonEmptyString(value.mediaUri))
    || !Array.isArray(value.aliases)
    || value.aliases.some(alias => !isNonEmptyString(alias))
    || !['available', 'missing', 'unknown'].includes(value.availability as string)
    || !isRecord(value.timing)) throw new TypeError(`${label} is unreadable.`);
  validateProvenance(value.timing, `${label}.timing`);
  if (value.durationSeconds !== null && (!isFiniteNumber(value.durationSeconds) || value.durationSeconds < 0)) throw new RangeError(`${label} duration is invalid.`);
  if (value.durationProvenance !== null) validateProvenance(value.durationProvenance, `${label}.duration`);
  if (value.registeredAssetId !== undefined && value.registeredAssetId !== null) requireId(value.registeredAssetId, `${label}.registeredAssetId`);
}

function validateScriptSnapshots(state: DurableFoundation): Set<string> {
  if (!Array.isArray(state.scriptSnapshots)) throw new TypeError('scriptSnapshots must be an array.');
  const snapshotIds = new Set<string>();
  const spanIds = new Set<string>();
  for (const [index, snapshot] of state.scriptSnapshots.entries()) {
    if (!isRecord(snapshot) || !isNonEmptyString(snapshot.id) || !isRevision(snapshot.revision)
      || typeof snapshot.rawText !== 'string' || !Array.isArray(snapshot.spans)) throw new TypeError(`script snapshot ${index + 1} is unreadable.`);
    if (snapshotIds.has(snapshot.id)) throw new Error(`script snapshot identity ${snapshot.id} is duplicated.`);
    snapshotIds.add(snapshot.id);
    const currentSpanIds = new Set<string>();
    for (const [spanIndex, span] of snapshot.spans.entries()) {
      if (!isRecord(span) || !isNonEmptyString(span.id) || !isNonEmptyString(span.lineId) || typeof span.text !== 'string') throw new TypeError(`script span ${spanIndex + 1} is unreadable.`);
      if (currentSpanIds.has(span.id)) throw new Error(`script span identity ${span.id} is duplicated in a snapshot.`);
      currentSpanIds.add(span.id);
      spanIds.add(span.id);
      if (span.actionCueIds !== undefined && (!Array.isArray(span.actionCueIds) || span.actionCueIds.some(id => !isNonEmptyString(id)))) throw new TypeError(`script span ${span.id} action cues are unreadable.`);
    }
    if (snapshot.previousSnapshotId !== undefined && snapshot.previousSnapshotId !== null) requireId(snapshot.previousSnapshotId, 'previous script snapshot id');
  }
  if (state.scriptSnapshots.length === 0) throw new Error('At least one script snapshot is required.');
  return spanIds;
}

function validateTimelineSnapshot(value: unknown, label: string, state: DurableFoundation): void {
  if (!isRecord(value) || !isRevision(value.revision) || !Array.isArray(value.clips)) throw new TypeError(`${label} is unreadable.`);
  const sourceMap = new Map(state.sources.map(source => [source.id, source]));
  const takeIds = new Set(state.takes.map(take => take.id));
  const spanIds = new Set(state.scriptSnapshots.flatMap(snapshot => snapshot.spans.map(span => span.id)));
  const pointIds = new Set(state.points.map(point => point.id));
  const reasonIds = new Set(state.reasons.map(reason => reason.id));
  const clipIds = new Set<string>();
  for (const [index, clip] of value.clips.entries()) {
    if (!isRecord(clip) || !isNonEmptyString(clip.id) || !isNonEmptyString(clip.sourceId)
      || !isFiniteNumber(clip.t0) || !isFiniteNumber(clip.t1) || !Array.isArray(clip.spanIds)
      || !Array.isArray(clip.pointIds) || !Array.isArray(clip.utteranceIds) || typeof clip.included !== 'boolean' || !Array.isArray(clip.reasonIds)) throw new TypeError(`${label} clip ${index + 1} is unreadable.`);
    const source = sourceMap.get(clip.sourceId);
    if (!source) throw new Error(`${label} clip ${clip.id} references an unknown source.`);
    requireRange(clip.t0, clip.t1, `${label} clip ${clip.id}`, source.durationSeconds);
    if (clipIds.has(clip.id)) throw new Error(`${label} clip identity ${clip.id} is duplicated.`);
    clipIds.add(clip.id);
    for (const id of clip.spanIds) if (!isNonEmptyString(id) || !spanIds.has(id)) throw new Error(`${label} clip ${clip.id} references an unknown script span.`);
    for (const id of clip.pointIds) if (!isNonEmptyString(id) || !pointIds.has(id)) throw new Error(`${label} clip ${clip.id} references an unknown point.`);
    for (const id of clip.utteranceIds) if (!isNonEmptyString(id)) throw new Error(`${label} clip ${clip.id} utterance identity is invalid.`);
    for (const id of clip.reasonIds) if (!isNonEmptyString(id) || !reasonIds.has(id)) throw new Error(`${label} clip ${clip.id} references an unknown reason.`);
    if (clip.takeId !== undefined && (!isNonEmptyString(clip.takeId) || !takeIds.has(clip.takeId))) throw new Error(`${label} clip ${clip.id} references an unknown take.`);
    if (clip.parentClipId !== undefined) requireId(clip.parentClipId, `${label} parent clip id`);
    if (clip.availability !== undefined && (typeof clip.availability !== 'string' || !['available', 'missing', 'unknown'].includes(clip.availability))) throw new TypeError(`${label} clip ${clip.id} availability is invalid.`);
  }
}

function validateStateArrays(state: DurableFoundation): void {
  const sourceMap = new Map(state.sources.map(source => [source.id, source]));
  const spanIds = new Set(state.scriptSnapshots.flatMap(snapshot => snapshot.spans.map(span => span.id)));
  const pointIds = new Set<string>();
  for (const point of state.points) {
    if (!isRecord(point) || !isNonEmptyString(point.id) || !isRevision(point.scriptRevision) || !Array.isArray(point.spanIds)) throw new TypeError('Point metadata is unreadable.');
    if (pointIds.has(point.id)) throw new Error(`point identity ${point.id} is duplicated.`);
    pointIds.add(point.id);
    for (const spanId of point.spanIds) if (!isNonEmptyString(spanId) || !spanIds.has(spanId)) throw new Error(`point ${point.id} references an unknown script span.`);
    if (point.producer) {
      if (!['unknown', 'not-collected', 'pending', 'partial', 'observed', 'complete', 'empty', 'failed', 'cancelled'].includes(point.producer.status)) throw new TypeError(`point ${point.id} producer status is invalid.`);
      if (!Array.isArray(point.producer.reasonIds)) throw new TypeError(`point ${point.id} reasons are unreadable.`);
      if (point.producer.payload !== undefined && !isJsonValue(point.producer.payload)) throw new TypeError(`point ${point.id} payload is unreadable.`);
    }
  }
  const takeIds = new Set<string>();
  for (const take of state.takes) {
    if (!isRecord(take) || !isNonEmptyString(take.id) || !isNonEmptyString(take.sourceId) || !sourceMap.has(take.sourceId)
      || !isFiniteNumber(take.t0) || !isFiniteNumber(take.t1) || !isRecord(take) || !Array.isArray(take.transcriptSegmentIds)
      || !Array.isArray(take.pointIds) || !Array.isArray(take.reasonIds)) throw new TypeError('Take metadata is unreadable.');
    if (takeIds.has(take.id)) throw new Error(`take identity ${take.id} is duplicated.`);
    takeIds.add(take.id);
    requireRange(take.t0, take.t1, `take ${take.id}`, sourceMap.get(take.sourceId)!.durationSeconds);
    if (!['clean', 'scratched', 'flub', 'unknown'].includes(take.quality)) throw new TypeError(`take ${take.id} quality is invalid.`);
    if (typeof take.playable !== 'boolean' && take.playable !== null) throw new TypeError(`take ${take.id} playable state is invalid.`);
    if (typeof take.inFrame !== 'boolean' && take.inFrame !== null) throw new TypeError(`take ${take.id} inFrame state is invalid.`);
    for (const id of take.pointIds) if (!isNonEmptyString(id) || !pointIds.has(id)) throw new Error(`take ${take.id} references an unknown point.`);
    for (const id of take.reasonIds) if (!isNonEmptyString(id)) throw new Error(`take ${take.id} reason is invalid.`);
  }
  const reasonIds = new Set<string>();
  for (const reason of state.reasons) {
    if (!isRecord(reason) || !isNonEmptyString(reason.id) || !isNonEmptyString(reason.kind) || typeof reason.text !== 'string' || !['creator', 'analysis'].includes(reason.actor)) throw new TypeError('Reason metadata is unreadable.');
    if (reasonIds.has(reason.id)) throw new Error(`reason identity ${reason.id} is duplicated.`);
    reasonIds.add(reason.id);
    if (reason.origin !== undefined && !['producer', 'creator', 'system', 'legacy'].includes(reason.origin)) throw new TypeError(`reason ${reason.id} origin is invalid.`);
    if (reason.sourceId !== undefined && (!isNonEmptyString(reason.sourceId) || !sourceMap.has(reason.sourceId))) throw new Error(`reason ${reason.id} references an unknown source.`);
    if (reason.payload !== undefined && !isJsonValue(reason.payload)) throw new TypeError(`reason ${reason.id} payload is unreadable.`);
  }
  for (const observation of state.observations) {
    if (!isRecord(observation) || !isNonEmptyString(observation.id) || !isNonEmptyString(observation.sourceId) || !sourceMap.has(observation.sourceId)
      || !isRecord(observation.provenance) || !isNonEmptyString(observation.kind)
      || !['unknown', 'not-collected', 'pending', 'partial', 'observed', 'complete', 'empty', 'failed', 'cancelled'].includes(observation.status)) throw new TypeError('Observation metadata is unreadable.');
    validateProvenance(observation.provenance, `observation ${observation.id}`);
    if (observation.t0 === null || observation.t1 === null) {
      if (observation.t0 !== null || observation.t1 !== null) throw new RangeError(`observation ${observation.id} has incomplete timing.`);
    } else {
      const duration = observation.provenance.clock === 'source-presentation' ? sourceMap.get(observation.sourceId)!.durationSeconds : null;
      if (observation.t0 === observation.t1) {
        if (!isFiniteNumber(observation.t0) || observation.t0 < 0 || (duration !== null && observation.t0 > duration)) throw new RangeError(`observation ${observation.id} sample time is invalid.`);
      } else requireRange(observation.t0, observation.t1, `observation ${observation.id}`, duration);
    }
    if (observation.payload !== undefined && !isJsonValue(observation.payload)) throw new TypeError(`observation ${observation.id} payload is unreadable.`);
    validateChunkReferences(observation.chunks, `observation ${observation.id}`);
  }
  const observationIds = new Set(state.observations.map(observation => observation.id));
  for (const revision of state.transcriptRevisions) {
    if (!isRecord(revision) || !isNonEmptyString(revision.id) || !isNonEmptyString(revision.sourceId) || !sourceMap.has(revision.sourceId) || !isRevision(revision.revision)
      || !['unknown', 'not-collected', 'pending', 'partial', 'observed', 'complete', 'empty', 'failed', 'cancelled'].includes(revision.status) || !isRecord(revision.provenance)) throw new TypeError('Transcript revision is unreadable.');
    validateProvenance(revision.provenance, `transcript revision ${revision.id}`);
    if (revision.segments !== undefined) {
      if (!Array.isArray(revision.segments)) throw new TypeError(`transcript revision ${revision.id} segments are unreadable.`);
      const segmentIds = new Set<string>();
      for (const segment of revision.segments) {
        if (!isRecord(segment) || !isNonEmptyString(segment.id) || segmentIds.has(segment.id) || segment.sourceId !== revision.sourceId || typeof segment.text !== 'string' || typeof segment.isFinal !== 'boolean' || !isRevision(segment.revision) || !isRecord(segment.timing)) throw new TypeError(`transcript revision ${revision.id} segment is unreadable.`);
        segmentIds.add(segment.id);
        requireRange(segment.t0, segment.t1, `transcript segment ${segment.id}`, sourceMap.get(revision.sourceId)!.durationSeconds);
        validateProvenance(segment.timing, `transcript segment ${segment.id}`);
      }
    }
    validateChunkReferences(revision.chunks, `transcript revision ${revision.id}`);
    if (revision.status === 'complete' && revision.segments === undefined && revision.chunks === undefined) throw new Error(`complete transcript revision ${revision.id} has no evidence pages.`);
  }
  const extensionKeys = new Set<string>();
  for (const extension of state.extensions) {
    if (!isRecord(extension) || !isNonEmptyString(extension.key) || !isRevision(extension.version) || !['available', 'missing', 'unknown', 'unsupported', 'failed'].includes(extension.availability) || !Array.isArray(extension.assetIds)) throw new TypeError('Extension metadata is unreadable.');
    const identity = JSON.stringify([extension.key, extension.version]);
    if (extensionKeys.has(identity)) throw new Error(`extension identity ${extension.key} version ${extension.version} is duplicated.`);
    extensionKeys.add(identity);
    if (extension.payload !== undefined && !isJsonValue(extension.payload)) throw new TypeError(`extension ${extension.key} payload is unreadable.`);
    for (const assetId of extension.assetIds) requireId(assetId, `extension ${extension.key} asset id`);
  }
  const assetIds = new Set<string>();
  for (const asset of state.assets) {
    if (!isRecord(asset) || !isNonEmptyString(asset.id) || (asset.registeredUri !== null && !isNonEmptyString(asset.registeredUri)) || (asset.mediaType !== null && !isNonEmptyString(asset.mediaType)) || (asset.sha256 !== null && !isNonEmptyString(asset.sha256)) || !['available', 'missing', 'unknown', 'pending', 'failed'].includes(asset.availability)) throw new TypeError('Asset reference is unreadable.');
    if (assetIds.has(asset.id)) throw new Error(`asset identity ${asset.id} is duplicated.`);
    assetIds.add(asset.id);
    if (asset.byteSize !== null && (!isRevision(asset.byteSize) || asset.byteSize < 0)) throw new RangeError(`asset ${asset.id} byteSize is invalid.`);
    validateChunkReferences(asset.chunks, `asset ${asset.id}`);
  }
  for (const extension of state.extensions) for (const assetId of extension.assetIds) if (!assetIds.has(assetId)) throw new Error(`extension ${extension.key} references an unknown asset.`);
  for (const takeGroup of state.takeGroups) {
    if (!isRecord(takeGroup) || !isNonEmptyString(takeGroup.id) || !Array.isArray(takeGroup.takeIds) || !Array.isArray(takeGroup.sourceIds) || !Array.isArray(takeGroup.observationIds) || !Array.isArray(takeGroup.pointIds) || !Array.isArray(takeGroup.reasonIds)) throw new TypeError('Take group metadata is unreadable.');
    for (const takeId of takeGroup.takeIds) if (!takeIds.has(takeId)) throw new Error(`take group ${takeGroup.id} references an unknown take.`);
    for (const sourceId of takeGroup.sourceIds) if (!sourceMap.has(sourceId)) throw new Error(`take group ${takeGroup.id} references an unknown source.`);
    for (const observationId of takeGroup.observationIds) if (!observationIds.has(observationId)) throw new Error(`take group ${takeGroup.id} references an unknown observation.`);
    for (const pointId of takeGroup.pointIds) if (!pointIds.has(pointId)) throw new Error(`take group ${takeGroup.id} references an unknown point.`);
    if (!['unknown', 'not-collected', 'pending', 'partial', 'observed', 'complete', 'empty', 'failed', 'cancelled'].includes(takeGroup.status)) throw new TypeError(`take group ${takeGroup.id} status is invalid.`);
  }
}

function validateHistory(state: DurableFoundation): void {
  const validateEntry: (entry: unknown, label: string) => asserts entry is TimelineCommand = (entry, label) => {
    if (!isRecord(entry) || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.kind)
      || !isRevision(entry.baseRevision) || !isRevision(entry.revision)
      || !Array.isArray(entry.before) || !Array.isArray(entry.after) || !Array.isArray(entry.reasonIds)) throw new TypeError(`${label} is unreadable.`);
    if (entry.revision < entry.baseRevision) throw new RangeError(`${label} revision precedes its base revision.`);
    validateTimelineSnapshot({ revision: entry.baseRevision, clips: entry.before }, `${label}.before`, state);
    validateTimelineSnapshot({ revision: entry.revision, clips: entry.after }, `${label}.after`, state);
    for (const reasonId of entry.reasonIds) requireId(reasonId, `${label} reason id`);
    if (entry.operationId !== undefined) requireId(entry.operationId, `${label} operation id`);
    if (entry.decisionId !== undefined && entry.decisionId !== null) requireId(entry.decisionId, `${label} decision id`);
    if (entry.baseRevisions !== undefined) validateRevisionVector(entry.baseRevisions, `${label}.baseRevisions`);
    if (entry.afterRevisions !== undefined) validateRevisionVector(entry.afterRevisions, `${label}.afterRevisions`);
  };
  if (!isRecord(state.history) || !Array.isArray(state.history.entries) || !isRevision(state.history.cursor) || !Array.isArray(state.history.abandonedEntries)) throw new TypeError('History state is unreadable.');
  if (state.history.initialSnapshot !== undefined) validateTimelineSnapshot(state.history.initialSnapshot, 'history initial snapshot', state);
  if (state.history.archive !== undefined) {
    if (!isRecord(state.history.archive) || state.history.archive.kind !== 'timeline-command' || !Array.isArray(state.history.archive.pageIds)) throw new TypeError('History archive is unreadable.');
    for (const pageId of state.history.archive.pageIds) requireId(pageId, 'history archive page id');
  }
  if (state.history.cursor > state.history.entries.length) throw new RangeError('History cursor is outside the active history.');
  const ids = new Set<string>();
  for (const [index, entry] of state.history.entries.entries()) {
    validateEntry(entry, `history entry ${index + 1}`);
    if (ids.has(entry.id)) throw new Error(`history entry identity ${entry.id} is duplicated.`);
    ids.add(entry.id);
  }
  for (const [index, entry] of state.history.abandonedEntries.entries()) {
    validateEntry(entry, `abandoned history entry ${index + 1}`);
    if (ids.has(entry.id)) throw new Error(`history entry identity ${entry.id} is duplicated.`);
    ids.add(entry.id);
  }
}

/** Validate one envelope before writing it to the existing Project/SQLite journal. */
export function validateFoundation(value: unknown, project?: Project): asserts value is DurableFoundation {
  if (!isRecord(value) || value.version !== T15_SCHEMA_VERSION || !isNonEmptyString(value.projectId)) throw new TypeError('Durable foundation envelope is unreadable or unsupported.');
  const state = value as unknown as DurableFoundation;
  if (project && state.projectId !== project.id) throw new Error('Durable foundation belongs to a different project.');
  if (!isRecord(state.revisions) || !Array.isArray(state.sources) || !Array.isArray(state.points) || !Array.isArray(state.transcriptRevisions)
    || !Array.isArray(state.observations) || !Array.isArray(state.reasons) || !Array.isArray(state.takes) || !Array.isArray(state.takeGroups)
    || !Array.isArray(state.proposals) || !Array.isArray(state.decisions) || !isRecord(state.timeline) || !isRecord(state.captions)
    || !Array.isArray(state.captionCorrections) || !isRecord(state.history) || !Array.isArray(state.extensions) || !Array.isArray(state.assets)) throw new TypeError('Durable foundation fields are unreadable.');
  validateRevisionVector(state.revisions);
  const sourceIds = new Set<string>();
  const aliases = new Set<string>();
  for (const [index, source] of state.sources.entries()) {
    validateSource(source, index);
    if (sourceIds.has(source.id)) throw new Error(`source identity ${source.id} is duplicated.`);
    sourceIds.add(source.id);
    for (const alias of source.aliases) {
      if (sourceIds.has(alias) || aliases.has(alias)) throw new Error(`source alias ${alias} collides with a source identity.`);
      aliases.add(alias);
    }
  }
  if (!sourceIds.has(state.projectId)) throw new Error('The project root source is missing.');
  validateScriptSnapshots(state);
  validateStateArrays(state);
  validateTimelineSnapshot(state.timeline, 'timeline', state);
  if (!isRevision(state.timeline.revision) || state.timeline.revision !== state.revisions.timelineRevision) throw new Error('Timeline revision does not match the revision vector.');
  if (state.captions.showInEditor !== true && state.captions.showInEditor !== false) throw new TypeError('Caption editor preference is invalid.');
  if (state.captions.burnIntoExport !== true && state.captions.burnIntoExport !== false) throw new TypeError('Caption export preference is invalid.');
  const decisionIds = new Set<string>();
  for (const decision of state.decisions) {
    if (!isRecord(decision) || !isNonEmptyString(decision.id) || !isNonEmptyString(decision.operationId) || decision.actor !== 'creator' || !isNonEmptyString(decision.kind) || !isRecord(decision.base) || !Array.isArray(decision.clipIds) || !Array.isArray(decision.takeIds) || !Array.isArray(decision.reasonIds)) throw new TypeError('Creator decision is unreadable.');
    if (decisionIds.has(decision.id)) throw new Error(`decision identity ${decision.id} is duplicated.`);
    decisionIds.add(decision.id);
    validateRevisionVector(decision.base, `decision ${decision.id}.base`);
    if (decision.after !== undefined) validateRevisionVector(decision.after, `decision ${decision.id}.after`);
    if (decision.proposalId !== undefined && decision.proposalId !== null) requireId(decision.proposalId, `decision ${decision.id} proposal id`);
    for (const id of [...decision.clipIds, ...decision.takeIds, ...decision.reasonIds]) requireId(id, `decision ${decision.id} reference`);
    if (decision.createdAt !== undefined && !isFiniteNumber(decision.createdAt)) throw new RangeError(`decision ${decision.id} timestamp is invalid.`);
  }
  const proposalIds = new Set<string>();
  for (const proposal of state.proposals) {
    if (!isRecord(proposal) || !isNonEmptyString(proposal.id) || !isRecord(proposal.base) || !Array.isArray(proposal.clips) || !Array.isArray(proposal.reasonIds) || !Array.isArray(proposal.conflicts) || !['pending', 'accepted', 'rejected', 'stale', 'unknown'].includes(proposal.status)) throw new TypeError('Timeline proposal is unreadable.');
    if (proposalIds.has(proposal.id)) throw new Error(`proposal identity ${proposal.id} is duplicated.`);
    proposalIds.add(proposal.id);
    validateRevisionVector(proposal.base, `proposal ${proposal.id}.base`);
    for (const clip of proposal.clips) validateTimelineSnapshot({ revision: proposal.base.timelineRevision, clips: [clip] }, `proposal ${proposal.id}`, state);
    for (const reasonId of proposal.reasonIds) requireId(reasonId, `proposal ${proposal.id} reason id`);
    for (const conflict of proposal.conflicts) if (!isRecord(conflict) || !isNonEmptyString(conflict.id) || !isNonEmptyString(conflict.code)) throw new TypeError(`proposal ${proposal.id} conflict is unreadable.`);
    if (proposal.jobId !== undefined && proposal.jobId !== null) requireId(proposal.jobId, `proposal ${proposal.id} job id`);
    if (proposal.resultId !== undefined && proposal.resultId !== null) requireId(proposal.resultId, `proposal ${proposal.id} result id`);
  }
  for (const correction of state.captionCorrections) {
    if (!isRecord(correction) || !isNonEmptyString(correction.id) || !isNonEmptyString(correction.segmentId) || !isNonEmptyString(correction.sourceId) || !sourceIds.has(correction.sourceId) || !isRevision(correction.revision) || typeof correction.text !== 'string' || !isRevision(correction.baseTranscriptRevision) || !['creator', 'legacy'].includes(correction.origin)) throw new TypeError('Caption correction is unreadable.');
  }
  validateHistory(state);
  if (state.jobRefs !== undefined) {
    if (!isRecord(state.jobRefs) || !Array.isArray(state.jobRefs.jobIds) || !Array.isArray(state.jobRefs.resultIds)) throw new TypeError('Analysis job references are unreadable.');
    for (const id of [...state.jobRefs.jobIds, ...state.jobRefs.resultIds]) requireId(id, 'analysis job reference');
  }
  if (state.revisions.scriptRevision < Math.max(...state.scriptSnapshots.map(snapshot => snapshot.revision))) throw new Error('Script revision precedes script snapshots.');
  for (const source of state.sources) if (state.revisions.transcriptRevision[source.id] === undefined) throw new Error(`Transcript revision is missing for source ${source.id}.`);
}

/** Stable JSON for duplicate operation/payload checks; object key order is ignored. */
export function canonicalJson(value: unknown): string {
  const canonicalize = (input: unknown, path: string): JsonValue => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError(`${path} contains a non-finite number.`);
      return input;
    }
    if (Array.isArray(input)) return input.map((item, index) => item === undefined ? null : canonicalize(item, `${path}[${index}]`));
    if (!isRecord(input)) throw new TypeError(`${path} is not JSON-compatible.`);
    const output: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(input).sort()) {
      // JSON object semantics omit optional undefined fields.  This keeps the
      // duplicate-operation check stable for legacy Project snapshots whose
      // optional fields were never written.
      if (input[key] === undefined) continue;
      output[key] = canonicalize(input[key], `${path}.${key}`);
    }
    return output;
  };
  return JSON.stringify(canonicalize(value, '$'));
}

/** Compare all revisions, including the complete per-source transcript map. */
export function sameRevisions(left: RevisionVector, right: RevisionVector): boolean {
  try {
    validateRevisionVector(left, 'left revision vector');
    validateRevisionVector(right, 'right revision vector');
  } catch {
    return false;
  }
  return left.projectRevision === right.projectRevision
    && left.scriptRevision === right.scriptRevision
    && left.timelineRevision === right.timelineRevision
    && left.captionRevision === right.captionRevision
    && canonicalJson(left.transcriptRevision) === canonicalJson(right.transcriptRevision);
}

/**
 * Convert established framing milliseconds at the adapter boundary.
 * Persisted values are always source-local seconds and retain the original unit
 * and method in provenance.
 */
export function framingIntervalFromMs(input: FramingIntervalMsInput): SourceInterval {
  if (!isRecord(input)) throw new TypeError('Framing interval input is unreadable.');
  const sourceId = input.sourceId ?? input.sourceMediaId;
  requireId(sourceId, 'framing source id');
  if (!isFiniteNumber(input.startMs) || !isFiniteNumber(input.endMs) || input.startMs < 0 || input.endMs <= input.startMs) throw new RangeError('Framing millisecond interval must be finite and non-empty.');
  if (input.sourceDurationMs !== undefined && input.sourceDurationMs !== null) {
    if (!isFiniteNumber(input.sourceDurationMs) || input.sourceDurationMs < 0 || input.endMs > input.sourceDurationMs) throw new RangeError('Framing interval exceeds its source duration.');
  }
  let uncertaintySeconds: number | null = null;
  if (input.uncertaintyMs !== undefined) {
    if (input.uncertaintyMs !== null && (!isFiniteNumber(input.uncertaintyMs) || input.uncertaintyMs < 0)) throw new RangeError('Framing uncertainty must be finite, non-negative, or null.');
    uncertaintySeconds = input.uncertaintyMs === null ? null : input.uncertaintyMs / 1000;
  } else if (input.provenance?.uncertaintySeconds !== undefined) {
    uncertaintySeconds = input.provenance.uncertaintySeconds ?? null;
  }
  const sourceProvenance = input.provenance ?? {};
  const provenance: TimingProvenance = {
    origin: sourceProvenance.origin ?? 'framing-ms-adapter',
    producer: sourceProvenance.producer ?? 'framing',
    version: sourceProvenance.version ?? '1',
    clock: sourceProvenance.clock ?? 'source-presentation',
    timingMethod: sourceProvenance.timingMethod ?? 'framing-milliseconds',
    inputUnit: 'milliseconds',
    uncertaintySeconds,
    processor: sourceProvenance.processor ?? 'unknown',
    monotonicOriginMs: sourceProvenance.monotonicOriginMs ?? null,
    sourceZeroOffsetSeconds: sourceProvenance.sourceZeroOffsetSeconds ?? null,
    captureGeneration: sourceProvenance.captureGeneration ?? null,
  };
  validateProvenance(provenance, 'framing interval');
  return { sourceId, t0: input.startMs / 1000, t1: input.endMs / 1000, provenance };
}

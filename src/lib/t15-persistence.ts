import type { Project } from './session';
import { createFoundation, validateFoundation, canonicalJson, sameRevisions, type RevisionVector, type SourceRecord } from './t15-schema.ts';
import type { AnalysisJob, AnalysisRequest, AnalysisResult, StoredAnalysisResult } from './t15-jobs';

export interface PersistenceConnection {
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<{ changes: number }>;
  getFirstAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
}
export interface PersistenceDatabase extends PersistenceConnection {
  withExclusiveTransactionAsync(action: (transaction: PersistenceConnection) => Promise<void>): Promise<void>;
}
export const T15_TABLES = `
  CREATE TABLE IF NOT EXISTS project_evidence (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT, data TEXT NOT NULL,
    UNIQUE(project_id, id));
  CREATE INDEX IF NOT EXISTS project_evidence_page ON project_evidence(project_id, kind, sequence);
  CREATE TABLE IF NOT EXISTS project_analysis_jobs (
    project_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(project_id, id));
`;
export const MAX_CHECKPOINT_BYTES = 128 * 1024;
export const MAX_CHECKPOINT_RECORDS = 128;
export interface EvidenceRecord { id: string; kind: string; sourceId?: string; payload: unknown }
export interface EvidencePage { sequence: number; record: EvidenceRecord }

function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A stable identity is required.');
}
function bounded(value: unknown): string {
  const data = canonicalJson(value);
  if (new TextEncoder().encode(data).length > MAX_CHECKPOINT_BYTES) throw new Error('Checkpoint is too large. Split it into bounded pages without dropping records.');
  return data;
}
async function available(tx: PersistenceConnection, id: string) {
  if (await tx.getFirstAsync('SELECT id FROM deleted_projects WHERE id = ?', id)) throw new Error('This project is being deleted.');
}
async function projectRow(tx: PersistenceConnection, id: string) {
  await available(tx, id);
  const row = await tx.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', id);
  if (!row) throw new Error('This project is no longer available.');
  const project = JSON.parse(row.data) as Project;
  if ((project.schemaVersion ?? 2) > 2) throw new Error('This project needs a newer app.');
  const state = project.v15 ?? createFoundation(project);
  validateFoundation(state, project);
  return { data: row.data, project: { ...project, v15: state } };
}
async function update(tx: PersistenceConnection, before: string, project: Project) {
  validateFoundation(project.v15!, project);
  const changed = await tx.runAsync('UPDATE projects SET data = ? WHERE id = ? AND data = ? AND NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)',
    JSON.stringify(project), project.id, before, project.id);
  if (changed.changes !== 1) throw new Error('The project changed. Reopen the latest edit and retry.');
}
const CHUNKED_KINDS = new Set(['creator-commit', 'creator-before', 'creator-after', 'timeline-command']);
const CHUNK_CHARACTERS = 16 * 1024;
function recordStorage(record: EvidenceRecord) {
  const complete = canonicalJson(record);
  if (new TextEncoder().encode(complete).length <= MAX_CHECKPOINT_BYTES) return { data: complete, chunks: [] as string[] };
  if (!CHUNKED_KINDS.has(record.kind)) throw new Error('Checkpoint is too large. Split it into bounded pages without dropping records.');
  const chunks: string[] = [];
  for (let offset = 0; offset < complete.length; offset += CHUNK_CHARACTERS) chunks.push(complete.slice(offset, offset + CHUNK_CHARACTERS));
  return { data: canonicalJson({ id: record.id, kind: record.kind, sourceId: record.sourceId,
    payload: { encoding: 'json-chunks-v1', prefix: `archive:${record.id}:`, chunkCount: chunks.length, characters: complete.length } }), chunks };
}
async function recordMatches(tx: PersistenceConnection, projectId: string, record: EvidenceRecord, data: string): Promise<boolean> {
  const expected = recordStorage(record);
  if (expected.data !== data) return false;
  for (let index = 0; index < expected.chunks.length; index++) {
    const chunk = await tx.getFirstAsync<{ data: string }>('SELECT data FROM project_evidence WHERE project_id = ? AND id = ?', projectId, `archive:${record.id}:${index}`);
    if (!chunk || chunk.data !== canonicalJson({ id: `archive:${record.id}:${index}`, kind: 'archive-chunk', payload: expected.chunks[index] })) return false;
  }
  return true;
}
async function insertRecord(tx: PersistenceConnection, projectId: string, record: EvidenceRecord) {
  nonempty(record.id); nonempty(record.kind);
  const stored = recordStorage(record);
  const previous = await tx.getFirstAsync<{ data: string }>('SELECT data FROM project_evidence WHERE project_id = ? AND id = ?', projectId, record.id);
  if (previous) {
    if (!await recordMatches(tx, projectId, record, previous.data)) throw new Error('This identity was already saved with a different payload.');
    return false;
  }
  for (let index = 0; index < stored.chunks.length; index++) {
    await insertRecord(tx, projectId, { id: `archive:${record.id}:${index}`, kind: 'archive-chunk', payload: stored.chunks[index] });
  }
  await tx.runAsync('INSERT INTO project_evidence (project_id, id, kind, source_id, data) VALUES (?, ?, ?, ?, ?)', projectId, record.id, record.kind, record.sourceId ?? null, stored.data);
  return true;
}

/** Uses the existing database. Transactions include both the current snapshot and audit record. */
export function createDurablePersistence(db: PersistenceDatabase, options: {
  assertDurableSource: (project: Project, sourceId: string, tx: PersistenceConnection) => Promise<void>;
}) {
  async function transaction<T>(action: (tx: PersistenceConnection) => Promise<T>): Promise<T> {
    let result!: T;
    await db.withExclusiveTransactionAsync(async tx => { result = await action(tx); });
    return result;
  }
  async function readJob(tx: PersistenceConnection, projectId: string, id: string): Promise<AnalysisJob> {
    await available(tx, projectId);
    const row = await tx.getFirstAsync<{ data: string }>('SELECT data FROM project_analysis_jobs WHERE project_id = ? AND id = ?', projectId, id);
    if (!row) throw new Error('Analysis job was not found.');
    return JSON.parse(row.data);
  }
  async function writeJob(tx: PersistenceConnection, job: AnalysisJob) {
    await tx.runAsync('INSERT INTO project_analysis_jobs (project_id, id, data) VALUES (?, ?, ?) ON CONFLICT(project_id, id) DO UPDATE SET data = excluded.data', job.request.projectId, job.request.id, canonicalJson(job));
  }
  return {
    async initialize(projectId: string): Promise<Project> {
      return transaction(async tx => {
        const row = await projectRow(tx, projectId);
        await update(tx, row.data, row.project);
        return row.project;
      });
    },
    /** Caller authors a new snapshot; B owns timeline command semantics. Full CAS rejects stale edits. */
    async commit(projectId: string, expected: RevisionVector, operationId: string, next: NonNullable<Project['v15']>, intent?: unknown): Promise<Project> {
      nonempty(operationId);
      return transaction(async tx => {
        const row = await projectRow(tx, projectId);
        const record = { id: operationId, kind: 'creator-commit', payload: intent === undefined ? { expected, next } : { expected, intent } };
        const existing = await tx.getFirstAsync<{ data: string }>('SELECT data FROM project_evidence WHERE project_id = ? AND id = ?', projectId, operationId);
        if (existing) {
          if (!await recordMatches(tx, projectId, record, existing.data)) throw new Error('This operation identity has a different payload.');
          return row.project;
        }
        if (!sameRevisions(row.project.v15!.revisions, expected)) throw new Error('The project changed. Reopen the latest edit and retry.');
        if (next.revisions.projectRevision !== expected.projectRevision + 1) throw new Error('A commit must advance the project revision exactly once.');
        // Originals and complete evidence are append-only. A timeline exclusion never removes sources.
        for (const source of row.project.v15!.sources) {
          const retained = next.sources.find(candidate => candidate.id === source.id);
          if (!retained || canonicalJson(retained) !== canonicalJson(source)) throw new Error('Creator edits cannot change or remove an original source.');
        }
        const current = row.project.v15!;
        for (const key of ['scriptSnapshots', 'transcriptRevisions', 'observations', 'reasons', 'takes', 'takeGroups', 'decisions', 'captionCorrections', 'proposals', 'assets'] as const) {
          for (const item of current[key]) {
            const retained = next[key].find(candidate => candidate.id === item.id);
            if (!retained || canonicalJson(retained) !== canonicalJson(item)) throw new Error(`Historical ${key} cannot be removed or rewritten.`);
          }
        }
        for (const extension of current.extensions) {
          if (!next.extensions.some(item => item.key === extension.key && item.version === extension.version && canonicalJson(item) === canonicalJson(extension))) throw new Error('Unknown and historical extensions must be retained.');
        }
        const nextHistoryIds = new Set([...next.history.entries, ...next.history.abandonedEntries].map(command => command.id));
        if (!next.history.archive && [...current.history.entries, ...current.history.abandonedEntries].some(command => !nextHistoryIds.has(command.id))) throw new Error('Retain abandoned history or its explicit archive reference.');
        for (const key of ['scriptRevision', 'timelineRevision', 'captionRevision'] as const) {
          if (next.revisions[key] < expected[key] || next.revisions[key] > expected[key] + 1) throw new Error('Revisions must advance monotonically one step at a time.');
        }
        for (const [sourceId, revision] of Object.entries(expected.transcriptRevision)) {
          const after = next.revisions.transcriptRevision[sourceId];
          if (after !== revision && after !== revision + 1) throw new Error('Transcript revisions must advance monotonically.');
        }
        if (canonicalJson(current.timeline.clips) !== canonicalJson(next.timeline.clips) && next.revisions.timelineRevision !== expected.timelineRevision + 1) throw new Error('Timeline changes must advance their revision.');
        if ((canonicalJson(current.captions) !== canonicalJson(next.captions) || canonicalJson(current.captionCorrections) !== canonicalJson(next.captionCorrections)) && next.revisions.captionRevision !== expected.captionRevision + 1) throw new Error('Caption changes must advance their revision.');
        if ((canonicalJson(current.scriptSnapshots) !== canonicalJson(next.scriptSnapshots) || canonicalJson(current.points) !== canonicalJson(next.points)) && next.revisions.scriptRevision !== expected.scriptRevision + 1) throw new Error('Script changes must advance their revision.');
        for (const source of current.sources) {
          const before = current.transcriptRevisions.filter(record => record.sourceId === source.id);
          const after = next.transcriptRevisions.filter(record => record.sourceId === source.id);
          if (canonicalJson(before) !== canonicalJson(after) && next.revisions.transcriptRevision[source.id] !== expected.transcriptRevision[source.id] + 1) throw new Error('Transcript changes must advance their source revision.');
        }
        for (const command of [...current.history.entries, ...current.history.abandonedEntries, ...next.history.entries, ...next.history.abandonedEntries]) {
          await insertRecord(tx, projectId, { id: `timeline-command:${command.id}`, kind: 'timeline-command', payload: command });
        }
        if (next.history.archive) {
          const pages = new Set(next.history.archive.pageIds);
          for (const pageId of current.history.archive?.pageIds ?? []) if (!pages.has(pageId)) throw new Error('Previously archived history references must be retained.');
          for (const command of [...current.history.entries, ...current.history.abandonedEntries]) {
            if (!nextHistoryIds.has(command.id) && !pages.has(`timeline-command:${command.id}`)) throw new Error('Every omitted history command needs its archive page reference.');
          }
          for (const pageId of pages) {
            const page = await tx.getFirstAsync<{ kind: string }>('SELECT kind FROM project_evidence WHERE project_id = ? AND id = ?', projectId, pageId);
            if (!page || page.kind !== 'timeline-command') throw new Error('The history archive references a missing command page.');
          }
        }
        const saved = { ...row.project, v15: next };
        await insertRecord(tx, projectId, { id: `creator-before:${operationId}`, kind: 'creator-before', payload: { revisions: current.revisions, timeline: current.timeline, captions: current.captions } });
        if (intent !== undefined) await insertRecord(tx, projectId, { id: `creator-after:${operationId}`, kind: 'creator-after', payload: next });
        await insertRecord(tx, projectId, record);
        await update(tx, row.data, saved);
        return saved;
      });
    },
    /** Capture metadata is a checkpoint, not a creator timeline command. */
    async checkpointSource(projectId: string, operationId: string, source: SourceRecord): Promise<Project> {
      return transaction(async tx => {
        const row = await projectRow(tx, projectId);
        const state = row.project.v15!;
        const prior = state.sources.find(item => item.id === source.id);
        const record = { id: operationId, kind: 'source-checkpoint', sourceId: source.id, payload: source };
        const receipt = await tx.getFirstAsync<{ data: string }>('SELECT data FROM project_evidence WHERE project_id = ? AND id = ?', projectId, operationId);
        if (receipt) {
          if (!await recordMatches(tx, projectId, record, receipt.data)) throw new Error('This source checkpoint has a different payload.');
          return row.project;
        }
        const uri = source.id === projectId ? row.project.videoUri : row.project.recordings?.find(item => item.id === source.id)?.mediaUri;
        if (source.mediaUri !== (uri ?? null)) throw new Error('Source metadata must reference the journal-owned original.');
        if (source.id !== projectId && !row.project.recordings?.some(item => item.id === source.id)) {
          const draft = await tx.getFirstAsync('SELECT key FROM kv WHERE key = ?', `pickup:${encodeURIComponent(projectId)}:${encodeURIComponent(source.id)}`);
          if (!draft) throw new Error('Start the pickup before registering its source metadata.');
        }
        if (prior && prior.durationSeconds !== null && source.durationSeconds !== prior.durationSeconds) throw new Error('A known original duration cannot be rewritten.');
        if (prior && prior.aliases.some(alias => !source.aliases.includes(alias))) throw new Error('Source aliases must be retained.');
        const saved = { ...row.project, v15: { ...state, sources: [...state.sources.filter(item => item.id !== source.id), source],
          revisions: { ...state.revisions, projectRevision: state.revisions.projectRevision + 1,
            transcriptRevision: { ...state.revisions.transcriptRevision, [source.id]: state.revisions.transcriptRevision[source.id] ?? 0 } } } };
        await insertRecord(tx, projectId, record);
        await update(tx, row.data, saved);
        return saved;
      });
    },
    /** Await each page before releasing producer buffers. Failure leaves the caller's page retryable. */
    async checkpoint(projectId: string, records: EvidenceRecord[]): Promise<void> {
      if (!records.length || records.length > MAX_CHECKPOINT_RECORDS) throw new Error('Use between 1 and 128 records per checkpoint.');
      bounded(records);
      await transaction(async tx => {
        const { project } = await projectRow(tx, projectId);
        for (const record of records) {
          if (record.sourceId) {
            if (!project.v15!.sources.some(source => source.id === record.sourceId)) throw new Error('Evidence belongs to an unknown source.');
          }
          await insertRecord(tx, projectId, record);
        }
      });
    },
    async page(projectId: string, after = 0, limit = 32, kind?: string): Promise<EvidencePage[]> {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('Invalid evidence page.');
      await available(db, projectId);
      const rows = kind
        ? await db.getAllAsync<{ sequence: number; data: string }>('SELECT sequence, data FROM project_evidence WHERE project_id = ? AND sequence > ? AND kind = ? ORDER BY sequence LIMIT ?', projectId, after, kind, limit)
        : await db.getAllAsync<{ sequence: number; data: string }>('SELECT sequence, data FROM project_evidence WHERE project_id = ? AND sequence > ? ORDER BY sequence LIMIT ?', projectId, after, limit);
      return rows.map(row => ({ sequence: row.sequence, record: JSON.parse(row.data) }));
    },
    async record(projectId: string, id: string): Promise<EvidenceRecord | null> {
      await available(db, projectId);
      const row = await db.getFirstAsync<{ data: string }>('SELECT data FROM project_evidence WHERE project_id = ? AND id = ?', projectId, id);
      return row ? JSON.parse(row.data) : null;
    },
    async enqueue(request: AnalysisRequest): Promise<AnalysisJob> {
      for (const id of [request.id, request.projectId, request.sourceId, request.idempotencyKey, request.producer, request.producerVersion]) nonempty(id);
      if (request.attempt !== 1) throw new Error('A new job starts at attempt 1. Use retry for later attempts.');
      return transaction(async tx => {
        const { data, project } = await projectRow(tx, request.projectId);
        const prior = await tx.getFirstAsync<{ data: string }>('SELECT data FROM project_analysis_jobs WHERE project_id = ? AND id = ?', request.projectId, request.id);
        if (prior) {
          const job = JSON.parse(prior.data) as AnalysisJob;
          const first = await tx.getFirstAsync<{ data: string }>('SELECT data FROM project_evidence WHERE project_id = ? AND id = ?', request.projectId, `job-request:${request.id}`);
          if (!first || first.data !== bounded({ id: `job-request:${request.id}`, kind: 'job-request', sourceId: request.sourceId, payload: request })) throw new Error('This job identity has a different payload.');
          return job;
        }
        if (!sameRevisions(project.v15!.revisions, request.base)) throw new Error('Analysis was requested against stale revisions.');
        if (!(request.sourceId in request.base.transcriptRevision)) throw new Error('Capture the source transcript revision before analysis.');
        await options.assertDurableSource(project, request.sourceId, tx);
        await insertRecord(tx, request.projectId, { id: `job-key:${request.idempotencyKey}`, kind: 'job-key', payload: request.id });
        await insertRecord(tx, request.projectId, { id: `job-request:${request.id}`, kind: 'job-request', sourceId: request.sourceId, payload: request });
        const job: AnalysisJob = { request, status: 'queued', lease: null };
        await writeJob(tx, job);
        await update(tx, data, project);
        return job;
      });
    },
    async start(projectId: string, jobId: string, attempt: number, lease: string): Promise<AnalysisJob> {
      nonempty(lease);
      return transaction(async tx => {
        const job = await readJob(tx, projectId, jobId);
        if (job.request.attempt !== attempt) throw new Error('This analysis attempt is stale.');
        if (job.status === 'running' && job.lease === lease) return job;
        if (job.status !== 'queued') throw new Error('This job is not queued.');
        const { project } = await projectRow(tx, projectId);
        if (!sameRevisions(project.v15!.revisions, job.request.base)) throw new Error('The project changed before analysis started. Retry with its current revisions.');
        await options.assertDurableSource(project, job.request.sourceId, tx);
        const started = { ...job, status: 'running' as const, lease };
        await writeJob(tx, started);
        return started;
      });
    },
    async finish(result: AnalysisResult, lease: string): Promise<StoredAnalysisResult> {
      for (const id of [result.id, result.jobId, result.projectId, result.sourceId, lease]) nonempty(id);
      if (!Number.isSafeInteger(result.attempt) || result.attempt < 1) throw new Error('Invalid result attempt.');
      for (const ids of [result.observationIds, result.proposalIds, result.reasonIds]) {
        if (!Array.isArray(ids)) throw new Error('Result evidence references are required.');
        ids.forEach(nonempty);
      }
      if (!['complete', 'partial', 'failed', 'cancelled'].includes(result.status)) throw new Error('Invalid analysis result status.');
      return transaction(async tx => {
        const job = await readJob(tx, result.projectId, result.jobId);
        const { project } = await projectRow(tx, result.projectId);
        const previous = await tx.getFirstAsync<{ data: string }>('SELECT data FROM project_evidence WHERE project_id = ? AND id = ?', result.projectId, `result:${result.id}`);
        if (previous) {
          const record = JSON.parse(previous.data) as EvidenceRecord;
          const stored = record.payload as StoredAnalysisResult;
          if (canonicalJson(stored.result) !== canonicalJson(result)) throw new Error('This result identity has a different payload.');
          return stored;
        }
        const requestRow = await tx.getFirstAsync<{ data: string }>('SELECT data FROM project_evidence WHERE project_id = ? AND id = ?', result.projectId,
          result.attempt === 1 ? `job-request:${result.jobId}` : `job-attempt:${result.jobId}:${result.attempt}`);
        const request = requestRow ? (JSON.parse(requestRow.data) as EvidenceRecord).payload as AnalysisRequest : null;
        if (!request || request.sourceId !== result.sourceId || !sameRevisions(request.base, result.base)) throw new Error('The result scope does not match its captured request.');
        for (const [kind, ids, inline] of [
          ['observation', result.observationIds, project.v15!.observations],
          ['proposal', result.proposalIds, project.v15!.proposals],
          ['reason', result.reasonIds, project.v15!.reasons],
        ] as const) {
          for (const id of ids) {
            const reference = await tx.getFirstAsync<{ kind: string; source_id: string | null }>('SELECT kind, source_id FROM project_evidence WHERE project_id = ? AND id = ?', result.projectId, id);
            const item = inline.find(item => item.id === id);
            if (!reference && !item) throw new Error(`Analysis references missing ${kind} evidence.`);
            const sourceId = reference?.source_id ?? (item && 'sourceId' in item ? item.sourceId : null);
            if ((reference && reference.kind !== kind) || (sourceId && sourceId !== result.sourceId)) throw new Error('Analysis evidence belongs to a different source or kind.');
          }
        }
        const current = job.request.attempt === result.attempt && job.status === 'running' && job.lease === lease;
        const stored: StoredAnalysisResult = { result, disposition: current && sameRevisions(project.v15!.revisions, result.base) ? 'awaiting-review' : 'historical' };
        await insertRecord(tx, result.projectId, { id: `result:${result.id}`, kind: 'analysis-result', sourceId: result.sourceId, payload: stored });
        if (current) await writeJob(tx, { ...job, lease: null, resultId: result.id,
          status: result.status === 'complete' ? 'ready' : result.status,
          ...(stored.disposition === 'historical' ? { error: 'The project changed. This result is preserved for review.' } : {}) });
        return stored;
      });
    },
    async cancel(projectId: string, jobId: string): Promise<AnalysisJob> {
      return transaction(async tx => {
        const job = await readJob(tx, projectId, jobId);
        if (job.status === 'cancelled') return job;
        const cancelled = { ...job, status: 'cancelled' as const, lease: null };
        await insertRecord(tx, projectId, { id: `job-cancel:${jobId}:${job.request.attempt}`, kind: 'job-cancel', payload: job.request });
        await writeJob(tx, cancelled);
        return cancelled;
      });
    },
    async retry(projectId: string, jobId: string, expectedAttempt: number): Promise<AnalysisJob> {
      return transaction(async tx => {
        const job = await readJob(tx, projectId, jobId);
        if (job.request.attempt === expectedAttempt + 1 && job.status === 'queued') return job;
        if (job.request.attempt !== expectedAttempt || !['failed', 'cancelled', 'partial', 'retryable', 'ready'].includes(job.status)) throw new Error('This job cannot be retried from the current state.');
        const { project } = await projectRow(tx, projectId);
        await options.assertDurableSource(project, job.request.sourceId, tx);
        const request = { ...job.request, attempt: expectedAttempt + 1, base: project.v15!.revisions };
        const next: AnalysisJob = { request, status: 'queued', lease: null };
        await insertRecord(tx, projectId, { id: `job-attempt:${jobId}:${request.attempt}`, kind: 'job-request', sourceId: request.sourceId, payload: request });
        await writeJob(tx, next);
        return next;
      });
    },
    /** Call once on runtime startup, not on every screen focus. Invalidates process-owned leases. */
    async recover(): Promise<void> {
      await transaction(async tx => {
        let cursor = 0;
        while (true) {
        const rows = await tx.getAllAsync<{ rowid: number; data: string }>('SELECT rowid, data FROM project_analysis_jobs WHERE rowid > ? AND project_id NOT IN (SELECT id FROM deleted_projects) ORDER BY rowid LIMIT 32', cursor);
        if (!rows.length) break;
        cursor = rows[rows.length - 1].rowid;
        for (const row of rows) {
          const job = JSON.parse(row.data) as AnalysisJob;
          if (job.status !== 'running' && job.status !== 'queued') continue;
          await insertRecord(tx, job.request.projectId, { id: `job-recovery:${job.request.id}:${job.request.attempt}`, kind: 'job-recovery', payload: job.request });
          await writeJob(tx, { ...job, status: 'retryable', lease: null, error: 'Analysis was interrupted. Your saved original and edit are available.' });
        }
        }
      });
    },
    async jobs(projectId: string): Promise<AnalysisJob[]> {
      await available(db, projectId);
      const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM project_analysis_jobs WHERE project_id = ? ORDER BY rowid DESC LIMIT 32', projectId);
      return rows.map(row => JSON.parse(row.data));
    },
  };
}

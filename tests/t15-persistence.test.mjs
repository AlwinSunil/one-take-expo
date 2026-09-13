import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createDurablePersistence,
  MAX_CHECKPOINT_RECORDS,
  T15_TABLES,
} from '../src/lib/t15-persistence.ts';

const PROJECT_ID = 'project:fixture';
const SOURCE_URI = 'file:///app/documents/videos/project-fixture.mp4';

/**
 * The app uses expo-sqlite's async connection.  This adapter keeps the
 * behavioural tests on a real SQLite engine while making transaction and
 * failure boundaries explicit.
 */
class SQLiteAdapter {
  constructor(database) {
    this.database = database;
    this.failNext = null;
  }

  runAsync(sql, ...params) {
    if (this.failNext?.(sql, params)) {
      this.failNext = null;
      throw new Error('SQLITE_FULL: simulated low storage');
    }
    const result = this.database.prepare(sql).run(...params);
    return Promise.resolve({ changes: Number(result.changes ?? 0) });
  }

  getFirstAsync(sql, ...params) {
    const row = this.database.prepare(sql).get(...params);
    return Promise.resolve(row ?? null);
  }

  getAllAsync(sql, ...params) {
    return Promise.resolve(this.database.prepare(sql).all(...params));
  }

  async withExclusiveTransactionAsync(action) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await action(this);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original failure if rollback itself is unavailable.
      }
      throw error;
    }
  }
}

function openDatabase(filename = ':memory:') {
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_projects (
      id TEXT PRIMARY KEY NOT NULL
    );
    ${T15_TABLES}
  `);
  return { database, adapter: new SQLiteAdapter(database) };
}

function legacyProject(id = PROJECT_ID) {
  return {
    id,
    mode: 'script',
    script: 'Say hello to the camera.',
    videoUri: SOURCE_URI,
    trim: { start: 0.25, end: 3.75 },
    clips: [{ id: 'legacy:clip', t0: 0, t1: 1, label: 'hello', recommended: true }],
    transcript: [
      { id: 'legacy:caption', t0: 0.5, t1: 1.25, text: 'Say hello', isFinal: true },
      { id: 'pickup:caption', recordingId: 'source:original', t0: 1.5, t1: 2.25, text: 'to the camera', isFinal: true },
    ],
    recordings: [{
      id: 'source:original',
      mediaUri: SOURCE_URI,
      duration: 4,
      createdAt: 1,
      evidenceStatus: 'complete',
    }],
    createdAt: 1,
  };
}

function insertProject(adapter, project = legacyProject()) {
  return adapter.runAsync(
    'INSERT INTO projects (id, data) VALUES (?, ?)',
    project.id,
    JSON.stringify(project),
  );
}

function clone(value) {
  return structuredClone(value);
}

function nextFoundation(foundation) {
  const next = clone(foundation);
  next.revisions = {
    ...foundation.revisions,
    projectRevision: foundation.revisions.projectRevision + 1,
  };
  return next;
}

function sourceIdFor(project) {
  assert.ok(project.v15?.sources?.length, 'legacy migration should create at least one source');
  return project.v15.sources.find(source => source.id === project.id)?.id ?? project.v15.sources[0].id;
}

function requestFor(project, overrides = {}) {
  return {
    id: 'job:fixture:1',
    projectId: project.id,
    sourceId: sourceIdFor(project),
    attempt: 1,
    idempotencyKey: 'idempotency:fixture:1',
    base: clone(project.v15.revisions),
    producer: 'fixture-producer',
    producerVersion: 'fixture-v1',
    ...overrides,
  };
}

function resultFor(request, overrides = {}) {
  return {
    id: `result:${request.id}:${request.attempt}`,
    jobId: request.id,
    attempt: request.attempt,
    projectId: request.projectId,
    sourceId: request.sourceId,
    base: clone(request.base),
    status: 'complete',
    observationIds: [],
    proposalIds: [],
    reasonIds: [],
    payload: {
      envelopeVersion: 1,
      sourceRange: { t0: 0.5, t1: 1.25, units: 'seconds', relativeTo: request.sourceId },
      provenance: { origin: 'fixture', uncertaintySeconds: null },
    },
    ...overrides,
  };
}

async function context(t, { filename = ':memory:', sourceAvailable = true } = {}) {
  const opened = openDatabase(filename);
  const { database, adapter } = opened;
  if (t) t.after(() => database.close());
  await insertProject(adapter);
  const availability = { value: sourceAvailable };
  const persistence = createDurablePersistence(adapter, {
    assertDurableSource: async (project, sourceId) => {
      if (!project.v15?.sources?.some(source => source.id === sourceId)) {
        throw new Error('fixture source identity is unknown');
      }
      if (!availability.value) throw new Error('fixture source is missing');
    },
  });
  const project = await persistence.initialize(PROJECT_ID);
  return { ...opened, persistence, project, availability };
}

test('initializing a legacy project seeds additive foundation and preserves legacy fields', async t => {
  const { persistence, adapter, project } = await context(t);

  assert.equal(project.id, PROJECT_ID);
  assert.equal(project.trim.start, 0.25);
  assert.equal(project.trim.end, 3.75);
  assert.equal(project.transcript[0].id, 'legacy:caption');
  assert.equal(project.recordings[0].id, 'source:original');
  assert.equal(project.v15.version, 1);
  assert.equal(project.v15.sources[0].id, PROJECT_ID);
  assert.ok(project.v15.sources.some(source => source.id === 'source:original'));
  assert.ok(project.v15.revisions.projectRevision >= 0);

  const stored = await adapter.getFirstAsync('SELECT data FROM projects WHERE id = ?', PROJECT_ID);
  const reopened = JSON.parse(stored.data);
  assert.deepEqual(reopened.trim, { start: 0.25, end: 3.75 });
  assert.equal(reopened.v15.sources[0].id, PROJECT_ID);
  assert.deepEqual((await persistence.page(PROJECT_ID, 0, 32, 'creator-commit')), []);
});

test('creator commit uses an atomic revision CAS, idempotent operation IDs, and keeps sources immutable', async t => {
  const { persistence, project } = await context(t);
  const expected = clone(project.v15.revisions);
  const next = nextFoundation(project.v15);
  const committed = await persistence.commit(PROJECT_ID, expected, 'operation:fixture:1', next);

  assert.equal(committed.v15.revisions.projectRevision, expected.projectRevision + 1);
  assert.deepEqual(committed.v15.sources, project.v15.sources);
  assert.deepEqual(committed.trim, project.trim);
  assert.deepEqual(committed.transcript, project.transcript);

  const idempotent = await persistence.commit(PROJECT_ID, expected, 'operation:fixture:1', next);
  assert.equal(idempotent.v15.revisions.projectRevision, committed.v15.revisions.projectRevision);

  await assert.rejects(
    persistence.commit(PROJECT_ID, expected, 'operation:fixture:2', next),
    /project changed/i,
  );
  await assert.rejects(
    persistence.commit(PROJECT_ID, expected, 'operation:fixture:1', {
      ...next,
      revisions: { ...next.revisions, projectRevision: next.revisions.projectRevision + 1 },
    }),
    /different payload/i,
  );

  const removeSource = nextFoundation(committed.v15);
  removeSource.sources = [];
  await assert.rejects(
    persistence.commit(PROJECT_ID, committed.v15.revisions, 'operation:remove-source', removeSource),
    /source/i,
  );
  const latest = await persistence.initialize(PROJECT_ID);
  assert.equal(latest.v15.sources[0].id, PROJECT_ID);
});

test('large caption commits retain complete script evidence in bounded audit chunks', async t => {
  const { persistence, project, adapter } = await context(t);
  const expected = clone(project.v15.revisions);
  const next = nextFoundation(project.v15);
  const largeScript = 'script evidence '.repeat(10 * 1024);
  next.scriptSnapshots.push({
    id: 'script:large:1',
    revision: expected.scriptRevision + 1,
    rawText: largeScript,
    spans: [],
    previousSnapshotId: project.v15.scriptSnapshots.at(-1).id,
  });
  next.captions = { ...project.v15.captions, showInEditor: !project.v15.captions.showInEditor };
  next.revisions = {
    ...expected,
    projectRevision: expected.projectRevision + 1,
    scriptRevision: expected.scriptRevision + 1,
    captionRevision: expected.captionRevision + 1,
  };

  const operationId = 'operation:large-caption-script';
  const committed = await persistence.commit(PROJECT_ID, expected, operationId, next);
  assert.equal(committed.v15.revisions.captionRevision, expected.captionRevision + 1);
  assert.ok(new TextEncoder().encode(JSON.stringify({ expected, next })).byteLength > 130 * 1024);

  const operationRow = await adapter.getFirstAsync(
    'SELECT data FROM project_evidence WHERE project_id = ? AND id = ?',
    PROJECT_ID,
    operationId,
  );
  const operationEnvelope = JSON.parse(operationRow.data);
  assert.equal(operationEnvelope.payload.encoding, 'json-chunks-v1');
  const chunkRows = await adapter.getAllAsync(
    'SELECT id, data FROM project_evidence WHERE project_id = ? AND id LIKE ? ORDER BY id',
    PROJECT_ID,
    `archive:${operationId}:%`,
  );
  assert.ok(chunkRows.length > 8, 'large creator audit should be split into internal evidence pages');
  assert.ok(chunkRows.every(row => JSON.parse(row.data).kind === 'archive-chunk'));

  const duplicate = await persistence.commit(PROJECT_ID, expected, operationId, next);
  assert.deepEqual(duplicate.v15.revisions, committed.v15.revisions);
  const duplicateChunkRows = await adapter.getAllAsync(
    'SELECT id FROM project_evidence WHERE project_id = ? AND id LIKE ? ORDER BY id',
    PROJECT_ID,
    `archive:${operationId}:%`,
  );
  assert.deepEqual(duplicateChunkRows.map(row => row.id), chunkRows.map(row => row.id));

  await adapter.runAsync('DELETE FROM project_evidence WHERE project_id = ? AND id = ?', PROJECT_ID, chunkRows[0].id);
  await assert.rejects(
    persistence.commit(PROJECT_ID, expected, operationId, next),
    /different payload/i,
  );
});

test('history moved out of the active window remains addressable from the evidence archive', async t => {
  const { persistence, project } = await context(t);
  const expected = clone(project.v15.revisions);
  const before = clone(project.v15.timeline.clips);
  const after = [{
    id: 'timeline:archive-clip',
    sourceId: sourceIdFor(project),
    t0: 0,
    t1: 1,
    spanIds: [],
    pointIds: [],
    utteranceIds: [],
    included: true,
    reasonIds: [],
  }];
  const command = {
    id: 'history:archive-command',
    kind: 'include',
    baseRevision: expected.timelineRevision,
    revision: expected.timelineRevision + 1,
    before,
    after,
    reasonIds: [],
  };
  const active = nextFoundation(project.v15);
  active.timeline = { revision: command.revision, clips: after };
  active.history = { ...active.history, entries: [command], cursor: 1, abandonedEntries: [] };
  active.revisions = {
    ...expected,
    projectRevision: expected.projectRevision + 1,
    timelineRevision: expected.timelineRevision + 1,
  };
  const first = await persistence.commit(PROJECT_ID, expected, 'operation:history-active', active);
  assert.equal(first.v15.history.entries[0].id, command.id);

  const archivePageId = `timeline-command:${command.id}`;
  const archived = nextFoundation(first.v15);
  archived.history = {
    ...archived.history,
    entries: [],
    cursor: 0,
    abandonedEntries: [],
    archive: { kind: 'timeline-command', pageIds: [archivePageId] },
  };
  archived.revisions = {
    ...first.v15.revisions,
    projectRevision: first.v15.revisions.projectRevision + 1,
  };
  const second = await persistence.commit(PROJECT_ID, first.v15.revisions, 'operation:history-archive', archived);
  assert.deepEqual(second.v15.history.entries, []);
  assert.deepEqual(second.v15.history.archive.pageIds, [archivePageId]);
  const archivedRecord = await persistence.record(PROJECT_ID, archivePageId);
  assert.equal(archivedRecord.kind, 'timeline-command');
  assert.equal(archivedRecord.payload.id, command.id);
  assert.ok((await persistence.page(PROJECT_ID, 0, 32, 'timeline-command')).some(entry => entry.record.id === archivePageId));
});

test('checkpoint pages are bounded, idempotent, mismatch-safe, and fully recoverable', async t => {
  const { persistence, project } = await context(t);
  const sourceId = sourceIdFor(project);
  const records = Array.from({ length: 140 }, (_, index) => ({
    id: `observation:fixture:${index}`,
    kind: 'observation',
    sourceId,
    payload: {
      sourceRange: { t0: index / 10, t1: (index + 1) / 10, units: 'seconds' },
      provenance: { origin: 'fixture', producer: 'test', version: '1', uncertaintySeconds: null },
      observationIndex: index,
    },
  }));

  await persistence.checkpoint(PROJECT_ID, records.slice(0, 70));
  await persistence.checkpoint(PROJECT_ID, records.slice(70));
  await persistence.checkpoint(PROJECT_ID, records.slice(0, 70));

  const loaded = [];
  let after = 0;
  while (true) {
    const page = await persistence.page(PROJECT_ID, after, 17, 'observation');
    if (!page.length) break;
    loaded.push(...page);
    after = page.at(-1).sequence;
  }
  assert.deepEqual(loaded.map(entry => entry.record.id), records.map(record => record.id));
  assert.deepEqual(loaded.map(entry => entry.record.payload.observationIndex), records.map((_, index) => index));

  await assert.rejects(
    persistence.checkpoint(PROJECT_ID, [{ ...records[0], payload: { changed: true } }]),
    /different payload/i,
  );
  await assert.rejects(
    persistence.checkpoint(PROJECT_ID, Array.from({ length: MAX_CHECKPOINT_RECORDS + 1 }, (_, index) => ({
      id: `too-many:${index}`,
      kind: 'observation',
      payload: { index },
    }))),
    /between 1 and 128/i,
  );
  await assert.rejects(
    persistence.checkpoint(PROJECT_ID, [{
      id: 'too-large',
      kind: 'observation',
      payload: { completeProducerEnvelope: 'x'.repeat(130 * 1024) },
    }]),
    /too large|bounded/i,
  );
});

test('the foundation and evidence survive reopening the same SQLite database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'one-take-t15-reopen-'));
  const filename = join(directory, 'project.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const first = await context(null, { filename });
  const sourceId = sourceIdFor(first.project);
  await first.persistence.checkpoint(PROJECT_ID, [{
    id: 'observation:reopen',
    kind: 'observation',
    sourceId,
    payload: { sourceRange: { t0: 1, t1: 2, units: 'seconds' }, complete: true },
  }]);
  first.database.close();

  const secondOpened = openDatabase(filename);
  t.after(() => secondOpened.database.close());
  const secondPersistence = createDurablePersistence(secondOpened.adapter, {
    assertDurableSource: async () => {},
  });
  const reopened = await secondPersistence.initialize(PROJECT_ID);
  const evidence = await secondPersistence.page(PROJECT_ID, 0, 32, 'observation');
  assert.equal(reopened.v15.sources[0].id, sourceId);
  assert.equal(evidence[0].record.id, 'observation:reopen');
  assert.deepEqual(evidence[0].record.payload.sourceRange, { t0: 1, t1: 2, units: 'seconds' });
});

test('analysis enqueue/start/finish is idempotent and a compatible result awaits creator review', async t => {
  const { persistence, project } = await context(t);
  const request = requestFor(project);
  const queued = await persistence.enqueue(request);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.lease, null);
  assert.deepEqual(await persistence.enqueue(request), queued);
  await assert.rejects(
    persistence.enqueue({ ...request, producerVersion: 'fixture-v2' }),
    /different payload/i,
  );

  const started = await persistence.start(PROJECT_ID, request.id, 1, 'lease:1');
  assert.equal(started.status, 'running');
  assert.equal((await persistence.start(PROJECT_ID, request.id, 1, 'lease:1')).lease, 'lease:1');

  const result = resultFor(request);
  await assert.rejects(
    persistence.finish(resultFor(request, { id: 'result:malformed-ref', observationIds: [null] }), 'lease:1'),
    /identity|references/i,
  );
  const stored = await persistence.finish(result, 'lease:1');
  assert.equal(stored.disposition, 'awaiting-review');
  assert.deepEqual(await persistence.finish(result, 'lease:1'), stored);
  await assert.rejects(
    persistence.finish({ ...result, payload: { changed: true } }, 'lease:1'),
    /different payload/i,
  );

  const jobs = await persistence.jobs(PROJECT_ID);
  assert.equal(jobs[0].status, 'ready');
  assert.equal(jobs[0].resultId, result.id);
  const evidence = await persistence.page(PROJECT_ID, 0, 32, 'analysis-result');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].record.payload.disposition, 'awaiting-review');
});

test('late results remain historical after an edit, and cancelled jobs keep late evidence without reopening', async t => {
  const { persistence, project } = await context(t);
  const request = requestFor(project, { id: 'job:late', idempotencyKey: 'idempotency:late' });
  await persistence.enqueue(request);
  await persistence.start(PROJECT_ID, request.id, 1, 'lease:late');

  const edited = nextFoundation(project.v15);
  await persistence.commit(PROJECT_ID, project.v15.revisions, 'operation:edit-before-result', edited);
  const historical = await persistence.finish(resultFor(request, { id: 'result:late' }), 'lease:late');
  assert.equal(historical.disposition, 'historical');
  assert.equal((await persistence.initialize(PROJECT_ID)).v15.revisions.projectRevision, edited.revisions.projectRevision);
  assert.equal((await persistence.jobs(PROJECT_ID)).find(job => job.request.id === request.id).status, 'ready');

  const cancelledRequest = requestFor(await persistence.initialize(PROJECT_ID), {
    id: 'job:cancelled',
    idempotencyKey: 'idempotency:cancelled',
  });
  await persistence.enqueue(cancelledRequest);
  await persistence.start(PROJECT_ID, cancelledRequest.id, 1, 'lease:cancelled');
  const cancelled = await persistence.cancel(PROJECT_ID, cancelledRequest.id);
  assert.equal(cancelled.status, 'cancelled');
  const lateCancelled = await persistence.finish(resultFor(cancelledRequest, { id: 'result:cancelled-late' }), 'lease:cancelled');
  assert.equal(lateCancelled.disposition, 'historical');
  const cancelledJob = (await persistence.jobs(PROJECT_ID)).find(job => job.request.id === cancelledRequest.id);
  assert.equal(cancelledJob.status, 'cancelled');
  assert.equal(cancelledJob.resultId, undefined);
  const results = await persistence.page(PROJECT_ID, 0, 32, 'analysis-result');
  assert.deepEqual(results.map(entry => entry.record.payload.disposition).sort(), ['historical', 'historical']);
});

test('startup recovery invalidates process leases and retry creates a new captured attempt', async t => {
  const { persistence, project, adapter } = await context(t);
  const request = requestFor(project, { id: 'job:recovery', idempotencyKey: 'idempotency:recovery' });
  await persistence.enqueue(request);
  await persistence.start(PROJECT_ID, request.id, 1, 'lease:dead-process');

  const restarted = createDurablePersistence(adapter, {
    assertDurableSource: async () => {},
  });
  await restarted.recover();
  const recovered = (await restarted.jobs(PROJECT_ID)).find(job => job.request.id === request.id);
  assert.equal(recovered.status, 'retryable');
  assert.equal(recovered.lease, null);
  assert.match(recovered.error, /interrupted/i);
  await restarted.recover();
  assert.equal((await restarted.jobs(PROJECT_ID)).filter(job => job.request.id === request.id).length, 1);

  const retry = await restarted.retry(PROJECT_ID, request.id, 1);
  assert.equal(retry.request.id, request.id);
  assert.equal(retry.request.attempt, 2);
  assert.equal(retry.status, 'queued');
  assert.notDeepEqual(retry.request.base, undefined);
  await restarted.start(PROJECT_ID, request.id, 2, 'lease:retry');
  const partial = await restarted.finish(resultFor(retry.request, {
    id: 'result:recovery:2',
    status: 'partial',
  }), 'lease:retry');
  assert.equal(partial.disposition, 'awaiting-review');
  assert.equal((await restarted.jobs(PROJECT_ID)).find(job => job.request.id === request.id).status, 'partial');
  const attempts = await restarted.page(PROJECT_ID, 0, 32, 'job-request');
  assert.ok(attempts.some(entry => entry.record.id === `job-attempt:${request.id}:2`));
});

test('missing durable source blocks analysis through the source assertion hook', async t => {
  const { persistence, project, availability, adapter } = await context(t, { sourceAvailable: false });
  const request = requestFor(project, { id: 'job:missing-source', idempotencyKey: 'idempotency:missing-source' });
  await assert.rejects(persistence.enqueue(request), /source is missing/i);
  assert.equal(await adapter.getFirstAsync('SELECT id FROM project_analysis_jobs WHERE id = ?', request.id), null);
  assert.deepEqual(await persistence.page(PROJECT_ID, 0, 32, 'job-request'), []);

  availability.value = true;
  const queued = await persistence.enqueue(request);
  assert.equal(queued.status, 'queued');
});

test('a failed metadata update rolls back the operation and retains the last durable project and evidence', async t => {
  const { persistence, project, adapter } = await context(t);
  const sourceId = sourceIdFor(project);
  await persistence.checkpoint(PROJECT_ID, [{
    id: 'observation:before-low-storage',
    kind: 'observation',
    sourceId,
    payload: { complete: true },
  }]);
  const expected = clone(project.v15.revisions);
  const next = nextFoundation(project.v15);
  adapter.failNext = sql => sql.startsWith('UPDATE projects SET data');

  await assert.rejects(
    persistence.commit(PROJECT_ID, expected, 'operation:low-storage', next),
    /SQLITE_FULL|low storage/i,
  );

  const reopened = await persistence.initialize(PROJECT_ID);
  assert.deepEqual(reopened.v15.revisions, expected);
  assert.equal(reopened.v15.sources[0].id, sourceId);
  const observations = await persistence.page(PROJECT_ID, 0, 32, 'observation');
  assert.deepEqual(observations.map(entry => entry.record.id), ['observation:before-low-storage']);
  assert.deepEqual(await persistence.page(PROJECT_ID, 0, 32, 'creator-commit'), []);
});

test('a tombstoned project cannot be recreated by a late row or checkpoint', async t => {
  const { persistence, adapter } = await context(t);
  await adapter.runAsync('DELETE FROM projects WHERE id = ?', PROJECT_ID);
  await adapter.runAsync('INSERT INTO deleted_projects (id) VALUES (?)', PROJECT_ID);
  await adapter.runAsync('INSERT INTO projects (id, data) VALUES (?, ?)', PROJECT_ID, JSON.stringify(legacyProject()));

  await assert.rejects(persistence.initialize(PROJECT_ID), /being deleted/i);
  await assert.rejects(persistence.checkpoint(PROJECT_ID, [{
    id: 'late:evidence',
    kind: 'observation',
    payload: { shouldNotReturn: true },
  }]), /being deleted/i);
  assert.equal(await adapter.getFirstAsync('SELECT COUNT(*) AS count FROM project_evidence WHERE project_id = ?', PROJECT_ID).then(row => Number(row.count)), 0);
});


test('analysis cannot become ready with missing or cross-source evidence references', async t => {
  const { persistence, project } = await context(t);
  const request = requestFor(project);
  await persistence.enqueue(request);
  await persistence.start(PROJECT_ID, request.id, 1, 'lease:refs');
  const result = resultFor(request, { observationIds: ['observation:required'] });
  await assert.rejects(persistence.finish(result, 'lease:refs'), /missing observation/);
  assert.equal((await persistence.jobs(PROJECT_ID))[0].status, 'running');
  await persistence.checkpoint(PROJECT_ID, [{ id: 'observation:required', kind: 'observation', sourceId: request.sourceId, payload: { status: 'unknown' } }]);
  assert.equal((await persistence.finish(result, 'lease:refs')).disposition, 'awaiting-review');
});

test('an archive marker cannot point to missing command history', async t => {
  const { persistence, project } = await context(t);
  const next = nextFoundation(project.v15);
  next.history.archive = { kind: 'timeline-command', pageIds: ['missing-page'] };
  await assert.rejects(persistence.commit(PROJECT_ID, project.v15.revisions, 'archive:missing', next), /missing command page/);
});

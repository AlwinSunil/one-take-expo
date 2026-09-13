import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';

const database = new DatabaseSync(':memory:');
const fileSystem = {
  directories: new Set(),
  files: new Map(),
  availableDiskSpace: Number.MAX_SAFE_INTEGER,
  failCopy: false,
  copyAsEmpty: false,
  failMove: false,
  failDelete: false,
};
const mediaState = { deletedExports: [] };
globalThis.__ONE_TAKE_STORE_TEST_STATE__ = { database, fileSystem, mediaState };

const SQLITE_MOCK_URL = 'mock:one-take-expo-sqlite';
const FILE_SYSTEM_MOCK_URL = 'mock:one-take-expo-file-system';
const MEDIA_MOCK_URL = 'mock:one-take-expo-media';

const SQLITE_MOCK = String.raw`
const state = globalThis.__ONE_TAKE_STORE_TEST_STATE__;
const database = state.database;

function connection() {
  const api = {
    async execAsync(sql) {
      database.exec(sql);
    },
    async runAsync(sql, ...params) {
      const result = database.prepare(sql).run(...params);
      return { changes: Number(result.changes ?? 0), lastInsertRowId: Number(result.lastInsertRowid ?? 0) };
    },
    async getFirstAsync(sql, ...params) {
      return database.prepare(sql).get(...params) ?? null;
    },
    async getAllAsync(sql, ...params) {
      return database.prepare(sql).all(...params);
    },
    async withTransactionAsync(action) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const value = await action();
        database.exec('COMMIT');
        return value;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
    async withExclusiveTransactionAsync(action) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const value = await action(api);
        database.exec('COMMIT');
        return value;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
  };
  return api;
}

export async function openDatabaseAsync() {
  state.sqliteOpenCount = (state.sqliteOpenCount ?? 0) + 1;
  return connection();
}
`;

const FILE_SYSTEM_MOCK = String.raw`
const state = globalThis.__ONE_TAKE_STORE_TEST_STATE__.fileSystem;

function partUri(part) {
  return typeof part === 'string' ? part : part?.uri;
}

function uriFor(parts) {
  const [first, ...rest] = parts;
  let uri = partUri(first) ?? 'file:///mock/document';
  for (const part of rest) uri = uri.replace(/\/$/, '') + '/' + String(part).replace(/^\//, '');
  return uri;
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  return new TextEncoder().encode(String(value));
}

export class Directory {
  constructor(...parts) {
    this.uri = uriFor(parts);
  }

  get exists() {
    return state.directories.has(this.uri);
  }

  create() {
    state.directories.add(this.uri);
  }

  delete() {
    state.directories.delete(this.uri);
    for (const uri of state.files.keys()) if (uri.startsWith(this.uri + '/')) state.files.delete(uri);
  }
}

export class File {
  constructor(...parts) {
    this.uri = uriFor(parts);
  }

  get exists() {
    return state.files.has(this.uri);
  }

  get size() {
    return state.files.get(this.uri)?.data.byteLength ?? 0;
  }

  create() {
    if (!this.exists) state.files.set(this.uri, { data: new Uint8Array() });
  }

  write(value) {
    state.files.set(this.uri, { data: bytes(value) });
  }

  copy(destination) {
    if (state.failCopy) throw new Error('mock copy failed');
    const source = state.files.get(this.uri);
    if (!source) throw new Error('mock source is missing');
    state.files.set(destination.uri, { data: state.copyAsEmpty ? new Uint8Array() : new Uint8Array(source.data) });
  }

  move(destination) {
    if (state.failMove) throw new Error('mock move failed');
    const source = state.files.get(this.uri);
    if (!source) throw new Error('mock source is missing');
    state.files.set(destination.uri, { data: new Uint8Array(source.data) });
    state.files.delete(this.uri);
  }

  delete() {
    if (state.failDelete) throw new Error('mock delete failed');
    state.files.delete(this.uri);
  }
}

state.directories.add('file:///mock/document');
state.directories.add('file:///mock/cache');
export const Paths = {
  document: new Directory('file:///mock/document'),
  cache: new Directory('file:///mock/cache'),
  get availableDiskSpace() { return state.availableDiskSpace; },
};

export const __mockFileSystem = {
  setFile(uri, value) { state.files.set(uri, { data: bytes(value) }); },
  hasFile(uri) { return state.files.has(uri); },
  getFileSize(uri) { return state.files.get(uri)?.data.byteLength ?? 0; },
};
`;

const MEDIA_MOCK = String.raw`
const state = globalThis.__ONE_TAKE_STORE_TEST_STATE__.mediaState;
const media = {
  async deleteExport(id, deleteGallery) { state.deletedExports.push({ id, deleteGallery }); },
  async getExport(id) { return { id, status: 'completed', progress: 1 }; },
  async cancelExport() {},
  async openExport() {},
  async saveToGallery(id) { return 'gallery:' + id; },
  async shareExport() {},
  async startExport() { return { id: 'mock-export' }; },
};
export default media;
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-sqlite') return { url: SQLITE_MOCK_URL, shortCircuit: true };
    if (specifier === 'expo-file-system') return { url: FILE_SYSTEM_MOCK_URL, shortCircuit: true };
    if (specifier === '../../modules/one-take-media') return { url: MEDIA_MOCK_URL, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      // Expo Metro resolves TypeScript extensionless imports; Node does not.
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url === SQLITE_MOCK_URL) return { format: 'module', source: SQLITE_MOCK, shortCircuit: true };
    if (url === FILE_SYSTEM_MOCK_URL) return { format: 'module', source: FILE_SYSTEM_MOCK, shortCircuit: true };
    if (url === MEDIA_MOCK_URL) return { format: 'module', source: MEDIA_MOCK, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const fsModule = await import('expo-file-system');
const {
  beginRecording,
  beginProjectPickup,
  checkpointProjectSource,
  checkpointProjectPickup,
  completeProjectPickup,
  commitProjectCaptions,
  deleteProject,
  getProject,
  initializeDurableProject,
  recoverProjectSaves,
  saveProject,
  saveProjectMetadata,
} = await import('../src/lib/store.ts');

const { database: sqliteDatabase } = globalThis.__ONE_TAKE_STORE_TEST_STATE__;
const fsState = globalThis.__ONE_TAKE_STORE_TEST_STATE__.fileSystem;
const documentRoot = fsModule.Paths.document.uri;
const cacheRoot = fsModule.Paths.cache.uri;

function fileUri(root, name) {
  return `${root}/${name}`;
}

function originalUri(projectId) {
  return `${documentRoot}/videos/${encodeURIComponent(projectId)}.mp4`;
}

function pickupUri(projectId, recordingId) {
  return `${documentRoot}/videos/${encodeURIComponent(JSON.stringify([projectId, recordingId]))}.mp4`;
}

function project(id, videoUri) {
  return {
    id,
    mode: 'script',
    script: 'Say hello to the camera.',
    videoUri,
    clips: [],
    transcript: [],
    createdAt: 1,
    duration: 4,
  };
}

function row(id) {
  return sqliteDatabase.prepare('SELECT data FROM projects WHERE id = ?').get(id);
}

function operationRows(id) {
  return sqliteDatabase.prepare('SELECT id, data FROM project_operations WHERE project_id = ? ORDER BY id').all(id);
}

function setSource(uri, content = 'fake-video-payload') {
  fsModule.__mockFileSystem.setFile(uri, content);
}

function resetFaults() {
  fsState.failCopy = false;
  fsState.copyAsEmpty = false;
  fsState.failMove = false;
  fsState.failDelete = false;
  fsState.availableDiskSpace = Number.MAX_SAFE_INTEGER;
}

test('real store durability harness covers capture, journals, concurrent pickup/edit, and deletion', async t => {
  t.after(() => sqliteDatabase.close());
  resetFaults();

  const projectId = 'store:alpha';
  const captureUri = fileUri(cacheRoot, 'capture-alpha.mp4');
  setSource(captureUri, 'alpha-original');
  const captured = project(projectId, captureUri);

  await beginRecording(captured);
  const interrupted = await getProject(projectId);
  assert.equal(interrupted.recordingStatus, 'interrupted');
  assert.equal(interrupted.videoUri, captureUri);

  await saveProjectMetadata(captured);
  assert.equal(fsModule.__mockFileSystem.hasFile(originalUri(projectId)), true);
  assert.equal(fsModule.__mockFileSystem.hasFile(captureUri), true);
  const afterCopy = await getProject(projectId);
  assert.equal(afterCopy.videoUri, originalUri(projectId));
  assert.equal(afterCopy.recordingStatus, 'complete');
  assert.equal(operationRows(projectId).length, 0);

  const finalMetadata = {
    ...afterCopy,
    trim: { start: 0.5, end: 3.5 },
    transcript: [{ id: 'alpha-caption', t0: 0.5, t1: 1.5, text: 'Say hello', isFinal: true }],
  };
  await saveProjectMetadata(finalMetadata);
  const saved = await saveProject(finalMetadata);
  assert.deepEqual(saved.trim, finalMetadata.trim);
  assert.equal(saved.videoUri, originalUri(projectId));
  const reopened = await getProject(projectId);
  assert.deepEqual(reopened.trim, finalMetadata.trim);
  assert.equal(reopened.transcript[0].id, 'alpha-caption');

  const modifiedRootUri = fileUri(cacheRoot, 'modified-root-alpha.mp4');
  setSource(modifiedRootUri, 'modified-root-payload');
  await assert.rejects(
    saveProjectMetadata({ ...reopened, videoUri: modifiedRootUri }),
    /different original|identity/i,
  );
  assert.deepEqual((await getProject(projectId)).trim, finalMetadata.trim);

  setSource(originalUri(projectId), '');
  assert.equal(fsModule.__mockFileSystem.getFileSize(originalUri(projectId)), 0);
  await assert.rejects(
    saveProject({ ...reopened, trim: { start: 0.9, end: 3.1 } }),
    /saved original is incomplete/i,
  );
  assert.ok(fsModule.__mockFileSystem.getFileSize(captureUri) > 0, 'the valid cache source must survive an incomplete original');
  assert.deepEqual((await getProject(projectId)).trim, finalMetadata.trim);
  setSource(originalUri(projectId), 'alpha-original');

  const failedId = 'store:copy-failure';
  const failedSource = fileUri(cacheRoot, 'capture-failure.mp4');
  setSource(failedSource, 'copy-failure-payload');
  const failedProject = project(failedId, failedSource);
  await beginRecording(failedProject);
  fsState.failCopy = true;
  await assert.rejects(saveProjectMetadata(failedProject), /mock copy failed|recording could not be fully saved/i);
  assert.equal(operationRows(failedId).length, 1);
  assert.equal(row(failedId).data.includes('recordingStatus'), true);

  fsState.failCopy = false;
  fsState.availableDiskSpace = 0;
  await recoverProjectSaves();
  assert.equal(operationRows(failedId).length, 1);
  assert.equal((await getProject(failedId)).recordingStatus, 'interrupted');
  resetFaults();
  await recoverProjectSaves();
  assert.equal(operationRows(failedId).length, 0);
  assert.equal((await getProject(failedId)).videoUri, originalUri(failedId));

  const lowId = 'store:low-space';
  const lowSource = fileUri(cacheRoot, 'capture-low.mp4');
  setSource(lowSource, 'low-space-payload');
  const lowProject = project(lowId, lowSource);
  await beginRecording(lowProject);
  fsState.availableDiskSpace = 1;
  await assert.rejects(saveProjectMetadata(lowProject), /not enough storage/i);
  assert.equal(operationRows(lowId).length, 1);
  assert.equal(JSON.parse(operationRows(lowId)[0].data).phase, 'copying');
  assert.equal((await getProject(lowId)).recordingStatus, 'interrupted');
  resetFaults();
  await saveProjectMetadata(lowProject);
  assert.equal((await getProject(lowId)).videoUri, originalUri(lowId));

  const journalId = 'store:journal-identity';
  const journalSource = fileUri(cacheRoot, 'capture-journal.mp4');
  const alternateJournalSource = fileUri(cacheRoot, 'capture-journal-alternate.mp4');
  setSource(journalSource, 'journal-source-payload');
  setSource(alternateJournalSource, 'alternate-source-payload');
  const journalProject = project(journalId, journalSource);
  await beginRecording(journalProject);
  fsState.copyAsEmpty = true;
  await assert.rejects(saveProjectMetadata(journalProject), /could not be fully saved/i);
  const journalPart = `${originalUri(journalId)}.part`;
  assert.equal(fsModule.__mockFileSystem.hasFile(journalPart), true);
  fsState.copyAsEmpty = false;
  await assert.rejects(
    saveProjectMetadata(project(journalId, alternateJournalSource)),
    /different payload/i,
  );
  assert.equal(fsModule.__mockFileSystem.hasFile(journalPart), true, 'identity rejection must retain the interrupted .part');
  assert.equal(operationRows(journalId).length, 1);
  await recoverProjectSaves();
  assert.equal(operationRows(journalId).length, 0);
  assert.equal(fsModule.__mockFileSystem.hasFile(journalPart), false);
  assert.equal((await getProject(journalId)).videoUri, originalUri(journalId));

  const corruptJournalId = 'store:modified-journal-root';
  const corruptSource = fileUri(cacheRoot, 'capture-corrupt-journal.mp4');
  setSource(corruptSource, 'corrupt-journal-payload');
  const corruptProject = project(corruptJournalId, corruptSource);
  await beginRecording(corruptProject);
  fsState.copyAsEmpty = true;
  await assert.rejects(saveProjectMetadata(corruptProject), /could not be fully saved/i);
  const corruptPart = `${originalUri(corruptJournalId)}.part`;
  const corruptRow = operationRows(corruptJournalId)[0];
  const corruptOperation = JSON.parse(corruptRow.data);
  const modifiedRoot = `${originalUri(corruptJournalId)}-modified.mp4`;
  sqliteDatabase.prepare('UPDATE project_operations SET data = ? WHERE id = ?').run(
    JSON.stringify({ ...corruptOperation, destinationUri: modifiedRoot }),
    corruptRow.id,
  );
  fsState.copyAsEmpty = false;
  await recoverProjectSaves();
  assert.equal(operationRows(corruptJournalId).length, 1);
  assert.equal(fsModule.__mockFileSystem.hasFile(corruptPart), true, 'invalid root URI recovery must leave the pending .part');
  sqliteDatabase.prepare('UPDATE project_operations SET data = ? WHERE id = ?').run(
    JSON.stringify(corruptOperation),
    corruptRow.id,
  );
  await recoverProjectSaves();
  assert.equal(operationRows(corruptJournalId).length, 0);
  assert.equal((await getProject(corruptJournalId)).videoUri, originalUri(corruptJournalId));

  const sourceCheckpointId = 'store:source-checkpoint';
  const sourceCaptureUri = fileUri(cacheRoot, 'capture-source-checkpoint.mp4');
  setSource(sourceCaptureUri, 'source-checkpoint-payload');
  await beginRecording(project(sourceCheckpointId, null));
  const preMedia = await initializeDurableProject(sourceCheckpointId);
  const preMediaSource = preMedia.v15.sources.find(source => source.id === sourceCheckpointId);
  assert.equal(preMediaSource.mediaUri, null);
  const checkpointed = await checkpointProjectSource(sourceCheckpointId, 'source-checkpoint:pre-media', preMediaSource);
  assert.equal(checkpointed.v15.sources.find(source => source.id === sourceCheckpointId).mediaUri, null);
  await saveProjectMetadata({ ...checkpointed, videoUri: sourceCaptureUri });
  const durableSource = {
    ...preMediaSource,
    mediaUri: originalUri(sourceCheckpointId),
    durationSeconds: 4,
    availability: 'available',
  };
  const sourceReady = await checkpointProjectSource(sourceCheckpointId, 'source-checkpoint:durable', durableSource);
  assert.equal(sourceReady.v15.sources.find(source => source.id === sourceCheckpointId).mediaUri, originalUri(sourceCheckpointId));
  assert.equal((await checkpointProjectSource(sourceCheckpointId, 'source-checkpoint:durable', durableSource)).v15.sources.find(source => source.id === sourceCheckpointId).durationSeconds, 4);
  await assert.rejects(
    checkpointProjectSource(sourceCheckpointId, 'source-checkpoint:duration-change', { ...durableSource, durationSeconds: 5 }),
    /duration/i,
  );

  const durable = await initializeDurableProject(projectId);
  const staleEditor = await getProject(projectId);
  const lineId = `${projectId}:line:0`;
  const pickupId = 'pickup:alpha';
  const pickupSource = fileUri(cacheRoot, 'pickup-alpha.mp4');
  setSource(pickupSource, 'pickup-alpha-payload');
  await beginProjectPickup(projectId, pickupId, [lineId]);
  const editorSave = saveProjectMetadata({
    ...staleEditor,
    trim: { start: 0.75, end: 3.25 },
  });
  const pickupSave = completeProjectPickup(projectId, pickupId, {
    videoUri: pickupSource,
    duration: 2,
    transcript: [{ id: 'pickup-caption', t0: 0.25, t1: 1.25, text: 'again', isFinal: true }],
    takes: [],
  });
  const outcomes = await Promise.allSettled([editorSave, pickupSave]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 0);
  const withPickup = await getProject(projectId);
  assert.deepEqual(withPickup.trim, { start: 0.75, end: 3.25 });
  assert.ok(withPickup.recordings.some(recording => recording.id === pickupId));
  assert.equal(withPickup.recordings.find(recording => recording.id === pickupId).evidenceStatus, 'complete');
  assert.ok(withPickup.transcript.some(segment => segment.recordingId === pickupId));
  assert.ok(withPickup.v15.sources.some(source => source.id === pickupId));
  assert.ok(withPickup.v15.revisions.projectRevision > durable.v15.revisions.projectRevision);
  assert.equal(fsModule.__mockFileSystem.hasFile(pickupUri(projectId, pickupId)), true);

  const preferencesBase = withPickup.v15.revisions;
  const corrections = [{ id: 'correction:retry', segmentId: withPickup.transcript[0].id, sourceId: projectId,
    revision: preferencesBase.captionRevision + 1, text: 'Creator correction', baseTranscriptRevision: preferencesBase.transcriptRevision[projectId], origin: 'creator' }];
  const corrected = await commitProjectCaptions(projectId, preferencesBase, 'captions:retry', { showInEditor: false, burnIntoExport: true }, corrections);
  const duplicate = await commitProjectCaptions(projectId, preferencesBase, 'captions:retry', { showInEditor: false, burnIntoExport: true }, corrections);
  assert.deepEqual(duplicate.v15, corrected.v15);
  assert.equal(duplicate.v15.captionCorrections.filter(item => item.id === 'correction:retry').length, 1);
  await assert.rejects(commitProjectCaptions(projectId, preferencesBase, 'captions:retry', { showInEditor: true, burnIntoExport: true }, corrections), /different payload/i);

  const originalFile = originalUri(projectId);
  const pickupFile = pickupUri(projectId, pickupId);
  await deleteProject(projectId);
  assert.equal(await getProject(projectId), null);
  assert.equal(fsModule.__mockFileSystem.hasFile(originalFile), false);
  assert.equal(fsModule.__mockFileSystem.hasFile(pickupFile), false);
  assert.equal(fsModule.__mockFileSystem.hasFile(captureUri), false);
  assert.equal(sqliteDatabase.prepare('SELECT id FROM projects WHERE id = ?').get(projectId), undefined);
  assert.ok(sqliteDatabase.prepare('SELECT id FROM deleted_projects WHERE id = ?').get(projectId));
  await assert.rejects(saveProject({ ...withPickup, videoUri: pickupFile }), /being deleted|cannot be changed/i);
});

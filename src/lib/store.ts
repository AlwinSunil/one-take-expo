import * as SQLite from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';

import { isWithinFileRoots, localFileIdentity, settleProjectCancellation } from './project-deletion';

import { projectReview, projectScriptLines, projectSegments } from './project-workflow';

import media from '../../modules/one-take-media';

import { deserializeScriptDraftSnapshot, serializeScriptDraftSnapshot, type ScriptDraftSnapshot } from './t1-script-draft';
import type { Project } from './session';
import { createDurablePersistence, T15_TABLES, type EvidenceRecord } from './t15-persistence';
import { canonicalJson, createFoundation, validateFoundation, type Observation, type SourceRecord, type AssetReference, type RevisionVector } from './t15-schema';
import { preserveDurableLegacyEdit } from './t15-legacy';
import type { AnalysisRequest, AnalysisResult } from './t15-jobs';
import { PENDING_PICKUP_MESSAGE, projectWithDurableOriginal, mergePickupRecording, normalizeProject, preserveNewRecordings, preserveEditsDuringCaptureFinalization, type PickupRecordingInput } from './project-data';

const deletedIds = new Set<string>();

let db: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb() {
  if (!db) {
    db = (async () => {
      const connection = await SQLite.openDatabaseAsync('onetake.db');
      await connection.execAsync(`
        PRAGMA busy_timeout = 5000;
        ${T15_TABLES}
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_operations (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deletion_options (project_id TEXT PRIMARY KEY NOT NULL, delete_gallery INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS deleted_projects (id TEXT PRIMARY KEY NOT NULL);
        CREATE TABLE IF NOT EXISTS project_files (project_id TEXT NOT NULL, uri TEXT NOT NULL, PRIMARY KEY(project_id, uri));
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      `);
      for (const row of await connection.getAllAsync<{ id: string }>('SELECT id FROM deleted_projects')) deletedIds.add(row.id);
      return connection;
    })().catch(error => { db = null; throw error; });
  }
  return db;
}

export async function saveProject(p: Project): Promise<Project> {
  return withProjectLock(p.id, async () => {
    await assertProjectAvailable(await getDb(), p.id);
    if (!p.videoUri) throw new Error('No recording is available to save.');
    await recoverPendingOriginal(p);
    const destination = new File(Paths.document, 'videos', `${encodeURIComponent(p.id)}.mp4`);
    if (destination.exists) {
      await assertOriginalSize(p.id, destination);
      await writeProjectMetadata(p);
      return checkMedia(await readStoredProject(p.id));
    }
    const saved = projectWithDurableOriginal(p, destination.uri);
    normalizeProject(saved);
    const operation: RecordingOperation = { id: `original:${p.id}`, projectId: p.id, kind: 'original',
      sourceUri: p.videoUri, destinationUri: destination.uri, expectedSize: 0, phase: 'copying', project: saved, createdAt: Date.now() };
    return saveRecordingOperation(operation);
  });
}

export async function listProjects(): Promise<Project[]> {
  await recoverProjectSaves();
  const d = await getDb();
  const rows = await d.getAllAsync<{ id: string; data: string }>('SELECT id, data FROM projects ORDER BY rowid DESC');
  const recovery = await pendingRecoveryMessages();
  const pending = new Set((await d.getAllAsync<{ id: string }>('SELECT id FROM deleted_projects')).map(row => row.id));
  return rows.map((r) => {
    try {
      const project = checkMedia(normalizeProject(JSON.parse(r.data)));
      if (recovery.has(r.id)) project.recoveryMessage = recovery.get(r.id);
      return pending.has(r.id) ? { ...project, recoveryMessage: 'Deletion did not finish. Retry Delete project to remove the remaining app files.' } : project;
    }
    catch { return unreadableProject(r.id); }
  });
}

export async function getProject(id: string): Promise<Project | null> {
  await recoverProjectSaves();
  const d = await getDb();
  const row = await d.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', id);
  if (!row) return null;
  let project: Project;
  try { project = checkMedia(normalizeProject(JSON.parse(row.data))); }
  catch { return unreadableProject(id); }
  const message = (await pendingRecoveryMessages()).get(id);
  return message ? { ...project, recoveryMessage: message } : project;
}

function unreadableProject(id: string): Project {
  const original = new File(Paths.document, 'videos', `${encodeURIComponent(id)}.mp4`);
  return { id, mode: 'assisted', videoUri: original.exists && original.size > 0 ? original.uri : null,
    clips: [], transcript: [], createdAt: 0,
    recoveryMessage: 'This project needs metadata recovery or a newer app. Its original remains available; existing metadata cannot be overwritten.' };
}

function checkMedia(project: Project): Project {
  const original = new File(Paths.document, 'videos', `${encodeURIComponent(project.id)}.mp4`);
  if (original.exists) project = { ...project, videoUri: original.uri };
  const missing = !project.videoUri || !new File(project.videoUri).exists;
  const unavailableTakeIds = project.takes?.filter(take => !take.mediaUri || !new File(take.mediaUri).exists).map(take => take.id) ?? [];
  const mediaUris = new Set([project.videoUri, ...(project.recordings ?? []).map(recording => recording.mediaUri)]);
  const availableMediaUris = [...mediaUris].filter((uri): uri is string => typeof uri === 'string' && !!uri && new File(uri).exists);
  const pendingEvidence = project.recordings?.some(recording => recording.evidenceStatus === 'pending');
  const unavailable = unavailableTakeIds.length;
  return { ...project, availableMediaUris, unavailableTakeIds, mediaMissing: missing, recoveryMessage: pendingEvidence ? PENDING_PICKUP_MESSAGE : unavailable ? `${unavailable} takes are unavailable for coverage. Your saved text and edits remain; record replacement takes.` : missing ? 'The recording file is missing. Its transcript and edits are still saved.' : project.recoveryMessage };
}

export async function saveProjectMetadata(project: Project): Promise<void> {
  return withProjectLock(project.id, async () => {
    normalizeProject(project);
    await recoverPendingOriginal(project);
    // The current capture owner already checkpoints here before optional caption finalization.
    // Complete its durable copy now, using the same original journal as Save/Retry.
    const original = new File(Paths.document, 'videos', `${encodeURIComponent(project.id)}.mp4`);
    if (project.videoUri && !original.exists) {
      await saveRecordingOperation({ id: `original:${project.id}`, projectId: project.id, kind: 'original',
        sourceUri: project.videoUri, destinationUri: original.uri, expectedSize: 0, phase: 'copying',
        project: projectWithDurableOriginal(project, original.uri), createdAt: Date.now() });
      return;
    }
    await writeProjectMetadata(project);
  });
}

async function writeProjectMetadata(project: Project): Promise<void> {
  const d = await getDb();
  await assertProjectAvailable(d, project.id);
  const row = await d.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', project.id);
  if (!row) throw new Error('This project is no longer available to update.');
  const current = normalizeProject(JSON.parse(row.data));
  const canonicalOriginal = new File(Paths.document, 'videos', `${encodeURIComponent(project.id)}.mp4`);
  if (canonicalOriginal.exists) await assertOriginalSize(project.id, canonicalOriginal);
  if (canonicalOriginal.exists && project.videoUri && project.videoUri !== canonicalOriginal.uri && project.videoUri !== current.videoUri) {
    const source = await d.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', `recording-source:original:${project.id}`);
    if (!source || source.value !== project.videoUri) throw new Error('This project identity already belongs to a different original.');
  }
  if (canonicalOriginal.exists && project.videoUri && project.videoUri !== canonicalOriginal.uri && isCacheFile(project.videoUri)) {
    project = preserveEditsDuringCaptureFinalization(current, project);
  }
  if (current.v15 && canonicalJson(project.v15 ?? null) !== canonicalJson(current.v15)) {
    throw new Error('The durable project changed. Reopen the latest edit before saving.');
  }
  project = preserveNewRecordings(current, project);
  // Legacy callers cannot author the new snapshot. Its owner uses commitDurableProject.
  if (current.v15) project = preserveDurableLegacyEdit(current, project);
  const preserved = new File(Paths.document, 'videos', `${encodeURIComponent(project.id)}.mp4`);
  const metadata = preserved.exists ? { ...project, videoUri: preserved.uri,
    takes: project.takes?.map(take => take.mediaUri === project.videoUri ? { ...take, mediaUri: preserved.uri } : take) } : project;
  normalizeProject(metadata);
  const result = await d.runAsync('UPDATE projects SET data = ? WHERE id = ? AND data = ? AND NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)', JSON.stringify(metadata), project.id, row.data, project.id);
  if (result.changes !== 1) throw new Error('The project changed while saving. Reopen it and retry.');
}

export async function beginRecording(project: Project): Promise<void> {
  const d = await getDb();
  await assertProjectAvailable(d, project.id);
  await d.runAsync('INSERT INTO projects (id, data) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)', project.id,
    JSON.stringify({ ...project, recordingStatus: 'interrupted', recoveryMessage: 'Recording did not finish. Any usable original remains on this device.' }), project.id);
}

const DRAFT_KEY = 'script_draft';
const ACCEPTED_KEY = 'script_accepted';

export async function saveDraft(text: string): Promise<void> {
  const d = await getDb();
  await d.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', DRAFT_KEY, text);
}

export async function getDraft(): Promise<string> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', DRAFT_KEY);
  return row?.value ?? '';
}

/** Atomically promote the draft to the accepted script and clear the draft. */
export async function acceptDraft(text: string): Promise<string> {
  const d = await getDb();
  await d.withTransactionAsync(async () => {
    await d.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', ACCEPTED_KEY, text);
    await d.runAsync('DELETE FROM kv WHERE key = ?', DRAFT_KEY);
  });
  return text;
}

export async function getAcceptedScript(): Promise<string> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', ACCEPTED_KEY);
  return row?.value ?? '';
}

/** Additive atomic draft API. Legacy string readers keep their exact keys. */
export async function saveTier1ScriptDraft(snapshot: ScriptDraftSnapshot): Promise<void> {
  const serialized = serializeScriptDraftSnapshot(snapshot);
  const d = await getDb();
  await d.withTransactionAsync(async () => {
    for (const [key, value] of [[DRAFT_KEY, snapshot.text], ['script_draft_lines', snapshot.structure], ['t1_script_draft', serialized]]) {
      await d.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value);
    }
  });
}

/** A present stale/malformed snapshot throws; callers must keep autosave disabled. */
export async function getTier1ScriptDraft(expectedIdentity?: string) {
  return readTier1ScriptSnapshot(DRAFT_KEY, 't1_script_draft', expectedIdentity);
}

export async function acceptTier1ScriptDraft(snapshot: ScriptDraftSnapshot): Promise<string> {
  const serialized = serializeScriptDraftSnapshot(snapshot);
  const d = await getDb();
  await d.withTransactionAsync(async () => {
    for (const [key, value] of [[ACCEPTED_KEY, snapshot.text], ['script_accepted_lines', snapshot.structure], ['t1_script_accepted', serialized]]) {
      await d.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value);
    }
    await d.runAsync('DELETE FROM kv WHERE key IN (?, ?, ?)', DRAFT_KEY, 'script_draft_lines', 't1_script_draft');
  });
  return snapshot.text;
}

export async function getAcceptedTier1Script(expectedIdentity?: string) {
  return readTier1ScriptSnapshot(ACCEPTED_KEY, 't1_script_accepted', expectedIdentity);
}

async function readTier1ScriptSnapshot(rawKey: string, snapshotKey: string, expectedIdentity?: string) {
  const d = await getDb();
  // One statement observes the paired values from the same committed snapshot.
  const rows = await d.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM kv WHERE key IN (?, ?)', rawKey, snapshotKey);
  const snapshot = rows.find(row => row.key === snapshotKey)?.value;
  return deserializeScriptDraftSnapshot(snapshot, { expectedIdentity, expectedText: rows.find(row => row.key === rawKey)?.value ?? '' });
}

export async function saveSetting(key: string, value: string): Promise<void> {
  const d = await getDb();
  await d.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value);
}

export async function getSetting(key: string, fallback = ''): Promise<string> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
  return row?.value ?? fallback;
}

const activeWork = new Map<string, Set<() => Promise<void>>>();
const deleting = new Set<string>();

async function assertProjectAvailable(d: SQLite.SQLiteDatabase, id: string) {
  if (deleting.has(id) || await d.getFirstAsync('SELECT id FROM deleted_projects WHERE id = ?', id)) {
    throw new Error('This project is being deleted and cannot be changed.');
  }
}

/** Cancellation must settle only after the job can no longer write files. */
export function registerProjectWork(id: string, cancel: () => Promise<void>): () => void {
  if (deleting.has(id) || deletedIds.has(id)) throw new Error('This project is being deleted.');
  const jobs = activeWork.get(id) ?? new Set();
  jobs.add(cancel);
  activeWork.set(id, jobs);
  return () => { jobs.delete(cancel); if (!jobs.size) activeWork.delete(id); };
}

export async function registerProjectFile(id: string, uri: string): Promise<void> {
  const d = await getDb();
  await assertProjectAvailable(d, id);
  if (!isPrivateFile(uri)) throw new Error('Only app-private files can belong to a project.');
  await d.runAsync('INSERT OR IGNORE INTO project_files (project_id, uri) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)', id, uri, id);
}

function isPrivateFile(uri: string): boolean {
  return isWithinFileRoots(uri, [Paths.document.uri, Paths.cache.uri]);
}

export async function deleteProject(id: string, options: { deleteGallery?: boolean } = {}): Promise<void> {
  if (deleting.has(id)) throw new Error('Deletion is already in progress.');
  deleting.add(id);
  deletedIds.add(id);
  try {
    const d = await getDb();
    // A durable tombstone prevents late saves and survives interrupted deletion.
    await d.runAsync('INSERT OR IGNORE INTO deleted_projects (id) VALUES (?)', id);
    await d.runAsync('INSERT OR IGNORE INTO deletion_options (project_id, delete_gallery) VALUES (?, ?)', id, options.deleteGallery ? 1 : 0);
    if (options.deleteGallery !== undefined) await d.runAsync('UPDATE deletion_options SET delete_gallery = ? WHERE project_id = ?', options.deleteGallery ? 1 : 0, id);
    const deletion = await d.getFirstAsync<{ delete_gallery: number }>('SELECT delete_gallery FROM deletion_options WHERE project_id = ?', id);
    await settleProjectCancellation(Array.from(activeWork.get(id) ?? []));
    const latest = await getSetting(`export:${id}`);
    const history = JSON.parse(await getSetting(`exports:${id}`, '[]')) as string[];
    const exports = new Set([...history, ...(latest ? [latest] : [])]);
    if (exports.size && !media) throw new Error('Reopen this project in the Android app to remove its exports, then retry deletion.');
    for (const exportId of exports) await media!.deleteExport(exportId, deletion?.delete_gallery === 1);
    const row = await d.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', id);
    const registered = await d.getAllAsync<{ uri: string }>('SELECT uri FROM project_files WHERE project_id = ?', id);
    const original = new File(Paths.document, 'videos', `${encodeURIComponent(id)}.mp4`);
    const temporary = new File(Paths.document, 'videos', `${encodeURIComponent(id)}.part`);
    const uris = new Set([original.uri, temporary.uri, ...registered.map(file => file.uri)]);
    try {
      const p = row ? JSON.parse(row.data) : null;
      if (typeof p?.videoUri === 'string') uris.add(p.videoUri);
      for (const take of [...(p?.takes ?? []), ...(p?.recordings ?? [])]) if (typeof take.mediaUri === 'string') uris.add(take.mediaUri);
    } catch { /* Canonical paths still allow removal of corrupt projects. */ }
    const operations = await d.getAllAsync<{ data: string }>('SELECT data FROM project_operations WHERE project_id = ?', id);
    for (const row of operations) {
      try { const op = JSON.parse(row.data); if (typeof op.destinationUri === 'string') { uris.add(op.destinationUri); uris.add(`${op.destinationUri}.part`); } if (typeof op.sourceUri === 'string' && isCacheFile(op.sourceUri)) uris.add(op.sourceUri); } catch { /* Registered files remain removable even when a journal is corrupt. */ }
    }
    const shared = await d.getAllAsync<{ uri: string }>('SELECT uri FROM project_files WHERE project_id != ?', id);
    const sharedUris = new Set(shared.map(file => file.uri));
    const others = await d.getAllAsync<{ id: string; data: string }>('SELECT id, data FROM projects WHERE id != ?', id);
    for (const other of others) {
      sharedUris.add(new File(Paths.document, 'videos', `${encodeURIComponent(other.id)}.mp4`).uri);
      try { const p = JSON.parse(other.data); if (typeof p.videoUri === 'string') sharedUris.add(p.videoUri); for (const take of [...(p.takes ?? []), ...(p.recordings ?? [])]) if (typeof take.mediaUri === 'string') sharedUris.add(take.mediaUri); } catch { /* Unreadable projects retain their canonical originals. */ }
    }
    const sharedFiles = new Set([...sharedUris].map(localFileIdentity).filter(uri => uri !== null));
    const deletedFiles = new Set<string>();
    let failed = false;
    for (const uri of uris) {
      const identity = localFileIdentity(uri);
      if (!identity || !isPrivateFile(uri) || sharedFiles.has(identity)) continue;
      try { const file = new File(uri); if (file.exists) file.delete(); deletedFiles.add(identity); } catch { failed = true; }
    }
    if (failed) throw new Error('Some app files could not be removed. Keep this project and retry deletion. Shared copies are unchanged.');
    await d.withTransactionAsync(async () => {
      const latestVideo = await d.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', 'last_video_uri');
      const latestIdentity = latestVideo ? localFileIdentity(latestVideo.value) : null;
      if (latestIdentity && deletedFiles.has(latestIdentity)) await d.runAsync('DELETE FROM kv WHERE key = ?', 'last_video_uri');
      await d.runAsync('DELETE FROM kv WHERE key = ?', `project_draft:${id}`);
      await d.runAsync('DELETE FROM kv WHERE key IN (?, ?)', `recording-source:original:${id}`, `recording-size:original:${id}`);
      await d.runAsync('DELETE FROM kv WHERE key IN (?, ?)', `export:${id}`, `exports:${id}`);
      const pickupKeys = await d.getAllAsync<{ key: string }>('SELECT key FROM kv');
      for (const row of pickupKeys) {
        if (row.key.startsWith(`pickup:${encodeURIComponent(id)}:`)) await d.runAsync('DELETE FROM kv WHERE key = ?', row.key);
        if (row.key.startsWith('recording-source:[') || row.key.startsWith('recording-size:[')) {
          try { if (JSON.parse(row.key.slice(row.key.indexOf(':') + 1))[1] === id) await d.runAsync('DELETE FROM kv WHERE key = ?', row.key); } catch { /* Keep unrelated receipts. */ }
        }
      }
      await d.runAsync('DELETE FROM project_evidence WHERE project_id = ?', id);
      await d.runAsync('DELETE FROM project_analysis_jobs WHERE project_id = ?', id);
      await d.runAsync('DELETE FROM project_operations WHERE project_id = ?', id);
      await d.runAsync('DELETE FROM project_files WHERE project_id = ?', id);
      await d.runAsync('DELETE FROM projects WHERE id = ?', id);
    });
  } finally { deleting.delete(id); }
}

export async function assertProjectExists(id: string): Promise<void> {
  const d = await getDb();
  await assertProjectAvailable(d, id);
  if (!await d.getFirstAsync('SELECT id FROM projects WHERE id = ?', id)) throw new Error('This project is no longer available.');
}

type RecordingOperation = {
  id: string;
  projectId: string;
  kind: 'original' | 'pickup';
  recordingId?: string;
  sourceUri: string;
  destinationUri: string;
  expectedSize: number;
  phase: 'copying' | 'ready';
  createdAt: number;
  project?: Project;
  input?: PickupRecordingInput;
};

const projectLocks = new Map<string, Promise<unknown>>();
const runningOperations = new Set<string>();
let recovering: Promise<void> | undefined;

async function withProjectLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(id) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(action);
  projectLocks.set(id, result);
  try { return await result; }
  finally { if (projectLocks.get(id) === result) projectLocks.delete(id); }
}

async function readStoredProject(id: string): Promise<Project> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', id);
  if (!row) throw new Error('This project is no longer available.');
  return normalizeProject(JSON.parse(row.data));
}

async function writeOperation(operation: RecordingOperation): Promise<void> {
  const d = await getDb();
  const previous = await d.getFirstAsync<{ data: string }>('SELECT data FROM project_operations WHERE id = ?', operation.id);
  if (previous) assertSameRecordingOperation(JSON.parse(previous.data), operation);
  const result = previous
    ? await d.runAsync('UPDATE project_operations SET data = ? WHERE id = ? AND data = ? AND NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)', JSON.stringify(operation), operation.id, previous.data, operation.projectId)
    : await d.runAsync('INSERT OR IGNORE INTO project_operations (id, project_id, data) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)',
      operation.id, operation.projectId, JSON.stringify(operation), operation.projectId);
  if (result.changes !== 1) throw new Error('This project is being deleted.');
}

async function saveRecordingOperation(operation: RecordingOperation, recoveringCopy = false): Promise<Project> {
  let cancelled = false;
  let finish!: () => void;
  const settled = new Promise<void>(resolve => { finish = resolve; });
  const unregister = registerProjectWork(operation.projectId, async () => { cancelled = true; await settled; });
  runningOperations.add(operation.id);
  try {
    const d = await getDb();
    await assertProjectAvailable(d, operation.projectId);
    const pending = await d.getFirstAsync<{ data: string }>('SELECT data FROM project_operations WHERE id = ?', operation.id);
    if (pending) {
      const journal = JSON.parse(pending.data) as RecordingOperation;
      validateOperation(journal, operation.id);
      assertSameRecordingOperation(journal, operation);
      operation = journal;
      recoveringCopy = true;
    }
    const directory = new Directory(Paths.document, 'videos');
    directory.create({ idempotent: true, intermediates: true });
    const source = new File(operation.sourceUri);
    const destination = new File(operation.destinationUri);
    const temporary = new File(`${operation.destinationUri}.part`);
    if (!destination.exists) {
      if (!(recoveringCopy && operation.phase === 'ready' && temporary.exists && temporary.size === operation.expectedSize)) {
        if (!source.exists || source.size <= 0) throw new Error('The recording file is missing.');
        operation.expectedSize = source.size;
        operation.phase = 'copying';
        await writeOperation(operation);
        await registerProjectFile(operation.projectId, destination.uri);
        await registerProjectFile(operation.projectId, temporary.uri);
        if (isCacheFile(source.uri)) await registerProjectFile(operation.projectId, source.uri);
        if (Paths.availableDiskSpace < source.size + 10 * 1024 * 1024) throw new Error('Not enough storage to save this recording. Free some space and retry.');
        if (temporary.exists) temporary.delete();
        await source.copy(temporary);
        if (temporary.size !== operation.expectedSize) throw new Error('The recording could not be fully saved. Keep the app open and retry.');
        operation.phase = 'ready';
        await writeOperation(operation);
      }
      if (cancelled) throw new Error('This project is being deleted.');
      await temporary.move(destination);
    } else if (recoveringCopy && operation.expectedSize > 0 && destination.size !== operation.expectedSize) {
      throw new Error('The saved recording is incomplete. Its source has been preserved.');
    }
    await assertProjectAvailable(d, operation.projectId);
    await registerProjectFile(operation.projectId, destination.uri);
    if (!recoveringCopy) {
      operation.expectedSize = destination.size;
      operation.phase = 'ready';
      await writeOperation(operation);
    }
    const previous = await d.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', operation.projectId);
    let saved = operation.kind === 'pickup'
      ? mergePickupRecording(normalizeProject(JSON.parse(previous!.data)), operation.recordingId!,
        { ...operation.input!, videoUri: destination.uri, takes: operation.input!.takes.map(take => ({ ...take, mediaUri: destination.uri })) }, operation.createdAt)
      : previous ? mergeOriginalJournal(normalizeProject(JSON.parse(previous.data)), operation.project!, recoveringCopy) : operation.project!;
    if (previous && operation.kind === 'pickup') saved = preserveDurableLegacyEdit(normalizeProject(JSON.parse(previous.data)), saved);
    await d.withExclusiveTransactionAsync(async tx => {
      const result = previous
        ? await tx.runAsync('UPDATE projects SET data = ? WHERE id = ? AND data = ? AND NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)', JSON.stringify(saved), saved.id, previous.data, saved.id)
        : await tx.runAsync('INSERT OR IGNORE INTO projects (id, data) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)', saved.id, JSON.stringify(saved), saved.id);
      if (result.changes !== 1) throw new Error('This project was deleted and cannot be saved.');
      await tx.runAsync('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)', `recording-source:${operation.id}`, operation.sourceUri);
      await tx.runAsync('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)', `recording-size:${operation.id}`, String(destination.size));
      await tx.runAsync('DELETE FROM project_operations WHERE id = ?', operation.id);
      if (operation.recordingId) {
        const key = pickupKey(operation.projectId, operation.recordingId);
        if (operation.input?.evidenceStatus === 'pending') {
          const draft = await tx.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
          if (draft) await tx.runAsync('UPDATE kv SET value = ? WHERE key = ?', JSON.stringify({ ...JSON.parse(draft.value), checkpointSourceUri: operation.sourceUri }), key);
        } else await tx.runAsync('DELETE FROM kv WHERE key = ?', key);
      }
    });
    return checkMedia(saved);
  } finally {
    runningOperations.delete(operation.id);
    finish();
    unregister();
  }
}

/** Replays only journaled saves; a partial copy is never mistaken for a valid original. */
export async function recoverProjectSaves(): Promise<void> {
  if (recovering) return recovering;
  recovering = (async () => {
    const d = await getDb();
    const rows = await d.getAllAsync<{ id: string; data: string }>('SELECT id, data FROM project_operations');
    for (const row of rows) {
      if (runningOperations.has(row.id)) continue;
      try {
        const operation = JSON.parse(row.data) as RecordingOperation;
        validateOperation(operation, row.id);
        if (deletedIds.has(operation.projectId)) continue;
        await withProjectLock(operation.projectId, async () => {
          if (!await d.getFirstAsync('SELECT id FROM project_operations WHERE id = ?', row.id)) return;
          try { await saveRecordingOperation(operation, true); }
          catch {
            if (operation.kind === 'original' && operation.project) {
              const interrupted = { ...operation.project, recordingStatus: 'interrupted', recoveryMessage: 'Saving was interrupted. Keep the original recording on this device and retry when space is available.' };
              await d.runAsync('INSERT OR IGNORE INTO projects (id, data) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)', operation.projectId, JSON.stringify(interrupted), operation.projectId);
            }
          }
        });
      } catch { /* A corrupt journal never causes deletion or replacement of an existing project. */ }
    }
  })().finally(() => { recovering = undefined; });
  return recovering;
}

export async function beginProjectPickup(projectId: string, recordingId: string, lineIds: string[]): Promise<void> {
  return withProjectLock(projectId, async () => {
    await assertProjectExists(projectId);
    const project = await readStoredProject(projectId);
    if (!recordingId || project.recordings?.some(recording => recording.id === recordingId)) throw new Error('Choose a new pickup recording identity.');
    const lines = new Set(projectScriptLines(project).map(line => line.id));
    if (!lineIds.length || lineIds.some(id => !lines.has(id))) throw new Error('Choose the script lines to record again.');
    const key = pickupKey(projectId, recordingId);
    const d = await getDb();
    const result = await d.runAsync('INSERT OR IGNORE INTO kv (key, value) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)', key,
      JSON.stringify({ projectId, recordingId, lineIds: [...new Set(lineIds)], createdAt: Date.now() }), projectId);
    if (result.changes !== 1) throw new Error('This pickup has already started or the project was deleted.');
  });
}

export async function checkpointProjectPickup(projectId: string, recordingId: string, input: { videoUri: string; duration: number }): Promise<Project> {
  return savePickup(projectId, recordingId, { ...input, transcript: [], takes: [], evidenceStatus: 'pending' });
}

export async function completeProjectPickup(projectId: string, recordingId: string, input: PickupRecordingInput): Promise<Project> {
  return savePickup(projectId, recordingId, { ...input, evidenceStatus: 'complete' });
}

async function savePickup(projectId: string, recordingId: string, input: PickupRecordingInput): Promise<Project> {
  return withProjectLock(projectId, async () => {
    await assertProjectExists(projectId);
    const project = await readStoredProject(projectId);
    const existing = project.recordings?.find(recording => recording.id === recordingId);
    if (existing && (existing.evidenceStatus !== 'pending' || input.evidenceStatus === 'pending')) {
      const originalInput = await getSetting(`recording-source:${pickupOperationId(projectId, recordingId)}`);
      if (input.videoUri !== existing.mediaUri && input.videoUri !== originalInput) throw new Error('This pickup evidence belongs to a different recording.');
      const normalized = { ...input, videoUri: existing.mediaUri, takes: input.takes.map(take => ({ ...take, mediaUri: take.mediaUri === input.videoUri ? existing.mediaUri : take.mediaUri })) };
      // The original request's line subset is preserved in the saved receipt.
      const receipt = input.evidenceStatus === 'pending' ? existing.checkpointPayload : existing.completionPayload;
      if (receipt) normalized.eligibleLineIds = JSON.parse(receipt).eligibleLineIds ?? undefined;
      return checkMedia(mergePickupRecording(project, recordingId, normalized, existing.createdAt));
    }
    const draft = await getSetting(pickupKey(projectId, recordingId));
    if (!draft) throw new Error('Start this pickup before saving it.');
    const { createdAt, lineIds, checkpointSourceUri } = JSON.parse(draft) as { createdAt: number; lineIds: string[]; checkpointSourceUri?: string };
    if (!Array.isArray(lineIds) || !lineIds.length || lineIds.some(id => typeof id !== 'string')) throw new Error('The pickup line selection is unreadable.');
    if (existing && input.videoUri !== existing.mediaUri && input.videoUri !== checkpointSourceUri) throw new Error('This pickup evidence belongs to a different recording.');
    const sourceUri = existing?.mediaUri ?? input.videoUri;
    input = { ...input, eligibleLineIds: [...lineIds], videoUri: sourceUri,
      takes: input.takes.map(take => take.mediaUri === input.videoUri ? { ...take, mediaUri: sourceUri } : take) };
    mergePickupRecording(project, recordingId, input, createdAt);
    const destination = pickupFile(projectId, recordingId);
    return saveRecordingOperation({ id: pickupOperationId(projectId, recordingId), recordingId, projectId, kind: 'pickup', input, sourceUri,
      destinationUri: destination.uri, expectedSize: 0, phase: 'copying', createdAt });
  });
}

export async function cancelProjectPickup(projectId: string, recordingId: string): Promise<void> {
  return withProjectLock(projectId, async () => {
    const d = await getDb();
    const operation = await d.getFirstAsync('SELECT id FROM project_operations WHERE id = ? AND project_id = ?', pickupOperationId(projectId, recordingId), projectId);
    const project = await readStoredProject(projectId);
    if (operation || project.recordings?.some(recording => recording.id === recordingId && recording.evidenceStatus === 'pending')) throw new Error('This pickup has a saved recording waiting for recovery. Retry saving it or delete the project to remove its files.');
    await d.runAsync('DELETE FROM kv WHERE key = ?', pickupKey(projectId, recordingId));
  });
}

export async function mergePickupProject(targetId: string, pickupId: string, lineIds: string[]): Promise<Project> {
  if (targetId === pickupId) throw new Error('Choose a different project containing the pickup recording.');
  const pickup = await getProject(pickupId);
  if (!pickup?.videoUri || pickup.mediaMissing) throw new Error('The pickup original is missing. Choose another recording.');
  if (pickup.recordings && pickup.recordings.length > 1) throw new Error('Choose a pickup project with one original recording.');
  const recordingId = `${targetId}:import:${pickupId}`;
  const target = await getProject(targetId);
  if (target?.recordings?.some(recording => recording.id === recordingId)) return target;
  if (!await getSetting(pickupKey(targetId, recordingId))) await beginProjectPickup(targetId, recordingId, lineIds);
  const takes = pickup.takes ?? projectReview(pickup).takes;
  const duration = pickup.duration ?? Math.max(0, ...pickup.transcript.map(segment => segment.t1), ...takes.map(take => take.t1));
  return completeProjectPickup(targetId, recordingId, { videoUri: pickup.videoUri, duration, transcript: projectSegments(pickup), takes: takes.map(take => ({ ...take, lineIds: undefined })) });
}

function pickupKey(projectId: string, recordingId: string): string {
  return `pickup:${encodeURIComponent(projectId)}:${encodeURIComponent(recordingId)}`;
}

async function pendingRecoveryMessages(): Promise<Map<string, string>> {
  const d = await getDb();
  const messages = new Map<string, string>();
  const pickups = await d.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM kv');
  for (const row of pickups) {
    if (!row.key.startsWith('pickup:')) continue;
    try {
      const draft = JSON.parse(row.value) as { projectId: string; checkpointSourceUri?: string };
      if (typeof draft.projectId === 'string') messages.set(draft.projectId, draft.checkpointSourceUri ? PENDING_PICKUP_MESSAGE : 'A pickup did not finish. Your earlier takes are safe. Record those lines again or attach a saved pickup.');
    } catch { /* Unrelated drafts must never prevent opening a recording. */ }
  }
  for (const row of await d.getAllAsync<{ project_id: string }>('SELECT project_id FROM project_operations')) {
    messages.set(row.project_id, 'A recording could not finish saving. Keep its source on this device, free some space if needed, then reopen Projects to retry.');
  }
  return messages;
}

function pickupFile(projectId: string, recordingId: string): File {
  return new File(Paths.document, 'videos', `${encodeURIComponent(JSON.stringify([projectId, recordingId]))}.mp4`);
}

function pickupOperationId(projectId: string, recordingId: string): string {
  return JSON.stringify(['pickup', projectId, recordingId]);
}

function validateOperation(operation: RecordingOperation, id: string): void {
  if (!operation || operation.id !== id || typeof operation.projectId !== 'string' || !operation.projectId
    || !['original', 'pickup'].includes(operation.kind) || !['copying', 'ready'].includes(operation.phase)
    || typeof operation.sourceUri !== 'string' || !operation.sourceUri || !Number.isFinite(operation.expectedSize)
    || operation.expectedSize < 0 || !Number.isFinite(operation.createdAt)) throw new Error('The save journal is unreadable.');
  const expected = operation.kind === 'original'
    ? new File(Paths.document, 'videos', `${encodeURIComponent(operation.projectId)}.mp4`)
    : pickupFile(operation.projectId, operation.recordingId!);
  if (operation.destinationUri !== expected.uri) throw new Error('The save journal file does not belong to this project.');
  if (operation.kind === 'original' && (!operation.project || normalizeProject(operation.project).id !== operation.projectId)) throw new Error('The save journal project is unreadable.');
  if (operation.kind === 'pickup' && (!operation.recordingId || !operation.input)) throw new Error('The pickup journal is unreadable.');
}

function isCacheFile(uri: string): boolean {
  return isWithinFileRoots(uri, [Paths.cache.uri]);
}


/** Recovery must not replay capture metadata over a newer durable editor snapshot. */
function mergeOriginalJournal(current: Project, captured: Project, recovering: boolean): Project {
  if (recovering && current.videoUri === captured.videoUri) return current;
  if (current.v15 && canonicalJson(current.v15) !== canonicalJson(captured.v15 ?? null)) {
    return { ...current, videoUri: captured.videoUri };
  }
  return preserveNewRecordings(current, captured);
}

let durableRepository: ReturnType<typeof createDurablePersistence> | undefined;
let durableStartup: Promise<void> | undefined;
async function durableStore() {
  const d = await getDb();
  if (!durableRepository) durableRepository = createDurablePersistence(d, {
    assertDurableSource: async (project, sourceId, tx) => {
      const source = (project.v15 ?? createFoundation(project)).sources.find(source => source.id === sourceId);
      if (!source) throw new Error('The analysis source is unknown.');
      const uri = sourceId === project.id ? project.videoUri : project.recordings?.find(recording => recording.id === sourceId)?.mediaUri;
      if (!uri || !isWithinFileRoots(uri, [Paths.document.uri])) throw new Error('Save the original before starting analysis.');
      const file = new File(uri);
      if (!file.exists || file.size <= 0) throw new Error('The saved original is missing or empty. Your last edit is preserved.');
      const registered = await tx.getFirstAsync('SELECT uri FROM project_files WHERE project_id = ? AND uri = ?', project.id, uri);
      // Older projects predate file registration. Register their known canonical original only.
      if (!registered) {
        const canonical = sourceId === project.id ? new File(Paths.document, 'videos', `${encodeURIComponent(project.id)}.mp4`) : pickupFile(project.id, sourceId);
        if (uri !== canonical.uri) throw new Error('This source must be saved through the recording journal first.');
        await tx.runAsync('INSERT OR IGNORE INTO project_files (project_id, uri) VALUES (?, ?)', project.id, uri);
      }
    },
  });
  if (!durableStartup) durableStartup = durableRepository.recover().catch(error => { durableStartup = undefined; throw error; });
  await durableStartup;
  return durableRepository;
}

export async function initializeDurableProject(projectId: string): Promise<Project> {
  return withProjectLock(projectId, async () => (await durableStore()).initialize(projectId));
}
export async function commitDurableProject(projectId: string, expected: RevisionVector, operationId: string, next: NonNullable<Project['v15']>): Promise<Project> {
  return withProjectLock(projectId, async () => (await durableStore()).commit(projectId, expected, operationId, next));
}
export async function checkpointProjectEvidence(projectId: string, records: EvidenceRecord[]): Promise<void> {
  return withProjectLock(projectId, async () => (await durableStore()).checkpoint(projectId, records));
}
export async function readProjectEvidence(projectId: string, after = 0, limit = 32, kind?: string) {
  return (await durableStore()).page(projectId, after, limit, kind);
}
export async function enqueueProjectAnalysis(request: AnalysisRequest) {
  return withProjectLock(request.projectId, async () => (await durableStore()).enqueue(request));
}
export async function startProjectAnalysis(projectId: string, jobId: string, attempt: number, lease: string) {
  return withProjectLock(projectId, async () => (await durableStore()).start(projectId, jobId, attempt, lease));
}
export async function finishProjectAnalysis(result: AnalysisResult, lease: string) {
  return withProjectLock(result.projectId, async () => (await durableStore()).finish(result, lease));
}
export async function cancelProjectAnalysis(projectId: string, jobId: string) {
  return withProjectLock(projectId, async () => (await durableStore()).cancel(projectId, jobId));
}
export async function retryProjectAnalysis(projectId: string, jobId: string, expectedAttempt: number) {
  return withProjectLock(projectId, async () => (await durableStore()).retry(projectId, jobId, expectedAttempt));
}
export async function listProjectAnalysisJobs(projectId: string) { return (await durableStore()).jobs(projectId); }

/** B authors commands and history; this adapter commits their snapshot against the whole scope. */
export async function commitTimeline(projectId: string, expected: RevisionVector, operationId: string,
  edit: Pick<NonNullable<Project['v15']>, 'timeline' | 'history' | 'reasons'>): Promise<Project> {
  const project = await getProject(projectId);
  if (!project?.v15) throw new Error('Initialize the durable project before editing its timeline.');
  return commitDurableAdapter(projectId, expected, operationId, { ...project.v15, ...edit,
    revisions: { ...expected, projectRevision: expected.projectRevision + 1, timelineRevision: expected.timelineRevision + 1 } }, { kind: 'timeline', edit });
}

/** C can change preferences without replacing recognition evidence or timeline state. */
export async function commitProjectCaptions(projectId: string, expected: RevisionVector, operationId: string,
  captions: NonNullable<Project['v15']>['captions'],
  corrections: NonNullable<Project['v15']>['captionCorrections'] = []): Promise<Project> {
  const project = await getProject(projectId);
  if (!project?.v15) throw new Error('Initialize the durable project before changing captions.');
  return commitDurableAdapter(projectId, expected, operationId, { ...project.v15, captions,
    captionCorrections: [...project.v15.captionCorrections, ...corrections],
    revisions: { ...expected, projectRevision: expected.projectRevision + 1, captionRevision: expected.captionRevision + 1 } }, { kind: 'captions', captions, corrections });
}


/** The typed observation boundary validates source-local timing before writing a complete page. */
export async function checkpointProjectObservations(projectId: string, observations: Observation[]): Promise<void> {
  return withProjectLock(projectId, async () => {
    const project = await readStoredProject(projectId);
    const state = project.v15 ?? createFoundation(project);
    validateFoundation({ ...state, observations }, project);
    await (await durableStore()).checkpoint(projectId, observations.map(observation => ({
      id: observation.id, kind: 'observation', sourceId: observation.sourceId, payload: observation,
    })));
  });
}

/** Register a completed optional asset, never a partial file, before publishing its reference. */
export async function registerDurableProjectAsset(projectId: string, expected: RevisionVector, operationId: string, asset: AssetReference): Promise<Project> {
  if (!asset.registeredUri || asset.availability !== 'available') throw new Error('Finish the asset write before registering its reference.');
  const file = new File(asset.registeredUri);
  if (!isPrivateFile(file.uri) || !file.exists || file.size <= 0 || asset.byteSize !== file.size) throw new Error('The optional asset is missing or incomplete. The previous edit is preserved.');
  await registerProjectFile(projectId, file.uri);
  const project = await getProject(projectId);
  if (!project?.v15) throw new Error('Initialize the durable project before attaching optional assets.');
  return commitDurableAdapter(projectId, expected, operationId, { ...project.v15,
    assets: [...project.v15.assets, asset], revisions: { ...expected, projectRevision: expected.projectRevision + 1 } }, { kind: 'asset', asset });
}


function assertSameRecordingOperation(previous: RecordingOperation, next: RecordingOperation): void {
  const intent = ({ phase: _phase, expectedSize: _size, createdAt: _created, ...payload }: RecordingOperation) => payload;
  if (canonicalJson(intent(previous)) !== canonicalJson(intent(next)) || (previous.expectedSize > 0 && next.expectedSize > 0 && previous.expectedSize !== next.expectedSize)) {
    throw new Error('This recording save identity already has a different payload. Reopen Projects to recover the original save.');
  }
}
async function assertOriginalSize(projectId: string, file: File): Promise<void> {
  const d = await getDb();
  const receipt = await d.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', `recording-size:original:${projectId}`);
  if (file.size <= 0 || (receipt && Number(receipt.value) !== file.size)) throw new Error('The saved original is incomplete. Its source and last edit have been preserved.');
}
export async function readProjectEvidenceRecord(projectId: string, id: string) {
  return (await durableStore()).record(projectId, id);
}


/** Allocate via beginRecording/beginProjectPickup first; metadata cannot invent a media file. */
export async function checkpointProjectSource(projectId: string, operationId: string, source: SourceRecord): Promise<Project> {
  return withProjectLock(projectId, async () => (await durableStore()).checkpointSource(projectId, operationId, source));
}


async function commitDurableAdapter(projectId: string, expected: RevisionVector, operationId: string,
  next: NonNullable<Project['v15']>, intent: unknown): Promise<Project> {
  return withProjectLock(projectId, async () => (await durableStore()).commit(projectId, expected, operationId, next, intent));
}


/** A moved canonical file is not committed while its original journal is pending. */
async function recoverPendingOriginal(project: Project): Promise<void> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ data: string }>('SELECT data FROM project_operations WHERE id = ?', `original:${project.id}`);
  if (!row) return;
  const operation = JSON.parse(row.data) as RecordingOperation;
  validateOperation(operation, `original:${project.id}`);
  if (project.videoUri && project.videoUri !== operation.sourceUri && project.videoUri !== operation.destinationUri) {
    throw new Error('This recording save identity already has a different payload. Recover the pending original first.');
  }
  assertSameRecordingOperation(operation, { ...operation, project: projectWithDurableOriginal(project, operation.destinationUri) });
  await saveRecordingOperation(operation, true);
}

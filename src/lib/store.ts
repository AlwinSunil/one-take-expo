import * as SQLite from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';

import { isWithinFileRoots, localFileIdentity, settleProjectCancellation } from './project-deletion';

import { projectReview, projectScriptLines, projectSegments } from './project-workflow';

import media from '../../modules/one-take-media';

import type { Project } from './session';
import { PENDING_PICKUP_MESSAGE, projectWithDurableOriginal, mergePickupRecording, normalizeProject, preserveNewRecordings, type PickupRecordingInput } from './project-data';

const deletedIds = new Set<string>();

let db: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb() {
  if (!db) {
    db = (async () => {
      const connection = await SQLite.openDatabaseAsync('onetake.db');
      await connection.execAsync(`
        PRAGMA busy_timeout = 5000;
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
    const destination = new File(Paths.document, 'videos', `${encodeURIComponent(p.id)}.mp4`);
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
    catch { return { id: r.id, mode: 'assisted' as const, videoUri: null, clips: [], transcript: [], createdAt: 0, recoveryMessage: 'This project has unreadable metadata. Its original files have not been deleted.' }; }
  });
}

export async function getProject(id: string): Promise<Project | null> {
  await recoverProjectSaves();
  const d = await getDb();
  const row = await d.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', id);
  if (!row) return null;
  const project = checkMedia(normalizeProject(JSON.parse(row.data)));
  const message = (await pendingRecoveryMessages()).get(id);
  return message ? { ...project, recoveryMessage: message } : project;
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
  return withProjectLock(project.id, () => writeProjectMetadata(project));
}

async function writeProjectMetadata(project: Project): Promise<void> {
  const d = await getDb();
  await assertProjectAvailable(d, project.id);
  project = preserveNewRecordings(await readStoredProject(project.id), project);
  const preserved = new File(Paths.document, 'videos', `${encodeURIComponent(project.id)}.mp4`);
  const metadata = preserved.exists ? { ...project, videoUri: preserved.uri } : project;
  const result = await d.runAsync('UPDATE projects SET data = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)', JSON.stringify(metadata), project.id, project.id);
  if (result.changes !== 1) throw new Error('This project is no longer available to update.');
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
      await d.runAsync('DELETE FROM kv WHERE key IN (?, ?)', `export:${id}`, `exports:${id}`);
      const pickupKeys = await d.getAllAsync<{ key: string }>('SELECT key FROM kv');
      for (const row of pickupKeys) if (row.key.startsWith(`pickup:${encodeURIComponent(id)}:`)) await d.runAsync('DELETE FROM kv WHERE key = ?', row.key);
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
  const result = await d.runAsync('INSERT OR REPLACE INTO project_operations (id, project_id, data) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)',
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
    const directory = new Directory(Paths.document, 'videos');
    directory.create({ idempotent: true, intermediates: true });
    const source = new File(operation.sourceUri);
    const destination = new File(operation.destinationUri);
    const temporary = new File(`${operation.destinationUri}.part`);
    if (!destination.exists) {
      if (!(recoveringCopy && operation.phase === 'ready' && temporary.exists && temporary.size === operation.expectedSize)) {
        if (!source.exists || source.size <= 0) throw new Error('The recording file is missing.');
        if (Paths.availableDiskSpace < source.size + 10 * 1024 * 1024) throw new Error('Not enough storage to save this recording. Free some space and retry.');
        operation.expectedSize = source.size;
        operation.phase = 'copying';
        await writeOperation(operation);
        await registerProjectFile(operation.projectId, destination.uri);
        await registerProjectFile(operation.projectId, temporary.uri);
        if (isCacheFile(source.uri)) await registerProjectFile(operation.projectId, source.uri);
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
    if (!recoveringCopy) {
      operation.expectedSize = destination.size;
      operation.phase = 'ready';
      await writeOperation(operation);
    }
    const previous = await d.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', operation.projectId);
    const saved = operation.kind === 'pickup'
      ? mergePickupRecording(await readStoredProject(operation.projectId), operation.recordingId!,
        { ...operation.input!, videoUri: destination.uri, takes: operation.input!.takes.map(take => ({ ...take, mediaUri: destination.uri })) }, operation.createdAt)
      : previous ? preserveNewRecordings(normalizeProject(JSON.parse(previous.data)), operation.project!) : operation.project!;
    await d.withTransactionAsync(async () => {
      const result = await d.runAsync('INSERT OR REPLACE INTO projects (id, data) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)', saved.id, JSON.stringify(saved), saved.id);
      if (result.changes !== 1) throw new Error('This project was deleted and cannot be saved.');
      await d.runAsync('DELETE FROM project_operations WHERE id = ?', operation.id);
      if (operation.recordingId) {
        const key = pickupKey(operation.projectId, operation.recordingId);
        if (operation.input?.evidenceStatus === 'pending') {
          const draft = await d.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
          if (draft) await d.runAsync('UPDATE kv SET value = ? WHERE key = ?', JSON.stringify({ ...JSON.parse(draft.value), checkpointSourceUri: operation.sourceUri }), key);
        } else await d.runAsync('DELETE FROM kv WHERE key = ?', key);
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
    if (existing && (existing.evidenceStatus !== 'pending' || input.evidenceStatus === 'pending')) return checkMedia(project);
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

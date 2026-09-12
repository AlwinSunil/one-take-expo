import * as SQLite from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';

import media from '../../modules/one-take-media';

import type { Project } from './session';
import { normalizeProject } from './project-data';

const deletedIds = new Set<string>();

let db: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb() {
  if (!db) {
    db = (async () => {
      const connection = await SQLite.openDatabaseAsync('onetake.db');
      await connection.execAsync(`
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
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

export async function saveProject(p: Project) {
  let cancelled = false;
  let finish!: () => void;
  const settled = new Promise<void>(resolve => { finish = resolve; });
  const unregister = registerProjectWork(p.id, async () => {
    cancelled = true;
    // Deletion cannot remove an in-flight copy or let its completion recreate a file.
    await settled;
  });
  try {
    const d = await getDb();
    await assertProjectAvailable(d, p.id);
    if (!p.videoUri) throw new Error('No recording is available to save.');
    const directory = new Directory(Paths.document, 'videos');
    directory.create({ idempotent: true, intermediates: true });
    const source = new File(p.videoUri);
    const destination = new File(directory, `${encodeURIComponent(p.id)}.mp4`);
    if (!destination.exists) {
      if (!source.exists) throw new Error('The recording file is missing.');
      if (Paths.availableDiskSpace < source.size + 10 * 1024 * 1024) throw new Error('Not enough storage to save this recording. Free some space and retry.');
      const temporary = new File(directory, `${encodeURIComponent(p.id)}.part`);
      if (temporary.exists) temporary.delete();
      await source.copy(temporary);
      if (cancelled) throw new Error('This project is being deleted.');
      await temporary.move(destination);
    }
    const saved = { ...p, takes: p.takes?.map(take => take.mediaUri === p.videoUri ? { ...take, mediaUri: destination.uri } : take), recordingStatus: 'complete' as const, recoveryMessage: undefined, videoUri: destination.uri };
    await assertProjectAvailable(d, p.id);
    const result = await d.runAsync('INSERT OR REPLACE INTO projects (id, data) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_projects WHERE id = ?)', p.id, JSON.stringify(saved), p.id);
    if (result.changes !== 1) throw new Error('This project was deleted and cannot be saved.');
    return saved;
  } finally {
    finish();
    unregister();
  }
}

export async function listProjects(): Promise<Project[]> {
  const d = await getDb();
  const rows = await d.getAllAsync<{ id: string; data: string }>('SELECT id, data FROM projects ORDER BY rowid DESC');
  const pending = new Set((await d.getAllAsync<{ id: string }>('SELECT id FROM deleted_projects')).map(row => row.id));
  return rows.map((r) => {
    try {
      const project = checkMedia(normalizeProject(JSON.parse(r.data)));
      return pending.has(r.id) ? { ...project, recoveryMessage: 'Deletion did not finish. Retry Delete project to remove the remaining app files.' } : project;
    }
    catch { return { id: r.id, mode: 'assisted' as const, videoUri: null, clips: [], transcript: [], createdAt: 0, recoveryMessage: 'This project has unreadable metadata. Its original files have not been deleted.' }; }
  });
}

export async function getProject(id: string): Promise<Project | null> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', id);
  return row ? checkMedia(normalizeProject(JSON.parse(row.data))) : null;
}

function checkMedia(project: Project): Project {
  const original = new File(Paths.document, 'videos', `${encodeURIComponent(project.id)}.mp4`);
  if (original.exists) project = { ...project, videoUri: original.uri };
  const missing = !project.videoUri || !new File(project.videoUri).exists;
  const unavailableTakeIds = project.takes?.filter(take => !take.mediaUri || !new File(take.mediaUri).exists).map(take => take.id) ?? [];
  const unavailable = unavailableTakeIds.length;
  return { ...project, unavailableTakeIds, mediaMissing: missing, recoveryMessage: unavailable ? `${unavailable} takes are unavailable for coverage. Your saved text and edits remain; record replacement takes.` : missing ? 'The recording file is missing. Its transcript and edits are still saved.' : project.recoveryMessage };
}

export async function saveProjectMetadata(project: Project): Promise<void> {
  const d = await getDb();
  await assertProjectAvailable(d, project.id);
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
  try {
    const normalized = new URL(uri).href;
    return [Paths.document.uri, Paths.cache.uri].some(root => normalized.startsWith(root.endsWith('/') ? root : `${root}/`));
  } catch { return false; }
}

export async function deleteProject(id: string): Promise<void> {
  if (deleting.has(id)) throw new Error('Deletion is already in progress.');
  deleting.add(id);
  deletedIds.add(id);
  try {
    const d = await getDb();
    // A durable tombstone prevents late saves and survives interrupted deletion.
    await d.runAsync('INSERT OR IGNORE INTO deleted_projects (id) VALUES (?)', id);
    await Promise.all(Array.from(activeWork.get(id) ?? [], cancel => cancel()));
    const latest = await getSetting(`export:${id}`);
    const history = JSON.parse(await getSetting(`exports:${id}`, '[]')) as string[];
    const exports = new Set([...history, ...(latest ? [latest] : [])]);
    if (exports.size && !media) throw new Error('Reopen this project in the Android app to remove its exports, then retry deletion.');
    for (const exportId of exports) await media!.deleteExport(exportId);
    const row = await d.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', id);
    const registered = await d.getAllAsync<{ uri: string }>('SELECT uri FROM project_files WHERE project_id = ?', id);
    const original = new File(Paths.document, 'videos', `${encodeURIComponent(id)}.mp4`);
    const temporary = new File(Paths.document, 'videos', `${encodeURIComponent(id)}.part`);
    const uris = new Set([original.uri, temporary.uri, ...registered.map(file => file.uri)]);
    try {
      const p = row ? JSON.parse(row.data) : null;
      if (typeof p?.videoUri === 'string') uris.add(p.videoUri);
      for (const take of p?.takes ?? []) if (typeof take.mediaUri === 'string') uris.add(take.mediaUri);
    } catch { /* Canonical paths still allow removal of corrupt projects. */ }
    const shared = await d.getAllAsync<{ uri: string }>('SELECT uri FROM project_files WHERE project_id != ?', id);
    const sharedUris = new Set(shared.map(file => file.uri));
    const others = await d.getAllAsync<{ id: string; data: string }>('SELECT id, data FROM projects WHERE id != ?', id);
    for (const other of others) {
      sharedUris.add(new File(Paths.document, 'videos', `${encodeURIComponent(other.id)}.mp4`).uri);
      try { const p = JSON.parse(other.data); if (typeof p.videoUri === 'string') sharedUris.add(p.videoUri); for (const take of p.takes ?? []) if (typeof take.mediaUri === 'string') sharedUris.add(take.mediaUri); } catch { /* Unreadable projects retain their canonical originals. */ }
    }
    let failed = false;
    for (const uri of uris) {
      if (!isPrivateFile(uri) || sharedUris.has(uri)) continue;
      try { const file = new File(uri); if (file.exists) file.delete(); } catch { failed = true; }
    }
    if (failed) throw new Error('Some app files could not be removed. Keep this project and retry deletion. Shared copies are unchanged.');
    let videoUri: string | undefined;
    try { videoUri = row ? JSON.parse(row.data).videoUri : undefined; } catch { /* The canonical original is still removed for corrupt metadata. */ }
    await d.withTransactionAsync(async () => {
      await d.runAsync('DELETE FROM kv WHERE key = ? AND (value = ? OR value = ?)', 'last_video_uri', original.uri, videoUri ?? original.uri);
      await d.runAsync('DELETE FROM kv WHERE key = ?', `project_draft:${id}`);
      await d.runAsync('DELETE FROM kv WHERE key IN (?, ?)', `export:${id}`, `exports:${id}`);
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

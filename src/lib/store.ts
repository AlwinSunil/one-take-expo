import * as SQLite from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';

import type { Project } from './session';
import { normalizeProject } from './project-data';

let db: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb() {
  if (!db) {
    db = (async () => {
      const connection = await SQLite.openDatabaseAsync('onetake.db');
      await connection.execAsync(`
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      `);
      return connection;
    })().catch(error => { db = null; throw error; });
  }
  return db;
}

export async function saveProject(p: Project) {
  const d = await getDb();
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
    await temporary.move(destination);
  }
  const saved = { ...p, videoUri: destination.uri };
  await d.runAsync('INSERT OR REPLACE INTO projects (id, data) VALUES (?, ?)', p.id, JSON.stringify(saved));
  return saved;
}

export async function listProjects(): Promise<Project[]> {
  const d = await getDb();
  const rows = await d.getAllAsync<{ id: string; data: string }>('SELECT id, data FROM projects ORDER BY rowid DESC');
  return rows.map((r) => {
    try { return checkMedia(normalizeProject(JSON.parse(r.data))); }
    catch { return { id: r.id, mode: 'assisted' as const, videoUri: null, clips: [], transcript: [], createdAt: 0, recoveryMessage: 'This project has unreadable metadata. Its original files have not been deleted.' }; }
  });
}

export async function getProject(id: string): Promise<Project | null> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', id);
  return row ? checkMedia(normalizeProject(JSON.parse(row.data))) : null;
}

function checkMedia(project: Project): Project {
  const missing = !project.videoUri || !new File(project.videoUri).exists;
  return { ...project, mediaMissing: missing, recoveryMessage: missing ? 'The recording file is missing. Its transcript and edits are still saved.' : project.recoveryMessage };
}

export async function saveProjectMetadata(project: Project): Promise<void> {
  const d = await getDb();
  const preserved = new File(Paths.document, 'videos', `${encodeURIComponent(project.id)}.mp4`);
  const metadata = preserved.exists ? { ...project, videoUri: preserved.uri } : project;
  const result = await d.runAsync('UPDATE projects SET data = ? WHERE id = ?', JSON.stringify(metadata), project.id);
  if (result.changes !== 1) throw new Error('This project is no longer available to update.');
}

export async function beginRecording(project: Project): Promise<void> {
  const d = await getDb();
  await d.runAsync('INSERT INTO projects (id, data) VALUES (?, ?)', project.id,
    JSON.stringify({ ...project, recordingStatus: 'interrupted', recoveryMessage: 'Recording did not finish. Any usable original remains on this device.' }));
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

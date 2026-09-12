import * as SQLite from 'expo-sqlite';

import type { Project } from './session';

let db: SQLite.SQLiteDatabase | null = null;

async function getDb() {
  if (!db) {
    db = await SQLite.openDatabaseAsync('onetake.db');
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);`
    );
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`
    );
  }
  return db;
}

export async function saveProject(p: Project) {
  const d = await getDb();
  await d.runAsync('INSERT OR REPLACE INTO projects (id, data) VALUES (?, ?)', p.id, JSON.stringify(p));
}

export async function listProjects(): Promise<Project[]> {
  const d = await getDb();
  const rows = await d.getAllAsync<{ data: string }>('SELECT data FROM projects ORDER BY rowid DESC');
  return rows.map((r) => JSON.parse(r.data) as Project);
}

export async function getProject(id: string): Promise<Project | null> {
  const d = await getDb();
  const row = await d.getFirstAsync<{ data: string }>('SELECT data FROM projects WHERE id = ?', id);
  return row ? (JSON.parse(row.data) as Project) : null;
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

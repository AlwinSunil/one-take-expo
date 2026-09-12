import * as SQLite from 'expo-sqlite';

import type { Project } from './session';

let db: SQLite.SQLiteDatabase | null = null;

async function getDb() {
  if (!db) {
    db = await SQLite.openDatabaseAsync('onetake.db');
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);`
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

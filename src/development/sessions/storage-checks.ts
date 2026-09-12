import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import { getDraft, getProject, listProjects, saveProject } from '@/lib/store';
import type { Project } from '@/lib/session';

export async function runStorageChecks(): Promise<{ name: string; passed: boolean; error?: string }[]> {
  const results: { name: string; passed: boolean; error?: string }[] = [];
  const source = new File(new Directory(Paths.document, 'research'), 'media-sample.mp4');
  if (!source.exists) return [{ name: 'Stage the dedicated media research fixture before storage checks', passed: false }];
  const prefix = `research-regression-${Date.now()}`;
  const ids = [`${prefix}-a`, `${prefix}-b`, `${prefix}-failed`];
  const savedFiles: string[] = [];
  const draft = await getDraft();
  const record = (name: string, passed: boolean) => results.push({ name, passed });
  try {
    const first: Project = { id: ids[0], mode: 'script', script: 'A dedicated regression fixture.', videoUri: source.uri, clips: [], transcript: [], createdAt: Date.now() };
    const saved = await saveProject(first);
    const file = new File(saved.videoUri!); savedFiles.push(file.uri);
    record('Legacy-shaped project saves a separate durable original', file.exists && file.size === source.size && file.uri !== source.uri);
    await saveProject({ ...saved, trim: { start: 1, end: 3 } });
    const reopened = await getProject(saved.id);
    record('Saved trim and script survive a fresh database read', reopened?.trim?.start === 1 && reopened.trim.end === 3 && reopened.script === first.script);
    const second = await saveProject({ ...first, id: ids[1] });
    savedFiles.push(second.videoUri!);
    record('Two projects retain separate original files', second.videoUri !== saved.videoUri && (await listProjects()).filter(p => ids.includes(p.id)).length === 2);
    const parked = new File(new Directory(Paths.document, 'research'), `${prefix}-parked.mp4`);
    const originalUri = file.uri;
    file.move(parked);
    try {
      record('Missing file does not erase persisted script or trim', (await getProject(saved.id))?.trim?.start === 1 && !new File(originalUri).exists);
    } finally { parked.move(new File(originalUri)); }
    let rejected = false;
    try { await saveProject({ ...first, id: ids[2], videoUri: new File(new Directory(Paths.document, 'research'), `${prefix}-absent.mp4`).uri }); }
    catch { rejected = true; }
    record('Missing-source save fails without adding a project', rejected && await getProject(ids[2]) === null);
    record('Failed save preserves both existing fixture originals', new File(saved.videoUri!).exists && new File(second.videoUri!).exists);
    record('Existing draft and source fixture stay unchanged', await getDraft() === draft && source.exists);
  } catch (error) { results.push({ name: 'Storage regression execution', passed: false, error: String(error) }); }
  finally {
    const db = await SQLite.openDatabaseAsync('onetake.db', { useNewConnection: true });
    try {
      for (const id of ids) await db.runAsync('DELETE FROM projects WHERE id = ?', id);
      for (const uri of savedFiles) { const fresh = new File(uri); if (fresh.exists) fresh.delete(); }
    } catch (error) { results.push({ name: 'Dedicated fixture cleanup', passed: false, error: String(error) }); }
    finally { await db.closeAsync(); }
  }
  return results;
}

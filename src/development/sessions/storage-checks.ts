import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import { beginProjectPickup, checkpointProjectPickup, completeProjectPickup, deleteProject, getDraft, getProject, listProjects, registerProjectFile, registerProjectWork, saveProject, saveProjectMetadata } from '@/lib/store';
import { projectReview, projectScriptLines } from '@/lib/project-workflow';
import type { Project } from '@/lib/session';

export async function runStorageChecks(): Promise<{ name: string; passed: boolean; error?: string }[]> {
  const results: { name: string; passed: boolean; error?: string }[] = [];
  const source = new File(new Directory(Paths.document, 'research'), 'media-sample.mp4');
  if (!source.exists) return [{ name: 'Stage the dedicated media research fixture before storage checks', passed: false }];
  const prefix = `research-regression-${Date.now()}`;
  const ids = [`${prefix}-a`, `${prefix}-b`, `${prefix}-failed`, `${prefix}-concurrent`, `${prefix}-recovery`];
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
    await file.move(parked);
    try {
      record('Missing file does not erase persisted script or trim', (await getProject(saved.id))?.trim?.start === 1 && !new File(originalUri).exists);
    } finally { await new File(new Directory(Paths.document, 'research'), `${prefix}-parked.mp4`).move(new File(originalUri)); }
    let rejected = false;
    try { await saveProject({ ...first, id: ids[2], videoUri: new File(new Directory(Paths.document, 'research'), `${prefix}-absent.mp4`).uri }); }
    catch { rejected = true; }
    record('Missing-source save fails without adding a project', rejected && await getProject(ids[2]) === null);
    record('Failed save preserves both existing fixture originals', new File(saved.videoUri!).exists && new File(second.videoUri!).exists);
    record('Existing draft and source fixture stay unchanged', await getDraft() === draft && source.exists);
    const transcript = [{ id: `${prefix}:speech`, t0: 1, t1: 3, text: first.script!, isFinal: true }];
    await saveProjectMetadata({ ...saved, transcript, takes: [{ id: `${prefix}:take`, t0: 0.5, t1: 3.5,
      mediaUri: saved.videoUri, playable: true, quality: 'clean', inFrame: true, transcriptSegmentIds: [transcript[0].id] }] });
    const withTake = await getProject(saved.id);
    record('Persisted take retains its original audio boundaries after reopen', withTake?.takes?.[0].t0 === 0.5 && withTake.takes[0].t1 === 3.5);
    await new File(originalUri).move(new File(new Directory(Paths.document, 'research'), `${prefix}-parked.mp4`));
    try {
      const missing = await getProject(saved.id);
      record('A missing take cannot establish coverage', !!missing && projectReview(missing).lines.every(line => line.status !== 'covered'));
    } finally { await new File(new Directory(Paths.document, 'research'), `${prefix}-parked.mp4`).move(new File(originalUri)); }
    const pickupId = `${prefix}:pickup`;
    await beginProjectPickup(saved.id, pickupId, projectScriptLines(saved).map(line => line.id));
    const pickupInput = { videoUri: source.uri, duration: 12, transcript,
      takes: [{ id: 'pickup-take', t0: 0.5, t1: 3.5, mediaUri: source.uri, playable: true, quality: 'clean' as const, inFrame: true, transcriptSegmentIds: [transcript[0].id] }] };
    const merged = await completeProjectPickup(saved.id, pickupId, pickupInput);
    const pickupUri = merged.recordings?.find(recording => recording.id === pickupId)?.mediaUri;
    if (pickupUri) savedFiles.push(pickupUri);
    record('Pickup merge preserves the original and copies independent pickup media', merged.videoUri === originalUri
      && !!pickupUri && pickupUri !== originalUri && new File(pickupUri).exists && merged.transcript.length === 2);
    const repeated = await completeProjectPickup(saved.id, pickupId, pickupInput);
    record('Repeated pickup completion is idempotent after reopen', repeated.transcript.length === 2 && repeated.takes?.length === 2);
    const checkpointId = `${prefix}:checkpoint`;
    await beginProjectPickup(saved.id, checkpointId, projectScriptLines(saved).map(line => line.id));
    const checkpoint = await checkpointProjectPickup(saved.id, checkpointId, { videoUri: source.uri, duration: 12 });
    const checkpointUri = checkpoint.recordings?.find(recording => recording.id === checkpointId)?.mediaUri;
    if (checkpointUri) savedFiles.push(checkpointUri);
    const checkpointReopened = await getProject(saved.id);
    record('Raw pickup checkpoint reopens durably without inventing caption evidence', !!checkpointUri
      && new File(checkpointUri).exists && new File(checkpointUri).size === source.size
      && checkpointReopened?.recordings?.find(recording => recording.id === checkpointId)?.evidenceStatus === 'pending'
      && checkpointReopened.transcript.length === repeated.transcript.length
      && checkpointReopened.takes?.length === repeated.takes?.length);
    const finalized = await completeProjectPickup(saved.id, checkpointId, pickupInput);
    const finalizeRetry = await completeProjectPickup(saved.id, checkpointId, pickupInput);
    record('Final evidence upgrades the same checkpoint once and preserves its source', finalized.recordings?.find(recording => recording.id === checkpointId)?.mediaUri === checkpointUri
      && finalized.recordings?.find(recording => recording.id === checkpointId)?.evidenceStatus === 'complete'
      && finalized.recordings.length === checkpoint.recordings?.length
      && finalized.transcript.length === repeated.transcript.length + 1
      && finalizeRetry.transcript.length === finalized.transcript.length);
    await saveProjectMetadata({ ...checkpoint, trim: { start: 1, end: 3 } });
    const afterStaleSave = await getProject(saved.id);
    record('An editor holding the pending checkpoint cannot erase finalized evidence', afterStaleSave?.recordings?.find(recording => recording.id === checkpointId)?.evidenceStatus === 'complete'
      && afterStaleSave.transcript.length === finalized.transcript.length
      && afterStaleSave.takes?.length === finalized.takes?.length
      && !afterStaleSave.recoveryMessage?.includes('captions and coverage did not finish'));
    const attachment = new File(Paths.document, 'videos', `${prefix}-attachment.txt`);
    attachment.write('Dedicated deletion fixture');
    savedFiles.push(attachment.uri);
    await registerProjectFile(saved.id, attachment.uri);
    let cancelled = false;
    const unregister = registerProjectWork(saved.id, async () => { cancelled = true; throw new Error('Dedicated cancellation failure'); });
    let deletionRejected = false;
    try { await deleteProject(saved.id); } catch { deletionRejected = true; }
    unregister();
    record('Failed job cancellation retains the project and original for retry', deletionRejected && cancelled && !!(await getProject(saved.id)) && new File(originalUri).exists);
    let lateSaveRejected = false;
    try { await saveProject(saved); } catch { lateSaveRejected = true; }
    record('Deletion tombstone rejects a late background save', lateSaveRejected);
    await deleteProject(saved.id);
    record('Deletion retry removes project original and registered app files', await getProject(saved.id) === null && !new File(originalUri).exists && !attachment.exists);
    record('Deleting one project preserves the other project and fixture source', !!(await getProject(second.id)) && new File(second.videoUri!).exists && source.exists);
    const concurrentSave = saveProject({ ...first, id: ids[3] }).then(() => true, () => false);
    await deleteProject(ids[3]);
    await concurrentSave;
    record('Deletion waits for concurrent save and leaves no recreated media', await getProject(ids[3]) === null
      && !new File(Paths.document, 'videos', `${encodeURIComponent(ids[3])}.mp4`).exists
      && !new File(Paths.document, 'videos', `${encodeURIComponent(ids[3])}.part`).exists
      && !new File(Paths.document, 'videos', `${encodeURIComponent(ids[3])}.mp4.part`).exists);
    const recoveryFile = new File(Paths.document, 'videos', `${ids[4]}.mp4`);
    savedFiles.push(recoveryFile.uri);
    const connection = await SQLite.openDatabaseAsync('onetake.db', { useNewConnection: true });
    try {
      await connection.runAsync('INSERT INTO project_operations (id, project_id, data) VALUES (?, ?, ?)', `original:${ids[4]}`, ids[4],
        JSON.stringify({ id: `original:${ids[4]}`, projectId: ids[4], kind: 'original', sourceUri: source.uri,
          destinationUri: recoveryFile.uri, expectedSize: source.size, phase: 'copying', createdAt: Date.now(),
          project: { ...first, id: ids[4], videoUri: recoveryFile.uri } }));
    } finally { await connection.closeAsync(); }
    record('Reopen replays an interrupted copy journal without losing the source', (await getProject(ids[4]))?.videoUri === recoveryFile.uri && recoveryFile.exists && source.exists);
  } catch (error) { results.push({ name: 'Storage regression execution', passed: false, error: String(error) }); }
  finally {
    const db = await SQLite.openDatabaseAsync('onetake.db', { useNewConnection: true });
    try {
      for (const id of ids) await db.runAsync('DELETE FROM projects WHERE id = ?', id);
      for (const id of ids) await db.runAsync('DELETE FROM project_files WHERE project_id = ?', id);
      for (const id of ids) await db.runAsync('DELETE FROM deleted_projects WHERE id = ?', id);
      for (const id of ids) await db.runAsync('DELETE FROM project_operations WHERE project_id = ?', id);
      for (const id of ids) await db.runAsync('DELETE FROM deletion_options WHERE project_id = ?', id);
      for (const row of await db.getAllAsync<{ key: string }>('SELECT key FROM kv')) {
        if (ids.some(id => row.key.startsWith(`pickup:${encodeURIComponent(id)}:`))) await db.runAsync('DELETE FROM kv WHERE key = ?', row.key);
      }
      for (const uri of savedFiles) { const fresh = new File(uri); if (fresh.exists) fresh.delete(); }
    } catch (error) { results.push({ name: 'Dedicated fixture cleanup', passed: false, error: String(error) }); }
    finally { await db.closeAsync(); }
  }
  return results;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFoundation, validateFoundation } from '../src/lib/t15-schema.ts';
import { preserveDurableLegacyEdit } from '../src/lib/t15-legacy.ts';
import { mergePickupRecording } from '../src/lib/project-data.ts';
const base = { id: 'p', mode: 'script', script: 'Hello.', videoUri: 'file:///original.mp4', duration: 8, createdAt: 1, clips: [], transcript: [{ id: 'speech', t0: 0, t1: 2, text: 'Hello.', rawText: 'Hello.', isFinal: true }] };
const current = () => ({ ...structuredClone(base), v15: createFoundation(base) });
test('legacy trim invalidates analysis while retaining the current canonical sequence', () => {
  const p = current();
  const next = preserveDurableLegacyEdit(p, { ...p, trim: { start: 1, end: 5 } });
  assert.equal(next.v15.revisions.projectRevision, 1);
  assert.equal(next.v15.revisions.timelineRevision, 1);
  assert.deepEqual(next.v15.timeline.clips, p.v15.timeline.clips);
  validateFoundation(next.v15, next);
});
test('legacy caption correction does not overwrite recognized speech or remove revision history', () => {
  const p = current();
  const next = preserveDurableLegacyEdit(p, { ...p, transcript: [{ ...p.transcript[0], text: 'Hi.', manualCorrection: 'Hi.' }] });
  assert.equal(next.v15.revisions.captionRevision, 1);
  assert.deepEqual(next.v15.transcriptRevisions, p.v15.transcriptRevisions);
  assert.equal(next.v15.revisions.transcriptRevision.p, p.v15.revisions.transcriptRevision.p);
  validateFoundation(next.v15, next);
});
test('new pickup sources and transcript history survive concurrent durable timeline state', () => {
  const p = current();
  const merged = mergePickupRecording(p, 'pickup', { videoUri: 'file:///pickup.mp4', duration: 3, transcript: [{ id: 'new', t0: 0, t1: 2, text: 'Hello.', isFinal: true }], takes: [] }, 2);
  const next = preserveDurableLegacyEdit(p, merged);
  assert.equal(next.v15.sources.length, 2);
  assert.deepEqual(next.v15.timeline.clips, p.v15.timeline.clips);
  assert.equal(next.v15.revisions.transcriptRevision.pickup, 1);
  assert.ok(next.v15.transcriptRevisions.some(row => row.sourceId === 'pickup'));
  validateFoundation(next.v15, next);
});
test('legacy script changes preserve the captured script snapshot', () => {
  const p = current();
  const next = preserveDurableLegacyEdit(p, { ...p, script: 'A new script.' });
  assert.equal(next.v15.scriptSnapshots.length, p.v15.scriptSnapshots.length + 1);
  assert.deepEqual(next.v15.scriptSnapshots[0], p.v15.scriptSnapshots[0]);
  validateFoundation(next.v15, next);
});

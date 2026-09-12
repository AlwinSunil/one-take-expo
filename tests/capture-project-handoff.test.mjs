import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCaptureDocument, requestedPickupLineIds, recordingTranscript, launchProjectPickup } from '../src/features/capture/project-handoff.ts';
import { deriveProjectCaptureCoverage } from '../src/features/capture/coverage.ts';
const p = { id: 'p', mode: 'script', videoUri: 'file:///raw.mp4', createdAt: 1, transcript: [], clips: [], scriptLines: [
  { id: 'saved-a', spokenText: 'Hello world.', actionCues: [{ id: 'cue-a', text: 'Smile', required: true, resolved: true }] },
  { id: 'saved-b', spokenText: 'Goodbye world.', actionCues: [] },
], pickupRequest: { lineIds: ['saved-b'], requestedAt: 1 } };
test('pickup script reconstructs persisted identities and cues independently of accepted draft', () => {
  const doc = projectCaptureDocument(p);
  assert.deepEqual(doc.lines.map(line => line.id), ['saved-a', 'saved-b']);
  assert.equal(doc.lines[0].actionCues[0].status, 'done');
  assert.deepEqual(requestedPickupLineIds(p), ['saved-b']);
});
test('capture coverage honors explicit choices and pickup eligibility', () => {
  const project = { ...p, transcript: [{ id: 's', t0: 0, t1: 2, text: 'Goodbye world.', isFinal: true }],
    takes: [{ id: 'wrong-scope', t0: 0, t1: 2, mediaUri: 'file:///raw.mp4', playable: true, quality: 'clean', inFrame: false, transcriptSegmentIds: ['s'], eligibleLineIds: ['saved-a'] }] };
  assert.equal(deriveProjectCaptureCoverage(projectCaptureDocument(project), project).spokenLines[1].status, 'needed');
});
test('audio start offset is removed and truncated boundary captions remain provisional', () => {
  const segments = [{ id: 'before', t0: 0, t1: 0.4, text: 'before', isFinal: true }, { id: 'inside', t0: 1, t1: 2, text: 'hello', isFinal: true }, { id: 'truncated', t0: 2, t1: 3, text: 'end', isFinal: true }];
  assert.deepEqual(recordingTranscript(segments, 1000, 1500, 2).map(s => [s.id, s.t0, s.t1, s.isFinal]), [['inside', 0.5, 1.5, true], ['truncated', 1.5, 2, false]]);
  assert.deepEqual(recordingTranscript(segments, null, 1500, 2), []);
});
test('launch waits for durable request and never navigates after failed persistence', async () => {
  const calls = [];
  assert.equal(await launchProjectPickup(p, async next => { calls.push(next.pickupRequest.lineIds); return false; }, () => calls.push('navigate')), false);
  assert.equal(calls.length, 1);
  await launchProjectPickup(p, async next => { calls.push('saved'); return true; }, route => calls.push(route.params));
  assert.deepEqual(calls.slice(-2), ['saved', { mode: 'script', script: '', pickupProjectId: 'p' }]);
});

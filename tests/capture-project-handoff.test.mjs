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

test('word timings follow the audio offset and discard truncated boundary words', () => {
  const result = recordingTranscript([{ id: 's', t0: 0.2, t1: 3, text: 'before hello end', words: [
    { text: 'before', t0: 0.2, t1: 0.6, confidence: 0.9 },
    { text: 'hello', t0: 1, t1: 2, confidence: 0.95 },
    { text: 'end', t0: 2.4, t1: 3, confidence: 0.8 },
  ] }], 1000, 1500, 2);
  assert.deepEqual(result[0].words, [{ text: 'hello', t0: 0.5, t1: 1.5, confidence: 0.95 }]);
  assert.equal(result[0].isFinal, false);
});

test('explicit pickup request can retake a line that is already covered', () => {
  const project = { ...p, pickupRequest: { lineIds: ['saved-b', 'unknown'], requestedAt: 1 },
    transcript: [{ id: 's', t0: 0, t1: 2, text: 'Goodbye world.', isFinal: true }],
    takes: [{ id: 'take', t0: 0, t1: 2, mediaUri: p.videoUri, playable: true, quality: 'clean', inFrame: false, transcriptSegmentIds: ['s'] }] };
  assert.deepEqual(requestedPickupLineIds(project), ['saved-b']);
});

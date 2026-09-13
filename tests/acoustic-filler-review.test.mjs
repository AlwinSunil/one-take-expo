import test from 'node:test';
import assert from 'node:assert/strict';
import { acousticFillerSources, normalizeAcousticFillerReviews, replaceAcousticFillerReview } from '../src/lib/acoustic-filler-review.ts';
import { normalizeProject } from '../src/lib/project-data.ts';
const project = { id: 'p', mode: 'assisted', videoUri: 'file:///original.mp4', duration: 10,
  createdAt: 1, transcript: [], clips: [], cuts: [{ t0: 1, t1: 8 }] };
const result = { schemaVersion: 1, status: 'ready', sourceId: 'p:original', analysisRevision: 1,
  model: { id: 'uhm', version: 'test' }, actualProcessor: 'cpu', durationSeconds: 10,
  events: [{ id: 'event', startSeconds: 1, endSeconds: 1.2, label: 'um', score: 0.8,
    timingUncertaintySeconds: null, timingResolutionSeconds: 0.02 }] };
const row = { sourceId: 'p:original', sourceUri: project.videoUri, revision: 1, status: 'ready', result, dismissedEventIds: ['event'] };

test('source identities distinguish original and pickup recordings', () => {
  assert.equal(acousticFillerSources(project)[0].id, 'p:original');
  assert.deepEqual(acousticFillerSources({ ...project, recordings: [
    { id: 'original', mediaUri: project.videoUri, duration: 10 },
    { id: 'pickup', mediaUri: 'file:///pickup.mp4', duration: 5 },
  ] }).map(source => source.id), ['original', 'pickup']);
});
test('review persists and reopens without changing cuts or transcript', () => {
  const changed = replaceAcousticFillerReview(project, row);
  const reopened = normalizeProject(JSON.parse(JSON.stringify(changed)));
  assert.deepEqual(reopened.acousticFillerReviews[0], row);
  assert.deepEqual(reopened.cuts, project.cuts);
  assert.deepEqual(reopened.transcript, []);
});
test('interrupted and cancelled jobs remain retryable without invented results', () => {
  for (const status of ['running', 'cancelled']) {
    const [loaded] = normalizeAcousticFillerReviews([{ ...row, status, result: undefined, dismissedEventIds: [] }], project);
    assert.equal(loaded.status, status === 'running' ? 'failed' : 'cancelled');
    assert.equal(loaded.result, undefined);
  }
});
test('replaced source and stale revisions cannot receive prior analysis', () => {
  assert.deepEqual(normalizeAcousticFillerReviews([row], { ...project, videoUri: 'file:///new.mp4' }), []);
  assert.throws(() => replaceAcousticFillerReview({ ...project, videoUri: 'file:///new.mp4' }, row), /recording changed/);
  assert.throws(() => replaceAcousticFillerReview({ ...project, acousticFillerReviews: [{ ...row, revision: 2 }] }, row), /newer analysis/);
  assert.throws(() => normalizeAcousticFillerReviews([{ ...row, result: { ...result, sourceId: 'pickup' } }], project));
  assert.throws(() => normalizeAcousticFillerReviews([{ ...row, result: { ...result, analysisRevision: 2 } }], project));
});
test('dismissals stay limited to validated events and missing ready results are rejected', () => {
  const [loaded] = normalizeAcousticFillerReviews([{ ...row, dismissedEventIds: ['unknown', 'event', 'event'] }], project);
  assert.deepEqual(loaded.dismissedEventIds, ['event']);
  assert.throws(() => normalizeAcousticFillerReviews([{ ...row, result: undefined }], project), /missing/);
});
test('metadata duration changes invalidate source snapshots without comparing decoded video duration', () => {
  const snapshot = { ...row, sourceDuration: 10 };
  assert.equal(normalizeAcousticFillerReviews([snapshot], project).length, 1);
  assert.deepEqual(normalizeAcousticFillerReviews([snapshot], { ...project, duration: 12 }), []);
  assert.throws(() => replaceAcousticFillerReview({ ...project, duration: 12 }, snapshot), /recording changed/);
});

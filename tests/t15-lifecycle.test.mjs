import test from 'node:test';
import assert from 'node:assert/strict';
import { projectLifecycle } from '../src/lib/t15-lifecycle.ts';
const project = { id: 'p', mode: 'assisted', videoUri: 'file:///original.mp4', transcript: [], clips: [], createdAt: 1 };
const job = { request: { id: 'job', attempt: 2 }, status: 'running', lease: 'lease' };
test('saved original remains accessible during analysis and no analysis is invented for legacy data', () => {
  assert.equal(projectLifecycle(project, [job]).canOpenEditor, true);
  assert.equal(projectLifecycle(project, [job]).phase, 'analyzing');
  assert.match(projectLifecycle(project).message, /not been collected/);
});
test('failure, cancellation, interrupted jobs expose a stable retry attempt without percentages', () => {
  for (const status of ['failed', 'partial', 'cancelled', 'retryable']) {
    const state = projectLifecycle(project, [{ ...job, status }]);
    assert.equal(state.canOpenEditor, true);
    assert.deepEqual(state.retryJob, { id: 'job', attempt: 2 });
    assert.doesNotMatch(state.message, /%/);
  }
});
test('missing media and pending pickup evidence remain partial rather than analysis success', () => {
  assert.equal(projectLifecycle({ ...project, mediaMissing: true }, [{ ...job, status: 'ready' }]).phase, 'partial');
  assert.equal(projectLifecycle({ ...project, recordings: [{ id: 'pickup', evidenceStatus: 'pending' }] }).phase, 'partial');
});

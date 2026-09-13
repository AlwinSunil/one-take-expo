import test from 'node:test';
import assert from 'node:assert/strict';
import { captureEvent, checkpointCaptureOriginal } from '../src/features/capture/stop-handoff.ts';
const scope = { projectId: 'project', sourceId: 'pickup', takeId: 'take', captureSessionId: 'capture:1', generation: 'binding:1' };

test('capture events preserve source identity and explicitly uncertain seconds', () => {
  const event = captureEvent(scope, 'stop-requested', 4000, 7250);
  assert.equal(event.relativeSeconds, 3.25);
  assert.equal(event.scope.sourceId, 'pickup');
  assert.equal(event.provenance.uncertaintySeconds, null);
  assert.equal(event.provenance.sourceZero, 'recordAsync-request');
  assert.throws(() => captureEvent(scope, 'stop-requested', 4000, 3999));
  assert.throws(() => captureEvent({ ...scope, sourceId: '' }, 'stop-requested', 0, 1));
});

test('slow original save never publishes durability or starts optional work early', async () => {
  const calls = [];
  let finish;
  const pending = checkpointCaptureOriginal(() => new Promise(resolve => { finish = resolve; }), saved => calls.push(saved.id));
  await Promise.resolve();
  assert.deepEqual(calls, []);
  finish({ id: 'durable-original' });
  const saved = await pending;
  assert.deepEqual(calls, [saved.id]);
});

test('save failure preserves retry and never emits original-saved; analysis failure cannot undo save', async () => {
  const calls = [];
  await assert.rejects(checkpointCaptureOriginal(async () => { throw new Error('low storage'); }, () => calls.push('durable')));
  assert.deepEqual(calls, []);
  const original = await checkpointCaptureOriginal(async () => ({ uri: 'file:///original' }), () => calls.push('durable'));
  await assert.rejects(Promise.reject(new Error('optional analysis unavailable')));
  assert.equal(original.uri, 'file:///original');
  assert.deepEqual(calls, ['durable']);
});

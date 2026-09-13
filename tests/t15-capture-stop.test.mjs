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

test('Stop payload rejects a foreign source or a save that has not completed', async () => {
  const { buildCaptureStopHandoff } = await import('../src/features/capture/stop-handoff.ts');
  const requested = captureEvent(scope, 'record-requested', 0, 0);
  const saved = captureEvent(scope, 'original-saved', 0, 4000);
  assert.throws(() => buildCaptureStopHandoff(scope, 3, [requested], null));
  assert.throws(() => buildCaptureStopHandoff({ ...scope, sourceId: 'other' }, 3, [saved], null));
  const result = buildCaptureStopHandoff(scope, 3, [requested, saved], null);
  assert.deepEqual(result.gaze, { status: 'not-collected' });
  assert.equal(result.metadataPersistence, 'pending-owner-integration');
  assert.equal(result.durationSeconds, 3);
  assert.equal(result.events[1].relativeSeconds, 4); // Lifecycle time may follow media end.
});

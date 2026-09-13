import test from 'node:test';
import assert from 'node:assert/strict';
import { startVisionBinding } from '../src/features/vision/binding.ts';

test('a queued native start settling after route exit receives a compensating stop', async () => {
  let resolve;
  let current = true;
  const stopped = [];
  const pending = startVisionBinding(() => new Promise(done => { resolve = done; }), () => current, async () => { stopped.push('old-binding'); });
  current = false; // Cleanup stop ran before native start was active.
  resolve({ status: 'started' });
  assert.equal(await pending, null);
  assert.deepEqual(stopped, ['old-binding']);
});

test('starting recording keeps its existing frame binding alive', async () => {
  const result = { status: 'started', sessionId: 'same-binding' };
  let stops = 0;
  assert.equal(await startVisionBinding(async () => result, () => true, async () => { stops++; }), result);
  assert.equal(stops, 0);
});

test('old binding cleanup failure cannot publish stale success or alter a newer binding', async () => {
  const stopped = [];
  assert.equal(await startVisionBinding(async () => ({ sessionId: 'old' }), () => false, async () => {
    stopped.push('old'); throw new Error('already detached');
  }), null);
  assert.deepEqual(stopped, ['old']);
});

test('a rejected partial native start is stopped even after its owner leaves', async () => {
  const stopped = [];
  await assert.rejects(startVisionBinding(async () => { throw new Error('partial bind rejected'); },
    () => false, async () => { stopped.push('old-binding'); }), /partial bind rejected/);
  assert.deepEqual(stopped, ['old-binding']);
});

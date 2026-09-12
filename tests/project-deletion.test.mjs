import test from 'node:test';
import assert from 'node:assert/strict';
import { isWithinFileRoots, localFileIdentity, settleProjectCancellation } from '../src/lib/project-deletion.ts';

const roots = ['file:///app/documents/', 'file:///app/cache/'];

test('native path aliases have one identity for shared-file protection', () => {
  assert.equal(localFileIdentity('file:///app/documents/clips/../a%20take.mp4'), localFileIdentity('file:///app/documents/a%20take.mp4'));
  assert.equal(localFileIdentity('file:///app/documents/clips%2Ftake.mp4'), localFileIdentity('file:///app/documents/clips/take.mp4'));
  assert.equal(localFileIdentity('file://localhost/app/documents/take.mp4'), localFileIdentity('file:///app/documents/take.mp4'));
});

test('encoded traversal cannot turn a private-file association into database deletion', () => {
  assert.equal(isWithinFileRoots('file:///app/documents/%2e%2e%2fdatabases/onetake.db', roots), false);
  assert.equal(isWithinFileRoots('file:///app/documents-other/take.mp4', roots), false);
  assert.equal(isWithinFileRoots('file:///app/documents/', roots), false);
  assert.equal(isWithinFileRoots('file:///app/cache/a%20take.mp4', roots), true);
  assert.equal(isWithinFileRoots('file:///app/documents/100%25.mp4', roots), true);
  assert.equal(isWithinFileRoots('content://media/take', roots), false);
});

test('failed cancellation still waits for all remaining writers to settle', async () => {
  let release;
  let finished = false;
  const writer = new Promise(resolve => { release = resolve; });
  const result = settleProjectCancellation([
    async () => { throw new Error('Camera refused cancellation'); },
    async () => { await writer; finished = true; },
  ]);
  let settled = false;
  const observed = result.catch(error => { settled = true; assert.match(error.message, /Camera refused/); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(finished, false);
  release();
  await observed;
  assert.equal(finished, true);
  assert.equal(settled, true);
});

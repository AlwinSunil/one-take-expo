import assert from 'node:assert/strict';
import test from 'node:test';
import { IDLE_CAPTION_STATUS, createCaptionStatusStore } from '../src/lib/caption-status-store.ts';
import { captionTimingReport, captionTimingState } from '../src/lib/caption-timing.ts';

const timing = captionTimingReport(captionTimingState());
const retry = async () => ({ ok: true });

const status = overrides => ({
  status: 'listening',
  reason: null,
  message: '',
  retryable: false,
  retry,
  timing,
  ...overrides,
});

test('a store starts idle and reports no retry path', async () => {
  const store = createCaptionStatusStore();
  assert.equal(store.getSnapshot(), IDLE_CAPTION_STATUS);
  assert.equal(store.getSnapshot().status, 'idle');
  assert.deepEqual(await store.getSnapshot().retry(), {
    ok: false,
    message: 'Live captions are not running.',
  });
});

test('publishing the same status keeps the snapshot and does not notify', () => {
  const store = createCaptionStatusStore();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  store.publish(status());
  const first = store.getSnapshot();
  store.publish(status());
  assert.equal(store.getSnapshot(), first);
  assert.equal(notifications, 1);
});

test('a changed reason or timing report replaces the snapshot', () => {
  const store = createCaptionStatusStore();
  store.publish(status());
  store.publish(status({ status: 'unavailable', reason: 'model-corrupt', retryable: true }));
  assert.equal(store.getSnapshot().reason, 'model-corrupt');

  const changed = captionTimingReport(captionTimingState());
  store.publish(status({ status: 'unavailable', reason: 'model-corrupt', retryable: true, timing: changed }));
  assert.equal(store.getSnapshot().timing, changed);
});

test('an unsubscribed listener stops hearing about changes', () => {
  const store = createCaptionStatusStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  store.publish(status());
  unsubscribe();
  store.publish(status({ status: 'stopped' }));
  assert.equal(notifications, 1);
  assert.equal(store.getSnapshot().status, 'stopped');
});

test('resetting returns the store to the idle status', () => {
  const store = createCaptionStatusStore();
  store.publish(status({ status: 'interrupted', reason: 'audio-route-changed', retryable: true }));
  store.reset();
  assert.equal(store.getSnapshot(), IDLE_CAPTION_STATUS);
});

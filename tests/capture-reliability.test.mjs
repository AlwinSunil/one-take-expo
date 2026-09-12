import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureFailureMessage,
  classifyCaptureFailure,
  describeCapturePermissions,
  inspectCaptureStorage,
  createStopLatch,
} from '../src/features/capture/reliability.ts';

function permission(overrides = {}) {
  return { granted: true, canAskAgain: true, status: 'granted', ...overrides };
}

test('permission guidance distinguishes loading, requestable, and settings recovery', () => {
  assert.equal(describeCapturePermissions(null, null).state, 'loading');

  const cameraDenied = describeCapturePermissions(
    permission({ granted: false, status: 'denied' }),
    permission(),
  );
  assert.equal(cameraDenied.state, 'requestable');
  assert.deepEqual(cameraDenied.missing, ['camera']);
  assert.equal(cameraDenied.action, 'request');
  assert.match(cameraDenied.message, /camera/i);

  const microphoneBlocked = describeCapturePermissions(
    permission(),
    permission({ granted: false, canAskAgain: false, status: 'denied' }),
  );
  assert.equal(microphoneBlocked.state, 'settings');
  assert.deepEqual(microphoneBlocked.missing, ['microphone']);
  assert.equal(microphoneBlocked.action, 'settings');
  assert.match(microphoneBlocked.message, /settings/i);

  assert.equal(describeCapturePermissions(permission(), permission()).state, 'ready');
});

test('storage preflight blocks exhaustion, warns before recording becomes risky, and tolerates unknown values', () => {
  assert.equal(inspectCaptureStorage(600 * 1024 * 1024).state, 'ok');

  const warning = inspectCaptureStorage(256 * 1024 * 1024);
  assert.equal(warning.state, 'warning');
  assert.equal(warning.canRecord, true);
  assert.match(warning.message, /free space/i);

  const blocked = inspectCaptureStorage(32 * 1024 * 1024);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.canRecord, false);
  assert.match(blocked.message, /free space/i);

  const unknown = inspectCaptureStorage(Number.NaN);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.canRecord, true);
});

test('capture failures become actionable for busy camera, storage, permission, and interruption paths', () => {
  assert.equal(classifyCaptureFailure(new Error('Camera is already in use')), 'camera-busy');
  assert.equal(classifyCaptureFailure(new Error('Starting video recording failed - could not create video file')), 'storage');
  assert.equal(classifyCaptureFailure(new Error('Missing permissions: android.permission.RECORD_AUDIO')), 'permission');
  assert.equal(classifyCaptureFailure(new Error('Camera source inactive')), 'interrupted');

  assert.match(captureFailureMessage('camera-busy'), /close.*camera|camera.*busy/i);
  assert.match(captureFailureMessage('storage'), /free space/i);
  assert.match(captureFailureMessage('permission'), /settings|permission/i);
  assert.match(captureFailureMessage('interrupted'), /interrupted|review/i);
});

test('rapid stop requests are idempotent and preserve the first reason', () => {
  const stop = createStopLatch();

  assert.equal(stop.request('user'), true);
  assert.equal(stop.request('interruption'), false);
  assert.equal(stop.requested, true);
  assert.equal(stop.reason, 'user');

  stop.reset();
  assert.equal(stop.requested, false);
  assert.equal(stop.reason, null);
  assert.equal(stop.request('storage'), true);
  assert.equal(stop.reason, 'storage');
});

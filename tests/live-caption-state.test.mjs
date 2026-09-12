import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captionState,
  classifyCaptionFailure,
  liveCaptionSession,
  mergeCaptionSegments,
  reduceCaption,
  reduceLiveCaptionStatus,
  replayCaptionSession,
} from '../src/lib/live-caption-state.ts';

test('a previous recording cannot overwrite the new recording captions', () => {
  const state = captionState('new');
  assert.equal(reduceCaption(state, { sessionId: 'old', sequence: 99, text: 'old words', isFinal: true }), state);
});

test('partial revisions replace text and older revisions cannot undo final output', () => {
  const partial = reduceCaption(captionState('one'), { sessionId: 'one', sequence: 1, text: 'hello', isFinal: false });
  const final = reduceCaption(partial, { sessionId: 'one', sequence: 3, text: 'hello world', isFinal: true });
  assert.equal(final.text, 'hello world');
  assert.equal(final.isFinal, true);
  assert.equal(reduceCaption(final, { sessionId: 'one', sequence: 2, text: 'hello word', isFinal: false }), final);
});

test('a new utterance can follow a completed utterance within the same recording', () => {
  const completed = { sessionId: 'one', sequence: 3, text: 'First sentence.', isFinal: true };
  const next = { sessionId: 'one', sequence: 4, text: 'Another sentence', isFinal: false };
  assert.equal(reduceCaption(completed, next), next);
});

test('starting another recording clears prior text and sequence', () => {
  assert.deepEqual(captionState('two'), { sessionId: 'two', sequence: -1, text: '', isFinal: false });
});

test('a missing model asset is a distinct recoverable reason', () => {
  assert.deepEqual(
    classifyCaptionFailure(undefined, "Moonshine model asset 'encoder.ort' is unavailable. Run python3 tools/prepare_moonshine.py before building."),
    { status: 'unavailable', reason: 'model-missing', retryable: true },
  );
});

test('a hash mismatch is reported as a corrupt model, not a missing one', () => {
  assert.deepEqual(
    classifyCaptionFailure(undefined, 'Caption model checksum mismatch: decoder_kv.ort'),
    { status: 'unavailable', reason: 'model-corrupt', retryable: true },
  );
});

test('an unclassified preparation failure is an initialization failure', () => {
  assert.deepEqual(
    classifyCaptionFailure(undefined, 'Could not start caption inference'),
    { status: 'unavailable', reason: 'initialization-failed', retryable: true },
  );
});

test('an unsupported device is not offered as a retry', () => {
  assert.deepEqual(
    classifyCaptionFailure(undefined, 'Moonshine live captions require an arm64-v8a device'),
    { status: 'unavailable', reason: 'unsupported-device', retryable: false },
  );
});

test('audio focus loss and route changes are interruptions rather than unavailability', () => {
  assert.deepEqual(
    classifyCaptionFailure('audio-focus-lost'),
    { status: 'interrupted', reason: 'audio-focus-lost', retryable: true },
  );
  assert.deepEqual(
    classifyCaptionFailure(undefined, 'The audio route changed during recording'),
    { status: 'interrupted', reason: 'audio-route-changed', retryable: true },
  );
});

test('a native reason wins over message guessing and an unknown one falls back to the message', () => {
  assert.equal(classifyCaptionFailure('model-corrupt', 'Microphone permission is unavailable').reason, 'model-corrupt');
  assert.equal(classifyCaptionFailure('surprise', 'Microphone permission is unavailable').reason, 'permission-denied');
  assert.deepEqual(classifyCaptionFailure(), { status: 'unavailable', reason: 'unknown', retryable: true });
});

test('a new session starts preparing and carries no earlier failure', () => {
  assert.deepEqual(liveCaptionSession('two'), {
    sessionId: 'two',
    status: 'preparing',
    reason: null,
    message: '',
    retryable: false,
  });
  assert.equal(liveCaptionSession('').status, 'idle');
});

test('a failed preparation reports the reason and stays visible through stop', () => {
  const failed = reduceLiveCaptionStatus(liveCaptionSession('one'), {
    sessionId: 'one',
    status: 'error',
    message: 'Caption model checksum mismatch: adapter.ort',
  });
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.reason, 'model-corrupt');
  assert.equal(failed.retryable, true);
  const stopped = reduceLiveCaptionStatus(failed, { sessionId: 'one', status: 'stopped' });
  assert.equal(stopped.status, 'unavailable');
  assert.equal(stopped.message, 'Caption model checksum mismatch: adapter.ort');
});

test('an interruption clears once recognition is listening again', () => {
  const interrupted = reduceLiveCaptionStatus(liveCaptionSession('one'), {
    sessionId: 'one',
    status: 'interrupted',
    reason: 'audio-route-changed',
  });
  assert.equal(interrupted.status, 'interrupted');
  const recovered = reduceLiveCaptionStatus(interrupted, { sessionId: 'one', status: 'listening' });
  assert.equal(recovered.status, 'listening');
  assert.equal(recovered.reason, null);
  assert.equal(recovered.message, '');
});

test('a stale session or an unknown status cannot change the reported state', () => {
  const listening = reduceLiveCaptionStatus(liveCaptionSession('one'), { sessionId: 'one', status: 'listening' });
  assert.equal(reduceLiveCaptionStatus(listening, { sessionId: 'old', status: 'error', message: 'gone' }), listening);
  assert.equal(reduceLiveCaptionStatus(listening, { sessionId: 'one', status: 'daydreaming' }), listening);
});

test('segment revisions merge by id in source time order', () => {
  const merged = mergeCaptionSegments(
    [{ id: 'b', t0: 2, t1: 3, text: 'second', isFinal: false }],
    [
      { id: 'b', t0: 2, t1: 3.4, text: 'second sentence', isFinal: true },
      { id: 'a', t0: 0.2, t1: 1.1, text: 'first', isFinal: true },
    ],
  );
  assert.deepEqual(merged.map(segment => segment.id), ['a', 'b']);
  assert.deepEqual(merged[1], { id: 'b', t0: 2, t1: 3.4, text: 'second sentence', isFinal: true });
});

test('replaying a session ignores stale sequences and other sessions', () => {
  const events = [
    { sessionId: 'one', sequence: 1, text: 'The camera can', isFinal: false, segments: [{ id: '1', t0: 0.2, t1: 1.1, text: 'The camera can', isFinal: false }] },
    { sessionId: 'other', sequence: 9, text: 'Wrong recording', isFinal: true },
    { sessionId: 'one', sequence: 2, text: 'The camera records clearly.', isFinal: true, segments: [{ id: '1', t0: 0.2, t1: 2.2, text: 'The camera records clearly.', isFinal: true }] },
    { sessionId: 'one', sequence: 1, text: 'Late draft', isFinal: false },
  ];
  const replayed = replayCaptionSession('one', events);
  assert.equal(replayed.text, 'The camera records clearly.');
  assert.equal(replayed.isFinal, true);
  assert.equal(replayed.sequence, 2);
  assert.deepEqual(replayed.segments, [{ id: '1', t0: 0.2, t1: 2.2, text: 'The camera records clearly.', isFinal: true }]);
});

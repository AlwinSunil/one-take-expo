import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captionState,
  classifyCaptionFailure,
  liveCaptionSession,
  mergeCaptionSegments,
  namespaceCaptionSegments,
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

test('an audio format failure is retryable and does not blame the device', () => {
  assert.deepEqual(
    classifyCaptionFailure(undefined, 'Unsupported PCM encoding: 4'),
    { status: 'unavailable', reason: 'initialization-failed', retryable: true },
  );
  assert.deepEqual(
    classifyCaptionFailure(undefined, 'Audio track has an unsupported channel count'),
    { status: 'unavailable', reason: 'initialization-failed', retryable: true },
  );
  // The two sentences the module actually emits about device support still
  // classify as unsupported-device.
  assert.equal(
    classifyCaptionFailure(undefined, 'Moonshine live captions require Android API 26 or newer').reason,
    'unsupported-device',
  );
  assert.equal(
    classifyCaptionFailure(undefined, 'Offline captions require arm64 Android 8 or newer').reason,
    'unsupported-device',
  );
});

test('the native status decides the interrupted split even with no reason or message', () => {
  const interrupted = reduceLiveCaptionStatus(liveCaptionSession('one'), {
    sessionId: 'one',
    status: 'interrupted',
  });
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.reason, 'lifecycle-interrupted');
  assert.equal(interrupted.retryable, true);

  // A nonsensical pairing keeps the native split rather than the classified one.
  const odd = reduceLiveCaptionStatus(liveCaptionSession('one'), {
    sessionId: 'one',
    status: 'interrupted',
    reason: 'model-corrupt',
  });
  assert.equal(odd.status, 'interrupted');
  assert.equal(odd.reason, 'lifecycle-interrupted');

  const failed = reduceLiveCaptionStatus(liveCaptionSession('one'), {
    sessionId: 'one',
    status: 'error',
    message: 'The audio route changed during recording',
  });
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.reason, 'audio-route-changed');
});

test('a retry keeps the utterances recognized before the failure', () => {
  const beforeFailure = [
    { id: '1', t0: 0.4, t1: 2.1, text: 'The light is low.', isFinal: true },
    { id: '2', t0: 2.6, t1: 4.2, text: 'And the room is quiet.', isFinal: true },
  ];
  // The retried native session restarts its segment ids from the beginning.
  const afterRetry = [{ id: '1', t0: 0.5, t1: 1.8, text: 'Reading the third line.', isFinal: true }];

  const resumed = mergeCaptionSegments(beforeFailure, namespaceCaptionSegments(afterRetry, 1, Math.max(...beforeFailure.map(segment => segment.t1))));
  assert.deepEqual(resumed.map(segment => segment.text), [
    'The light is low.',
    'And the room is quiet.',
    'Reading the third line.',
  ]);
  assert.deepEqual(resumed.map(segment => segment.id), ['1', '2', 'r1:1']);
  assert.equal(resumed[2].t0, 4.7);
  assert.equal(resumed[2].t1, 6);
  assert.equal(afterRetry[0].t0, 0.5);

  // Without the namespace the retried session would silently overwrite the
  // first utterance, which is the regression this guards.
  assert.equal(mergeCaptionSegments(beforeFailure, afterRetry).length, 2);

  assert.deepEqual(namespaceCaptionSegments(afterRetry, 0), afterRetry);
  assert.throws(() => namespaceCaptionSegments(afterRetry, -1), RangeError);
});

test('retry offsets stay fixed across revisions and accumulate across attempts', () => {
  const original = [{ id: '1', t0: 0, t1: 4, text: 'A', isFinal: true }];
  const retry = [{ id: '1', t0: 0.5, t1: 1, text: 'B', isFinal: false }];
  const offset = Math.max(...original.map(segment => segment.t1));
  let transcript = mergeCaptionSegments(original, namespaceCaptionSegments(retry, 1, offset));
  transcript = mergeCaptionSegments(transcript, namespaceCaptionSegments(
    [{ ...retry[0], t1: 2, text: 'B final', isFinal: true }], 1, offset,
  ));
  assert.deepEqual(transcript.map(segment => [segment.id, segment.t0, segment.t1]), [
    ['1', 0, 4], ['r1:1', 4.5, 6],
  ]);
  const nextOffset = Math.max(...transcript.map(segment => segment.t1));
  transcript = mergeCaptionSegments(transcript, namespaceCaptionSegments(retry, 2, nextOffset));
  assert.deepEqual(transcript.map(segment => segment.t0), [0, 4.5, 6.5]);
  for (const invalid of [-1, NaN, Infinity]) {
    assert.throws(() => namespaceCaptionSegments(retry, 1, invalid), RangeError);
  }
});

test('retry moves measured word boundaries with the source clock and revisions replace stale boundaries', () => {
  const partial = [{ id: '1', t0: 0.2, t1: 1.5, text: 'um hello', isFinal: false,
    words: [{ text: 'um', t0: 0.2, t1: 0.45, confidence: 0.9 }] }];
  const translated = namespaceCaptionSegments(partial, 1, 8);
  assert.deepEqual(translated[0].words, [{ text: 'um', t0: 8.2, t1: 8.45, confidence: 0.9 }]);
  assert.equal(partial[0].words[0].t0, 0.2);
  const final = namespaceCaptionSegments([{ ...partial[0], isFinal: true,
    words: [{ text: 'um', t0: 0.3, t1: 0.5, confidence: 0.95 }, { text: 'hello', t0: 0.6, t1: 1.4, confidence: 0.99 }] }], 1, 8);
  const merged = mergeCaptionSegments(translated, final);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].words.map(word => [word.text, word.t0, word.t1]), [['um', 8.3, 8.5], ['hello', 8.6, 9.4]]);
});

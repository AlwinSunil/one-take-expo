import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAlignmentState,
  createAlignmentFollower,
  manualNext,
  manualPrevious,
  reduceAlignment,
  reduceCaptionAlignment,
  resetAlignment,
  reanchorAlignment,
  matchEnglish,
} from '../src/features/speech-analysis/alignment.ts';

const lines = [
  { id: 'line-a', text: 'Today I am going to show you how One Take works.' },
  { id: 'line-b', text: 'The camera keeps the original recording.' },
  { id: 'line-c', text: 'Review the result before you export.' },
];

const segment = (id, text, extra = {}) => ({
  id,
  text,
  isFinal: true,
  t0: 0,
  t1: 1,
  ...extra,
});

test('the English matcher accepts contractions, a generic paraphrase, and the approved One Take example', () => {
  assert.equal(matchEnglish(
    'Today I am going to show you how One Take works.',
    "Today I'm going to show you how the One Take app works.",
  ).verdict, 'matched');

  assert.equal(matchEnglish(
    'The guide will show the result.',
    'The guide will demonstrate the result.',
  ).verdict, 'matched');
  assert.ok(matchEnglish(
    'The guide will show the result.',
    'The guide will demonstrate the result.',
  ).score >= 0.8);
  assert.equal(matchEnglish('Save the clip on your device.', 'Store the clip locally.').verdict, 'matched');
  assert.equal(matchEnglish(
    'You can review the recording before sharing it.',
    'Before you share, you can check the recording.',
  ).verdict, 'matched');
});

test('meaning-bearing changes never become a normal match', () => {
  assert.equal(matchEnglish('The camera records in 4K.', 'The camera records in 1080p.').verdict, 'mismatch');
  assert.equal(matchEnglish('Alice presents the report.', 'Alicia presents the report.').verdict, 'mismatch');
  assert.equal(matchEnglish('Alice saves the video.', 'alice saves the video.').verdict, 'matched');
  assert.equal(matchEnglish('The customer can cancel.', 'The creator can cancel.').verdict, 'mismatch');
  assert.equal(matchEnglish('The camera records the clip.', 'The camera does not record the clip.').verdict, 'mismatch');
  assert.equal(matchEnglish('I pay you.', 'You pay me.').verdict, 'mismatch');
  assert.equal(matchEnglish('We will upload the video.', 'We might upload the video.').verdict, 'mismatch');
  assert.equal(matchEnglish('We keep audio and video.', 'We keep audio or video.').verdict, 'mismatch');
  assert.equal(matchEnglish('The result is ready.', 'The weather is sunny.').verdict, 'mismatch');
});

test('numeric lexemes stay protected without splitting decimals or formatted values', () => {
  assert.equal(matchEnglish('The measurement is 1.5 meters.', 'The measurement is 1 meters.').verdict, 'mismatch');
  assert.equal(matchEnglish('The budget is 1,500 dollars.', 'The budget is 1500 dollars.').verdict, 'matched');
  assert.equal(matchEnglish('The budget is 1,500 dollars.', 'The budget is 1,550 dollars.').verdict, 'mismatch');
});

test('incomplete ideas are partial and absent speech is unknown', () => {
  assert.equal(matchEnglish('The camera records the original video.', 'The camera records').verdict, 'partial');
  assert.equal(matchEnglish('This is sponsored.', '').verdict, 'unknown');
  assert.equal(matchEnglish('', 'hello').verdict, 'unknown');
});

test('a follower commits only a final revision and ignores duplicates and stale sequences', () => {
  let state = createAlignmentState({ lines, sessionId: 'session-1' });
  state = reduceAlignment(state, segment('utterance-1', 'Today I am going to show', {
    isFinal: false,
    sequence: 1,
    t1: 0.8,
  }));
  assert.equal(state.cursor, 0);
  assert.equal(state.status, 'pending');

  state = reduceAlignment(state, segment('utterance-1', lines[0].text, {
    sequence: 2,
    t1: 1.4,
  }));
  assert.equal(state.cursor, 1);
  assert.equal(state.currentLineId, 'line-b');
  assert.deepEqual(state.committedLineIds, ['line-a']);

  const afterDuplicate = reduceAlignment(state, segment('utterance-1', lines[0].text, {
    sequence: 3,
    t1: 1.4,
  }));
  assert.deepEqual(afterDuplicate, state);

  const afterStale = reduceAlignment(state, segment('utterance-stale', lines[1].text, {
    sequence: 1,
    t0: 1.5,
    t1: 2.5,
  }));
  assert.deepEqual(afterStale, state);
});

test('a caption update with one shared sequence can advance every stable final segment once', () => {
  let state = createAlignmentState({ lines, sessionId: 'caption-batch' });
  const update = {
    sessionId: 'caption-batch',
    sequence: 7,
    text: `${lines[0].text} ${lines[1].text}`,
    isFinal: true,
    segments: [
      segment('batch-a', lines[0].text, { t0: 0, t1: 1 }),
      segment('batch-b', lines[1].text, { t0: 1.1, t1: 2 }),
    ],
  };
  state = reduceCaptionAlignment(state, update);
  assert.equal(state.cursor, 2);
  assert.deepEqual(state.committedLineIds, ['line-a', 'line-b']);
  assert.deepEqual(state.observations.map(({ id }) => id), ['batch-a', 'batch-b']);
  assert.deepEqual(reduceCaptionAlignment(state, update), state);

  const textOnly = reduceCaptionAlignment(state, {
    sessionId: 'caption-batch', sequence: 8, text: 'unidentified text', isFinal: true,
  });
  assert.equal(textOnly.cursor, state.cursor);
  assert.equal(textOnly.observations.length, state.observations.length);
  assert.equal(textOnly.status, 'unknown');
});

test('one final utterance can advance across adjacent lines without splitting its evidence', () => {
  const state = reduceAlignment(createAlignmentState({ lines, sessionId: 'session-1' }), segment(
    'utterance-b-c',
    `${lines[0].text} ${lines[1].text}`,
    { t1: 2.8 },
  ));
  assert.equal(state.cursor, 2);
  assert.equal(state.currentLineId, 'line-c');
  assert.deepEqual(state.committedLineIds, ['line-a', 'line-b']);
  assert.deepEqual(state.history.at(-1).lineIds, ['line-a', 'line-b']);
  assert.equal(state.history.at(-1).segmentId, 'utterance-b-c');
});

test('repeated similar lines stay ambiguous, while an unambiguous later line records skipped ids', () => {
  const repeatedLines = [
    { id: 'line-start', text: 'Start the recording.' },
    { id: 'line-repeat-1', text: 'The result is ready.' },
    { id: 'line-repeat-2', text: 'The result is ready.' },
    { id: 'line-end', text: 'Finish with a review.' },
  ];
  let state = createAlignmentState({ lines: repeatedLines, sessionId: 'session-2' });
  state = reduceAlignment(state, segment('ambiguous-repeat', 'The result is ready.', { t1: 1 }));
  assert.equal(state.cursor, 0);
  assert.equal(state.status, 'paused');
  assert.match(state.history.at(-1).reason, /ambiguous/i);

  state = reduceAlignment(state, segment('later-unique', 'Finish with a review.', { t0: 1.1, t1: 2 }));
  assert.equal(state.cursor, 4);
  assert.deepEqual(state.committedLineIds, ['line-end']);
  assert.deepEqual(state.skippedLineIds, ['line-start', 'line-repeat-1', 'line-repeat-2']);
});

test('manual movement creates a barrier that invalidates buffered recognition', () => {
  let state = createAlignmentState({ lines, sessionId: 'session-3' });
  state = reduceAlignment(state, segment('buffered', 'Today I am going to show', {
    isFinal: false,
    sequence: 1,
    t0: 0,
    t1: 0.9,
  }));
  state = manualNext(state, 1);
  assert.equal(state.cursor, 1);
  assert.equal(state.epoch, 1);
  assert.ok(state.invalidatedSegmentIds.includes('buffered'));

  const staleFinal = reduceAlignment(state, segment('buffered', lines[0].text, {
    sequence: 2,
    t0: 0,
    t1: 1.4,
  }));
  assert.deepEqual(staleFinal, state);

  state = reduceAlignment(state, segment('fresh-line', lines[1].text, {
    sequence: 3,
    t0: 1.1,
    t1: 2,
  }));
  assert.equal(state.cursor, 2);
  assert.deepEqual(state.committedLineIds, ['line-b']);

  const noTiming = reduceAlignment(state, segment('untimed', lines[2].text, {
    sequence: 4,
    t0: undefined,
    t1: undefined,
  }));
  assert.deepEqual(noTiming, state);
});

test('source time keeps a delayed older segment from advancing a later line', () => {
  let state = createAlignmentState({ lines, sessionId: 'session-time' });
  state = reduceAlignment(state, segment('first', lines[0].text, { sequence: 1, t0: 0, t1: 1 }));
  const delayed = reduceAlignment(state, segment('delayed-old', lines[1].text, { sequence: 2, t0: 0.2, t1: 0.9 }));
  assert.deepEqual(delayed, state);
});

test('a nearby unambiguous reread reacquires its line without creating a second advance', () => {
  let state = createAlignmentState({ lines, sessionId: 'session-reread' });
  state = reduceAlignment(state, segment('first', lines[0].text, { sequence: 1, t0: 0, t1: 1 }));
  state = reduceAlignment(state, segment('second', lines[1].text, { sequence: 2, t0: 1.1, t1: 2 }));
  state = reduceAlignment(state, segment('third', lines[2].text, { sequence: 3, t0: 2.1, t1: 3 }));
  assert.equal(state.cursor, 3);
  state = reduceAlignment(state, segment('reread-second', lines[1].text, { sequence: 4, t0: 3.1, t1: 4 }));
  assert.equal(state.cursor, 2);
  assert.equal(state.history.at(-1).outcome, 'reread');
  assert.equal(state.history.at(-1).text, lines[1].text);
});

test('a changed final revision is retained as paused history and cannot advance twice', () => {
  let state = createAlignmentState({ lines, sessionId: 'session-revision' });
  state = reduceAlignment(state, segment('final-revision', lines[0].text, { sequence: 1, t0: 0, t1: 1 }));
  state = reduceAlignment(state, segment('final-revision', 'Today I am going to show a different app.', { sequence: 2, t0: 0, t1: 1.1 }));
  assert.equal(state.cursor, 1);
  assert.equal(state.status, 'paused');
  assert.equal(state.history.at(-1).outcome, 'ignored');
  assert.equal(state.history.at(-1).text, 'Today I am going to show a different app.');
});

test('delayed and unavailable recognition hold the reader until listening resumes explicitly', () => {
  let state = createAlignmentState({ lines, sessionId: 'session-status' });
  state = reduceAlignment(state, { type: 'status', status: 'delayed', message: 'Catching up.' });
  const delayed = reduceAlignment(state, segment('line-a', lines[0].text, { sequence: 1, t0: 0, t1: 1 }));
  assert.deepEqual(delayed, state);
  state = reduceAlignment(state, { type: 'status', status: 'listening' });
  state = reduceAlignment(state, segment('line-a', lines[0].text, { sequence: 2, t0: 0, t1: 1 }));
  assert.equal(state.cursor, 1);
  state = reduceAlignment(state, { type: 'status', status: 'unavailable', message: 'No model.' });
  const unavailable = reduceAlignment(state, segment('line-b', lines[1].text, { sequence: 3, t0: 1.1, t1: 2 }));
  assert.equal(unavailable.cursor, 1);
  assert.equal(unavailable.status, 'unavailable');
});

test('pickup mode follows requested stable ids and does not mark unrelated lines skipped', () => {
  let state = createAlignmentState({ lines, sessionId: 'pickup-1', pickupLineIds: ['line-b'] });
  assert.equal(state.currentLineId, 'line-b');
  assert.equal(state.nextLineId, null);

  state = reduceAlignment(state, segment('outside', lines[0].text));
  assert.equal(state.cursor, 0);
  assert.deepEqual(state.committedLineIds, []);
  assert.deepEqual(state.skippedLineIds, []);

  state = reduceAlignment(state, segment('pickup', lines[1].text, { t0: 1.1, t1: 2 }));
  assert.equal(state.cursor, 1);
  assert.deepEqual(state.committedLineIds, ['line-b']);
  assert.deepEqual(state.skippedLineIds, []);
  assert.deepEqual(state.pickupLineIds, ['line-b']);
});

test('manual previous, reanchor, lifecycle status, and reset preserve separate reading state', () => {
  let state = createAlignmentState({ lines, sessionId: 'session-4' });
  state = reduceAlignment(state, segment('first', lines[0].text));
  state = reduceAlignment(state, segment('second', lines[1].text, { t0: 1.1, t1: 2 }));
  assert.equal(state.cursor, 2);

  state = manualPrevious(state, 2.1);
  assert.equal(state.cursor, 1);
  state = reanchorAlignment(state, 'line-a', 2.2);
  assert.equal(state.currentLineId, 'line-a');
  assert.equal(state.cursor, 0);

  state = reduceAlignment(state, { type: 'status', status: 'unavailable', message: 'Recognition unavailable.' });
  assert.equal(state.status, 'unavailable');
  assert.match(state.statusMessage, /unavailable/i);

  const reset = resetAlignment(state, { reason: 'retry', sessionId: 'session-4-retry' });
  assert.equal(reset.cursor, 0);
  assert.equal(reset.sessionId, 'session-4-retry');
  assert.deepEqual(reset.committedLineIds, []);
  assert.deepEqual(reset.history, []);
  assert.equal(reset.epoch, state.epoch + 1);
});

test('the object follower exposes the same deterministic reducer and toggle lifecycle', () => {
  const follower = createAlignmentFollower({ lines, sessionId: 'session-5' });
  follower.consume(segment('first', lines[0].text));
  assert.equal(follower.getState().cursor, 1);
  follower.setEnabled(false);
  follower.consume(segment('second', lines[1].text));
  assert.equal(follower.getState().cursor, 1);
  follower.setEnabled(true);
  follower.consume(segment('second', lines[1].text, { sequence: 2, t0: 1, t1: 2 }));
  assert.equal(follower.getState().cursor, 2);
});

test('manual navigation without a clock holds delayed speech until an explicit timed reanchor', () => {
  let state = manualNext(createAlignmentState({ lines, sessionId: 'no-clock' }));
  state = reduceAlignment(state, segment('buffered-unknown', lines[1].text, { t0: 1, t1: 2 }));
  assert.equal(state.cursor, 1);
  state = reanchorAlignment(state, lines[1].id, 3);
  state = reduceAlignment(state, segment('fresh-clock', lines[1].text, { t0: 3.1, t1: 4 }));
  assert.equal(state.cursor, 2);
});

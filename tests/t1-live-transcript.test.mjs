import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLiveTranscriptView,
  createLiveTranscriptState,
  reduceLiveTranscript,
  visibleLiveTranscriptText,
} from '../src/features/speech-control/live-transcript.ts';

const event = (sequence, extra = {}) => ({ sessionId: 'take-1', sequence, ...extra });

test('replay keeps provisional text, accepts final text, and suppresses stale events', () => {
  let state = createLiveTranscriptState('take-1');
  state = reduceLiveTranscript(state, event(1, {
    status: 'listening', text: 'The camera can', isFinal: false,
    segments: [{ id: 'line-1', t0: 0.2, t1: 1.1, text: 'The camera can', isFinal: false }],
  }));
  assert.equal(buildLiveTranscriptView(state).state, 'provisional');
  state = reduceLiveTranscript(state, event(2, {
    status: 'listening', text: 'The camera records clearly.', isFinal: true,
    segments: [{ id: 'line-1', t0: 0.2, t1: 2.2, text: 'The camera records clearly.', isFinal: true }],
  }));
  assert.equal(state.isFinal, true);
  assert.equal(state.segments[0].text, 'The camera records clearly.');
  const before = state;
  assert.equal(reduceLiveTranscript(state, event(1, { text: 'stale', isFinal: false })), before);
  assert.equal(reduceLiveTranscript(state, { ...event(99), sessionId: 'old', text: 'wrong' }), before);
});

test('delayed, unavailable, and no-speech states remain honest and separate from coverage', () => {
  const empty = createLiveTranscriptState('take-1');
  assert.equal(buildLiveTranscriptView(empty).state, 'no-speech');
  assert.match(buildLiveTranscriptView(empty).hint, /microphone/);
  const delayed = reduceLiveTranscript(empty, event(1, { status: 'delayed', message: 'Native recognizer is catching up.' }));
  assert.equal(buildLiveTranscriptView(delayed).state, 'delayed');
  assert.match(buildLiveTranscriptView(delayed).hint, /after stopping/);
  const unavailable = reduceLiveTranscript(delayed, event(2, { status: 'error', message: 'Model unavailable.' }));
  const view = buildLiveTranscriptView(unavailable);
  assert.equal(view.state, 'unavailable');
  assert.equal(view.label, 'Transcript unavailable');
  assert.match(view.hint, /Model unavailable/);
  assert.doesNotMatch(JSON.stringify(view), /\bcovered\b|\bcoverage\b|\bscript coverage\b/i);
});

test('large text and long sessions stay bounded for the live surface', () => {
  let state = createLiveTranscriptState('take-1', { maxSegments: 3 });
  for (let i = 0; i < 8; i += 1) {
    state = reduceLiveTranscript(state, event(i, {
      status: 'listening', text: `sentence ${i} ` + 'x'.repeat(900), isFinal: true,
      segments: [{ id: `segment-${i}`, t0: i, t1: i + 0.8, text: `sentence ${i}`, isFinal: true }],
    }), { maxSegments: 3 });
  }
  assert.equal(state.segments.length, 3);
  const visible = visibleLiveTranscriptText({ text: 'a'.repeat(20), segments: [] }, 8);
  assert.equal(visible.truncated, true);
  assert.equal(visible.text.length, 8);
  assert.match(visible.text, /^…/);
  assert.deepEqual(visibleLiveTranscriptText({ text: 'too long', segments: [] }, 1), { text: '…', truncated: true });
});

test('final segment state stays final if a later provisional update arrives', () => {
  let state = createLiveTranscriptState('take-1');
  state = reduceLiveTranscript(state, event(1, {
    status: 'listening', text: 'final phrase', isFinal: true,
    segments: [{ id: 'a', t0: 0, t1: 1, text: 'final phrase', isFinal: true }],
  }));
  state = reduceLiveTranscript(state, event(2, {
    status: 'listening', text: 'changed phrase', isFinal: false,
    segments: [{ id: 'a', t0: 0, t1: 1, text: 'changed phrase', isFinal: false }],
  }));
  assert.equal(state.segments[0].text, 'final phrase');
  assert.equal(state.isFinal, true);
});

test('a new provisional utterance clears the global final label while the prior final remains sticky', () => {
  let state = createLiveTranscriptState('take-1');
  state = reduceLiveTranscript(state, event(1, {
    status: 'listening', text: 'first phrase', isFinal: true,
    segments: [{ id: 'first', t0: 0, t1: 1, text: 'first phrase', isFinal: true }],
  }));
  state = reduceLiveTranscript(state, event(2, {
    status: 'listening', text: 'second draft', isFinal: false,
    segments: [
      { id: 'first', t0: 0, t1: 1, text: 'first phrase', isFinal: true },
      { id: 'second', t0: 1.2, t1: 2, text: 'second draft', isFinal: false },
    ],
  }));
  assert.equal(state.isFinal, false);
  assert.equal(state.segments.find(({ id }) => id === 'first').text, 'first phrase');
  assert.equal(state.segments.find(({ id }) => id === 'second').isFinal, false);
});

test('an unavailable recognizer remains unavailable after the native stop event', () => {
  let state = createLiveTranscriptState('take-1');
  state = reduceLiveTranscript(state, event(1, { status: 'error', message: 'Model unavailable.' }));
  state = reduceLiveTranscript(state, event(2, { status: 'stopped' }));
  assert.equal(state.status, 'error');
  assert.match(buildLiveTranscriptView(state).hint, /Model unavailable/);
});

test('a final stop with partial text is labeled incomplete, and no text is not claimed as no speech', () => {
  let partial = createLiveTranscriptState('take-1');
  partial = reduceLiveTranscript(partial, event(1, { status: 'listening', text: 'unfinished', isFinal: false }));
  partial = reduceLiveTranscript(partial, event(2, { status: 'stopped' }));
  assert.equal(buildLiveTranscriptView(partial).label, 'Transcript incomplete');
  const empty = reduceLiveTranscript(createLiveTranscriptState('take-2'), { sessionId: 'take-2', sequence: 1, status: 'stopped' });
  assert.equal(buildLiveTranscriptView(empty).label, 'No transcript received');
  assert.match(buildLiveTranscriptView(empty).hint, /does not establish/);
});

test('large unbounded segment props are projected from the latest bounded slice', () => {
  const segments = Array.from({ length: 10_000 }, (_, index) => ({
    id: `segment-${index}`, t0: index, t1: index + 0.5, text: `line ${index}`, isFinal: true,
  }));
  const view = buildLiveTranscriptView({ text: '', segments, isFinal: true, status: 'listening', message: '' }, 64);
  assert.equal(view.truncated, true);
  assert.match(view.text, /line 9999/);
  assert.doesNotMatch(view.text, /line 0\n/);
});

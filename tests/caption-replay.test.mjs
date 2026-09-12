import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captionState,
  liveCaptionSession,
  reduceCaption,
  reduceLiveCaptionStatus,
  replayCaptionSession,
} from '../src/lib/live-caption-state.ts';
import { summarizeCaptionTiming } from '../src/lib/caption-timing.ts';

const recordingsDirectory = new URL('../tools/speech-fixtures/recordings/', import.meta.url);

const recordings = readdirSync(recordingsDirectory)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => JSON.parse(readFileSync(new URL(name, recordingsDirectory), 'utf8')));

const recording = name => {
  const found = recordings.find(item => item.name === name);
  assert.ok(found, `missing recording fixture: ${name}`);
  return found;
};

/** Events the replay must drop, whatever position they arrive in. */
function partitionStale(session) {
  const fresh = [];
  const stale = [];
  let state = captionState(session.sessionId);
  for (const event of session.events) {
    const next = reduceCaption(state, event);
    if (next === state) stale.push(event);
    else {
      fresh.push(event);
      state = next;
    }
  }
  return { fresh, stale };
}

const merged = session => JSON.stringify(replayCaptionSession(session.sessionId, session.events));

test('synthetic caption replay is deterministic and preserves utterance timing', () => {
  const f = JSON.parse(readFileSync(new URL('../tools/fixtures/captions.json', import.meta.url), 'utf8'));
  const replay = () => f.events.reduce(reduceCaption, captionState(f.sessionId));
  assert.deepEqual(replay(), replay());
  assert.equal(replay().text, 'This is another sentence.');
  assert.equal(replay().segments[0].t0, 3.1);
  assert.equal(replay().isFinal, false);
});

test('every recorded session is present, synthetic and self-consistent', () => {
  assert.ok(recordings.length >= 5, 'expected the quiet, noisy, empty, model failure and interruption recordings');
  for (const session of recordings) {
    assert.equal(session.synthetic, true, `${session.name} must be labelled synthetic`);
    assert.equal(typeof session.sessionId, 'string');
    assert.ok(session.sessionId.length > 0);
    for (const event of session.statusEvents) {
      assert.equal(event.sessionId, session.sessionId);
    }
  }
});

test('replaying a recorded session twice produces byte-identical merged output', () => {
  for (const session of recordings) {
    assert.equal(merged(session), merged(session), `${session.name} is not deterministic`);
  }
});

test('late or duplicated stale events cannot change the replayed transcript', () => {
  for (const session of recordings) {
    const { fresh, stale } = partitionStale(session);
    const expected = merged(session);
    assert.equal(
      merged({ ...session, events: [...fresh, ...stale] }),
      expected,
      `${session.name} changed when stale events arrived late`,
    );
    assert.equal(
      merged({ ...session, events: [...session.events, ...stale, ...stale] }),
      expected,
      `${session.name} changed when stale events were redelivered`,
    );
    assert.equal(
      merged({ ...session, events: [...fresh, ...[...stale].reverse()] }),
      expected,
      `${session.name} changed when stale events were reordered among themselves`,
    );
  }
});

test('the noisy recording exercises stale events from another session and an older revision', () => {
  const { stale } = partitionStale(recording('noisy-read'));
  assert.equal(stale.length, 2);
  assert.deepEqual(stale.map(event => event.sessionId), ['quiet-read', 'noisy-read']);
});

test('quiet and noisy reads produce final utterances with timing', () => {
  for (const name of ['quiet-read', 'noisy-read']) {
    const replayed = replayCaptionSession(recording(name).sessionId, recording(name).events);
    const finals = replayed.segments.filter(segment => segment.isFinal);
    assert.equal(finals.length, 2, `${name} should finalize both lines`);
    for (const segment of finals) {
      assert.ok(segment.t1 > segment.t0, `${name} segment ${segment.id} has no duration`);
      assert.ok(segment.text.trim().length > 0);
    }
    assert.equal(replayed.isFinal, true);
  }
});

test('an empty recording never produces a final segment with text', () => {
  const empty = recording('empty-recording');
  assert.ok(empty.capturedDurationMs < 1_000);
  const replayed = replayCaptionSession(empty.sessionId, empty.events);
  assert.deepEqual(replayed.segments, []);
  assert.equal(replayed.text, '');
  assert.equal(replayed.isFinal, false);
});

test('the loading and delayed states of a read are visible through the status reducer', () => {
  const statuses = name => {
    const session = recording(name);
    let state = liveCaptionSession(session.sessionId);
    return session.statusEvents.map(event => {
      state = reduceLiveCaptionStatus(state, event);
      return state.status;
    });
  };

  assert.deepEqual(statuses('quiet-read'), ['preparing', 'listening', 'stopping', 'stopped']);
  assert.deepEqual(statuses('noisy-read'), ['preparing', 'listening', 'delayed', 'listening', 'stopping', 'stopped']);
  assert.deepEqual(statuses('empty-recording'), ['preparing', 'listening', 'stopping', 'stopped']);
});

test('a failed model stays unavailable with its reason after the session stops', () => {
  const session = recording('model-missing');
  const state = session.statusEvents.reduce(reduceLiveCaptionStatus, liveCaptionSession(session.sessionId));
  assert.equal(state.status, 'unavailable');
  assert.equal(state.reason, 'model-missing');
  assert.equal(state.retryable, true);
  assert.match(state.message, /prepare_moonshine/);
});

test('an interrupted take keeps its recognized utterance and recovers on the next start', () => {
  const session = recording('route-change-interruption');
  const interrupted = session.statusEvents.reduce(reduceLiveCaptionStatus, liveCaptionSession(session.sessionId));
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.reason, 'audio-route-changed');
  assert.equal(replayCaptionSession(session.sessionId, session.events).segments.length, 1);

  const restarted = liveCaptionSession('route-change-interruption-2');
  assert.equal(restarted.status, 'preparing');
  assert.equal(restarted.reason, null);
});

test('recorded timing events replay to the same separated durations', () => {
  const noisy = summarizeCaptionTiming(recording('noisy-read').timingEvents);
  assert.deepEqual(noisy.utterances.map(item => [item.pauseDetectionMs, item.finalizationMs, item.coverageMs]), [
    [320, 1_640, 220],
    [280, 160, 150],
  ]);
  assert.deepEqual(noisy.utterances.map(item => item.delayed), [true, false]);
  assert.equal(noisy.delayed, false);

  const quiet = summarizeCaptionTiming(recording('quiet-read').timingEvents);
  assert.equal(quiet.delayed, false);
  assert.equal(quiet.lines.length, 2);
  assert.deepEqual(summarizeCaptionTiming(recording('empty-recording').timingEvents).utterances, []);
});

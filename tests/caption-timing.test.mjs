import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COVERAGE_DELAY_MS,
  FINALIZATION_DELAY_MS,
  captionTimingReport,
  captionTimingState,
  reduceCaptionTiming,
  selectNewTimingLines,
  streamElapsedMs,
  summarizeCaptionTiming,
  timingAdjustedStatus,
} from '../src/lib/caption-timing.ts';

const utterance = (id, speechEnd, pause, final, coverage) => [
  { utteranceId: id, stage: 'speech-end', at: speechEnd },
  { utteranceId: id, stage: 'pause-detected', at: pause },
  { utteranceId: id, stage: 'final-segment', at: final },
  { utteranceId: id, stage: 'coverage-verdict', at: coverage },
];

test('the three stage durations are reported separately', () => {
  const report = summarizeCaptionTiming(utterance('u1', 1_000, 1_320, 2_100, 2_260));
  assert.deepEqual(report.utterances, [{
    utteranceId: 'u1',
    pauseDetectionMs: 320,
    finalizationMs: 780,
    coverageMs: 160,
    recognizedMs: 1_100,
    complete: true,
    delayed: false,
  }]);
  assert.equal(report.delayed, false);
});

test('an incomplete utterance reports only the durations it can measure', () => {
  const report = summarizeCaptionTiming(utterance('u1', 0, 200, 900, 1_000).slice(0, 2));
  assert.deepEqual(report.utterances, [{
    utteranceId: 'u1',
    pauseDetectionMs: 200,
    finalizationMs: null,
    coverageMs: null,
    recognizedMs: null,
    complete: false,
    delayed: false,
  }]);
  assert.deepEqual(report.lines, []);
});

test('finalization is delayed only above the threshold', () => {
  const onThreshold = summarizeCaptionTiming(utterance('u1', 0, 100, 100 + FINALIZATION_DELAY_MS, 100 + FINALIZATION_DELAY_MS));
  assert.equal(onThreshold.utterances[0].finalizationMs, FINALIZATION_DELAY_MS);
  assert.equal(onThreshold.delayed, false);

  const overThreshold = summarizeCaptionTiming(utterance('u1', 0, 100, 101 + FINALIZATION_DELAY_MS, 101 + FINALIZATION_DELAY_MS));
  assert.equal(overThreshold.utterances[0].finalizationMs, FINALIZATION_DELAY_MS + 1);
  assert.equal(overThreshold.delayed, true);
});

test('coverage processing is delayed only above the threshold', () => {
  const onThreshold = summarizeCaptionTiming(utterance('u1', 0, 100, 200, 200 + COVERAGE_DELAY_MS));
  assert.equal(onThreshold.utterances[0].coverageMs, COVERAGE_DELAY_MS);
  assert.equal(onThreshold.delayed, false);

  const overThreshold = summarizeCaptionTiming(utterance('u1', 0, 100, 200, 201 + COVERAGE_DELAY_MS));
  assert.equal(overThreshold.utterances[0].coverageMs, COVERAGE_DELAY_MS + 1);
  assert.equal(overThreshold.delayed, true);
});

test('a slow pause detection alone is not a delayed state', () => {
  const report = summarizeCaptionTiming(utterance('u1', 0, 9_000, 9_100, 9_200));
  assert.equal(report.utterances[0].pauseDetectionMs, 9_000);
  assert.equal(report.delayed, false);
});

test('the reported state follows the most recent utterance', () => {
  const slowThenFast = summarizeCaptionTiming([
    ...utterance('u1', 0, 100, 5_000, 5_100),
    ...utterance('u2', 6_000, 6_100, 6_200, 6_300),
  ]);
  assert.deepEqual(slowThenFast.utterances.map(item => item.delayed), [true, false]);
  assert.equal(slowThenFast.delayed, false);
});

test('each completed utterance produces one caption-timing log line', () => {
  const report = summarizeCaptionTiming([
    ...utterance('u1', 0, 320, 1_100, 1_200),
    ...utterance('u2', 2_000, 2_100, 4_000, 4_100),
  ]);
  assert.deepEqual(report.lines.map(entry => entry.line), [
    'caption-timing: utterance=u1 pause_detection_ms=320 finalization_ms=780 coverage_processing_ms=100 recognized_ms=1100 state=live',
    'caption-timing: utterance=u2 pause_detection_ms=100 finalization_ms=1900 coverage_processing_ms=100 recognized_ms=2000 state=delayed',
  ]);
  assert.deepEqual(report.lines.map(entry => entry.key), ['u1:complete', 'u2:complete']);
});

test('a repeated stage keeps the first timestamp and the same state object', () => {
  const first = utterance('u1', 0, 320, 1_100, 1_200)
    .reduce(reduceCaptionTiming, captionTimingState());
  const repeated = reduceCaptionTiming(first, { utteranceId: 'u1', stage: 'final-segment', at: 9_999 });
  assert.equal(repeated, first);
  assert.equal(captionTimingReport(repeated).utterances[0].finalizationMs, 780);
});

test('timing events that move backwards are rejected', () => {
  assert.throws(
    () => summarizeCaptionTiming([
      { utteranceId: 'u1', stage: 'speech-end', at: 1_000 },
      { utteranceId: 'u1', stage: 'pause-detected', at: 900 },
    ]),
    RangeError,
  );
});

test('malformed timing events are rejected', () => {
  assert.throws(() => summarizeCaptionTiming([{ utteranceId: '', stage: 'speech-end', at: 0 }]), TypeError);
  assert.throws(() => summarizeCaptionTiming([{ utteranceId: 'u1', stage: 'guessed', at: 0 }]), TypeError);
  assert.throws(() => summarizeCaptionTiming([{ utteranceId: 'u1', stage: 'speech-end', at: Number.NaN }]), RangeError);
  assert.throws(() => summarizeCaptionTiming([{ utteranceId: 'u1', stage: 'speech-end', at: -1 }]), RangeError);
});

test('an utterance with no pause source still logs a line with n/a stages', () => {
  const report = summarizeCaptionTiming([
    { utteranceId: 'u1', stage: 'speech-end', at: 2_100 },
    { utteranceId: 'u1', stage: 'final-segment', at: 2_410 },
  ]);
  assert.deepEqual(report.lines, [{
    key: 'u1:partial',
    utteranceId: 'u1',
    complete: false,
    line: 'caption-timing: utterance=u1 pause_detection_ms=n/a finalization_ms=n/a coverage_processing_ms=n/a recognized_ms=310 state=live',
  }]);
});

test('each caption-timing line is logged exactly once when utterances complete out of order', () => {
  // u1 and u2 both finalize, then u2 gets its coverage verdict before u1.
  const steps = [
    { utteranceId: 'u1', stage: 'speech-end', at: 1_000 },
    { utteranceId: 'u1', stage: 'pause-detected', at: 1_200 },
    { utteranceId: 'u1', stage: 'final-segment', at: 1_400 },
    { utteranceId: 'u2', stage: 'speech-end', at: 3_000 },
    { utteranceId: 'u2', stage: 'pause-detected', at: 3_200 },
    { utteranceId: 'u2', stage: 'final-segment', at: 3_400 },
    { utteranceId: 'u2', stage: 'coverage-verdict', at: 3_500 },
    { utteranceId: 'u1', stage: 'coverage-verdict', at: 3_900 },
  ];

  const logged = new Set();
  const emitted = [];
  let state = captionTimingState();
  for (const step of steps) {
    state = reduceCaptionTiming(state, step);
    for (const line of selectNewTimingLines(captionTimingReport(state), logged)) {
      logged.add(line.key);
      emitted.push(line.key);
    }
  }

  assert.deepEqual(emitted, ['u1:partial', 'u2:partial', 'u2:complete', 'u1:complete']);
  assert.equal(new Set(emitted).size, emitted.length, 'a line was logged more than once');
});

test('stage timestamps share the audio-stream clock', () => {
  assert.equal(streamElapsedMs(10_600, 10_000), 600);
  assert.equal(streamElapsedMs(9_900, 10_000), 0);
  assert.equal(streamElapsedMs(10_600, null), null, 'no stream means no observation');

  // Speech end comes from the segment's own t1 on the stream clock; a pause
  // reported by the coverage lane on the same clock must not be inflated by
  // the preparation interval that preceded `listening`.
  const streamStartWallMs = 10_000;
  const report = summarizeCaptionTiming([
    { utteranceId: 'u1', stage: 'speech-end', at: 2.1 * 1_000 },
    { utteranceId: 'u1', stage: 'pause-detected', at: streamElapsedMs(12_340, streamStartWallMs) },
    { utteranceId: 'u1', stage: 'final-segment', at: streamElapsedMs(12_410, streamStartWallMs) },
  ]);
  assert.equal(report.utterances[0].pauseDetectionMs, 240);
  assert.equal(report.utterances[0].finalizationMs, 70);
});

test('only a listening session is relabelled as delayed by timing', () => {
  const delayed = summarizeCaptionTiming(utterance('u1', 0, 100, 5_000, 5_100));
  const live = summarizeCaptionTiming(utterance('u1', 0, 100, 200, 300));
  assert.equal(timingAdjustedStatus('listening', delayed), 'delayed');
  assert.equal(timingAdjustedStatus('listening', live), 'listening');
  for (const status of ['idle', 'preparing', 'stopping', 'stopped', 'unavailable', 'interrupted']) {
    assert.equal(timingAdjustedStatus(status, delayed), status);
  }
});

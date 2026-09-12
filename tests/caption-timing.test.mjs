import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COVERAGE_DELAY_MS,
  FINALIZATION_DELAY_MS,
  captionTimingReport,
  captionTimingState,
  reduceCaptionTiming,
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
  assert.deepEqual(report.lines, [
    'caption-timing: utterance=u1 pause_detection_ms=320 finalization_ms=780 coverage_processing_ms=100 state=live',
    'caption-timing: utterance=u2 pause_detection_ms=100 finalization_ms=1900 coverage_processing_ms=100 state=delayed',
  ]);
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

test('only a listening session is relabelled as delayed by timing', () => {
  const delayed = summarizeCaptionTiming(utterance('u1', 0, 100, 5_000, 5_100));
  const live = summarizeCaptionTiming(utterance('u1', 0, 100, 200, 300));
  assert.equal(timingAdjustedStatus('listening', delayed), 'delayed');
  assert.equal(timingAdjustedStatus('listening', live), 'listening');
  for (const status of ['idle', 'preparing', 'stopping', 'stopped', 'unavailable', 'interrupted']) {
    assert.equal(timingAdjustedStatus(status, delayed), status);
  }
});

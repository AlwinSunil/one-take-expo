import assert from 'node:assert/strict';
import test from 'node:test';

import { activeCaptionAt, partitionCaptionTimeline } from '../src/lib/caption-timeline.ts';
import { buildExportPlan, ExportPlanError } from '../src/lib/export-plan.ts';

function project(overrides = {}) {
  return {
    id: 'project-1',
    mode: 'assisted',
    videoUri: 'file:///private/original.mp4',
    clips: [],
    createdAt: 1,
    transcript: [],
    ...overrides,
  };
}

test('uses the selected trim, preserves corrected display text, and filters draft captions', () => {
  const result = buildExportPlan(project({
    transcript: [
      { id: 'one', t0: 1, t1: 2, text: 'raw one', manualCorrection: 'Edited one', isFinal: true },
      { id: 'draft', t0: 2.1, t1: 2.8, text: 'not ready', isFinal: false },
      { id: 'two', t0: 3, t1: 4, text: 'raw two', correctedText: 'Corrected two', isFinal: true },
    ],
  }), 0.5, 5);

  assert.deepEqual(result.cuts, [{ t0: 0.5, t1: 5 }]);
  assert.deepEqual(result.captions, [
    { t0: 1, t1: 2, text: 'Edited one' },
    { t0: 3, t1: 4, text: 'Corrected two' },
  ]);
  assert.equal(result.captionTiming, 'live-estimate');
  assert.equal(result.hasEstimatedCaptions, true);
  assert.equal(result.sourceUri, 'file:///private/original.mp4');
});

test('explicit project cuts override the current trim and retain their output order', () => {
  const result = buildExportPlan(project({
    cuts: [{ t0: 7, t1: 8 }, { t0: 1, t1: 3 }], cutsReviewed: true,
  }), 0, 10);
  assert.deepEqual(result.cuts, [{ t0: 7, t1: 8 }, { t0: 1, t1: 3 }]);
});

test('unreviewed project cuts cannot be sent to native export', () => {
  assert.throws(() => buildExportPlan(project({ cuts: [{ t0: 1, t1: 2 }] }), 0, 5), (error) =>
    error instanceof ExportPlanError && error.code === 'unreviewed-cuts'
    && error.message === 'Review and accept each cut before exporting.');
});

test('saved-audio timing is exportable without an estimated-timing warning', () => {
  const result = buildExportPlan(project({
    transcript: [{ id: 'saved', t0: 1, t1: 2, text: 'saved', isFinal: true, timingSource: 'saved-audio', source: 'refined' }],
  }), 0, 4);
  assert.equal(result.captionTiming, 'saved-audio');
  assert.equal(result.hasEstimatedCaptions, false);
});

test('a blank manual correction intentionally omits that caption', () => {
  const result = buildExportPlan(project({
    transcript: [
      { id: 'removed', t0: 1, t1: 2, text: 'remove this', manualCorrection: '   ', isFinal: true, timingSource: 'saved-audio' },
      { id: 'kept', t0: 2.5, t1: 3.5, text: 'keep this', isFinal: true, timingSource: 'saved-audio' },
    ],
  }), 0, 4);

  assert.deepEqual(result.captions, [{ t0: 2.5, t1: 3.5, text: 'keep this' }]);
  assert.equal(result.captionTiming, 'saved-audio');
  assert.equal(result.hasEstimatedCaptions, false);
});

test('caption gaps are retained while overlapping intervals are partitioned into cues', () => {
  const result = buildExportPlan(project({
    transcript: [
      { id: 'one', t0: 1, t1: 2, text: 'one', isFinal: true },
      { id: 'two', t0: 3, t1: 4, text: 'two', isFinal: true },
    ],
  }), 0, 5);
  assert.deepEqual(result.captions, [
    { t0: 1, t1: 2, text: 'one' },
    { t0: 3, t1: 4, text: 'two' },
  ]);

  const overlapping = buildExportPlan(project({
    transcript: [
      { id: 'one', t0: 1, t1: 3, text: 'one', isFinal: true },
      { id: 'two', t0: 2, t1: 4, text: 'two', isFinal: true },
    ],
  }), 0, 5);
  assert.deepEqual(overlapping.captions, [
    { t0: 1, t1: 2, text: 'one' },
    { t0: 2, t1: 3, text: 'one\ntwo' },
    { t0: 3, t1: 4, text: 'two' },
  ]);
});

test('caption partitioning skips drafts and blanks and keeps active text stable', () => {
  const cues = partitionCaptionTimeline([
    { t0: 0, t1: 2, text: 'first', isFinal: true },
    { t0: 1, t1: 3, text: 'second', isFinal: true },
    { t0: 1.5, t1: 2.5, text: '   ', isFinal: true },
    { t0: 2, t1: 4, text: 'draft', isFinal: false },
  ]);

  assert.deepEqual(cues, [
    { t0: 0, t1: 1, text: 'first' },
    { t0: 1, t1: 2, text: 'first\nsecond' },
    { t0: 2, t1: 3, text: 'second' },
  ]);
  assert.equal(activeCaptionAt(cues, 0.5)?.text, 'first');
  assert.equal(activeCaptionAt(cues, 1.5)?.text, 'first\nsecond');
  assert.equal(activeCaptionAt(cues, 2)?.text, 'second');
  assert.equal(activeCaptionAt(cues, 4), undefined);
});

test('caption partitioning rejects invalid source times without clamping them', () => {
  assert.throws(() => partitionCaptionTimeline([
    { t0: 3, t1: 2, text: 'backwards' },
  ]), /interval 1 is invalid/i);
  assert.throws(() => partitionCaptionTimeline([
    { t0: 0, t1: Number.POSITIVE_INFINITY, text: 'unbounded' },
  ]), /interval 1 is invalid/i);
});

test('nonfinite ranges and missing source media fail before an export request can start', () => {
  assert.throws(() => buildExportPlan(project(), Number.NaN, 2), /trim/i);
  assert.throws(() => buildExportPlan(project({
    transcript: [{ id: 'bad', t0: 1, t1: Infinity, text: 'bad', isFinal: true }],
  }), 0, 5), (error) => error instanceof ExportPlanError && error.code === 'invalid-caption');
  assert.throws(() => buildExportPlan(project({ videoUri: null }), 0, 5), (error) => error instanceof ExportPlanError && error.code === 'missing-source');
});

test('empty explicit cuts mean the complete source, as defined by the native export contract', () => {
  const result = buildExportPlan(project({ cuts: [] }), 2, 3);
  assert.deepEqual(result.cuts, []);
});

test('action directions and standalone scratch commands never become captions', () => {
  const result = buildExportPlan(project({ transcript: [
    { t0: 0, t1: 1, text: '[show product]' },
    { t0: 1, t1: 2, text: 'Scratch that!' },
    { t0: 2, t1: 3, text: 'Hello [wave] there', timingSource: 'saved-audio' },
    { t0: 3, t1: 4, text: 'Do not scratch that surface.', timingSource: 'saved-audio' },
  ] }), 0, 4);
  assert.deepEqual(result.captions, [
    { t0: 2, t1: 3, text: 'Hello there' },
    { t0: 3, t1: 4, text: 'Do not scratch that surface.' },
  ]);
  assert.equal(result.hasEstimatedCaptions, false);
});

test('reviewed multi-source segments preserve source-local captions and selection order', () => {
  const result = buildExportPlan(project({ videoUri: null, cutsReviewed: true, reviewSegments: [
    { uri: 'file:///pickup.mp4', t0: 0, t1: 2, captions: [{ t0: 0, t1: 1, text: 'Pickup [wave]' }], takeId: 'pickup' },
    { uri: 'file:///original.mp4', t0: 0, t1: 2, captions: [{ t0: 0, t1: 1, text: 'Original' }] },
  ] }), 0, 0);
  assert.deepEqual(result.segments.map(s => [s.uri, s.captions[0].text]), [['file:///pickup.mp4', 'Pickup'], ['file:///original.mp4', 'Original']]);
  assert.equal(result.sourceUri, 'file:///pickup.mp4');
  assert.deepEqual(result.captions, []);
  assert.throws(() => buildExportPlan(project({ cutsReviewed: true, reviewSegments: [] }), 0, 1), /at least one/);
});

test('reviewed pickup segments keep supplied captions when no transcript belongs to that source', () => {
  const result = buildExportPlan(project({
    recordings: [{ id: 'original', mediaUri: 'file:///private/original.mp4', duration: 5, createdAt: 1 }],
    transcript: [{ id: 'original-caption', recordingId: 'original', t0: 0, t1: 1, text: 'Original' }],
    cutsReviewed: true,
    reviewSegments: [{
      uri: 'file:///pickup.mp4',
      t0: 0,
      t1: 2,
      captions: [{ t0: 0, t1: 1, text: 'Pickup [wave]' }],
      takeId: 'pickup',
    }],
  }), 0, 0);

  assert.deepEqual(result.segments?.[0].captions, [{ t0: 0, t1: 1, text: 'Pickup' }]);
});

test('single-source export requires an explicitly inventoried media URI', () => {
  assert.throws(() => buildExportPlan(project({
    mediaMissing: false,
    availableMediaUris: ['file:///private/other.mp4'],
  }), 0, 5), (error) => error instanceof ExportPlanError
    && error.code === 'missing-source'
    && /unavailable/i.test(error.message));

  const result = buildExportPlan(project({
    mediaMissing: false,
    availableMediaUris: ['file:///private/original.mp4'],
  }), 0, 5);
  assert.equal(result.sourceUri, 'file:///private/original.mp4');
});

test('legacy export excludes overlapping pickup captions using recording and take ownership', () => {
  const result = buildExportPlan(project({
    recordings: [{ id: 'original', mediaUri: 'file:///private/original.mp4' }, { id: 'pickup', mediaUri: 'file:///pickup.mp4' }],
    takes: [{ id: 'pickup-take', mediaUri: 'file:///pickup.mp4', transcriptSegmentIds: ['pickup-linked'] }],
    transcript: [
      { id: 'primary', recordingId: 'original', t0: 0, t1: 1, text: 'Original' },
      { id: 'pickup', recordingId: 'pickup', t0: 0, t1: 1, text: 'Wrong source' },
      { id: 'pickup-linked', t0: 1, t1: 2, text: 'Also wrong source' },
      { id: 'legacy', t0: 1, t1: 2, text: 'Legacy original' },
    ],
  }), 0, 2);
  assert.deepEqual(result.captions.map(caption => caption.text), ['Original', 'Legacy original']);
});

import assert from 'node:assert/strict';
import test from 'node:test';

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

test('caption gaps are retained while overlapping caption intervals are rejected', () => {
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

  assert.throws(() => buildExportPlan(project({
    transcript: [
      { id: 'one', t0: 1, t1: 3, text: 'one', isFinal: true },
      { id: 'two', t0: 2, t1: 4, text: 'two', isFinal: true },
    ],
  }), 0, 5), (error) => error instanceof ExportPlanError && error.code === 'caption-overlap');
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

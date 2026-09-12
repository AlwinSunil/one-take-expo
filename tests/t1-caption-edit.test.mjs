import assert from 'node:assert/strict';
import test from 'node:test';

import {
  StaleCaptionEditError,
  beginCaptionWordEdit,
  captionDisplayText,
  clearCaptionCorrection,
  replaceCaptionWord,
  saveCaptionWordEdit,
  splitCaptionWords,
  undoCaptionWordEdit,
} from '../src/lib/t1-caption-edit.ts';
import { buildExportPlan } from '../src/lib/export-plan.ts';

function segment(overrides = {}) {
  return {
    id: 'segment-1',
    t0: 1.25,
    t1: 2.5,
    text: 'the pixel nine',
    rawText: 'the pixel nine',
    manualCorrection: null,
    revision: 4,
    isFinal: true,
    ...overrides,
  };
}

test('word tokens expose source ranges while leaving punctuation in the caption', () => {
  const text = "Hello, creator's world!";
  const words = splitCaptionWords(text);

  assert.deepEqual(words.map(({ index, text: value, start, end }) => ({ index, value, start, end })), [
    { index: 0, value: 'Hello', start: 0, end: 5 },
    { index: 1, value: "creator's", start: 7, end: 16 },
    { index: 2, value: 'world', start: 17, end: 22 },
  ]);
  assert.equal(replaceCaptionWord(text, 0, 'Hi'), "Hi, creator's world!");
  assert.equal(replaceCaptionWord(text, 1, 'maker'), 'Hello, maker world!');
});

test('saving a word correction changes only the display correction and keeps raw evidence', () => {
  const original = segment();
  const draft = beginCaptionWordEdit(original, 2);
  const result = saveCaptionWordEdit([original], draft, '9');

  assert.equal(result.edit.segmentId, original.id);
  assert.equal(result.edit.beforeWord, 'nine');
  assert.equal(result.edit.afterWord, '9');
  assert.equal(result.segments[0].manualCorrection, 'the pixel 9');
  assert.equal(captionDisplayText(result.segments[0]), 'the pixel 9');
  assert.equal(result.segments[0].text, original.text);
  assert.equal(result.segments[0].rawText, original.rawText);
  assert.equal(result.segments[0].revision, original.revision);
  assert.equal(result.segments[0].t0, original.t0);
  assert.equal(result.segments[0].t1, original.t1);
});

test('a saved correction survives project-style serialization and reopen', () => {
  const original = segment({ manualCorrection: 'the pixel nine' });
  const draft = beginCaptionWordEdit(original, 2);
  const saved = saveCaptionWordEdit([original], draft, '9').segments[0];
  const reopened = JSON.parse(JSON.stringify(saved));

  assert.equal(captionDisplayText(reopened), 'the pixel 9');
  assert.equal(reopened.text, 'the pixel nine');
  assert.equal(reopened.rawText, 'the pixel nine');
});

test('the saved display correction is the caption text supplied to export', () => {
  const original = segment();
  const saved = saveCaptionWordEdit(
    [original],
    beginCaptionWordEdit(original, 2),
    '9',
  ).segments[0];
  const plan = buildExportPlan({
    id: 'project-1',
    mode: 'assisted',
    videoUri: 'file:///private/original.mp4',
    clips: [],
    createdAt: 1,
    transcript: [saved],
  }, 0, 4);

  assert.deepEqual(plan.captions, [{ t0: 1.25, t1: 2.5, text: 'the pixel 9' }]);
  assert.equal(saved.text, 'the pixel nine');
});

test('stale recognition revisions cannot receive a word correction prepared for an older segment', () => {
  const original = segment();
  const draft = beginCaptionWordEdit(original, 2);
  const refined = segment({ text: 'the pixel 10', rawText: 'the pixel 10', revision: 5 });

  assert.throws(
    () => saveCaptionWordEdit([refined], draft, '9'),
    (error) => error instanceof StaleCaptionEditError && error.code === 'STALE_SEGMENT',
  );
});

test('a changed display correction is stale even when its recognition revision is unchanged', () => {
  const original = segment({ manualCorrection: 'the pixel 9' });
  const draft = beginCaptionWordEdit(original, 2);
  const changed = segment({ manualCorrection: 'the pixel ten' });

  assert.throws(
    () => saveCaptionWordEdit([changed], draft, '10'),
    (error) => error instanceof StaleCaptionEditError && /display text changed/.test(error.message),
  );
});

test('undo restores the previous correction and never rewrites spoken evidence', () => {
  const original = segment({ manualCorrection: 'the pixel nine' });
  const draft = beginCaptionWordEdit(original, 2);
  const saved = saveCaptionWordEdit([original], draft, '9');
  const undone = undoCaptionWordEdit(saved.segments, saved.edit);

  assert.equal(undone[0].manualCorrection, 'the pixel nine');
  assert.equal(captionDisplayText(undone[0]), 'the pixel nine');
  assert.equal(undone[0].text, original.text);
  assert.equal(undone[0].rawText, original.rawText);
});

test('undo rejects an edit after a newer correction has replaced it', () => {
  const original = segment();
  const first = saveCaptionWordEdit(
    [original],
    beginCaptionWordEdit(original, 2),
    '9',
  );
  const second = saveCaptionWordEdit(
    first.segments,
    beginCaptionWordEdit(first.segments[0], 2),
    'ten',
  );

  assert.throws(
    () => undoCaptionWordEdit(second.segments, first.edit),
    (error) => error instanceof StaleCaptionEditError && error.code === 'STALE_SEGMENT',
  );
});

test('clearing a persisted correction restores recognized display after reopen', () => {
  const corrected = segment({ manualCorrection: 'the pixel 9' });
  const restored = clearCaptionCorrection([corrected], corrected.id, 'the pixel 9');

  assert.equal(restored[0].manualCorrection, null);
  assert.equal(captionDisplayText(restored[0]), 'the pixel nine');
  assert.equal(restored[0].text, corrected.text);
  assert.equal(restored[0].rawText, corrected.rawText);
});

test('word saves require a single non-empty replacement and a real segment', () => {
  const original = segment();
  const draft = beginCaptionWordEdit(original, 2);

  assert.throws(() => saveCaptionWordEdit([original], draft, ''), /non-empty/);
  assert.throws(() => saveCaptionWordEdit([original], draft, 'two words'), /single word/);
  assert.throws(() => beginCaptionWordEdit(original, 4), /word index/);
  assert.throws(() => saveCaptionWordEdit([], draft, '9'), /unknown caption segment/);
});

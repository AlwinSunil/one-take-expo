import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildTimelineEditorCaptions, buildTimelineExportPlan, buildExportPlan, freezeExportPlan } from '../src/lib/export-plan.ts';
import { mapExportCaptions } from '../modules/one-take-media/timeline.ts';

const source = 'file:///original.mp4';
const pickup = 'file:///pickup.mp4';
function fixture() {
  return { id: 'project', mode: 'assisted', createdAt: 1, clips: [], videoUri: source,
    recordings: [{ id: 's', mediaUri: source, duration: 8 }, { id: 'p', mediaUri: pickup, duration: 4 }],
    availableMediaUris: [source, pickup],
    transcript: [
      { id: 'a', recordingId: 's', t0: 0, t1: 4, text: 'raw original', manualCorrection: 'Corrected whole phrase', timingSource: 'saved-audio' },
      { id: 'b', recordingId: 'p', t0: 0, t1: 2, text: 'Pickup phrase', timingSource: 'saved-audio' },
      { id: 'c', recordingId: 's', t0: 5, t1: 8, text: 'Excluded phrase' },
    ] };
}
// B resolver output fixture: reorder pickup first, then a trim split mid-cue.
// Excluded clip s[5,8) is absent, exactly as B's included resolver contract requires.
function sequence() {
  return { revision: 7, issues: [], duration: 5, segments: [
    { clipId: 'pickup', sourceId: 'p', uri: pickup, t0: 0, t1: 2, outputT0: 0, outputT1: 2 },
    { clipId: 'left', sourceId: 's', uri: source, t0: 1, t1: 2, outputT0: 2, outputT1: 3 },
    { clipId: 'right', sourceId: 's', uri: source, t0: 2, t1: 4, outputT0: 3, outputT1: 5 },
  ] };
}
function mapped(plan) {
  let offset = 0;
  return plan.segments.flatMap(segment => {
    const result = mapExportCaptions(segment.captions, [segment]).map(cue => ({ ...cue, t0: cue.t0 + offset, t1: cue.t1 + offset }));
    offset += segment.t1 - segment.t0;
    return result;
  });
}
test('four independent choices preserve source text/corrections and identical selected video', () => {
  const project = fixture();
  const before = structuredClone(project);
  let video;
  for (const showInEditor of [false, true]) for (const burnIntoExport of [false, true]) {
    const plan = buildTimelineExportPlan(project, sequence(), burnIntoExport);
    const intervals = plan.segments.map(({ captions, ...segment }) => segment);
    video ??= intervals;
    assert.deepEqual(intervals, video);
    assert.equal(plan.timelineRevision, 7);
    assert.equal(plan.burnIntoExport, burnIntoExport);
    assert.equal(mapped(plan).length, burnIntoExport ? 3 : 0);
    // Display choice does not enter export selection or touch project data.
    const preview = buildTimelineEditorCaptions(project, sequence(), showInEditor);
    assert.equal(preview.length, showInEditor ? 3 : 0);
    assert.deepEqual(project, before);
  }
});
test('overlapping source clocks, reorder, trim, pickup and mid-cue split retain whole corrected text', () => {
  assert.deepEqual(mapped(buildTimelineExportPlan(fixture(), sequence(), true)), [
    { t0: 0, t1: 2, text: 'Pickup phrase' },
    { t0: 2, t1: 3, text: 'Corrected whole phrase' },
    { t0: 3, t1: 5, text: 'Corrected whole phrase' },
  ]);
});
test('empty or invalid included sequences reject before native dispatch without original fallback', () => {
  for (const burn of [false, true]) {
    assert.throws(() => buildTimelineExportPlan(fixture(), { ...sequence(), segments: [], duration: 0 }, burn), /at least one clip/);
    assert.throws(() => buildTimelineExportPlan(fixture(), { ...sequence(), issues: ['missing source'] }, burn), /Resolve timeline/);
  }
  const bad = sequence(); bad.segments[0].outputT1 = 3;
  assert.throws(() => buildTimelineExportPlan(fixture(), bad, false), /inconsistent/);
});
test('whole displayed proposal exports without per-exclusion cutsReviewed approval', () => {
  const project = { ...fixture(), cutsReviewed: false, cuts: [{ t0: 5, t1: 8 }] };
  assert.equal(buildTimelineExportPlan(project, sequence(), false).segments.length, 3);
});
test('selected request stays frozen through later edits, correction changes and source relocation', () => {
  const project = fixture(); const selected = sequence();
  const plan = buildTimelineExportPlan(project, selected, true);
  const before = structuredClone(plan);
  selected.revision++; selected.segments.reverse(); selected.segments[0].t0 = 3;
  project.transcript[0].manualCorrection = 'Later correction'; project.recordings[0].mediaUri = 'file:///relocated.mp4';
  assert.deepEqual(plan, before);
  assert.throws(() => { plan.segments[0].t0 = 9; }, TypeError);
  const legacy = buildExportPlan(fixture(), 0, 4);
  const frozen = freezeExportPlan(legacy); legacy.cuts[0].t0 = 3;
  assert.equal(frozen.cuts[0].t0, 0);
});
test('pending and unavailable captions permit captionless export and never fabricate text', () => {
  const project = fixture();
  project.transcript = [{ recordingId: 's', t0: 0, t1: 4, text: 'provisional', isFinal: false }];
  assert.deepEqual(mapped(buildTimelineExportPlan(project, sequence(), true)), []);
  project.transcript = [];
  assert.deepEqual(mapped(buildTimelineExportPlan(project, sequence(), true)), []);
  project.transcript = null;
  assert.deepEqual(mapped(buildTimelineExportPlan(project, sequence(), false)), []);
  project.transcript = [{ recordingId: 's', t0: 0, t1: 4, text: null }];
  assert.deepEqual(mapped(buildTimelineExportPlan(project, sequence(), false)), []);
});
test('missing inventory, mismatched identity and out-of-source trim block both burn modes', () => {
  for (const burn of [false, true]) {
    assert.throws(() => buildTimelineExportPlan({ ...fixture(), availableMediaUris: [source] }, sequence(), burn), /unavailable/);
    const bad = sequence(); bad.segments[0].sourceId = 's';
    assert.throws(() => buildTimelineExportPlan(fixture(), bad, burn), /unavailable/);
    const project = fixture(); project.recordings[1].duration = 1;
    assert.throws(() => buildTimelineExportPlan(project, sequence(), burn), /duration/);
  }
});

test('stable source IDs isolate captions even if two source records alias the same URI', () => {
  const project = fixture();
  project.recordings[1].mediaUri = source;
  const selected = sequence(); selected.segments[0].uri = source;
  const plan = buildTimelineExportPlan(project, selected, true);
  assert.deepEqual(mapped(plan), [
    { t0: 0, t1: 2, text: 'Pickup phrase' },
    { t0: 2, t1: 3, text: 'Corrected whole phrase' },
    { t0: 3, t1: 5, text: 'Corrected whole phrase' },
  ]);
});

test('framing remains source-ID scoped and identical in both caption modes', () => {
  const row = JSON.parse(readFileSync(new URL('../tools/fixtures/t1-framing.json', import.meta.url))).cases[0].input;
  const project = fixture();
  project.recordings = [{ id: row.sourceMediaId, mediaUri: source, duration: 8 }, { id: 'alias', mediaUri: source, duration: 8 }];
  project.framing = { enabled: true, suggestions: row.suggestions };
  project.transcript = [];
  const selected = { revision: 8, duration: 6, issues: [], segments: [
    { clipId: 'first', sourceId: row.sourceMediaId, uri: source, takeId: 'take-1', t0: 2, t1: 5, outputT0: 0, outputT1: 3 },
    { clipId: 'alias', sourceId: 'alias', uri: source, takeId: 'take-1', t0: 2, t1: 5, outputT0: 3, outputT1: 6 },
  ] };
  for (const burn of [true, false]) {
    const plan = buildTimelineExportPlan(project, selected, burn, true);
    assert.deepEqual(plan.segments[0].crop, row.expected.nativeCrop);
    assert.equal(plan.segments[1].crop, undefined);
  }
});

test('missing or stale source availability cannot bypass export validation', () => {
  for (const burn of [true, false]) {
    assert.throws(() => buildTimelineExportPlan({ ...fixture(), mediaMissing: true, availableMediaUris: undefined }, sequence(), burn), /unavailable/);
    assert.throws(() => buildTimelineExportPlan({ ...fixture(), availableMediaUris: undefined }, sequence(), burn), /unavailable/);
    // Primary-source absence does not prevent an independently inventoried pickup export.
    const selected = sequence(); selected.segments = selected.segments.slice(0, 1); selected.duration = 2;
    assert.equal(buildTimelineExportPlan({ ...fixture(), mediaMissing: true, availableMediaUris: [pickup] }, selected, burn).segments.length, 1);
  }
});

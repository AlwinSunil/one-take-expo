import test from 'node:test';
import assert from 'node:assert/strict';
import { hasMultipleRecordingSources, transcriptForSource } from '../src/lib/review-source.ts';
import { reviewExportSelection } from '../src/lib/review-export-selection.ts';
const primary = { id: 'primary-caption', t0: 0, t1: 2, text: 'Original words' };
const pickup = { id: 'pickup-caption', recordingId: 'pickup', t0: 0, t1: 2, text: 'Pickup words' };
const project = { videoUri: 'file:///raw.mp4', transcript: [primary, pickup], recordings: [{ id: 'primary', mediaUri: 'file:///raw.mp4' }, { id: 'pickup', mediaUri: 'file:///pickup.mp4' }] };
test('source-local overlapping timestamps do not mix captions in raw/manual preview', () => {
  assert.deepEqual(transcriptForSource(project, project.videoUri), [primary]);
  assert.deepEqual(transcriptForSource(project, 'file:///pickup.mp4'), [pickup]);
  assert.deepEqual(reviewExportSelection(project, 'trim', true).transcript, [primary]);
});
test('legacy take references disambiguate source and unknown recording ids stay excluded', () => {
  const p = { ...project, transcript: [{ ...pickup, recordingId: undefined }, { ...primary, recordingId: 'unknown' }], takes: [{ mediaUri: 'file:///pickup.mp4', transcriptSegmentIds: [pickup.id] }] };
  assert.deepEqual(transcriptForSource(p, project.videoUri), []);
  assert.equal(transcriptForSource(p, 'file:///pickup.mp4').length, 1);
});
test('source-aware refinement guard permits legacy recording and blocks merged projects', () => {
  assert.equal(hasMultipleRecordingSources(project), true);
  const legacy = { videoUri: project.videoUri, transcript: [primary] };
  assert.equal(hasMultipleRecordingSources(legacy), false);
  assert.deepEqual(transcriptForSource(legacy, legacy.videoUri), [primary]);
});

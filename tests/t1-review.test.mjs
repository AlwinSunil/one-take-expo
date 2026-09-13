import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReviewFootage, chooseReviewTake } from '../src/lib/t1-review.ts';
const project = { id: 'p', mediaMissing: false, mode: 'script', script: 'Hello world.', duration: 5, videoUri: 'file:///original.mp4', clips: [], createdAt: 0, transcript: [{id: 's', t0: 1, t1: 3, text: 'Hello world.', isFinal: true}] };
test('take choice preserves original and raw evidence, and requires reviewed cuts again', () => {
  const next = chooseReviewTake({...project, cutsReviewed: true}, 'p:line:0', 'take:s');
  assert.equal(next.videoUri, project.videoUri);
  assert.deepEqual(next.transcript, project.transcript);
  assert.equal(next.cutsReviewed, false);
  assert.equal(next.reviewDecisions.length, 1);
});
test('missing, foreign and out-of-range footage cannot be previewed or selected', () => {
  const reference = {recordingId:'p', t0:1, t1:3};
  assert.equal(canReviewFootage(project, reference), true);
  for (const value of [{...project, mediaMissing:true}, {...project, mediaMissing:undefined}, {...project, videoUri:null}, {...project, duration:undefined}]) {
    assert.equal(canReviewFootage(value, reference), false);
    assert.throws(() => chooseReviewTake(value, 'p:line:0', 'take:s'), /unavailable/);
  }
  assert.equal(canReviewFootage(project, {...reference, recordingId:'pickup'}), false);
  assert.equal(canReviewFootage(project, {...reference, t1:6}), false);
});

import { buildExportPlan } from '../src/lib/export-plan.ts';
test('stale URI marked missing cannot start an export', () => {
  assert.throws(() => buildExportPlan({...project, mediaMissing:true}, {...project, mediaMissing:undefined}, 0, 5), /unavailable/);
});

test('prepared multi-source export picks reopened word corrections rather than stale caption snapshots', () => {
  const value = { ...project, recordings: [{id:'pickup', mediaUri:'file:///pickup.mp4', duration:5, createdAt:1}], availableMediaUris:['file:///pickup.mp4'], cutsReviewed:true,
    transcript:[{id:'p1',recordingId:'pickup',t0:1,t1:3,text:'raw speech',manualCorrection:'corrected caption',isFinal:true}],
    reviewSegments:[{uri:'file:///pickup.mp4',t0:1,t1:3,captions:[{t0:1,t1:3,text:'stale caption'}]}] };
  const plan = buildExportPlan(JSON.parse(JSON.stringify(value)), 0, 5);
  assert.equal(plan.segments[0].captions[0].text, 'corrected caption');
  assert.equal(value.transcript[0].text, 'raw speech');
});
test('pickup evidence resolves only through the refreshed source inventory', () => {
  const value = {...project, recordings:[{id:'pickup',mediaUri:'file:///pickup.mp4',duration:5,createdAt:1}]};
  const reference = {recordingId:'pickup',t0:1,t1:3};
  assert.equal(canReviewFootage(value, reference), false);
  assert.equal(canReviewFootage({...value,availableMediaUris:['file:///pickup.mp4']},reference), true);
  assert.equal(canReviewFootage({...value,availableMediaUris:[]},reference), false);
});

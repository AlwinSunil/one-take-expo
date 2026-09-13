import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyProjectFraming } from '../src/lib/t1-framing-selection.ts';
import { buildExportPlan } from '../src/lib/export-plan.ts';
const row = JSON.parse(readFileSync(new URL('../tools/fixtures/t1-framing.json', import.meta.url))).cases[0].input;
const project = {id:row.sourceMediaId,mode:'assisted',createdAt:0,clips:[],duration:12,videoUri:'file:///source.mp4',mediaMissing:false,transcript:[{t0:2,t1:5,text:'corrected caption',isFinal:true}], cutsReviewed:true,framing:{enabled:true,suggestions:row.suggestions}, reviewSegments:[{uri:'file:///source.mp4',takeId:'take-1',t0:2,t1:5}]};
test('preview and export reuse identical static crop and reset retains original media', () => {
  const preview = applyProjectFraming(project, project.reviewSegments, true);
  const exported = buildExportPlan(project, 0, 12, true);
  assert.deepEqual(exported.segments[0].crop, preview[0].crop);
  assert.deepEqual(preview[0].crop, row.expected.nativeCrop);
  assert.equal(applyProjectFraming(project,preview,false)[0].crop, undefined);
  assert.equal(buildExportPlan(project,0,12).segments[0].crop, undefined);
  assert.equal(project.videoUri,'file:///source.mp4');
});
test('missing media and changed cut intervals fall back without reusing an old crop', () => {
  assert.equal(applyProjectFraming({...project,mediaMissing:true},project.reviewSegments,true)[0].crop,undefined);
  assert.equal(applyProjectFraming(project,[{...project.reviewSegments[0],t1:6,crop:row.expected.nativeCrop}],true)[0].crop,undefined);
});

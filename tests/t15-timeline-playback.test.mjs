import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewFromPosition, shouldProtectTimelineBack } from '../src/features/timeline/playback.ts';
const segments = [
  { clipId:'A',sourceId:'original',uri:'original',t0:2,t1:4,outputT0:0,outputT1:2,captions:[{t0:2,t1:4,text:'A'}]},
  { clipId:'B',sourceId:'pickup',uri:'pickup',t0:2,t1:5,outputT0:2,outputT1:5,captions:[{t0:2,t1:5,text:'B'}]},
];
test('seek slices only the native preview request and retains source-local caption identity', () => {
  const original = structuredClone(segments);
  const request = previewFromPosition(segments, 3);
  assert.equal(request.offset,3);
  assert.equal(request.segments.length,1);
  assert.equal(request.segments[0].sourceId,'pickup');
  assert.equal(request.segments[0].t0,3);
  assert.equal(request.segments[0].t1,5);
  assert.equal(request.segments[0].captions[0].text,'B');
  assert.deepEqual(segments,original);
});
test('excluded empty sequence never becomes raw preview; replay after end starts at zero', () => {
  assert.deepEqual(previewFromPosition([],0), { segments:[],offset:0 });
  assert.deepEqual(previewFromPosition(segments,5).segments,segments);
  assert.equal(previewFromPosition(segments,2).segments[0].sourceId,'pickup');
  assert.throws(()=>previewFromPosition(segments,NaN),/valid/);
});
test('Back retains unsaved changes during edits, failed saves and in-flight save', () => {
  for (const status of ['dirty','saving','error']) assert.equal(shouldProtectTimelineBack(status),true);
  assert.equal(shouldProtectTimelineBack('saved'),false);
});

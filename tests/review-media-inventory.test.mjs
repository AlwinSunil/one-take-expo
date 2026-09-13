import test from 'node:test';
import assert from 'node:assert/strict';
import {projectForMediaReview,preserveStoredMediaEvidence} from '../src/lib/review-media-inventory.ts';
import {projectReview} from '../src/lib/project-workflow.ts';
test('failed pickup is unavailable in both legacy review and Tier 1 inventory',()=>{
 const p={id:'p',mode:'script',script:'Hello.',createdAt:0,clips:[],videoUri:'file:///a',mediaMissing:false,availableMediaUris:['file:///a','file:///b'],transcript:[{id:'s',text:'Hello.',t0:0,t1:1,isFinal:true}],takes:[{id:'take',t0:0,t1:1,mediaUri:'file:///b',playable:true,quality:'clean',inFrame:true,transcriptSegmentIds:['s']}]};
 const next=projectForMediaReview(p,['file:///b']);
 assert.equal(projectReview(next).takes[0].playable,false);assert.notEqual(projectReview(next).lines[0].status,'covered');
 assert.equal(next.mediaMissing,false);assert.equal(p.takes[0].playable,true);assert.equal(next.takes[0].mediaUri,'file:///b');
});
test('explicit empty inventory overrides a stale primary presence flag',()=>{
 const p={id:'p',mode:'script',script:'Hello.',createdAt:0,clips:[],videoUri:'file:///gone',mediaMissing:false,availableMediaUris:[],transcript:[{id:'s',text:'Hello.',t0:0,t1:1,isFinal:true}]};
 assert.equal(projectForMediaReview(p).mediaMissing,true);assert.equal(projectReview(projectForMediaReview(p)).takes[0].playable,false);
});

test('saving a review projection retains stored playability for later file recovery',()=>{
 const p={id:'p',mode:'script',createdAt:0,clips:[],transcript:[],videoUri:'file:///a',mediaMissing:false,availableMediaUris:['file:///a'],takes:[{id:'take',mediaUri:'file:///a',playable:true}]};
 const projected=projectForMediaReview(p,['file:///a']);
 assert.equal(projected.takes[0].playable,false);
 const saved=preserveStoredMediaEvidence(p,{...projected,trim:{start:0,end:1}});
 assert.equal(saved.takes[0].playable,true);assert.deepEqual(saved.trim,{start:0,end:1});
});

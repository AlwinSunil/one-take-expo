import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProjectEdit } from '../src/lib/project-edit-merge.ts';
const base = { id: 'p', mode: 'script', videoUri: 'file:///original.mp4', clips: [], createdAt: 1, transcript: [{id:'a',t0:0,t1:1,text:'raw a'},{id:'b',t0:1,t1:2,text:'raw b'}], scriptLines:[{id:'line',spokenText:'raw a',actionCues:[{id:'cue',text:'show',required:true,resolved:false}]}] };
test('fast legacy keystrokes retain the latest caption and intervening action confirmation', () => {
 const first = mergeProjectEdit(base, base, {...base,transcript:base.transcript.map((s,i)=>i? s:{...s,manualCorrection:'w'})});
 const action = mergeProjectEdit(base, first, {...base,scriptLines:[{...base.scriptLines[0],actionCues:[{...base.scriptLines[0].actionCues[0],resolved:true}]}]});
 const last = mergeProjectEdit(base, action, {...base,transcript:base.transcript.map((s,i)=>i?s:{...s,manualCorrection:'word'})});
 assert.equal(last.transcript[0].manualCorrection,'word');assert.equal(last.scriptLines[0].actionCues[0].resolved,true);assert.equal(last.transcript[0].text,'raw a');
});
test('top Save and wrap snapshots preserve earlier caption corrections', () => {
 const corrected = {...base,transcript:[{...base.transcript[0],manualCorrection:'fixed'},base.transcript[1]]};
 const saved = mergeProjectEdit(base,corrected,{...base,trim:{start:0,end:2}});
 const wrapped=mergeProjectEdit(base,saved,{...base,wrapAcknowledgement:{evidenceRevision:'r',acknowledgedAt:2,remainingFlags:['pending']}});
 assert.equal(wrapped.transcript[0].manualCorrection,'fixed');assert.deepEqual(wrapped.trim,{start:0,end:2});assert.equal(wrapped.videoUri,base.videoUri);
});
test('edits to different caption identities preserve each other',()=>{
 const first={...base,transcript:[{...base.transcript[0],manualCorrection:'first'},base.transcript[1]]};
 const next={...base,transcript:[base.transcript[0],{...base.transcript[1],manualCorrection:'second'}]};
 assert.deepEqual(mergeProjectEdit(base,first,next).transcript.map(s=>s.manualCorrection),['first','second']);
 assert.throws(()=>mergeProjectEdit(base,first,{...next,id:'other'}));
});

test('stale row edit preserves intervening additions and removals',()=>{
 const current={...base,transcript:[base.transcript[0],{id:'c',t0:2,t1:3,text:'new'}]};
 const next={...base,transcript:[{...base.transcript[0],manualCorrection:'fixed'},base.transcript[1]]};
 const result=mergeProjectEdit(base,current,next);
 assert.deepEqual(result.transcript.map(s=>s.id),['a','c']);assert.equal(result.transcript[0].manualCorrection,'fixed');
});

test('stale caption corrections cannot resurrect transcript rows removed by refinement', () => {
 const current = {...base, transcript: [base.transcript[0]]};
 const stale = {...base, transcript: [base.transcript[0], {...base.transcript[1], manualCorrection: 'late edit'}]};
 const result = mergeProjectEdit(base, current, stale);
 assert.deepEqual(result.transcript, current.transcript);
 assert.equal(result.videoUri, base.videoUri);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveVisionFrame } from '../src/features/vision/frame-receipt.ts';
import { beginVisionSession, createVisionState, toVisionEvidence } from '../src/features/vision/state.ts';
const event = {sessionId:'one',lensFacing:'front',frameId:1,frameCapturedAtMs:10000,frameEmittedAtMs:10020,facePresent:true,stable:true,faces:[]};
test('a fresh frame uses its own receipt clock instead of the previous250ms timer tick',()=>{
 const initial=beginVisionSession(createVisionState(),'one','front');
 const first=receiveVisionFrame(initial,event,null,100);
 assert.equal(toVisionEvidence(first.state,first.nowMs).status,'ready');
 const next=receiveVisionFrame(first.state,{...event,frameId:2,frameCapturedAtMs:10200,frameEmittedAtMs:10220},first.clockOffsetMs,300);
 // The last timer tick was250; comparing it with capture280 falsely declares this fresh frame stale.
 assert.equal(toVisionEvidence(next.state,250).status,'unavailable');
 assert.equal(toVisionEvidence(next.state,next.nowMs).status,'ready');
 assert.equal(next.clockOffsetMs,first.clockOffsetMs);
 assert.equal(toVisionEvidence(next.state,781).status,'unavailable');
});
test('clock publication does not hide native inference delay or future capture timestamps',()=>{
 const initial=beginVisionSession(createVisionState(),'one','front');
 const delayed=receiveVisionFrame(initial,{...event,frameEmittedAtMs:10600},null,700);
 assert.equal(toVisionEvidence(delayed.state,delayed.nowMs).status,'unavailable');
 const future=receiveVisionFrame(initial,{...event,frameCapturedAtMs:10030},null,100);
 assert.equal(toVisionEvidence(future.state,future.nowMs).status,'unavailable');
});

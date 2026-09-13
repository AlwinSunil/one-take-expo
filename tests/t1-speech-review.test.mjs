import test from 'node:test';
import assert from 'node:assert/strict';
import {projectWithSpeechEvidence} from '../src/lib/t1-speech-review.ts';
const p={id:'p',mode:'script',createdAt:0,clips:[],transcript:[],videoUri:'file:///original.mp4',tier1Evidence:{version:1,revision:'old'},speechControl:{version:99}};
test('malformed present speech envelope cannot reuse an older all-clear snapshot',()=>{
 const r=projectWithSpeechEvidence(p,true);assert.ok(r.error);assert.equal(r.project.tier1Evidence,undefined);assert.equal(r.project.videoUri,p.videoUri);assert.equal(r.project.speechControl,p.speechControl);assert.equal(p.tier1Evidence.revision,'old');
});
test('gated and legacy projects preserve their existing review path',()=>{assert.equal(projectWithSpeechEvidence(p).project,p);const {speechControl,...legacy}=p;assert.equal(projectWithSpeechEvidence(legacy,true).project,legacy);});

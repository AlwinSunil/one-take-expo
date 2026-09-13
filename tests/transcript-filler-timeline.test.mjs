import test from 'node:test';
import assert from 'node:assert/strict';
import { fillerTimelineMarks } from '../src/lib/transcript-filler-timeline.ts';
const project = {id:'p',mode:'assisted',createdAt:0,clips:[],videoUri:'file:///original.mp4',transcript:[
 {id:'a',text:'um',t0:1,t1:2}, {id:'b',recordingId:'pickup',text:'uh',t0:2,t1:3}],
 recordings:[{id:'p:original',mediaUri:'file:///original.mp4',duration:10,createdAt:0},{id:'pickup',mediaUri:'file:///pickup.mp4',duration:5,createdAt:1}]};
test('timeline markers follow only the selected recording',()=>{
 const marks=fillerTimelineMarks(project,[{uri:project.videoUri,t0:0,t1:10}]);
 assert.equal(marks.length,1); assert.equal(marks[0].label.toLowerCase(),'um'); assert.equal(marks[0].sourceUri,project.videoUri);
});
test('clean sequence maps each source into output time and omits removed fillers',()=>{
 const marks=fillerTimelineMarks(project,[{uri:project.videoUri,t0:4,t1:6},{uri:'file:///pickup.mp4',t0:1,t1:4}]);
 assert.equal(marks.length,1); assert.equal(marks[0].t0,3); assert.equal(marks[0].sourceTime,2);
 assert.equal(marks[0].sourceUri,'file:///pickup.mp4');
});

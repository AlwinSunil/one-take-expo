import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAutomaticEdit, applyAutomaticEdit, automaticEditCurrent, automaticMissingLines } from '../src/lib/automatic-edit.ts';
import { normalizeProject } from '../src/lib/project-data.ts';
const seg = (id, text, t0, t1) => ({ id, text, t0, t1, isFinal: true });
const project = (extra = {}) => ({ id: 'p', mode: 'script', videoUri: 'file:///p.mp4', duration: 12, createdAt: 0, clips: [], transcript: [], ...extra });
const duration = p => p.reviewSegments.reduce((sum, c) => sum + c.t1 - c.t0, 0);
test('retakes stay excluded and remain restorable from the timeline', () => {
  const p = project({ cuts: [{ t0: 0, t1: 2 }, { t0: 5, t1: 12 }], cutsReviewed: true });
  const next = applyAutomaticEdit(p, buildAutomaticEdit(p));
  assert.equal(duration(next), 9);
  assert.equal(next.automaticEdit.clips.find(c => c.t0 === 2).included, false);
  assert.deepEqual(normalizeProject(JSON.parse(JSON.stringify(next))).automaticEdit, JSON.parse(JSON.stringify(next.automaticEdit)));
  const restored = next.automaticEdit.clips.map(c => ({ ...c, included: true, manual: true }));
  const saved = applyAutomaticEdit(next, { ...next.automaticEdit, clips: restored });
  assert.equal(duration(saved), 12);
  assert.equal(automaticEditCurrent(saved), true);
});
test('long measured silence is shortened with breathing room; short pauses stay', () => {
  const p = project();
  const next = applyAutomaticEdit(p, buildAutomaticEdit(p, { p: { quiet: [{ t0: 2, t1: 5 }, { t0: 7, t1: 7.7 }] } }));
  assert.ok(Math.abs(duration(next) - 9.32) < 0.001);
  assert.equal(next.automaticEdit.clips.find(c => c.reason === 'silence').t0, 2.16);
});
test('isolated vocal fillers are removed, uncertain in-sentence positions remain suggestions', () => {
  const p = project({ transcript: [seg('a', 'um', 0, 1), seg('b', 'This is uh a useful tool.', 2, 7)] });
  const next = applyAutomaticEdit(p, buildAutomaticEdit(p));
  assert.equal(duration(next), 11);
  assert.ok(next.automaticEdit.clips.some(c => c.reason === 'filler' && c.suggested && c.included));
  assert.ok(next.automaticEdit.clips.some(c => c.reason === 'filler' && !c.included));
});
test('repeated utterances keep one delivery and expose the earlier cut', () => {
  const p = project({ transcript: [seg('a', 'This is a useful tool.', 0, 3), seg('b', 'This is a useful tool.', 5, 8)] });
  const next = applyAutomaticEdit(p, buildAutomaticEdit(p));
  assert.equal(duration(next), 9);
  assert.ok(next.automaticEdit.clips.some(c => c.t0 === 0 && c.reason === 'repeat' && !c.included));
});
test('different factual amounts are not silently collapsed as repeats', () => {
  const p = project({ scriptLines: [{ id: 'a', spokenText: 'It costs 50 dollars.', actionCues: [] }], transcript: [seg('a', 'It costs 50 dollars.', 0, 3), seg('b', 'It costs 15 dollars.', 5, 8)] });
  assert.equal(buildAutomaticEdit(p).clips.filter(c => c.reason === 'repeat').length, 0);
});
test('a pickup for a missing line is inserted before the next script line', () => {
  const p = project({ scriptLines: [
    { id: 'a', spokenText: 'Welcome to this tutorial.', actionCues: [] },
    { id: 'b', spokenText: 'Delivery is always free.', actionCues: [] },
    { id: 'c', spokenText: 'Thank you for watching.', actionCues: [] },
  ], transcript: [seg('a', 'Welcome to this tutorial.', 0, 3), seg('c', 'Thank you for watching.', 5, 8), { ...seg('b', 'Delivery is always free.', 0, 3), recordingId: 'pickup' }],
    recordings: [{ id: 'pickup', mediaUri: 'file:///pickup.mp4', duration: 3, createdAt: 1 }] });
  const clips = buildAutomaticEdit(p).clips.filter(c => c.lineId && c.included);
  assert.deepEqual(clips.map(c => c.lineId), ['a', 'b', 'c']);
});
test('semantic matches use the exact current utterance and survive a paraphrase', () => {
  const p = project({ scriptLines: [{ id: 'a', spokenText: 'Delivery is free.', actionCues: [] }], transcript: [seg('s', 'You do not pay for shipping.', 0, 3)], semanticMatches: [{ segmentId: 's', text: 'You do not pay for shipping.', lineId: 'a', verdict: 'complete' }] });
  assert.equal(buildAutomaticEdit(p).clips[0].lineId, 'a');
  const next = applyAutomaticEdit(p, buildAutomaticEdit(p));
  assert.equal(automaticEditCurrent({ ...next, transcript: [seg('s', 'Shipping costs money.', 0, 3)] }), false);
});
test('malformed stored cuts are rejected before playback', () => {
  assert.throws(() => normalizeProject(project({ automaticEdit: { version: 1, sourceKeys: {}, clips: [{ id: 'bad', sourceId: 'p', t0: 3, t1: 2, included: true, label: '' }] } })), /Automatic cuts/);
});
test('trusted word timestamps remove only the filler audio interval', () => {
  const p = project({ transcript: [{ ...seg('a', 'This is um a useful tool.', 0, 5), wordTimingSource: 'saved-audio', words: [
    { text: 'um', t0: 1.3, t1: 1.6, confidence: 0.95 },
  ] }] });
  const next = applyAutomaticEdit(p, buildAutomaticEdit(p));
  const removed = next.automaticEdit.clips.filter(c => !c.included);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].t0, 1.3);
  assert.equal(removed[0].t1, 1.6);
  assert.equal(removed[0].suggested, false);
  assert.ok(Math.abs(duration(next) - 11.7) < 0.001);
});
test('manual restores survive new silence boundaries during reanalysis', () => {
  let p = project({ transcript: [seg('a', 'A useful sentence.', 0, 5)] });
  p = applyAutomaticEdit(p, buildAutomaticEdit(p));
  p = applyAutomaticEdit(p, { ...p.automaticEdit, clips: p.automaticEdit.clips.map(c => ({ ...c, manual: true, included: true })) });
  const next = applyAutomaticEdit(p, buildAutomaticEdit(p, { p: { quiet: [{ t0: 1, t1: 4 }] } }));
  assert.equal(duration(next), 12);
  assert.ok(next.automaticEdit.clips.every(c => c.manual && c.included));
});
test('a newly recorded pickup is included when the previous edit has no rows for it', () => {
  let p = project({ transcript: [seg('a', 'Welcome to this tutorial.', 0, 3)] });
  p = applyAutomaticEdit(p, buildAutomaticEdit(p));
  p = { ...p, recordings: [{ id: 'pickup', mediaUri: 'file:///pickup.mp4', duration: 3, createdAt: 1 }], transcript: [...p.transcript, { ...seg('b', 'Delivery is always free.', 0, 3), recordingId: 'pickup' }] };
  const next = applyAutomaticEdit(p, buildAutomaticEdit(p));
  assert.ok(next.reviewSegments.some(c => c.uri === 'file:///pickup.mp4'));
});
test('filler slices in a weaker repeated take are removed with the whole take', () => {
  const p = project({ scriptLines: [{ id: 'a', spokenText: 'This is a useful tool.', actionCues: [] }],
    transcript: [seg('a', 'This is um a useful tool.', 0, 3), seg('b', 'This is a useful tool.', 5, 8)],
    semanticMatches: [{ segmentId: 'a', text: 'This is um a useful tool.', lineId: 'a', verdict: 'complete' }, { segmentId: 'b', text: 'This is a useful tool.', lineId: 'a', verdict: 'complete' }] });
  assert.ok(buildAutomaticEdit(p).clips.filter(c => c.t0 < 3).every(c => !c.included));
});
test('repeated fillers use distinct trusted word intervals', () => {
  const p = project({ transcript: [{ ...seg('a', 'This um is um useful.', 0, 5), wordTimingSource: 'saved-audio', words: [
    { text: 'um', t0: 1, t1: 1.3, confidence: 0.95 }, { text: 'um', t0: 2, t1: 2.4, confidence: 0.95 },
  ] }] });
  assert.deepEqual(buildAutomaticEdit(p).clips.filter(c => !c.included).map(c => [c.t0, c.t1]), [[1, 1.3], [2, 2.4]]);
});
test('nonfinite clip bounds cannot reach the media exporter', () => {
  assert.throws(() => applyAutomaticEdit(project(), { version: 1, sourceKeys: {}, clips: [{ id: 'a', sourceId: 'p', t0: NaN, t1: 3, included: true, label: '' }] }), /outside/);
});

test('partial line matches still offer a missing-line retake', () => {
  const p = project({ scriptLines: [{ id: 'a', spokenText: 'The plan costs fifty dollars and delivery is free.', actionCues: [] }], transcript: [seg('s', 'The plan costs fifty dollars.', 0, 3)] });
  assert.equal(automaticMissingLines(applyAutomaticEdit(p, buildAutomaticEdit(p))).length, 1);
});
test('a complete paraphrase is not offered as missing', () => {
  const p = project({ scriptLines: [{ id: 'a', spokenText: 'Delivery is free.', actionCues: [] }], transcript: [seg('s', 'Shipping does not cost anything.', 0, 3)], semanticMatches: [{ segmentId: 's', text: 'Shipping does not cost anything.', lineId: 'a', verdict: 'complete' }] });
  assert.equal(automaticMissingLines(applyAutomaticEdit(p, buildAutomaticEdit(p))).length, 0);
});

test('pickup capture retakes stay excluded when extending an existing automatic edit', async () => {
  const { mergePickupRecording } = await import('../src/lib/project-data.ts');
  let p = project();
  p = applyAutomaticEdit(p, buildAutomaticEdit(p));
  for (const captureCuts of [[{ t0: 2, t1: 4 }], []]) {
    const merged = mergePickupRecording(p, 'pickup', { videoUri: 'file:///pickup.mp4', duration: 4, transcript: [], takes: [], captureCuts }, 1);
    const result = applyAutomaticEdit(merged, buildAutomaticEdit(merged));
    assert.deepEqual(result.reviewSegments.filter(c => c.uri === 'file:///pickup.mp4').map(({t0,t1}) => ({t0,t1})), captureCuts);
    assert.ok(result.automaticEdit.clips.some(c => c.sourceId === 'pickup' && !c.included));
  }
});

test('repeating one line never removes another line in the same earlier utterance', () => {
  const both = seg('both', 'Delivery is free. Returns last thirty days.', 0, 4);
  const repeat = seg('repeat', 'Shipping never costs money.', 5, 7);
  const p = project({ scriptLines: [
    { id: 'a', spokenText: 'Delivery is free.', actionCues: [] },
    { id: 'b', spokenText: 'Returns last thirty days.', actionCues: [] },
  ], transcript: [both, repeat], semanticMatches: [
    { segmentId: both.id, text: both.text, lineId: 'a', verdict: 'complete' },
    { segmentId: repeat.id, text: repeat.text, lineId: 'a', verdict: 'complete' },
  ] });
  assert.ok(buildAutomaticEdit(p).clips.filter(c => c.t0 < 4).every(c => c.included));
});
test('overlapping filler estimates preserve the end of the spoken line and repair earlier automatic cuts', () => {
  const p = project({ duration: 5, transcript: [seg('good', "I'm happy.", 2.234, 3.194), { ...seg('filler', 'Um...', 3.034, 4.378), timingSource: 'live-estimate', words: [{ text: 'Um...', t0: 3.072, t1: 3.113, confidence: 1 }] }] });
  const next = applyAutomaticEdit(p, buildAutomaticEdit(p));
  const removed = next.automaticEdit.clips.filter(c => !c.included);
  assert.deepEqual(removed.map(c => [c.t0, c.t1]), [[3.194, 4.378]]);
  const old = { ...next, automaticEdit: { ...next.automaticEdit, sourceKeys: { p: 'old' }, clips: next.automaticEdit.clips.map(c => c.t0 >= 3.034 && c.t1 <= 4.378 ? { ...c, included: false, reason: 'filler' } : c) } };
  assert.ok(buildAutomaticEdit(old).clips.filter(c => c.t0 < 3.194 && c.t1 > 3.034).every(c => c.included));
  const manual = { ...old, automaticEdit: { ...old.automaticEdit, clips: old.automaticEdit.clips.map(c => ({ ...c, manual: true })) } };
  assert.ok(buildAutomaticEdit(manual).clips.filter(c => c.t0 < 3.194 && c.t1 > 3.034).every(c => !c.included));
});
test('filler removal drops a sub-frame orphan tail but preserves explicit restoration', () => {
  const p = project({ duration: 4.397, transcript: [seg('good', "I'm happy.", 2.234, 3.194), { ...seg('filler', 'Um...', 3.034, 4.378), timingSource: 'live-estimate', words: [{ text: 'Um...', t0: 3.072, t1: 3.113, confidence: 1 }] }] });
  const next = applyAutomaticEdit(p, buildAutomaticEdit(p));
  const tail = next.automaticEdit.clips.at(-1);
  assert.equal(tail.t0, 4.378);
  assert.equal(tail.included, false);
  assert.equal(tail.reason, 'silence');
  const restored = { ...next, automaticEdit: { ...next.automaticEdit, clips: next.automaticEdit.clips.map(c => c.id === tail.id ? { ...c, included: true, manual: true } : c) } };
  assert.equal(buildAutomaticEdit(restored).clips.at(-1).included, true);
});
test('three similar deliveries keep the cleanest instead of automatically picking the last', () => {
  const p = project({ transcript: [seg('a', 'This is a useful tool.', 0, 3), seg('b', 'This is um a useful tool.', 4, 7), seg('c', 'This is uh a useful tool.', 8, 11)] });
  const clips = buildAutomaticEdit(p).clips;
  assert.ok(clips.filter(c => c.t0 < 3).every(c => c.included));
  assert.ok(clips.filter(c => (c.t0 >= 4 && c.t1 <= 7) || (c.t0 >= 8 && c.t1 <= 11)).every(c => !c.included));
});
test('semantically complete paraphrases use delivery quality to select one take', () => {
  const transcript = [seg('a', 'Delivery is free.', 0, 2), seg('b', 'Um shipping costs nothing.', 3, 6), seg('c', 'Uh you pay nothing for delivery.', 7, 11)];
  const p = project({ scriptLines: [{ id: 'line', spokenText: 'Delivery is free.', actionCues: [] }], transcript,
    semanticMatches: transcript.map(s => ({ segmentId: s.id, text: s.text, lineId: 'line', verdict: 'complete' })) });
  assert.ok(buildAutomaticEdit(p).clips.filter(c => c.t0 < 2).every(c => c.included));
  assert.ok(buildAutomaticEdit(p).clips.filter(c => (c.t0 >= 3 && c.t1 <= 6) || (c.t0 >= 7 && c.t1 <= 11)).every(c => !c.included));
});
test('offline recognition confidence helps rank otherwise equal deliveries', () => {
  const p = project({ transcript: [
    { ...seg('a', 'This is a useful tool.', 0, 3), wordTimingSource: 'saved-audio', words: [{ text: 'useful', t0: 1, t1: 2, confidence: 0.99 }] },
    { ...seg('b', 'This is a useful tool.', 5, 8), wordTimingSource: 'saved-audio', words: [{ text: 'useful', t0: 6, t1: 7, confidence: 0.55 }] },
  ] });
  assert.ok(buildAutomaticEdit(p).clips.filter(c => c.t0 < 3).every(c => c.included));
});
test('saved repeated takes are reconsidered after timing evidence improves', () => {
  let p = project({ transcript: [seg('a', 'This is a useful tool.', 0, 3), seg('b', 'This is a useful tool.', 5, 8)] });
  p = applyAutomaticEdit(p, buildAutomaticEdit(p));
  p = { ...p, transcript: p.transcript.map(s => ({ ...s, wordTimingSource: 'saved-audio', words: [{ text: 'tool', t0: s.t1 - 1, t1: s.t1, confidence: s.id === 'a' ? 0.99 : 0.5 }] })) };
  const clips = buildAutomaticEdit(p).clips;
  assert.ok(clips.filter(c => c.t0 < 3).every(c => c.included));
  assert.ok(clips.filter(c => c.t0 >= 5 && c.t1 <= 8).every(c => !c.included));
});
test('a measured gap cannot erase a trusted softly spoken word', () => {
  const p = project({ transcript: [{ ...seg('a', 'Important detail.', 0, 5), wordTimingSource: 'saved-audio', words: [{ text: 'detail', t0: 2.4, t1: 2.8, confidence: 0.95 }] }] });
  assert.ok(buildAutomaticEdit(p, { p: { quiet: [{ t0: 1, t1: 4 }] } }).clips.filter(c => c.t0 < 2.8 && c.t1 > 2.4).every(c => c.included));
});
test('audio-derived gap labels and exclusions survive another analysis', () => {
  const p = project();
  const saved = applyAutomaticEdit(p, buildAutomaticEdit(p, { p: { quiet: [{ t0: 2, t1: 5 }] } }));
  const next = buildAutomaticEdit(saved);
  assert.deepEqual(next.clips.filter(c => !c.included).map(c => [c.t0, c.t1, c.reason]), [[2.16, 4.84, 'silence']]);
});
test('caption corrections do not conceal a recorded filler from cleanup', () => {
  const p = project({ transcript: [{ ...seg('s', 'A useful um tool.', 0, 3), manualCorrection: 'A useful tool.', wordTimingSource: 'saved-audio', words: [{ text: 'um', t0: 1.4, t1: 1.7, confidence: 0.95 }] }] });
  const filler = buildAutomaticEdit(p).clips.find(c => c.reason === 'filler');
  assert.equal(filler.label, 'um');
  assert.equal(filler.t0, 1.4);
  assert.equal(filler.included, false);
});
test('live estimated words never authorize an exact mixed-sentence filler cut', () => {
  const p = project({ transcript: [{ ...seg('s', 'A useful um tool.', 0, 3), timingSource: 'live-estimate', words: [{ text: 'um', t0: 0.01, t1: 0.02, confidence: 1 }] }] });
  assert.ok(buildAutomaticEdit(p).clips.every(c => c.included));
});
test('overlapping repeat boundaries never remove audio from the winning take', () => {
  const p = project({ transcript: [seg('a', 'A useful editing tool.', 0, 4), seg('b', 'A useful editing tool.', 3.5, 7.5)] });
  assert.ok(buildAutomaticEdit(p).clips.filter(c => c.t0 < 7.5 && c.t1 > 3.5).every(c => c.included));
});
test('an incomplete semantic attempt cannot outrank a complete delivery', () => {
  const transcript = [seg('a', 'This um is a useful tool.', 0, 3), seg('b', 'This is a useful tool.', 5, 8)];
  const p = project({ scriptLines: [{ id: 'line', spokenText: 'This is a useful tool.', actionCues: [] }], transcript,
    semanticMatches: transcript.map(s => ({ segmentId: s.id, text: s.text, lineId: 'line', verdict: s.id === 'a' ? 'complete' : 'partial' })) });
  assert.ok(buildAutomaticEdit(p).clips.filter(c => c.t0 >= 5 && c.t1 <= 8).every(c => !c.included));
});
test('near-identical changed facts remain separate even if semantic evidence claims completion', () => {
  for (const texts of [['It costs 50 dollars.', 'It costs 15 dollars.'], ['Delivery is free.', 'Delivery is not free.']]) {
    const transcript = texts.map((text, i) => seg(String(i), text, i * 5, i * 5 + 3));
    const p = project({ scriptLines: [{ id: 'line', spokenText: texts[0], actionCues: [] }], transcript,
      semanticMatches: transcript.map(s => ({ segmentId: s.id, text: s.text, lineId: 'line', verdict: 'complete' })) });
    assert.equal(buildAutomaticEdit(p).clips.some(c => c.reason === 'repeat'), false);
  }
});
test('new trusted speech reopens only its interval inside an earlier automatic gap', () => {
  const audio = { p: { quiet: [{ t0: 1, t1: 4 }] } };
  const p = project({ transcript: [seg('s', 'Important detail.', 0, 5)] });
  const saved = applyAutomaticEdit(p, buildAutomaticEdit(p, audio));
  const enriched = { ...saved, transcript: [{ ...p.transcript[0], wordTimingSource: 'saved-audio', words: [{ text: 'detail', t0: 2.4, t1: 2.8, confidence: 0.95 }] }] };
  const recovered = buildAutomaticEdit(enriched, audio);
  assert.ok(recovered.clips.filter(c => c.t0 < 2.8 && c.t1 > 2.4).every(c => c.included));
  assert.deepEqual(recovered.clips.filter(c => !c.included).map(c => [c.t0, c.t1]), [[1.16, 2.4], [2.8, 3.84]]);
  const manual = { ...enriched, automaticEdit: { ...enriched.automaticEdit, clips: enriched.automaticEdit.clips.map(c => !c.included ? { ...c, manual: true } : c) } };
  assert.ok(buildAutomaticEdit(manual, audio).clips.filter(c => c.t0 < 2.8 && c.t1 > 2.4).every(c => !c.included));
  assert.deepEqual(buildAutomaticEdit(saved).clips.filter(c => !c.included).map(c => [c.t0, c.t1, c.reason]), [[1.16, 3.84, 'silence']]);
});

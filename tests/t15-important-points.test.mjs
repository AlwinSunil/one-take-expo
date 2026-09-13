import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScript } from '../src/lib/script-lines.ts';
import { suggestImportantPoints, editImportantPoint, addImportantPoint, reattachImportantPoint, matchImportantPoints, createMissingPointPickup, proposePickupInsertion } from '../src/features/speech-analysis/important-points.ts';
const scope = { projectId: 'project', sourceId: 'original', scriptRevision: 's1', editRevision: 'e1' };
const doc = parseScript('We record the introduction. We explain the camera. We save the video.');
const points = suggestImportantPoints(doc, 's1');
const obs = (id, text, sourceId = 'original', extra = {}) => ({ id, text, sourceId, takeId: `take:${id}`, t0: 1, t1: 4, isFinal: true, provenance: 'manual-review', uncertaintySeconds: null, verifiedBoundary: true, ...extra });
test('extractive baseline quotes actual spoken lines and keeps cues separate', () => {
  const result = suggestImportantPoints(parseScript('We show the camera. [hold it up]'), 's1');
  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'We show the camera.');
  assert.equal(result[0].span.end, result[0].text.length);
});
test('creator edit, importance and removal survive re-analysis and stale revisions remain pending', () => {
  const edited = editImportantPoint(editImportantPoint(points, points[0].id, { text: 'Record our introduction.', importance: 'optional' }), points[1].id, { removed: true });
  const rerun = suggestImportantPoints(doc, 's1', edited);
  assert.equal(rerun[0].text, 'Record our introduction.');
  assert.equal(rerun[0].importance, 'optional');
  assert.equal(rerun[1].removed, true);
  const changed = suggestImportantPoints(doc, 's2', rerun);
  assert.equal(changed[0].state, 'pending');
  const confirmed = reattachImportantPoint(changed, changed[0].id, { ...changed[0].span, scriptRevision: 's2' });
  assert.equal(confirmed[0].state, 'available');
  assert.ok(confirmed[0].revision > changed[0].revision);
  assert.equal(addImportantPoint(points, 'manual', points[0].span).at(-1).origin, 'creator');
});
test('missing B request preserves original project/line/point and unresolved action identities', () => {
  const matches = matchImportantPoints(points, [obs('a', points[0].text), obs('c', points[2].text)], scope);
  const request = createMissingPointPickup({ id: 'pickup', scope, points, matches, context: points.map(p => p.span), unresolvedActionIds: ['action'] });
  assert.deepEqual(request.pointIds, [points[1].id]);
  assert.deepEqual(request.lineIds, [points[1].span.lineId]);
  assert.equal(request.scope.projectId, 'project');
  assert.deepEqual(request.unresolvedActionIds, ['action']);
});
test('partial, uncertain, pending and unavailable never establish coverage', () => {
  for (const observation of [obs('partial', points[0].text, 'original', { isFinal: false }), obs('uncertain', points[0].text, 'original', { uncertain: true })]) {
    assert.notEqual(matchImportantPoints(points, [observation], scope)[0].verdict, 'covered');
  }
  assert.equal(matchImportantPoints(points, [], scope, 'pending')[0].state, 'pending');
  assert.equal(matchImportantPoints(points, [], scope, 'unavailable')[0].state, 'unavailable');
  assert.equal(matchImportantPoints(points, [obs('foreign', points[0].text, 'another')], scope)[0].verdict, 'missing');
});
function requestFor(selected = points) { return createMissingPointPickup({ id: 'pickup', scope, points: selected, matches: [], context: points.map(p => p.span) }); }
function pickupMatch(point, id) { return { scope: { ...scope, sourceId: 'pickup-source' }, pointId: point.id, pointRevision: point.revision, scriptRevision: 's1', state: 'available', verdict: 'covered', observationIds: [id], reason: 'fixture' }; }
test('pickup B supplies insertion slot for A,B,C without modifying prior footage', () => {
  const result = proposePickupInsertion({ request: requestFor([points[1]]), currentScope: scope, pickupSourceId: 'pickup-source', observations: [obs('b', points[1].text, 'pickup-source')], matches: [pickupMatch(points[1], 'b')] });
  assert.equal(result.state, 'available');
  assert.equal(result.insertions[0].scriptOrder, 1);
  assert.equal(result.insertions[0].sourceId, 'pickup-source');
});
test('reverse order pickups sort by script, adjacent points share one whole range', () => {
  const reverse = proposePickupInsertion({ request: requestFor(), currentScope: scope, pickupSourceId: 'pickup-source', observations: [obs('c', points[2].text, 'pickup-source'), obs('b', points[1].text, 'pickup-source', { t0: 5, t1: 8 })], matches: [pickupMatch(points[2], 'c'), pickupMatch(points[1], 'b')] });
  assert.deepEqual(reverse.insertions.map(i => i.scriptOrder), [1, 2]);
  const shared = obs('bc', `${points[1].text} ${points[2].text}`, 'pickup-source');
  const matches = matchImportantPoints(points, [shared], { ...scope, sourceId: 'pickup-source' });
  assert.equal(matches[1].verdict, 'covered');
  assert.equal(matches[2].verdict, 'covered');
  const result = proposePickupInsertion({ request: requestFor(), currentScope: scope, pickupSourceId: 'pickup-source', observations: [shared], matches });
  assert.equal(result.insertions.length, 1);
  assert.deepEqual(result.insertions[0].pointIds, [points[1].id, points[2].id]);
});
test('stale jobs, edited targets, missing media and unsafe shared utterances require resolution', () => {
  const shared = obs('ac', 'fixture', 'pickup-source', { verifiedBoundary: false, provenance: 'recognition' });
  const result = proposePickupInsertion({ request: requestFor(), currentScope: { ...scope, editRevision: 'e2' }, pickupSourceId: 'pickup-source', observations: [shared], matches: [pickupMatch(points[0], 'ac'), pickupMatch(points[2], 'ac')], changedTargetPointIds: [points[0].id] });
  assert.equal(result.state, 'pending');
  assert.ok(result.conflicts.length >= 4);
  assert.equal(result.insertions.length, 1);
  const missing = proposePickupInsertion({ request: requestFor(), currentScope: scope, pickupSourceId: 'pickup-source', observations: [], matches: [pickupMatch(points[0], 'missing')] });
  assert.equal(missing.state, 'pending');
  assert.equal(missing.insertions.length, 0);
  assert.throws(() => createMissingPointPickup({ id: 'stale', scope: { ...scope, scriptRevision: 's2' }, points, matches: [], context: [] }), /stale/);
});
test('one occurrence of repeated similar points cannot cover both original slots', () => {
  const repeated = suggestImportantPoints(parseScript('We save the video. We save the video.'), 's1');
  const matches = matchImportantPoints(repeated, [obs('one', 'We save the video.')], scope);
  assert.ok(matches.every(match => match.verdict !== 'covered'));
});
test('changed names, facts and negation remain missing, not important-point coverage', () => {
  for (const [script, spoken] of [
    ['Alice saves twelve videos.', 'Bob saves twelve videos.'],
    ['Alice saves twelve videos.', 'Alice saves twenty videos.'],
    ['We do not upload recordings.', 'We upload recordings.'],
    ['The camera records offline.', 'The camera records online.'],
  ]) {
    const selected = suggestImportantPoints(parseScript(script), 's1');
    assert.notEqual(matchImportantPoints(selected, [obs('bad', spoken)], scope)[0].verdict, 'covered', `${script} / ${spoken}`);
  }
});
test('pickup B containing already-good C cannot silently duplicate shared audio', () => {
  const shared = obs('bc', `${points[1].text} ${points[2].text}`, 'pickup-source');
  const result = proposePickupInsertion({ request: requestFor([points[1]]), currentScope: scope, pickupSourceId: 'pickup-source', observations: [shared], matches: [pickupMatch(points[1], 'bc'), pickupMatch(points[2], 'bc')] });
  assert.equal(result.state, 'pending');
  assert.match(result.conflicts.join(' '), /outside this pickup slot/);
});
test('conflicting utterance revisions cannot reuse an earlier matching text', () => {
  const duplicates = [obs('same', points[0].text), obs('same', 'Wrong final text.')];
  assert.equal(matchImportantPoints(points, duplicates, scope)[0].state, 'pending');
  const result = proposePickupInsertion({ request: requestFor(), currentScope: scope, pickupSourceId: 'original', observations: duplicates, matches: [{ ...pickupMatch(points[0], 'same'), scope }] });
  assert.equal(result.state, 'pending');
  assert.equal(result.insertions.length, 0);
});
test('a same-id observation in another source cannot borrow point coverage', () => {
  const originalMatch = { ...pickupMatch(points[1], 'reused'), scope };
  const result = proposePickupInsertion({ request: requestFor([points[1]]), currentScope: scope, pickupSourceId: 'pickup-source', observations: [obs('reused', 'Incorrect text.', 'pickup-source')], matches: [originalMatch] });
  assert.equal(result.state, 'pending');
  assert.equal(result.insertions.length, 0);
});
test('manual subspan survives re-analysis at the same script revision', () => {
  const span = { ...points[0].span, start: 3, end: 9, text: points[0].span.text.slice(3, 9) };
  const manual = addImportantPoint(points, 'manual-subspan', span);
  assert.equal(suggestImportantPoints(doc, 's1', manual).at(-1).state, 'available');
});
test('overlapping distinct pickup utterances require boundary resolution', () => {
  const result = proposePickupInsertion({ request: requestFor([points[1], points[2]]), currentScope: scope, pickupSourceId: 'pickup-source', observations: [obs('b', points[1].text, 'pickup-source'), obs('c', points[2].text, 'pickup-source', { t0: 3, t1: 6 })], matches: [pickupMatch(points[1], 'b'), pickupMatch(points[2], 'c')] });
  assert.equal(result.state, 'pending');
  assert.match(result.conflicts.join(' '), /overlap/);
});
test('stale transcript evidence and script context cannot suppress or misdirect pickups', () => {
  const older = { ...scope, transcriptRevision: 't1' };
  const current = { ...scope, transcriptRevision: 't2' };
  const matches = matchImportantPoints(points, [obs('a', points[0].text)], older);
  const request = createMissingPointPickup({ id: 'retry', scope: current, points, matches, context: [] });
  assert.ok(request.pointIds.includes(points[0].id));
  assert.throws(() => createMissingPointPickup({ id: 'stale-context', scope, points, matches: [], context: [{ ...points[0].span, scriptRevision: 'old' }] }), /context/);
  assert.equal(matchImportantPoints(points, [], scope)[0].state, 'unknown');
  assert.equal(matchImportantPoints(points, [], scope, 'available')[0].state, 'available');
});

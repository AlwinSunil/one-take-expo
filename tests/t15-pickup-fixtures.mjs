import { parseScript } from '../src/lib/script-lines.ts';
import { suggestImportantPoints, matchImportantPoints, createMissingPointPickup, proposePickupInsertion } from '../src/features/speech-analysis/important-points.ts';
const scope = { projectId: 'fixture:project', sourceId: 'fixture:original', scriptRevision: 'script:1', editRevision: 'edit:1', transcriptRevision: 'transcript:original:1' };
const pickupScope = { ...scope, sourceId: 'fixture:pickup', transcriptRevision: 'transcript:pickup:1' };
const points = suggestImportantPoints(parseScript('We record the introduction. We explain the camera. We save the video.'), scope.scriptRevision);
const observation = (id, text, t0, t1, sourceId = scope.sourceId) => ({ id, text, t0, t1, sourceId, takeId: `${sourceId}:take`, isFinal: true, provenance: 'manual-review', uncertaintySeconds: null, verifiedBoundary: true });
function scenario(id, originals, pickups) {
  const originalMatches = matchImportantPoints(points, originals, scope);
  const request = createMissingPointPickup({ id, scope, points, matches: originalMatches, context: points.map(p => p.span) });
  const pickupMatches = matchImportantPoints(points, pickups, pickupScope);
  const intent = proposePickupInsertion({ request, currentScope: scope, pickupSourceId: pickupScope.sourceId, pickupTranscriptRevision: pickupScope.transcriptRevision, observations: pickups, matches: pickupMatches });
  return { id, originalScope: scope, pickupScope, points, originals, originalMatches, request, pickups, pickupMatches, intent };
}
console.log(JSON.stringify({
  provenance: { origin: 'synthetic', humanAccepted: false, boundaryFlags: 'simulated manual-review input, not a real listening result', timelineApplied: false },
  scenarios: [
    scenario('fixture:missing-b', [observation('a', points[0].text, 0, 2), observation('c', points[2].text, 3, 5)], [observation('b', points[1].text, 0, 2, pickupScope.sourceId)]),
    scenario('fixture:reverse-bc', [observation('a', points[0].text, 0, 2)], [observation('c', points[2].text, 0, 2, pickupScope.sourceId), observation('b', points[1].text, 3, 5, pickupScope.sourceId)]),
    scenario('fixture:whole-bc', [observation('a', points[0].text, 0, 2)], [observation('bc', `${points[1].text} ${points[2].text}`, 0, 4, pickupScope.sourceId)]),
  ],
}, null, 2));

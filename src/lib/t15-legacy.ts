import type { Project } from './session';
import { canonicalJson, createFoundation, synchronizeSources } from './t15-schema.ts';

/** Existing caption/trim callers still invalidate captured analysis scopes. */
export function preserveDurableLegacyEdit(current: Project, next: Project): Project {
  if (!current.v15) return next;
  const state = synchronizeSources(next, current.v15);
  const changed = (keys: (keyof Project)[]) => keys.some(key => canonicalJson(current[key] ?? null) !== canonicalJson(next[key] ?? null));
  const revisions = { ...state.revisions, transcriptRevision: { ...state.revisions.transcriptRevision } };
  if (changed(['script', 'scriptLines', 'scriptSnapshot'])) {
    revisions.scriptRevision += 1;
    const snapshot = createFoundation({ ...next, v15: undefined }).scriptSnapshots[0];
    if (snapshot) state.scriptSnapshots.push({ ...snapshot, id: `${next.id}:script-revision:${revisions.scriptRevision}`,
      revision: revisions.scriptRevision });
  }
  if (changed(['trim', 'cuts', 'reviewSegments', 'reviewDecisions', 'cleanupReview', 'framing'])) revisions.timelineRevision += 1;
  if (changed(['transcript', 'captionRevision', 'refinementCandidate'])) {
    revisions.captionRevision += 1;
    for (const segment of next.transcript) {
      const sourceId = segment.recordingId ?? next.id;
      const previous = current.transcript.find(row => row.id === segment.id && (row.recordingId ?? current.id) === sourceId);
      if (!segment.id || !previous) continue;
      if (canonicalJson([previous.manualCorrection ?? null, previous.correctedText ?? null]) === canonicalJson([segment.manualCorrection ?? null, segment.correctedText ?? null])) continue;
      state.captionCorrections.push({ id: `${sourceId}:correction:${segment.id}:${revisions.captionRevision}`,
        segmentId: segment.id, sourceId, revision: revisions.captionRevision, text: segment.manualCorrection ?? segment.correctedText ?? segment.text,
        baseTranscriptRevision: revisions.transcriptRevision[sourceId] ?? 0, origin: 'creator' });
    }
  }
  const recognition = (project: Project, sourceId: string) => project.transcript.filter(segment => (segment.recordingId ?? project.id) === sourceId)
    .map(({ id, t0, t1, text, rawText, isFinal, revision }) => ({ id: id ?? null, t0, t1, text: rawText ?? text, isFinal: isFinal ?? null, revision: revision ?? null }));
  for (const source of state.sources) {
    if (canonicalJson(recognition(current, source.id)) !== canonicalJson(recognition(next, source.id))) {
      revisions.transcriptRevision[source.id] = (revisions.transcriptRevision[source.id] ?? 0) + 1;
      const revision = revisions.transcriptRevision[source.id];
      const snapshot = createFoundation({ ...next, v15: undefined }).transcriptRevisions.find(record => record.sourceId === source.id);
      if (snapshot) state.transcriptRevisions.push({ ...snapshot, id: `${source.id}:transcript-revision:${revision}`, revision });
    }
  }
  if (canonicalJson({ ...current, v15: null }) !== canonicalJson({ ...next, v15: null })) revisions.projectRevision += 1;
  return { ...next, v15: { ...state, revisions, timeline: { ...state.timeline, revision: revisions.timelineRevision } } };
}

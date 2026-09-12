import type { Project } from './session';

export function hasMultipleRecordingSources(project: Project): boolean {
  return new Set([project.videoUri, ...(project.recordings ?? []).map(recording => recording.mediaUri),
    ...(project.takes ?? []).map(take => take.mediaUri)].filter(Boolean)).size > 1;
}

export function transcriptForSource(project: Project, uri: string | null) {
  if (!uri) return [];
  return project.transcript.filter(segment => {
    if (segment.recordingId) return project.recordings?.find(recording => recording.id === segment.recordingId)?.mediaUri === uri;
    const linked = project.takes?.filter(take => segment.id && take.transcriptSegmentIds.includes(segment.id)) ?? [];
    if (linked.length) return linked.every(take => take.mediaUri === uri);
    // Legacy captions belong to the primary recording; pickup merges namespace theirs.
    return uri === project.videoUri;
  });
}

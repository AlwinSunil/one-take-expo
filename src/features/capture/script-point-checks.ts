import { suggestImportantPoints, matchImportantPoints } from '../speech-analysis/important-points.ts';
import type { ScriptDocument } from '../../lib/script-lines';
import type { Project, TranscriptSeg } from '../../lib/session';
import { projectCaptureDocument } from './project-handoff.ts';
import { transcriptForSource } from '../../lib/review-source.ts';

export type PointCheck = {
  id: string;
  lineId: string;
  order: number;
  text: string;
  status: 'covered' | 'partial' | 'missing' | 'unavailable';
};

/** Synchronous on-device checks against actual script text; no model-generated importance claims. */
export function scriptPointChecks(document: ScriptDocument, transcript: readonly TranscriptSeg[], available = true): PointCheck[] {
  const points = suggestImportantPoints(document, 'current-script');
  const matches = matchImportantPoints(points, transcript.map((segment, index) => ({
    id: segment.id ?? `speech:${index}`, sourceId: 'current-source', takeId: `speech:${index}`,
    text: segment.manualCorrection ?? segment.correctedText ?? segment.text,
    t0: segment.t0, t1: segment.t1, isFinal: segment.isFinal === true,
    uncertain: segment.needsListening, provenance: 'recognition' as const,
    uncertaintySeconds: null, verifiedBoundary: false,
  })), { projectId: 'current-project', sourceId: 'current-source', scriptRevision: 'current-script', editRevision: 'current-edit' }, available ? 'available' : 'unavailable');
  return points.filter(point => point.importance === 'important').map(point => {
    const match = matches.find(item => item.pointId === point.id)!;
    return { id: point.id, lineId: point.span.lineId, order: point.span.order, text: point.text,
      status: !available ? 'unavailable' : match.verdict === 'covered' && match.state === 'available'
        ? 'covered' : match.verdict === 'partial' ? 'partial' : 'missing' };
  });
}

/** A point removed from the edited video cannot remain covered by its original recording. */
export function projectPointChecks(project: Project): PointCheck[] {
  const document = projectCaptureDocument(project);
  const sources = [...new Set([project.videoUri, ...(project.recordings ?? []).map(recording => recording.mediaUri)].filter((uri): uri is string => !!uri))];
  const perSource = sources.map(uri => {
    const kept = project.reviewSegments !== undefined ? project.reviewSegments.filter(segment => segment.uri === uri)
      : uri === project.videoUri ? project.cuts ?? (project.trim ? [{ t0: project.trim.start, t1: project.trim.end }] : undefined) : undefined;
    const segments = transcriptForSource(project, uri).filter(segment => {
      if (kept && !kept.some(cut => segment.t0 >= cut.t0 && segment.t1 <= cut.t1)) return false;
      const takes = project.takes?.filter(take => segment.id && take.transcriptSegmentIds.includes(segment.id)) ?? [];
      return !takes.length || takes.some(take => take.quality === 'clean' && take.playable);
    }).map(segment => ({ ...segment, isFinal: segment.isFinal !== false }));
    const sourceAvailable = !project.mediaMissing && (!project.availableMediaUris || project.availableMediaUris.includes(uri))
      && project.recordings?.find(recording => recording.mediaUri === uri)?.evidenceStatus !== 'pending';
    return scriptPointChecks(document, segments, sourceAvailable && project.transcript.length > 0);
  });
  return scriptPointChecks(document, [], false).map(point => {
    const candidates = perSource.flatMap(checks => checks.filter(check => check.id === point.id));
    return candidates.find(check => check.status === 'covered') ?? candidates.find(check => check.status === 'partial')
      ?? candidates.find(check => check.status === 'missing') ?? point;
  });
}

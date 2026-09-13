import { suggestImportantPoints, matchImportantPoints } from '../speech-analysis/important-points.ts';
import type { ScriptDocument } from '../../lib/script-lines';
import type { Project, TranscriptSeg } from '../../lib/session';
import { projectCaptureDocument } from './project-handoff.ts';
import { clearLineImportance } from '../local-ai/importance-analysis.ts';
import { liveScriptCoverage } from './live-script.ts';
import { transcriptForSource } from '../../lib/review-source.ts';

export type PointCheck = {
  id: string;
  lineId: string;
  order: number;
  text: string;
  status: 'covered' | 'partial' | 'missing' | 'unavailable';
};

/** Synchronous on-device checks against actual script text; no model-generated importance claims. */
export function scriptPointChecks(document: ScriptDocument, transcript: readonly TranscriptSeg[], available = true, importantIds?: readonly string[]): PointCheck[] {
  const points = suggestImportantPoints(document, 'current-script');
  const matches = matchImportantPoints(points, transcript.map((segment, index) => ({
    id: segment.id ?? `speech:${index}`, sourceId: 'current-source', takeId: `speech:${index}`,
    text: segment.manualCorrection ?? segment.correctedText ?? segment.text,
    t0: segment.t0, t1: segment.t1, isFinal: segment.isFinal === true,
    uncertain: segment.needsListening, provenance: 'recognition' as const,
    uncertaintySeconds: null, verifiedBoundary: false,
  })), { projectId: 'current-project', sourceId: 'current-source', scriptRevision: 'current-script', editRevision: 'current-edit' }, available ? 'available' : 'unavailable');
  return points.filter(point => importantIds ? importantIds.includes(point.span.lineId) : clearLineImportance(point.text) ?? point.importance === 'important').map(point => {
    const match = matches.find(item => item.pointId === point.id)!;
    return { id: point.id, lineId: point.span.lineId, order: point.span.order, text: point.text,
      status: !available ? 'unavailable' : match.verdict === 'covered' && match.state === 'available'
        ? 'covered' : match.verdict === 'partial' ? 'partial' : 'missing' };
  });
}

function retainedSpeech(segment: TranscriptSeg, kept: readonly { t0: number; t1: number }[] | undefined): TranscriptSeg | null {
  if (!kept || kept.some(cut => segment.t0 >= cut.t0 && segment.t1 <= cut.t1)) return segment;
  if (!segment.words?.length) return null;
  const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (normalize(segment.words.map(word => word.text).join(' ')) !== normalize(segment.text)) return null;
  const words = segment.words.filter(word => kept.some(cut => word.t0 >= cut.t0 && word.t1 <= cut.t1));
  if (!words.length) return null;
  const removed = segment.words.filter(word => !words.includes(word));
  // Removing silence or a hesitation must not erase otherwise intact meaning evidence.
  if (removed.every(word => /^(?:um+|uh+|erm+|er+|ah+|hmm+)$/i.test(normalize(word.text)))) return segment;
  return { ...segment, text: words.map(word => word.text).join(' '), words,
    manualCorrection: undefined, correctedText: undefined, t0: words[0].t0, t1: words.at(-1)!.t1 };
}

/** A point removed from the edited video cannot remain covered by its original recording. */
export function projectPointChecks(project: Project): PointCheck[] {
  const document = projectCaptureDocument(project);
  const analysisCurrent = !!project.scriptAnalysis && project.scriptAnalysis.script === project.script;
  const importantIds = analysisCurrent ? project.scriptAnalysis!.importantLineIds : undefined;
  const semantic = project.scriptAnalysis && !analysisCurrent ? [] : project.semanticMatches;
  const sources = [...new Set([project.videoUri, ...(project.recordings ?? []).map(recording => recording.mediaUri)].filter((uri): uri is string => !!uri))];
  const perSource = sources.map(uri => {
    const kept = project.reviewSegments !== undefined ? project.reviewSegments.filter(segment => segment.uri === uri)
      : uri === project.videoUri ? project.cuts ?? (project.trim ? [{ t0: project.trim.start, t1: project.trim.end }] : undefined) : undefined;
    const segments = transcriptForSource(project, uri).flatMap(segment => {
      const takes = project.takes?.filter(take => segment.id && take.transcriptSegmentIds.includes(segment.id)) ?? [];
      if (takes.length && !takes.some(take => take.quality === 'clean' && take.playable)) return [];
      const retained = retainedSpeech(segment, kept);
      return retained ? [{ ...retained, isFinal: retained.isFinal !== false }] : [];
    });
    const sourceAvailable = !project.mediaMissing && (!project.availableMediaUris || project.availableMediaUris.includes(uri))
      && project.recordings?.find(recording => recording.mediaUri === uri)?.evidenceStatus !== 'pending';
    const combinedCoverage = liveScriptCoverage(document.lines, segments.filter(segment => !segment.needsListening).map((segment, index) => ({
      id: segment.id ?? `speech:${index}`, text: segment.manualCorrection ?? segment.correctedText ?? segment.text, isFinal: segment.isFinal,
    })), semantic);
    return scriptPointChecks(document, segments, sourceAvailable && project.transcript.length > 0, importantIds).map(point => ({ ...point,
      status: sourceAvailable && combinedCoverage.some(line => line.lineId === point.lineId && line.status === 'covered') ? 'covered' as const : point.status }));
  });
  return scriptPointChecks(document, [], false, importantIds).map(point => {
    const candidates = perSource.flatMap(checks => checks.filter(check => check.id === point.id));
    return candidates.find(check => check.status === 'covered') ?? candidates.find(check => check.status === 'partial')
      ?? candidates.find(check => check.status === 'missing') ?? point;
  });
}

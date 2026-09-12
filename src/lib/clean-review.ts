import { sanitizeExportCaption } from './export-plan.ts';
import type { Project } from './session';
import { projectReview } from './project-workflow.ts';
import { matchTranscriptToScript, type ReviewState } from './transcript-workflow.ts';
import { projectScriptLines } from './project-workflow.ts';

export function cleanReview(project: Project): ReviewState {
  const baseline = projectReview(project);
  const recordedAt = (uri: string | null) => project.recordings?.find(recording => recording.mediaUri === uri)?.createdAt ?? (uri === project.videoUri ? project.createdAt : 0);
  const takeRecordedAt = (id: string, uri: string | null) => project.takes?.find(take => take.id === id)?.recordedAt ?? recordedAt(uri);
  const defaults = baseline.lines.flatMap(line => {
    if (baseline.decisions.some(d => d.type === 'take-selection' && d.lineId === line.id)) return [];
    const take = baseline.takes.filter(t => line.candidateTakeIds.includes(t.id) && t.playable && t.mediaUri
      && baseline.transcript.some(s => t.transcriptSegmentIds.includes(s.id) && s.isFinal && line.matchedSegmentIds.includes(s.id)))
      .sort((a, b) => Number(b.inFrame) - Number(a.inFrame) || takeRecordedAt(b.id, b.mediaUri) - takeRecordedAt(a.id, a.mediaUri) || (a.mediaUri === b.mediaUri ? b.t0 - a.t0 : 0) || a.id.localeCompare(b.id))[0];
    return take ? [{ id: `default:${line.id}`, type: 'take-selection' as const, lineId: line.id, takeId: take.id }] : [];
  });
  const selected = projectReview({ ...project, reviewDecisions: [...defaults, ...baseline.decisions] });
  return { ...selected, decisions: baseline.decisions, suggestions: baseline.suggestions };
}

export function selectedReviewCuts(review: ReviewState, mediaUri: string | null, duration?: number) {
  if (new Set(review.takes.filter(t => t.playable && t.mediaUri).map(t => t.mediaUri)).size > 1) {
    return { cuts: [], unavailableTakeIds: review.takes.filter(t => t.mediaUri !== mediaUri).map(t => t.id), conflict: false };
  }
  const selectedIds = new Set(review.lines.flatMap(line => line.selectedTakeId ? [line.selectedTakeId] : []));
  const conflictingTakeIds = [...selectedIds].filter(id => review.lines.some(line =>
    line.selectedTakeId && line.selectedTakeId !== id && line.candidateTakeIds.includes(id)));
  if (conflictingTakeIds.length) return { cuts: [], unavailableTakeIds: conflictingTakeIds, conflict: true };
  const seen = new Set<string>();
  const cuts: { t0: number; t1: number }[] = [];
  const unavailableTakeIds: string[] = [];
  for (const line of review.lines) {
    if (!line.selectedTakeId || seen.has(line.selectedTakeId)) continue;
    seen.add(line.selectedTakeId);
    const take = review.takes.find(t => t.id === line.selectedTakeId);
    if (!take || take.quality !== 'clean' || !take.playable || !mediaUri || take.mediaUri !== mediaUri
      || !Number.isFinite(take.t0) || !Number.isFinite(take.t1) || take.t0 < 0 || take.t1 <= take.t0
      || (duration !== undefined && take.t1 > duration)) {
      unavailableTakeIds.push(line.selectedTakeId); continue;
    }
    cuts.push({ t0: take.t0, t1: take.t1 });
  }
  return { cuts, unavailableTakeIds, conflict: false };
}

export function pickupLineIds(review: ReviewState): string[] {
  return review.lines.filter(line => line.spokenText.trim() && !line.selectedTakeId).map(line => line.id);
}

export function selectedReviewSegments(project: Project, review = cleanReview(project)) {
  const selectedIds = new Set(review.lines.flatMap(line => line.selectedTakeId ? [line.selectedTakeId] : []));
  const conflicts = [...selectedIds].filter(id => {
    const take = review.takes.find(item => item.id === id);
    const spokenIds = new Set(review.transcript.filter(segment => take?.transcriptSegmentIds.includes(segment.id))
      .flatMap(segment => matchTranscriptToScript(segment, projectScriptLines(project)).lineIds));
    return review.lines.some(line => line.selectedTakeId && line.selectedTakeId !== id
      && (line.candidateTakeIds.includes(id) || spokenIds.has(line.id)));
  });
  const segments: NonNullable<Project['reviewSegments']> = [];
  const unavailableTakeIds: string[] = [];
  if (conflicts.length) return { segments, unavailableTakeIds, conflicts };
  for (const id of selectedIds) {
    const take = review.takes.find(item => item.id === id);
    const duration = project.recordings?.find(recording => recording.mediaUri === take?.mediaUri)?.duration
      ?? (take?.mediaUri === project.videoUri ? project.duration : undefined);
    if (!take || !take.playable || !take.mediaUri || take.quality !== 'clean' || project.unavailableTakeIds?.includes(id)
      || !Number.isFinite(take.t0) || !Number.isFinite(take.t1) || take.t0 < 0 || take.t1 <= take.t0
      || (duration !== undefined && take.t1 > duration)) {
      unavailableTakeIds.push(id); continue;
    }
    const captions = review.transcript.filter(segment => take.transcriptSegmentIds.includes(segment.id) && segment.isFinal)
      .map(segment => ({ t0: Math.max(take.t0, segment.t0), t1: Math.min(take.t1, segment.t1), text: sanitizeExportCaption(segment.manualCorrection ?? segment.text) }))
      .filter(caption => caption.t1 > caption.t0 && caption.text.trim());
    segments.push({ uri: take.mediaUri, t0: take.t0, t1: take.t1, takeId: id, captions });
  }
  return { segments, unavailableTakeIds, conflicts };
}

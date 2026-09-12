import type { Project } from './session';
import { projectReview } from './project-workflow.ts';
import { deriveReviewState, type ReviewState } from './transcript-workflow.ts';
import { projectScriptLines } from './project-workflow.ts';

export function cleanReview(project: Project): ReviewState {
  const baseline = projectReview(project);
  // Source-relative times cannot establish recency between separate recordings.
  if (new Set(baseline.takes.filter(t => t.playable && t.mediaUri).map(t => t.mediaUri)).size > 1) return baseline;
  const defaults = baseline.lines.flatMap(line => {
    if (baseline.decisions.some(d => d.type === 'take-selection' && d.lineId === line.id)) return [];
    const take = baseline.takes.filter(t => line.candidateTakeIds.includes(t.id) && t.playable && t.mediaUri
      && baseline.transcript.some(s => t.transcriptSegmentIds.includes(s.id) && s.isFinal && line.matchedSegmentIds.includes(s.id)))
      .sort((a, b) => Number(b.inFrame) - Number(a.inFrame) || b.t0 - a.t0 || a.id.localeCompare(b.id))[0];
    return take ? [{ id: `default:${line.id}`, type: 'take-selection' as const, lineId: line.id, takeId: take.id }] : [];
  });
  const selected = deriveReviewState({ lines: projectScriptLines(project), segments: baseline.transcript,
    takes: baseline.takes, decisions: [...defaults, ...baseline.decisions] });
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

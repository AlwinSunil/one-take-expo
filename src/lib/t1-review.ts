import type { Project } from './session';
import type { FootageReference } from './t1-contracts';
import { projectReview } from './project-workflow.ts';
import { selectTake } from './transcript-workflow.ts';

/** Narrow primary-source adapter until the multi-recording store in #49 merges. */
export function canReviewFootage(project: Project, footage: FootageReference): boolean {
  return !!footage && footage.recordingId === project.id && typeof project.videoUri === 'string' && !!project.videoUri.trim() && project.mediaMissing === false
    && Number.isFinite(footage.t0) && Number.isFinite(footage.t1)
    && footage.t0 >= 0 && footage.t1 > footage.t0
    && typeof project.duration === 'number' && footage.t1 <= project.duration;
}
export function chooseReviewTake(project: Project, lineId: string, takeId: string): Project {
  const review = projectReview(project);
  const line = review.lines.find(item => item.id === lineId);
  const take = review.takes.find(item => item.id === takeId);
  if (!line?.candidateTakeIds.includes(takeId) || !take?.playable || !canReviewFootage(project, { recordingId: project.id, t0: take.t0, t1: take.t1 })) {
    throw new Error('This take is unavailable. Keep the original or record a pickup.');
  }
  return { ...project, reviewDecisions: selectTake(project.reviewDecisions ?? [], lineId, takeId, review.takes), cutsReviewed: false };
}

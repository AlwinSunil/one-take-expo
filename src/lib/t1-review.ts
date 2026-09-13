import type { Project } from './session';
import type { FootageReference } from './t1-contracts';
import { projectReview } from './project-workflow.ts';
import { selectTake } from './transcript-workflow.ts';

/** Resolve source identity using the store's refreshed file inventory. */
export function resolveReviewFootage(project: Project, footage: FootageReference): { uri: string; duration: number } | null {
  if (!footage || !Number.isFinite(footage.t0) || !Number.isFinite(footage.t1) || footage.t0 < 0 || footage.t1 <= footage.t0) return null;
  const recording = project.recordings?.find(item => item.id === footage.recordingId);
  const primary = !recording && footage.recordingId === project.id;
  const uri = recording?.mediaUri ?? (primary ? project.videoUri : null);
  const duration = recording?.duration ?? (primary ? project.duration : undefined);
  const available = typeof uri === 'string' && (project.availableMediaUris?.includes(uri) ?? (primary && project.mediaMissing === false));
  if (!available || !uri || typeof duration !== 'number' || !Number.isFinite(duration) || footage.t1 > duration || recording?.evidenceStatus === 'pending') return null;
  return { uri, duration };
}
export function canReviewFootage(project: Project, footage: FootageReference): boolean {
  return resolveReviewFootage(project, footage) !== null;
}
export function takeFootage(project: Project, take: { mediaUri: string | null; t0: number; t1: number }): FootageReference {
  return { recordingId: project.recordings?.find(recording => recording.mediaUri === take.mediaUri)?.id ?? (take.mediaUri === project.videoUri ? project.id : ''), t0: take.t0, t1: take.t1 };
}
export function chooseReviewTake(project: Project, lineId: string, takeId: string): Project {
  const review = projectReview(project);
  const line = review.lines.find(item => item.id === lineId);
  const take = review.takes.find(item => item.id === takeId);
  if (!line?.candidateTakeIds.includes(takeId) || !take?.playable || !canReviewFootage(project, takeFootage(project, take))) {
    throw new Error('This take is unavailable. Keep the original or record a pickup.');
  }
  return { ...project, reviewDecisions: selectTake(project.reviewDecisions ?? [], lineId, takeId, review.takes), cutsReviewed: false };
}

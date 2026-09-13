import { validateAcousticFillerResult, type AcousticFillerResult } from '../features/speech-control/acoustic-fillers.ts';
import type { Project } from './session';

export interface AcousticFillerReview {
  sourceId: string;
  sourceUri: string;
  sourceDuration?: number;
  revision: number;
  status: 'running' | 'ready' | 'failed' | 'cancelled';
  result?: AcousticFillerResult;
  dismissedEventIds: string[];
  error?: string;
}

export function acousticFillerSources(project: Project) {
  const recordings = project.recordings?.length ? project.recordings : project.videoUri
    ? [{ id: `${project.id}:original`, mediaUri: project.videoUri, duration: project.duration }] : [];
  return recordings.map((source, index) => ({ id: source.id, uri: source.mediaUri, duration: source.duration,
    label: index === 0 ? 'Original recording' : `Recording ${index + 1}` }));
}

export function normalizeAcousticFillerReviews(value: unknown, project: Project): AcousticFillerReview[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Acoustic filler reviews are unreadable.');
  const sources = acousticFillerSources(project);
  const seen = new Set<string>();
  return value.flatMap((row: AcousticFillerReview) => {
    if (!row || typeof row.sourceId !== 'string' || typeof row.sourceUri !== 'string'
      || (row.sourceDuration !== undefined && (!Number.isFinite(row.sourceDuration) || row.sourceDuration < 0))
      || !Number.isSafeInteger(row.revision) || row.revision < 0
      || !['running', 'ready', 'failed', 'cancelled'].includes(row.status)
      || !Array.isArray(row.dismissedEventIds) || row.dismissedEventIds.some(id => typeof id !== 'string')
      || (row.error !== undefined && typeof row.error !== 'string') || seen.has(row.sourceId)) {
      throw new Error('Acoustic filler review data is unreadable.');
    }
    seen.add(row.sourceId);
    if (!sources.some(source => source.id === row.sourceId && source.uri === row.sourceUri
      && (row.sourceDuration === undefined || source.duration === row.sourceDuration))) return [];
    const result = row.result === undefined ? undefined : validateAcousticFillerResult(row.result,
      { sourceId: row.sourceId, analysisRevision: row.revision });
    if (row.status === 'ready' && result?.status !== 'ready') throw new Error('Acoustic filler result is missing.');
    const ids = new Set(result?.events.map(event => event.id));
    return [{ ...row, result, dismissedEventIds: [...new Set(row.dismissedEventIds)].filter(id => ids.has(id)),
      ...(row.status === 'running' ? { status: 'failed' as const, error: 'Analysis was interrupted. Try again.' } : {}) }];
  });
}

export function replaceAcousticFillerReview(project: Project, review: AcousticFillerReview): Project {
  if (!acousticFillerSources(project).some(source => source.id === review.sourceId && source.uri === review.sourceUri
    && (review.sourceDuration === undefined || source.duration === review.sourceDuration))) {
    throw new Error('The recording changed. Analyze the current recording again.');
  }
  const previous = project.acousticFillerReviews?.find(row => row.sourceId === review.sourceId);
  if (previous && previous.revision > review.revision) throw new Error('A newer analysis has replaced this result.');
  return { ...project, acousticFillerReviews: [...(project.acousticFillerReviews ?? []).filter(row => row.sourceId !== review.sourceId), review] };
}

import type { Project } from './session';
import type { AnalysisJob } from './t15-jobs';

export type ProjectLifecyclePhase = 'saving' | 'analyzing' | 'ready' | 'partial' | 'failed' | 'cancelled';
export interface ProjectLifecycle {
  phase: ProjectLifecyclePhase;
  message: string;
  canOpenEditor: boolean;
  retryJob?: { id: string; attempt: number };
}
export function projectLifecycle(project: Project, jobs: AnalysisJob[] = [], saving = false): ProjectLifecycle {
  if (saving) return { phase: 'saving', message: 'Saving the original. Keep this screen open until the copy finishes.', canOpenEditor: !!project.videoUri };
  const job = jobs[0];
  if (project.mediaMissing || project.recordings?.some(source => source.evidenceStatus === 'pending')) {
    return { phase: 'partial', message: project.recoveryMessage ?? 'Some source media or analysis is unavailable. Your saved edit is preserved.', canOpenEditor: true };
  }
  if (job) {
    if (job.status === 'queued' || job.status === 'running') return { phase: 'analyzing', message: job.status === 'queued'
      ? 'Analysis is queued. You can open the saved original while it waits.'
      : 'Analyzing the saved original. You can edit while suggestions are prepared.', canOpenEditor: true };
    if (job.status === 'ready') return { phase: 'ready', message: job.error ?? 'Analysis is saved. Suggestions wait for your review.', canOpenEditor: true };
    return { phase: job.status === 'retryable' ? 'partial' : job.status,
      message: job.error ?? (job.status === 'cancelled' ? 'Analysis was cancelled. Your saved edit is unchanged.' : 'Analysis did not finish completely. Your saved original and edit remain available.'),
      canOpenEditor: true, retryJob: { id: job.request.id, attempt: job.request.attempt } };
  }
  if (project.recoveryMessage) return { phase: 'partial', message: project.recoveryMessage, canOpenEditor: true };
  return { phase: 'ready', message: 'The saved original is available. Final analysis has not been collected.', canOpenEditor: true };
}

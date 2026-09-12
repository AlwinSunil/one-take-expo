import { transcriptForSource } from './review-source.ts';
import type { Project } from './session';

export function reviewExportSelection(project: Project, mode: 'original' | 'trim' | 'cut', hasAutomaticCuts: boolean) {
  if (mode === 'original') return { ...project, cuts: [], reviewSegments: undefined, cutsReviewed: false, transcript: [] };
  if (mode === 'trim') return { ...project, transcript: transcriptForSource(project, project.videoUri), cuts: undefined, reviewSegments: undefined, cutsReviewed: false };
  if (hasAutomaticCuts && project.cuts === undefined && !project.reviewSegments?.length) return null;
  return project;
}

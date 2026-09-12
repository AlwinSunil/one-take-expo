import type { Project } from './session';

export function reviewExportSelection(project: Project, mode: 'original' | 'trim' | 'cut', hasAutomaticCuts: boolean) {
  if (mode === 'original') return { ...project, cuts: [], cutsReviewed: false, transcript: [] };
  if (mode === 'trim') return { ...project, cuts: undefined, cutsReviewed: false };
  if (hasAutomaticCuts && project.cuts === undefined) return null;
  return project;
}

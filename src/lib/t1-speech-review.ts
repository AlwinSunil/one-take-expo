import type { Project } from './session';
import { projectScriptLines } from './project-workflow.ts';
import { adaptT1SpeechProviderEnvelope } from './t1-speech-provider.ts';

/** Gated consumer projection; never rewrites the stored producer envelope. */
export function projectWithSpeechEvidence(project: Project, enabled = false): { project: Project; error?: string } {
  if (!enabled || project.speechControl === undefined) return { project };
  const result = adaptT1SpeechProviderEnvelope(project.speechControl, {
    projectId: project.id,
    scriptSnapshot: projectScriptLines(project).filter(line => line.spokenText.trim()).map(line => ({ lineId: line.id, spokenText: line.spokenText })),
  });
  return result.ok ? { project: { ...project, tier1Evidence: result.evidence } }
    : { project: { ...project, tier1Evidence: undefined }, error: result.error.message };
}

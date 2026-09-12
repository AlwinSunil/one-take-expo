import type { Project, TranscriptSeg } from '../../lib/session';
import { projectScriptLines } from '../../lib/project-workflow.ts';
import { cleanReview, pickupLineIds } from '../../lib/clean-review.ts';
import { parseScript, type ScriptDocument } from '../../lib/script-lines.ts';

export function projectCaptureDocument(project: Project): ScriptDocument {
  const lines = projectScriptLines(project).map(line => ({
    id: line.id,
    text: [line.spokenText, ...line.actionCues.map(cue => `[${cue.text}]`)].filter(Boolean).join(' '),
    spokenText: line.spokenText,
    actionCues: line.actionCues.map(cue => ({ id: cue.id, text: cue.text, required: cue.required, status: cue.resolved ? 'done' as const : 'pending' as const })),
    ambiguousCues: [],
    kind: line.spokenText.trim() ? 'spoken' as const : 'action-only' as const,
    wordCount: line.spokenText.trim() ? line.spokenText.trim().split(/\s+/).length : 0,
  }));
  const text = lines.map(line => line.text).join('\n');
  return { ...parseScript(text), text, lines };
}

export function requestedPickupLineIds(project: Project): string[] {
  const needed = new Set(pickupLineIds(cleanReview(project)));
  const requested = new Set(project.pickupRequest?.lineIds ?? needed);
  return projectScriptLines(project).filter(line => needed.has(line.id) && requested.has(line.id)).map(line => line.id);
}

export function recordingTranscript(segments: readonly TranscriptSeg[], audioStartedAt: number | null, videoStartedAt: number, duration: number): TranscriptSeg[] {
  if (audioStartedAt === null || !Number.isFinite(duration) || duration <= 0) return [];
  const offset = (videoStartedAt - audioStartedAt) / 1000;
  return segments.flatMap(segment => {
    const t0 = Math.max(0, segment.t0 - offset);
    const t1 = Math.min(duration, segment.t1 - offset);
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return [];
    // Boundary-truncated recognition cannot establish a complete spoken take.
    return [{ ...segment, t0, t1, isFinal: segment.isFinal !== false && segment.t0 >= offset && segment.t1 - offset <= duration }];
  });
}

export async function launchProjectPickup(project: Project, save: (project: Project) => Promise<boolean>, navigate: (route: { pathname: '/camera'; params: { mode: 'script'; script: string; pickupProjectId: string } }) => void): Promise<boolean> {
  const lineIds = pickupLineIds(cleanReview(project));
  if (!lineIds.length) return false;
  if (!await save({ ...project, pickupRequest: { lineIds, requestedAt: Date.now() } })) return false;
  navigate({ pathname: '/camera', params: { mode: 'script', script: project.script ?? '', pickupProjectId: project.id } });
  return true;
}

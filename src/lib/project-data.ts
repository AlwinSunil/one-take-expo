import type { Project, TranscriptSeg } from './session';

export function normalizeProject(value: unknown): Project {
  if (!value || typeof value !== 'object') throw new Error('Project data is unreadable.');
  const p = value as Project;
  if (typeof p.id !== 'string' || !p.id || !['script', 'assisted'].includes(p.mode)) throw new Error('Project identity is invalid.');
  for (const key of ['scriptLines', 'reviewDecisions', 'rawTranscript', 'refinementCandidate', 'cuts', 'quietIntervals'] as const) {
    if (p[key] !== undefined && !Array.isArray(p[key])) throw new Error(`Project ${key} data is unreadable.`);
  }
  if (p.scriptLines?.some(line =>
    !line
    || typeof line.id !== 'string'
    || typeof line.spokenText !== 'string'
    || !Array.isArray(line.actionCues)
    || line.actionCues.some(cue => !isValidActionCue(cue))
  )) throw new Error('Project script lines are unreadable.');
  if (p.cuts?.some(cut => !cut || !Number.isFinite(cut.t0) || !Number.isFinite(cut.t1) || cut.t0 < 0 || cut.t1 <= cut.t0)) throw new Error('Project cuts are unreadable.');
  const transcript = Array.isArray(p.transcript) ? p.transcript.filter((s): s is TranscriptSeg =>
    !!s && typeof s.text === 'string' && Number.isFinite(s.t0) && Number.isFinite(s.t1) && s.t0 >= 0 && s.t1 >= s.t0,
  ) : [];
  return {
    ...p, schemaVersion: 2,
    videoUri: typeof p.videoUri === 'string' ? p.videoUri : null,
    clips: Array.isArray(p.clips) ? p.clips : [],
    transcript: transcript.map((s, i) => ({ ...s, id: s.id || `${p.id}:legacy:${i}` })),
    createdAt: Number.isFinite(p.createdAt) ? p.createdAt : 0,
    refinement: p.refinement?.status === 'running'
      ? { ...p.refinement, status: 'failed', error: 'Refinement was interrupted. Your previous captions are preserved; retry when ready.' }
      : p.refinement,
  };
}

function isValidActionCue(value: unknown): value is {
  id: string;
  text: string;
  required: boolean;
  resolved: boolean;
} {
  if (!value || typeof value !== 'object') return false;
  const cue = value as Record<string, unknown>;
  return typeof cue.id === 'string'
    && cue.id.trim().length > 0
    && typeof cue.text === 'string'
    && cue.text.trim().length > 0
    && typeof cue.required === 'boolean'
    && typeof cue.resolved === 'boolean';
}

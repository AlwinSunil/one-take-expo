import { detectScratchCommand } from '../speech-control/take-decisions.ts';
import { createTranscriptSegment, matchTranscriptToScript, type ScriptLine } from '../../lib/transcript-workflow.ts';

interface SpeechSegment {
  id: string;
  text: string;
  t0: number;
  t1: number;
  isFinal: boolean;
}

export interface VoiceScratch {
  commandId: string;
  targetId: string | null;
  lineId: string | null;
  startedAt: number;
  endedAt: number;
  reason: 'scratched' | 'no-target' | 'ambiguous' | 'pending';
}

/** Replay source-local utterances; revisions and repeated delivery never apply a command twice. */
export function resolveVoiceScratches(segments: readonly SpeechSegment[], lines: readonly ScriptLine[]) {
  const ordered = [...new Map(segments.map(segment => [segment.id, segment])).values()]
    .sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1 || a.id.localeCompare(b.id));
  const actions: VoiceScratch[] = [];
  const excluded = new Set<string>();
  let previous: SpeechSegment | null = null;
  for (const segment of ordered) {
    const command = detectScratchCommand({ ...segment, sessionId: 'capture', sourceId: 'current-recording',
      // The native recognizer supplies endpointed utterances, not arbitrary text windows.
      commandContext: 'standalone',
    }, { scriptLines: lines.map(line => line.spokenText) });
    if (!command) {
      if (segment.text.trim()) previous = segment;
      continue;
    }
    excluded.add(segment.id);
    const target = previous;
    const lineIds = target ? matchTranscriptToScript(createTranscriptSegment(target), lines).lineIds : [];
    const ambiguous = !!target && (!target.isFinal || target.t1 > segment.t0 || lineIds.length > 1);
    const targetId = target && !ambiguous ? target.id : null;
    if (targetId) excluded.add(targetId);
    actions.push({ commandId: segment.id, targetId, lineId: targetId ? lineIds[0] ?? null : null,
      startedAt: targetId ? target!.t0 : segment.t0, endedAt: segment.t1, reason: target && !target.isFinal ? 'pending' : ambiguous ? 'ambiguous' : targetId ? 'scratched' : 'no-target' });
    // Repeating the command without new speech must not scratch an older line.
    previous = null;
  }
  return { actions, excluded };
}

export interface RetakeRange { t0: number; t1: number }

export function resolveManualScratch(segments: readonly SpeechSegment[], lines: readonly ScriptLine[],
  at: number, excluded: ReadonlySet<string>): VoiceScratch {
  const target = [...segments].filter(segment => segment.t0 < at && segment.text.trim())
    .sort((a, b) => b.t0 - a.t0 || b.t1 - a.t1)[0];
  const lineIds = target ? matchTranscriptToScript(createTranscriptSegment(target), lines).lineIds : [];
  const usable = target && !excluded.has(target.id) && lineIds.length <= 1;
  return { commandId: `manual:${at}`, targetId: usable ? target.id : null,
    lineId: usable ? lineIds[0] ?? null : null, startedAt: usable ? target.t0 : at, endedAt: at,
    reason: target && lineIds.length > 1 ? 'ambiguous' : usable ? 'scratched' : 'no-target' };
}

/** Explicit retakes author the actual source intervals used by playback and muxed A/V export. */
export function captureRetakeEdit(duration: number, ranges: readonly RetakeRange[], audioToVideoOffset = 0):
  { cuts?: RetakeRange[]; cutsReviewed?: true } {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(audioToVideoOffset)) {
    throw new Error('Retake media timing is unavailable.');
  }
  const excluded = ranges.map(range => {
    if (!Number.isFinite(range.t0) || !Number.isFinite(range.t1) || range.t1 <= range.t0) {
      throw new Error('Retake interval is invalid.');
    }
    return { t0: Math.max(0, range.t0 - audioToVideoOffset), t1: Math.min(duration, range.t1 - audioToVideoOffset) };
  }).filter(range => range.t1 > range.t0).sort((a, b) => a.t0 - b.t0);
  if (!excluded.length) return {};
  const cuts: RetakeRange[] = [];
  let cursor = 0;
  for (const range of excluded) {
    if (range.t0 > cursor) cuts.push({ t0: cursor, t1: range.t0 });
    cursor = Math.max(cursor, range.t1);
  }
  if (cursor < duration) cuts.push({ t0: cursor, t1: duration });
  // The scratch command is the creator's explicit edit; do not make them accept it again.
  return { cuts, cutsReviewed: true };
}

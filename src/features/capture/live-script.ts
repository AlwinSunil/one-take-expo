import { matchEnglish } from '../speech-analysis/alignment.ts';
import type { SemanticMatch } from '../local-ai/script-model';
export function liveScriptCoverage(lines: readonly { id: string; spokenText: string }[], segments: readonly { id: string; text: string; isFinal: boolean; recordingId?: string }[], semantic: readonly SemanticMatch[] = []) {
  return lines.map(line => {
    let complete = false, partial = false;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const meaning = semantic.find(item => item.segmentId === segment.id && item.text === segment.text && item.lineId === line.id);
      if (meaning?.verdict === 'complete' && segment.isFinal) complete = true;
      if (meaning?.verdict === 'partial' || meaning?.verdict === 'fumbled') partial = true;
      for (let size = 1; size <= Math.min(3, i + 1); size++) {
        const window = segments.slice(i - size + 1, i + 1);
        if (window.some(item => item.recordingId !== segment.recordingId)) continue;
        const match = matchEnglish(line.spokenText, window.map(item => item.text).join(' '));
        if (match.verdict === 'matched' && window.every(item => item.isFinal)) complete = true;
        if (match.verdict === 'partial' && match.score > 0.25) partial = true;
      }
    }
    return { lineId: line.id, status: complete ? 'covered' as const : partial ? 'partial' as const : 'missing' as const };
  });
}


type TimedSpeech = { id: string; text: string; isFinal: boolean; t0: number; t1: number };

export function canAutoRetake(match: SemanticMatch, analyzed: TimedSpeech, current: readonly TimedSpeech[], lines: readonly { id: string; spokenText: string }[]) {
  const latest = current.at(-1);
  if (match.verdict !== 'fumbled' || match.segmentId !== analyzed.id || match.text !== analyzed.text
    || !latest?.isFinal || latest.id !== analyzed.id || latest.text !== analyzed.text
    || latest.t0 !== analyzed.t0 || latest.t1 !== analyzed.t1
    || !Number.isFinite(latest.t0) || !Number.isFinite(latest.t1) || latest.t1 <= latest.t0
    || !lines.some(line => line.id === match.lineId)) return false;
  // A recognizer utterance may contain several script lines; a whole-utterance cut must not erase a good one.
  const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const spoken = ` ${normalize(latest.text)} `;
  return !lines.some(line => spoken.includes(` ${normalize(line.spokenText)} `)
    || latest.text.split(/[.!?;]+/).some(clause => matchEnglish(line.spokenText, clause).verdict === 'matched'));
}

type ReminderSpeech = TimedSpeech & { recordingId?: string };
export function missedImportantLine(
  lines: readonly { id: string; spokenText: string }[],
  segments: readonly ReminderSpeech[],
  semantic: readonly SemanticMatch[],
  importantIds: readonly string[],
  now: number,
  pendingSegmentIds: ReadonlySet<string> = new Set(),
) {
  const latest = segments.at(-1);
  if (!latest || !Number.isFinite(now)) return undefined;
  const coverage = liveScriptCoverage(lines, segments, semantic);
  const latestCovered = Math.max(-1, ...coverage.flatMap((line, index) => line.status === 'covered' ? [index] : []));
  const paused = latest.isFinal && now - latest.t1 >= 2.5;
  // Give a just-finished paraphrase time to resolve before asking the speaker to repeat it.
  if (segments.some(segment => pendingSegmentIds.has(segment.id) && now - segment.t1 < 3)) return undefined;
  return lines.find((line, index) => importantIds.includes(line.id) && coverage[index].status !== 'covered'
    && (index < latestCovered || (paused && coverage[index].status === 'partial')));
}

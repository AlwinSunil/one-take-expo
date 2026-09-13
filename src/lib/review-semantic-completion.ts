import type { Project } from './session';
import type { SemanticMatch } from '../features/local-ai/script-model';
import { matchEnglish } from '../features/speech-analysis/alignment.ts';
import { transcriptForSource } from './review-source.ts';

type Line = { id: string; spokenText: string };
type Infer = (lines: readonly Line[], segment: { id: string; text: string }) => Promise<SemanticMatch | null>;

export async function completeSourceSemantics(project: Project, sourceUri: string, infer: Infer, active: () => boolean): Promise<SemanticMatch[]> {
  const matches = [...(project.semanticMatches ?? [])];
  const eligible = new Set(project.takes?.filter(take => take.mediaUri === sourceUri).flatMap(take => take.eligibleLineIds ?? []) ?? []);
  const lines = (project.scriptLines ?? []).filter(line => line.spokenText.trim() && (!eligible.size || eligible.has(line.id)));
  if (!lines.length) return matches;
  const segments = transcriptForSource(project, sourceUri).filter(segment => segment.isFinal !== false && Number.isFinite(segment.t0) && Number.isFinite(segment.t1) && segment.t0 >= 0 && segment.t1 > segment.t0 && segment.id && segment.text.trim()).sort((a, b) => a.t0 - b.t0);
  let cursor = 0;
  for (const segment of segments) {
    if (!active()) break;
    const saved = matches.find(match => match.segmentId === segment.id && match.text === segment.text && lines.some(line => line.id === match.lineId));
    if (saved) { if (saved.verdict === 'complete') cursor = lines.findIndex(line => line.id === saved.lineId); continue; }
    const lexical = lines.map((line, index) => ({ index, match: matchEnglish(line.spokenText, segment.text) }))
      .filter(item => item.match.verdict === 'matched').sort((a, b) => b.match.score - a.match.score || Math.abs(a.index - cursor) - Math.abs(b.index - cursor))[0];
    if (lexical) { cursor = lexical.index; continue; }
    if (segment.text.length > 1800) continue;
    let remaining = 6500 - segment.text.length;
    const candidates: Line[] = [];
    for (const line of lines.slice(Math.max(0, cursor - 2), Math.max(0, cursor - 2) + 12)) {
      if (line.spokenText.length > 800 || line.spokenText.length > remaining) continue;
      candidates.push(line);
      remaining -= line.spokenText.length;
    }
    if (!candidates.length) continue;
    let match: SemanticMatch | null;
    try { match = await infer(candidates, { id: segment.id!, text: segment.text }); }
    catch { break; }
    if (!active()) break;
    if (match && match.segmentId === segment.id && match.text === segment.text && candidates.some(line => line.id === match.lineId)
      && ['complete', 'partial', 'fumbled'].includes(match.verdict)) {
      matches.push(match);
      if (match.verdict === 'complete') cursor = lines.findIndex(line => line.id === match.lineId);
    }
  }
  return matches;
}

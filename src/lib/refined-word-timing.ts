import type { TranscriptSeg } from './session';

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
type Word = NonNullable<TranscriptSeg['words']>[number];
const trusted = (word: Word, segment: Pick<TranscriptSeg, 't0' | 't1'>) => Number.isFinite(word.t0) && Number.isFinite(word.t1)
  && Number.isFinite(word.confidence) && word.confidence >= 0.8 && word.t0 >= segment.t0 && word.t1 <= segment.t1 && word.t1 > word.t0;

export function needsRefinedWords(segments: readonly TranscriptSeg[]) {
  return segments.some(segment => segment.isFinal !== false && segment.text.trim()
    && ((segment.wordTimingSource !== 'saved-audio' && segment.timingSource !== 'saved-audio')
      || !segment.words?.some(word => trusted(word, segment))));
}

/** Attach timing evidence without replacing the creator's transcript or its identity. */
export function enrichWordTiming(original: readonly TranscriptSeg[], refined: readonly Pick<TranscriptSeg, 'words'>[]) {
  const words = refined.flatMap(segment => segment.words ?? []).sort((a, b) => a.t0 - b.t0);
  const used = new Set<Word>();
  return original.map(segment => {
    if (segment.isFinal === false) return segment;
    const spoken = segment.text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.map(normalize) ?? [];
    const candidates = words.filter(word => !used.has(word) && trusted(word, segment) && normalize(word.text));
    // Order alignment disambiguates repeated fillers and never invents timing for unmatched speech.
    const scores = Array.from({ length: spoken.length + 1 }, () => new Uint16Array(candidates.length + 1));
    for (let i = spoken.length - 1; i >= 0; i--) for (let j = candidates.length - 1; j >= 0; j--) {
      scores[i][j] = spoken[i] === normalize(candidates[j].text) ? 1 + scores[i + 1][j + 1] : Math.max(scores[i + 1][j], scores[i][j + 1]);
    }
    const matched: Word[] = [];
    for (let i = 0, j = 0; i < spoken.length && j < candidates.length;) {
      if (spoken[i] === normalize(candidates[j].text)) { matched.push({ ...candidates[j] }); used.add(candidates[j]); i++; j++; }
      else if (scores[i + 1][j] >= scores[i][j + 1]) i++;
      else j++;
    }
    return matched.length ? { ...segment, words: matched, wordTimingSource: 'saved-audio' as const } : segment;
  });
}

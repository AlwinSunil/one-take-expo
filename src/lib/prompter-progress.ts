export function prompterWords(text: string): string[] {
  return text.match(/\S+/gu) ?? [];
}

function normalize(word: string): string {
  return word.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Recompute from revised utterances so partial recognition never permanently marks a word read. */
export function followScript(script: readonly string[], transcript: string) {
  const expected = script.map(normalize);
  const heard = prompterWords(transcript).map(normalize).filter(Boolean);
  const matched = new Set<number>();
  let cursor = 0;
  for (let i = 0; i < heard.length; i++) {
    while (cursor < expected.length && !expected[cursor]) cursor++;
    for (let j = cursor; j < Math.min(expected.length, cursor + 12); j++) {
      if (expected[j] !== heard[i]) continue;
      // A skipped phrase needs a second anchor; a stray common word must not jump the script.
      if (j > cursor && (!heard[i + 1] || expected[j + 1] !== heard[i + 1])) continue;
      matched.add(j);
      cursor = j + 1;
      break;
    }
  }
  return { cursor, matched };
}

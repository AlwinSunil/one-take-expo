import { importantCategory } from './semantic-policy.ts';

/** Only omit standalone social phrases; a greeting can also contain an essential instruction. */
export function clearLineImportance(text: string): boolean | null {
  const value = text.trim();
  if (!value) return false;
  if (/\d|[%$€£₹]|\b(?:must|never|required|important|remember|deadline|expires?|costs?|price|free|offline|guarantee|promise|subscribe|download|contact|order|buy|click|tap|save|before|after)\b/i.test(value)) return true;
  if (/^(?:(?:hi|hello|hey)(?:\s+(?:everyone|everybody|there|folks))?|(?:thank you|thanks)(?:\s+(?:for watching|everyone|everybody|so much))?|(?:goodbye|bye)(?:\s+(?:everyone|everybody))?|see you(?:\s+(?:soon|next time))?)[\s.!]*$/i.test(value)) return false;
  return null;
}

export async function importantLineIds(
  lines: readonly { id: string; spokenText: string }[],
  classify: (text: string) => Promise<string>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const line of lines) {
    const clear = clearLineImportance(line.spokenText);
    const important = clear ?? importantCategory(await classify(line.spokenText));
    if (important !== false) ids.push(line.id);
  }
  return ids;
}

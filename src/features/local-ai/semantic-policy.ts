import { englishHardConflict, matchEnglish } from '../speech-analysis/alignment.ts';

const COMMON_CAPITALS = new Set(('a an the i you your we our it its they their this that these those hello hi hey thanks thank welcome delivery shipping save before after each every visit order buy please remember subscribe download use try start stop open close press click tap make record share send get keep no not do does is are can will if when for with on in at to from today tomorrow yesterday free').split(' '));
function names(text: string): string[] {
  return [...text.matchAll(/\b[A-Z][a-z]+\b/g)].map(match => match[0].toLowerCase()).filter(word => !COMMON_CAPITALS.has(word));
}
export function semanticText(text: string): string {
  return text.toLowerCase().replace(/[’]/g, "'")
    .replace(/\b(?:you |customers? )?(?:do not|don't|never) (?:have to )?pay for (?:shipping|delivery)\b/g, 'delivery is free')
    .replace(/\b(?:shipping|delivery) (?:has no (?:charge|cost)|costs nothing|is at no (?:charge|cost))\b/g, 'delivery is free')
    .replace(/\bno[- ]cost (?:shipping|delivery)\b/g, 'free delivery')
    .replace(/\bshipping\b/g, 'delivery').replace(/\bparcel\b/g, 'package')
    .replace(/\byour package\b/g, 'the package')
    .replace(/\bthe next day\b/g, 'tomorrow')
    .replace(/\bwill be delivered\b/g, 'arrives')
    .replace(/\b(?:closing|close|exit|exiting)\b/g, 'exit')
    .replace(/\b(?:changes|work)\b/g, 'changes')
    .replace(/\bremember to\b/g, '').replace(/\bpurchase\b/g, 'order')
    .replace(/^before you ([^,]+),\s*(.+?)[.!]?$/, '$2 before $1')
    .replace(/\bexit the (?:app|application)\b/g, 'exit');
}
export function semanticFactsAgree(script: string, spoken: string): boolean {
  const a = semanticText(script), b = semanticText(spoken);
  const temporal = (text: string) => [...(text.match(/\b(?:today|tomorrow|yesterday|before|after|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g) ?? [])].sort().join('|');
  if (temporal(a) !== temporal(b)) return false;
  const allNames = new Set([...names(script), ...names(spoken)]);
  if ([...allNames].some(name => new RegExp(`\\b${name}\\b`, 'i').test(script) !== new RegExp(`\\b${name}\\b`, 'i').test(spoken))) return false;
  return !englishHardConflict(a, b) && !englishHardConflict(b, a);
}
const FILLER_WORDS = new Set('a an the is are was were be been being i you your we our us it its this that for to of in on at and or as has have do does with by will would can could should please remember'.split(' '));
export function sharesMeaningAnchor(script: string, spoken: string): boolean {
  const tokens = (text: string) => semanticText(text).match(/[a-z0-9]+/g)?.filter(word => !FILLER_WORDS.has(word)) ?? [];
  const a = tokens(script), b = new Set(tokens(spoken));
  return a.some(word => b.has(word));
}
export function safeSemanticCandidate(script: string, spoken: string): boolean {
  return semanticFactsAgree(script, spoken) && sharesMeaningAnchor(script, spoken);
}
export function obviousSpeechMatch(script: string, spoken: string): 'complete' | 'partial' | null {
  if (!semanticFactsAgree(script, spoken)) return null;
  const match = matchEnglish(semanticText(script), semanticText(spoken));
  return match.verdict === 'matched' ? 'complete' : match.verdict === 'partial' ? 'partial' : null;
}
export function selectedSentence(result: string, count: number): number | null {
  if (/none of|no (?:matching|sentence|option)|unrelated/i.test(result)) return null;
  const first = result.replace(/\*|#/g, '').trim().split(/\n|\\n/)[0];
  const match = first.match(/^(?:(?:the )?(?:best |correct )?(?:answer|sentence|choice)(?: number)?(?: is|:)?\s*)?(\d+)(?:[.)\s]|$)/i);
  const index = match ? Number(match[1]) - 1 : -1;
  return index >= 0 && index < count ? index : null;
}
export function importantCategory(result: string): boolean | null {
  const category = result.replace(/"[^"]*"/g, '').toLowerCase().match(/\b(greeting|goodbye|transition|filler|fact|instruction|promise|claim|action)\b/)?.[1];
  if (!category) return null;
  return ['fact', 'instruction', 'promise', 'claim', 'action'].includes(category);
}
export function explicitRestart(text: string): boolean {
  return /\b(?:let me (?:start|try|say (?:that|it)) again|start (?:over|again)|sorry[, ]+(?:let me|i mean)|i messed (?:that|it) up)\b/i.test(text);
}

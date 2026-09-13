/**
 * Conservative script following for the existing final Moonshine segments.
 *
 * This module owns a reading position only.  It does not create takes, mark
 * coverage, resolve action cues, or make a media decision.  Recognition text
 * is useful evidence, but semantic matching remains a deterministic lexical
 * heuristic and its score must never be presented as recognizer confidence.
 */

export type EnglishMatchVerdict = 'matched' | 'partial' | 'mismatch' | 'unknown';

export interface EnglishMatch {
  verdict: EnglishMatchVerdict;
  /** Heuristic similarity in the closed interval [0, 1], never confidence. */
  score: number;
  reason: string;
}

export interface AlignmentLine {
  id: string;
  /** Raw line text. `spokenText` is preferred when a parsed script supplies it. */
  text?: string;
  spokenText?: string;
  order?: number;
}

/** A segment from the already session/sequence-filtered caption stream. */
export interface AlignmentSegment {
  id: string;
  text: string;
  isFinal: boolean;
  t0?: number;
  t1?: number;
  sequence?: number;
  sessionId?: string;
}

export type AlignmentStatus =
  | 'idle'
  | 'following'
  | 'pending'
  | 'partial'
  | 'paused'
  | 'unavailable'
  | 'stopped'
  | 'unknown';

export interface AlignmentStatusEvent {
  type: 'status';
  status: 'idle' | 'preparing' | 'listening' | 'delayed' | 'unavailable' | 'error' | 'stopped' | 'interrupted';
  message?: string;
  sequence?: number;
  sessionId?: string;
}

export type AlignmentEvent = AlignmentSegment | AlignmentStatusEvent;

/** Shape of the existing `useLiveCaptions` CaptionUpdate event. */
export interface CaptionAlignmentUpdate {
  sessionId: string;
  sequence: number;
  text?: string;
  isFinal?: boolean;
  segments?: readonly AlignmentSegment[];
}

export type AlignmentOutcome = 'matched' | 'partial' | 'mismatch' | 'unknown' | 'reread' | 'ignored';

export interface AlignmentHistoryEntry {
  id: string;
  segmentId: string;
  text: string;
  lineIds: string[];
  outcome: AlignmentOutcome;
  score: number;
  reason: string;
  final: boolean;
  epoch: number;
  t0: number | null;
  t1: number | null;
}

export interface AlignmentState {
  /** Stable script snapshot used by this reducer. */
  lines: AlignmentLine[];
  /** Script-order subset the follower may visit; null means all spoken lines. */
  pickupLineIds: string[] | null;
  activeLineIds: string[];
  /** Index of the line currently shown, or activeLineIds.length at the end. */
  cursor: number;
  currentLineId: string | null;
  nextLineId: string | null;
  /** Alignment evidence, deliberately separate from coverage verdicts. */
  committedLineIds: string[];
  skippedLineIds: string[];
  history: AlignmentHistoryEntry[];
  observations: AlignmentSegment[];
  pendingSegmentIds: string[];
  invalidatedSegmentIds: string[];
  status: AlignmentStatus;
  statusMessage: string;
  /** Native recognition lifecycle. A delayed or unavailable engine blocks movement. */
  engineStatus: 'ready' | 'pending' | 'unavailable' | 'stopped';
  enabled: boolean;
  /** Incremented by a manual movement or lifecycle reset. */
  epoch: number;
  lastSequence: number;
  lastSourceTime: number | null;
  /** Source-time barrier after a manual override. */
  barrierTime: number | null;
  /** Manual movement without a calibrated clock cannot authorize fresh speech yet. */
  manualClockUnknown: boolean;
  sessionId: string | null;
  scriptRevision: string | null;
}

export interface CreateAlignmentStateOptions {
  lines: readonly AlignmentLine[];
  sessionId?: string | null;
  scriptRevision?: string | null;
  pickupLineIds?: readonly string[] | null;
  startLineId?: string | null;
  enabled?: boolean;
}

export interface ResetAlignmentOptions {
  reason?: 'new-source' | 'retry' | 'script-revision' | 'lifecycle' | 'resume' | 'pickup' | 'manual';
  lines?: readonly AlignmentLine[];
  sessionId?: string | null;
  scriptRevision?: string | null;
  pickupLineIds?: readonly string[] | null;
  startLineId?: string | null;
  enabled?: boolean;
}

export interface AlignmentFollower {
  readonly state: AlignmentState;
  getState(): AlignmentState;
  consume(event: AlignmentEvent): AlignmentState;
  manualNext(at?: number): AlignmentState;
  manualPrevious(at?: number): AlignmentState;
  reanchor(lineId: string, at?: number): AlignmentState;
  setEnabled(enabled: boolean): AlignmentState;
  setPickupLineIds(lineIds: readonly string[] | null): AlignmentState;
  reset(options?: ResetAlignmentOptions): AlignmentState;
}

const MAX_CONTEXT_LINES = 4;
const EPSILON = 1e-6;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'we', 'our', 'ours',
  'they', 'their', 'theirs', 'he', 'she', 'it', 'his', 'her', 'its', 'them',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'for', 'on', 'in',
  'at', 'by', 'with', 'and', 'or', 'but', 'so', 'than', 'as', 'that', 'this', 'these',
  'those', 'how', 'what', 'when', 'where', 'why', 'from', 'into', 'about', 'then', 'there',
  'here', 'please', 'let', 'me', 'very', 'really', 'also', 'just', 'do', 'does', 'did',
  'have', 'has', 'had', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
  'who', 'whom', 'which', 'while', 'if', 'than', 'all', 'each',
]);

const OPTIONAL_SPOKEN_EXTRAS = new Set(['app', 'application']);

// First/second-person and human pronouns affect who did what. Neutral `it`
// is omitted because ASR commonly drops a repeated object without changing
// the spoken idea (for example, "share it" -> "share").
const PRONOUNS = new Set(['i', 'me', 'you', 'we', 'they', 'he', 'she', 'them', 'my', 'mine', 'your', 'yours', 'our', 'ours', 'their', 'theirs', 'his', 'her', 'hers', 'its']);

const MODAL_WORDS = new Set(['will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'must', 'need']);

const CONJUNCTIONS = new Set(['and', 'or']);

const NEGATIONS = new Set(['not', 'no', 'never', 'without', 'neither', 'nor', 'hardly', 'barely']);

const ROLE_WORDS = new Set([
  'customer', 'creator', 'user', 'viewer', 'host', 'guest', 'buyer', 'seller', 'seller',
  'doctor', 'nurse', 'teacher', 'student', 'manager', 'director', 'engineer', 'developer',
  'editor', 'presenter', 'operator', 'admin', 'administrator', 'owner', 'reviewer', 'client',
  'parent', 'child', 'person', 'team', 'audience', 'employee', 'employer',
]);

const FACT_WORDS = new Set([
  'first', 'second', 'third', 'last', 'before', 'after', 'above', 'below', 'more', 'less',
  'only', 'none', 'every', 'each', 'some', 'any', 'always', 'different', 'same', 'original',
  'final', 'live', 'offline', 'online', 'manual', 'automatic', 'enabled', 'disabled',
  'required', 'optional', 'clean', 'noisy', 'quiet', 'loud', 'public', 'private', 'free',
  'paid', 'maximum', 'minimum', 'exactly', 'true', 'false', 'can', 'cannot', 'must', 'need',
  'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'and', 'or',
]);

const COMMON_FIRST_WORDS = new Set([
  'a', 'an', 'the', 'today', 'this', 'that', 'these', 'those', 'now', 'here', 'there',
  'i', 'we', 'you', 'they', 'it', 'my', 'our', 'your', 'start', 'stop', 'open', 'close',
  'review', 'record', 'show', 'see', 'use', 'save', 'store', 'keep', 'preserve', 'demonstrate',
  'upload', 'share', 'check', 'start', 'finish', 'say', 'tell', 'make', 'capture', 'let', 'please', 'welcome', 'first', 'next',
  'the', 'before', 'after', 'when', 'while', 'because', 'although',
]);

const CONTRACTIONS: Record<string, string> = {
  "i'm": 'i am', "you're": 'you are', "we're": 'we are', "they're": 'they are',
  "he's": 'he is', "she's": 'she is', "it's": 'it is', "that's": 'that is',
  "what's": 'what is', "there's": 'there is', "here's": 'here is',
  "i've": 'i have', "you've": 'you have', "we've": 'we have', "they've": 'they have',
  "i'll": 'i will', "you'll": 'you will', "we'll": 'we will', "they'll": 'they will',
  "he'll": 'he will', "she'll": 'she will', "it'll": 'it will',
  "i'd": 'i would', "you'd": 'you would', "we'd": 'we would', "they'd": 'they would',
  "can't": 'can not', "cannot": 'can not', "won't": 'will not', "don't": 'do not',
  "doesn't": 'does not', "didn't": 'did not', "isn't": 'is not', "aren't": 'are not',
  "wasn't": 'was not', "weren't": 'were not', "shouldn't": 'should not',
  "wouldn't": 'would not', "couldn't": 'could not', "mustn't": 'must not',
  "haven't": 'have not', "hasn't": 'has not', "hadn't": 'had not',
};

const SYNONYMS: Record<string, string> = {
  demonstrate: 'show', display: 'show', present: 'show',
  function: 'work', functions: 'work', operates: 'work', operate: 'work', working: 'work',
  capture: 'record', captures: 'record', recording: 'record', records: 'record',
  begin: 'start', begins: 'start', beginning: 'start', launch: 'start', launches: 'start',
  finish: 'end', finishes: 'end', complete: 'end', completes: 'end',
  check: 'review', inspect: 'review', examines: 'review', examine: 'review',
  result: 'outcome', results: 'outcome', outcome: 'outcome', outcomes: 'outcome',
  save: 'store', stores: 'store', storing: 'store', preserve: 'keep', retains: 'keep', retain: 'keep',
  locally: 'local', local: 'local',
  original: 'original',
};


const OPPOSITES: Record<string, string> = {
  first: 'last', last: 'first', before: 'after', after: 'before', above: 'below', below: 'above',
  more: 'less', less: 'more', same: 'different', different: 'same',
  required: 'optional', optional: 'required', enabled: 'disabled', disabled: 'enabled',
  live: 'offline', offline: 'live', public: 'private', private: 'public',
  clean: 'noisy', noisy: 'clean', quiet: 'loud', loud: 'quiet', free: 'paid', paid: 'free',
  true: 'false', false: 'true',
};

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10,
};

interface MatchToken {
  surface: string;
  norm: string;
  canonical: string;
  kind: 'word' | 'number' | 'name' | 'role' | 'negation' | 'fact';
  hard: boolean;
  sentenceStart: boolean;
}

interface LcsResult {
  matched: Array<{ script: MatchToken; spoken: MatchToken; scriptIndex: number; spokenIndex: number }>;
  matchedWeight: number;
  scriptWeight: number;
  unmatchedSpokenWeight: number;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function normalizeWord(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[’']/g, "'");
}

function tokenWeight(token: MatchToken): number {
  return token.hard ? 4 : 1;
}

function isWordCapitalized(value: string): boolean {
  return /^\p{Lu}/u.test(value);
}

function isSentenceStart(text: string, start: number): boolean {
  if (start === 0) return true;
  return /[.!?]\s*$/u.test(text.slice(0, start));
}

function canonicalWord(norm: string): string {
  if (SYNONYMS[norm]) return SYNONYMS[norm];
  if (norm.length > 5 && norm.endsWith('ing')) {
    const stem = norm.slice(0, -3);
    return SYNONYMS[stem] ?? SYNONYMS[`${stem}e`] ?? `${stem}e`;
  }
  if (norm.length > 4 && norm.endsWith('ed')) return SYNONYMS[norm.slice(0, -2)] ?? norm.slice(0, -2);
  if (norm.length > 4 && norm.endsWith('s')) return SYNONYMS[norm.slice(0, -1)] ?? norm.slice(0, -1);
  return norm;
}

function numberCanonical(norm: string): string | null {
  const compact = norm.replace(/,/g, '');
  if (/^\d+(?:\.\d+)?[a-z]*$/u.test(compact)) return `number:${compact}`;
  const value = NUMBER_WORDS[compact];
  return value === undefined ? null : `number:${value}`;
}

function tokenize(text: string): MatchToken[] {
  const source = text.normalize('NFKC').replace(/[–—]/gu, '-')
    .replace(/\bon (?:your|the|this) device\b/giu, 'locally');
  const result: MatchToken[] = [];
  // Keep decimal/comma numbers as one protected lexeme. Splitting `1.5` into
  // `1` and `5` would let a changed fact pass through a bag-of-words score.
  const words = /(?:\d[\d,]*(?:\.\d+)?[\p{L}]*|[\p{L}]+(?:['’][\p{L}]+)?)/gu;
  for (const match of source.matchAll(words)) {
    const surface = match[0];
    const start = match.index ?? 0;
    const norm = normalizeWord(surface);
    const sentenceStart = isSentenceStart(source, start);
    const expansion = CONTRACTIONS[norm] ?? (norm.endsWith("'s") ? norm.slice(0, -2) : norm);
    for (const expanded of expansion.split(/\s+/u)) {
      const expandedNorm = normalizeWord(expanded);
      const nameCandidate = isWordCapitalized(surface)
        && !sentenceStart
        && !STOPWORDS.has(expandedNorm)
        && !COMMON_FIRST_WORDS.has(expandedNorm);
      const firstNameCandidate = result.length === 0
        && isWordCapitalized(surface)
        && !COMMON_FIRST_WORDS.has(expandedNorm)
        && !STOPWORDS.has(expandedNorm);
      const number = nameCandidate || firstNameCandidate ? null : numberCanonical(expandedNorm);
      const kind: MatchToken['kind'] = number !== null
        ? 'number'
        : NEGATIONS.has(expandedNorm)
          ? 'negation'
          : ROLE_WORDS.has(expandedNorm)
            ? 'role'
            : nameCandidate || firstNameCandidate
              ? 'name'
              : FACT_WORDS.has(expandedNorm) || MODAL_WORDS.has(expandedNorm) || CONJUNCTIONS.has(expandedNorm)
                ? 'fact'
                : 'word';
      const canonical = number ?? (kind === 'name' ? `name:${expandedNorm}` : canonicalWord(expandedNorm));
      result.push({
        surface: expanded,
        norm: expandedNorm,
        canonical,
        kind,
        hard: kind !== 'word',
        sentenceStart,
      });
    }
  }
  return collapseFuturePhrase(result);
}

/** Treat the generic future forms "going to" and "will" alike. */
function collapseFuturePhrase(tokens: MatchToken[]): MatchToken[] {
  const result: MatchToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    if (current.norm === 'going' && next?.norm === 'to' && !current.hard && !next.hard) {
      result.push({ ...current, surface: 'going to', norm: 'will', canonical: 'will', kind: 'fact', hard: true });
      index += 1;
      continue;
    }
    result.push(current);
  }
  return result;
}

function contentTokens(tokens: readonly MatchToken[]): MatchToken[] {
  return tokens.filter(token => token.hard || !STOPWORDS.has(token.norm) || PRONOUNS.has(token.norm));
}

function hardCompatible(script: MatchToken, spoken: MatchToken): boolean {
  if (script.kind === 'name' && (spoken.kind === 'name' || spoken.kind === 'word')) return script.norm === spoken.norm;
  // A lower-cased ASR result may classify a brand such as "One Take" as a
  // number word. The literal spelling is still required; a different name is
  // never accepted through a generic synonym.
  if (script.kind === 'name' && spoken.kind === 'number') return script.norm === spoken.norm;
  if (script.kind !== spoken.kind) return false;
  return script.canonical === spoken.canonical;
}

function tokensCompatible(script: MatchToken, spoken: MatchToken): boolean {
  if (script.hard || spoken.hard) return hardCompatible(script, spoken);
  return script.canonical === spoken.canonical;
}

function weightedLcs(script: readonly MatchToken[], spoken: readonly MatchToken[]): LcsResult {
  const rows = script.length + 1;
  const cols = spoken.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = script.length - 1; i >= 0; i -= 1) {
    for (let j = spoken.length - 1; j >= 0; j -= 1) {
      const match = tokensCompatible(script[i], spoken[j]) ? tokenWeight(script[i]) : 0;
      table[i][j] = Math.max(match + table[i + 1][j + 1], table[i + 1][j], table[i][j + 1]);
    }
  }

  const matched: LcsResult['matched'] = [];
  let i = 0;
  let j = 0;
  while (i < script.length && j < spoken.length) {
    if (tokensCompatible(script[i], spoken[j])
      && table[i][j] === tokenWeight(script[i]) + table[i + 1][j + 1]
      && table[i][j] >= table[i + 1][j]
      && table[i][j] >= table[i][j + 1]) {
      matched.push({ script: script[i], spoken: spoken[j], scriptIndex: i, spokenIndex: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  const scriptWeight = script.reduce((sum, token) => sum + tokenWeight(token), 0);
  const matchedWeight = matched.reduce((sum, pair) => sum + tokenWeight(pair.script), 0);
  const matchedSpokenIndexes = new Set(matched.map(pair => pair.spokenIndex));
  const unmatchedSpokenWeight = spoken.reduce((sum, token, index) => {
    if (matchedSpokenIndexes.has(index) || OPTIONAL_SPOKEN_EXTRAS.has(token.norm)) return sum;
    return sum + tokenWeight(token);
  }, 0);
  return { matched, matchedWeight, scriptWeight, unmatchedSpokenWeight };
}

function prefixLike(script: readonly MatchToken[], spoken: readonly MatchToken[]): boolean {
  if (spoken.length === 0) return false;
  let scriptIndex = 0;
  let matchedAny = false;
  for (const spokenToken of spoken) {
    let found = false;
    while (scriptIndex < script.length) {
      const scriptToken = script[scriptIndex];
      scriptIndex += 1;
      if (tokensCompatible(scriptToken, spokenToken)) {
        found = true;
        matchedAny = true;
        break;
      }
      // A spoken token that is not a script prefix is an off-script turn.
      if (!STOPWORDS.has(scriptToken.norm)) return false;
    }
    if (!found) return false;
  }
  return matchedAny;
}

function findHardConflict(script: readonly MatchToken[], spoken: readonly MatchToken[]): string | null {
  const scriptHard = script.filter(token => token.hard);
  const spokenHard = spoken.filter(token => token.hard);
  const used = new Set<number>();
  for (const expected of scriptHard) {
    const found = spokenHard.findIndex((actual, index) => !used.has(index) && hardCompatible(expected, actual));
    if (found >= 0) {
      used.add(found);
      continue;
    }
    const sameKind = spokenHard.some(actual => actual.kind === expected.kind);
    if (sameKind) {
      return `A meaning-bearing ${expected.kind} differs from the script.`;
    }
  }
  const scriptNegations = scriptHard.filter(token => token.kind === 'negation').length;
  const spokenNegations = spokenHard.filter(token => token.kind === 'negation').length;
  if (scriptNegations !== spokenNegations) return 'Negation changed, so this cannot be treated as the same line.';

  for (const actual of spokenHard) {
    if (used.has(spokenHard.indexOf(actual))) continue;
    if (actual.kind === 'number' || actual.kind === 'name' || actual.kind === 'role' || actual.kind === 'fact') {
      const opposite = OPPOSITES[actual.norm];
      if (opposite && script.some(token => token.norm === opposite)) return `The fact "${actual.norm}" conflicts with the script.`;
      if (!scriptHard.some(expected => hardCompatible(expected, actual))) {
        return `A meaning-bearing ${actual.kind} was added or changed.`;
      }
    }
  }
  return null;
}

function compactTokens(text: string): MatchToken[] {
  return tokenize(text);
}

/**
 * Compare two English utterances with a small, explainable lexical policy.
 *
 * The policy accepts contractions, inflection and a short list of generic
 * wording equivalents. It requires ordered content and exact protected
 * anchors for names, numbers, roles, polarity and high-risk facts. A score is
 * only a heuristic used to rank candidate lines; it is not a confidence value.
 */
export function matchEnglish(script: string, spoken: string): EnglishMatch {
  if (typeof script !== 'string' || typeof spoken !== 'string') {
    return { verdict: 'unknown', score: 0, reason: 'Script and speech text must be strings.' };
  }
  const scriptTokens = compactTokens(script);
  const spokenTokens = compactTokens(spoken);
  if (scriptTokens.length === 0 || spokenTokens.length === 0) {
    return { verdict: 'unknown', score: 0, reason: 'There is not enough text to compare.' };
  }
  const scriptContent = contentTokens(scriptTokens);
  const spokenContent = contentTokens(spokenTokens);
  if (scriptContent.length === 0 || spokenContent.length === 0) {
    return prefixLike(scriptTokens, spokenTokens)
      ? { verdict: 'partial', score: 0.1, reason: 'Speech has started the line but contains no supported content yet.' }
      : { verdict: 'mismatch', score: 0, reason: 'Speech has no supported content in the script.' };
  }

  const conflict = findHardConflict(scriptContent, spokenContent);
  const lcs = weightedLcs(scriptContent, spokenContent);
  const coverage = lcs.scriptWeight === 0 ? 0 : lcs.matchedWeight / lcs.scriptWeight;
  const extraPenalty = lcs.unmatchedSpokenWeight / Math.max(1, lcs.scriptWeight + lcs.unmatchedSpokenWeight);
  const score = clamp(coverage - extraPenalty * 0.35);
  const isPrefix = prefixLike(scriptTokens, spokenTokens);

  if (conflict) return { verdict: 'mismatch', score, reason: conflict };
  // A normal match needs every meaning-bearing script token. The sole leniency
  // here is a tiny list of generic context additions such as "app"; an omitted
  // content word must remain partial rather than crossing the follow barrier.
  if (coverage >= 0.999 && lcs.unmatchedSpokenWeight === 0) {
    return { verdict: 'matched', score, reason: 'Ordered script content is supported with only generic wording variation.' };
  }
  if (isPrefix || (coverage >= 0.25 && spokenContent.length < scriptContent.length && lcs.unmatchedSpokenWeight === 0)) {
    return { verdict: 'partial', score, reason: 'Speech follows the beginning of the line but leaves part of the idea unresolved.' };
  }
  return { verdict: 'mismatch', score, reason: coverage > 0
    ? 'Speech overlaps the script but changes or omits too much meaning to advance.'
    : 'Speech does not follow the script content.' };
}

function lineText(line: AlignmentLine): string {
  return (line.spokenText ?? line.text ?? '').trim();
}

function copyLines(lines: readonly AlignmentLine[]): AlignmentLine[] {
  const ids = new Set<string>();
  return lines.map((line, index) => {
    if (!line || typeof line.id !== 'string' || !line.id.trim()) throw new Error('Alignment line ids must be non-empty.');
    if (ids.has(line.id)) throw new Error(`Duplicate alignment line id: ${line.id}`);
    ids.add(line.id);
    if (line.text !== undefined && typeof line.text !== 'string') throw new TypeError(`Alignment line ${line.id} text must be a string.`);
    if (line.spokenText !== undefined && typeof line.spokenText !== 'string') throw new TypeError(`Alignment line ${line.id} spokenText must be a string.`);
    return { ...line, order: line.order ?? index };
  });
}

function activeLineIds(lines: readonly AlignmentLine[], pickupLineIds: readonly string[] | null | undefined): string[] {
  const spokenIds = lines.filter(line => lineText(line).length > 0).map(line => line.id);
  if (pickupLineIds === null || pickupLineIds === undefined) return spokenIds;
  const requested = new Set(pickupLineIds);
  return spokenIds.filter(id => requested.has(id));
}

function validPickupIds(lines: readonly AlignmentLine[], pickupLineIds: readonly string[] | null | undefined): string[] | null {
  if (pickupLineIds === null || pickupLineIds === undefined) return null;
  const known = new Set(lines.map(line => line.id));
  const unique: string[] = [];
  for (const id of pickupLineIds) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Pickup line ids must be non-empty.');
    if (!known.has(id)) throw new Error(`Unknown pickup line id: ${id}`);
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
}

function cursorLineIds(active: readonly string[], cursor: number): { currentLineId: string | null; nextLineId: string | null } {
  return {
    currentLineId: active[cursor] ?? null,
    nextLineId: active[cursor + 1] ?? null,
  };
}

function withCursor(state: AlignmentState, cursor: number): AlignmentState {
  const bounded = Math.max(0, Math.min(state.activeLineIds.length, cursor));
  const ids = cursorLineIds(state.activeLineIds, bounded);
  return { ...state, cursor: bounded, ...ids };
}

export function createAlignmentState(options: CreateAlignmentStateOptions): AlignmentState {
  const lines = copyLines(options.lines);
  const pickupLineIds = validPickupIds(lines, options.pickupLineIds);
  const active = activeLineIds(lines, pickupLineIds);
  const requestedStart = options.startLineId ? active.indexOf(options.startLineId) : 0;
  const cursor = requestedStart >= 0 ? requestedStart : 0;
  const ids = cursorLineIds(active, cursor);
  return {
    lines,
    pickupLineIds,
    activeLineIds: active,
    cursor,
    ...ids,
    committedLineIds: [],
    skippedLineIds: [],
    history: [],
    observations: [],
    pendingSegmentIds: [],
    invalidatedSegmentIds: [],
    status: options.enabled === false ? 'idle' : 'idle',
    statusMessage: options.enabled === false ? 'Voice follow is off.' : '',
    engineStatus: 'ready',
    enabled: options.enabled !== false,
    epoch: 0,
    lastSequence: -1,
    lastSourceTime: null,
    barrierTime: null,
    manualClockUnknown: false,
    sessionId: options.sessionId ?? null,
    scriptRevision: options.scriptRevision ?? null,
  };
}

function statusFromEvent(status: AlignmentStatusEvent['status']): AlignmentStatus {
  if (status === 'unavailable' || status === 'error' || status === 'interrupted') return 'unavailable';
  if (status === 'delayed' || status === 'preparing') return 'pending';
  if (status === 'stopped') return 'stopped';
  return 'idle';
}

function addHistory(
  state: AlignmentState,
  event: AlignmentSegment,
  outcome: AlignmentOutcome,
  lineIds: readonly string[],
  score: number,
  reason: string,
  final: boolean,
): AlignmentState {
  const entry: AlignmentHistoryEntry = {
    id: `${state.epoch}:${event.id}:${state.history.length}`,
    segmentId: event.id,
    text: event.text,
    lineIds: [...lineIds],
    outcome,
    score: clamp(score),
    reason,
    final,
    epoch: state.epoch,
    t0: finiteTime(event.t0) ? event.t0! : null,
    t1: finiteTime(event.t1) ? event.t1! : null,
  };
  return { ...state, history: [...state.history, entry], statusMessage: reason };
}

function finiteTime(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function normalizeSegment(event: AlignmentSegment): AlignmentSegment | null {
  if (!event || typeof event.id !== 'string' || !event.id.trim() || typeof event.text !== 'string') return null;
  if (event.sequence !== undefined && (!Number.isInteger(event.sequence) || event.sequence < 0)) return null;
  if (event.t0 !== undefined && (!Number.isFinite(event.t0) || event.t0 < 0)) return null;
  if (event.t1 !== undefined && (!Number.isFinite(event.t1) || event.t1 < 0)) return null;
  if (event.t0 !== undefined && event.t1 !== undefined && event.t1 <= event.t0) return null;
  return { ...event, text: event.text.trim() };
}

function sameSegment(a: AlignmentSegment, b: AlignmentSegment): boolean {
  return a.id === b.id && a.text === b.text && a.isFinal === b.isFinal && a.t0 === b.t0 && a.t1 === b.t1;
}

function eventBeforeBarrier(state: AlignmentState, event: AlignmentSegment): boolean {
  if (state.manualClockUnknown) return true;
  if (state.invalidatedSegmentIds.includes(event.id)) return true;
  // Without a source timestamp there is no evidence that this utterance
  // started after a manual override. Holding it is safer than letting delayed
  // buffered recognition undo the creator's movement.
  if (state.barrierTime !== null && event.t0 === undefined) return true;
  if (state.barrierTime === null || event.t0 === undefined) return false;
  return event.t0 < state.barrierTime - EPSILON;
}

function candidateWindows(state: AlignmentState, spoken: string): Array<{
  start: number;
  end: number;
  lineIds: string[];
  match: EnglishMatch;
}> {
  const candidates: Array<{ start: number; end: number; lineIds: string[]; match: EnglishMatch }> = [];
  for (let length = 1; length <= MAX_CONTEXT_LINES && state.cursor + length <= state.activeLineIds.length; length += 1) {
    const lineIds = state.activeLineIds.slice(state.cursor, state.cursor + length);
    const text = lineIds
      .map(id => lineText(state.lines.find(line => line.id === id)!))
      .join(' ');
    candidates.push({
      start: state.cursor,
      end: state.cursor + length,
      lineIds,
      match: matchEnglish(text, spoken),
    });
  }
  // A later exact match permits honest reanchoring past omitted lines. Only
  // singleton later candidates are added: multi-line context is meaningful
  // only from the current cursor and cannot safely skip an unknown start.
  for (let index = state.cursor + 1; index < state.activeLineIds.length; index += 1) {
    const lineId = state.activeLineIds[index];
    const text = lineText(state.lines.find(line => line.id === lineId)!);
    candidates.push({ start: index, end: index + 1, lineIds: [lineId], match: matchEnglish(text, spoken) });
  }
  return candidates;
}

function chooseMatchedCandidate(candidates: readonly ReturnType<typeof candidateWindows>[number][]): {
  candidate: ReturnType<typeof candidateWindows>[number] | null;
  ambiguous: boolean;
} {
  const matched = candidates.filter(candidate => candidate.match.verdict === 'matched');
  if (matched.length === 0) return { candidate: null, ambiguous: false };
  const cursorStart = candidates[0]?.start ?? 0;
  const current = matched.filter(candidate => candidate.start === cursorStart);
  if (current.length > 0) {
    return { candidate: current.slice().sort((a, b) => b.end - a.end || b.match.score - a.match.score)[0], ambiguous: false };
  }
  const topScore = Math.max(...matched.map(candidate => candidate.match.score));
  const top = matched.filter(candidate => Math.abs(candidate.match.score - topScore) <= 0.08);
  if (top.length > 1) return { candidate: null, ambiguous: true };
  return { candidate: top[0], ambiguous: false };
}

function bestPartial(candidates: readonly ReturnType<typeof candidateWindows>[number][]): ReturnType<typeof candidateWindows>[number] | null {
  const partial = candidates.filter(candidate => candidate.match.verdict === 'partial');
  if (partial.length === 0) return null;
  const current = partial.find(candidate => candidate.start === 0);
  return current ?? partial.slice().sort((a, b) => b.match.score - a.match.score)[0];
}

function findReread(state: AlignmentState, eventText: string): { index: number; lineIds: string[]; match: EnglishMatch } | null {
  if (state.cursor <= 0) return null;
  const prior = state.activeLineIds.slice(0, state.cursor).map(id => ({
    id,
    index: state.activeLineIds.indexOf(id),
    match: matchEnglish(lineText(state.lines.find(line => line.id === id)!), eventText),
  })).filter(item => item.match.verdict === 'matched');
  if (prior.length !== 1) return null;
  return { index: prior[0].index, lineIds: [prior[0].id], match: prior[0].match };
}

function addSkipped(state: AlignmentState, ids: readonly string[]): string[] {
  const result = [...state.skippedLineIds];
  for (const id of ids) {
    if (!result.includes(id) && !state.committedLineIds.includes(id)) result.push(id);
  }
  return result;
}

function addCommitted(state: AlignmentState, ids: readonly string[]): string[] {
  const result = [...state.committedLineIds];
  for (const id of ids) if (!result.includes(id)) result.push(id);
  return result;
}

function updateObservation(state: AlignmentState, event: AlignmentSegment): AlignmentState | null {
  const previous = state.observations.find(item => item.id === event.id);
  if (previous && sameSegment(previous, event)) return null;
  if (previous?.isFinal && !event.isFinal) return null;
  // A final revision with the same stable segment id must not undo a committed
  // movement. The raw first final snapshot remains the evidence boundary.
  if (previous?.isFinal && event.isFinal) return null;
  const observations = previous
    ? state.observations.map(item => item.id === event.id ? { ...event } : item)
    : [...state.observations, { ...event }];
  const pendingSegmentIds = event.isFinal
    ? state.pendingSegmentIds.filter(id => id !== event.id)
    : state.pendingSegmentIds.includes(event.id) ? state.pendingSegmentIds : [...state.pendingSegmentIds, event.id];
  const lastSourceTime = finiteTime(event.t1)
    ? Math.max(state.lastSourceTime ?? 0, event.t1!)
    : state.lastSourceTime;
  return { ...state, observations, pendingSegmentIds, lastSourceTime, ...(event.sequence === undefined ? {} : { lastSequence: event.sequence }) };
}

function sourceTimeIsStale(state: AlignmentState, event: AlignmentSegment, previous: AlignmentSegment | undefined): boolean {
  if (state.lastSourceTime === null || event.t1 === undefined) return false;
  // A final revision is the one legitimate exception to the source clock
  // guard: a provisional segment may finalize after a later segment has been
  // observed by the adapter.
  if (previous && !previous.isFinal && event.isFinal) return false;
  return event.t1 <= state.lastSourceTime + EPSILON;
}

function reduceFinalRevision(state: AlignmentState, event: AlignmentSegment): AlignmentState {
  const previousLineIds = state.history
    .slice()
    .reverse()
    .find(entry => entry.segmentId === event.id)?.lineIds ?? [];
  const lastSourceTime = finiteTime(event.t1)
    ? Math.max(state.lastSourceTime ?? 0, event.t1)
    : state.lastSourceTime;
  const next = {
    ...state,
    lastSourceTime,
    ...(event.sequence === undefined ? {} : { lastSequence: event.sequence }),
    status: 'paused' as const,
  };
  return addHistory(next, event, 'ignored', previousLineIds, 0,
    'A changed final revision was retained as history but cannot move the reader a second time.', true);
}

function reduceSegment(state: AlignmentState, event: AlignmentSegment): AlignmentState {
  if (!state.enabled) return state;
  if (state.engineStatus !== 'ready') return state;
  const segment = normalizeSegment(event);
  if (!segment) return state;
  if (segment.sessionId && state.sessionId && segment.sessionId !== state.sessionId) return state;
  if (segment.sequence !== undefined && segment.sequence <= state.lastSequence) return state;
  if (eventBeforeBarrier(state, segment)) return state;
  const previous = state.observations.find(item => item.id === segment.id);
  if (sourceTimeIsStale(state, segment, previous)) return state;
  if (previous?.isFinal && segment.isFinal && !sameSegment(previous, segment)) return reduceFinalRevision(state, segment);
  const updated = updateObservation(state, segment);
  if (!updated) return state;
  if (!segment.isFinal) {
    const current = state.activeLineIds[state.cursor];
    const partial = current
      ? matchEnglish(lineText(state.lines.find(line => line.id === current)!), segment.text)
      : { verdict: 'unknown' as const, score: 0, reason: 'The script has reached its end.' };
    const result = addHistory(updated, segment, partial.verdict === 'partial' ? 'partial' : 'ignored', current ? [current] : [], partial.score,
      partial.verdict === 'partial' ? partial.reason : 'Provisional speech is retained as pending evidence and cannot move the reader.', false);
    return { ...result, status: 'pending' };
  }

  if (!segment.text) {
    return { ...addHistory(updated, segment, 'unknown', [], 0, 'No final speech text was received; the reader stays in place.', true), status: 'unknown' };
  }

  const candidates = candidateWindows(updated, segment.text);
  const selected = chooseMatchedCandidate(candidates);
  if (selected.ambiguous) {
    return { ...addHistory(updated, segment, 'mismatch', [], 0, 'Several similar script lines are ambiguous for this final speech; manual reanchoring is required.', true), status: 'paused' };
  }
  if (selected.candidate) {
    const candidate = selected.candidate;
    const skipped = addSkipped(updated, updated.activeLineIds.slice(updated.cursor, candidate.start));
    const committed = addCommitted(updated, candidate.lineIds);
    const withProgress = withCursor({ ...updated, skippedLineIds: skipped, committedLineIds: committed, status: 'following' }, candidate.end);
    return addHistory(withProgress, segment, 'matched', candidate.lineIds, candidate.match.score,
      candidate.start > updated.cursor
        ? `Matched a later script line and reanchored; intervening lines remain skipped and unresolved.`
        : candidate.lineIds.length > 1
          ? `Matched one final utterance across ${candidate.lineIds.length} adjacent script lines.`
          : candidate.match.reason,
      true);
  }

  const partial = bestPartial(candidates);
  if (partial) {
    return { ...addHistory(updated, segment, 'partial', partial.lineIds, partial.match.score, partial.match.reason, true), status: 'partial' };
  }

  const reread = findReread(updated, segment.text);
  if (reread) {
    const distance = updated.cursor - reread.index;
    if (distance <= 2) {
      // A nearby, unambiguous reread reacquires the script after the spoken
      // line. This may move back over a skipped section, while preserving its
      // earlier skipped history and never touching coverage.
      const reacquired = withCursor({
        ...updated,
        committedLineIds: addCommitted(updated, reread.lineIds),
        status: 'following',
      }, reread.index + 1);
      return addHistory(reacquired, segment, 'reread', reread.lineIds, reread.match.score,
        'This final speech reacquired a nearby earlier line; the reader moved to the following line.', true);
    }
    return { ...addHistory(updated, segment, 'ignored', reread.lineIds, reread.match.score,
      'This reread is too far from the current line to reanchor automatically; use manual navigation.', true), status: 'paused' };
  }
  return { ...addHistory(updated, segment, 'mismatch', [], 0, 'Final speech does not unambiguously match the current script position.', true), status: 'paused' };
}

function reduceStatus(state: AlignmentState, event: AlignmentStatusEvent): AlignmentState {
  if (event.sessionId && state.sessionId && event.sessionId !== state.sessionId) return state;
  if (event.sequence !== undefined && (!Number.isInteger(event.sequence) || event.sequence <= state.lastSequence)) return state;
  const status = statusFromEvent(event.status);
  const engineStatus: AlignmentState['engineStatus'] = status === 'unavailable'
    ? 'unavailable'
    : status === 'pending'
      ? 'pending'
      : status === 'stopped'
        ? 'stopped'
        : 'ready';
  return {
    ...state,
    status,
    engineStatus,
    statusMessage: event.message ?? (status === 'unavailable' ? 'Voice follow is unavailable; use manual navigation.' : ''),
    ...(event.sequence === undefined ? {} : { lastSequence: event.sequence }),
  };
}

export function reduceAlignment(state: AlignmentState, event: AlignmentEvent): AlignmentState {
  if (!event || typeof event !== 'object') return state;
  if (isAlignmentStatusEvent(event)) return reduceStatus(state, event);
  return reduceSegment(state, event);
}

function isAlignmentStatusEvent(event: AlignmentEvent): event is AlignmentStatusEvent {
  return 'type' in event && event.type === 'status';
}

/**
 * Adapt one existing caption update without applying its sequence filter once
 * per segment. Native updates may contain a snapshot of several final
 * segments, and all of those segments share the update sequence. Text-only
 * updates are retained as an honest pending/unknown state; a synthetic id is
 * never created from display text.
 */
export function reduceCaptionAlignment(state: AlignmentState, update: CaptionAlignmentUpdate): AlignmentState {
  if (!update || typeof update.sessionId !== 'string' || typeof update.sequence !== 'number'
    || !Number.isInteger(update.sequence) || update.sequence < 0) return state;
  if (state.sessionId && update.sessionId !== state.sessionId) return state;
  if (update.sequence <= state.lastSequence) return state;

  let next: AlignmentState = { ...state, lastSequence: update.sequence };
  const segments = update.segments ?? [];
  if (segments.length > 0) {
    for (const segment of segments) {
      // The update owns the ordering barrier. Removing the shared sequence
      // here lets every snapshot entry reach the reducer exactly once.
      next = reduceSegment(next, { ...segment, sessionId: update.sessionId, sequence: undefined });
    }
    return next;
  }

  const text = typeof update.text === 'string' ? update.text.trim() : '';
  return {
    ...next,
    status: text ? update.isFinal === true ? 'unknown' : 'pending' : 'unknown',
    statusMessage: text
      ? 'Caption text has no stable segment identity; it cannot advance the reader.'
      : 'No stable speech segment was received; the reader stays in place.',
  };
}

function barrierFor(state: AlignmentState, at?: number): number | null {
  if (at !== undefined && Number.isFinite(at) && at >= 0) return at;
  return state.lastSourceTime;
}

function manualMove(state: AlignmentState, cursor: number, at: number | undefined, reason: string): AlignmentState {
  const target = Math.max(0, Math.min(state.activeLineIds.length, cursor));
  const pending = state.observations.filter(item => !item.isFinal).map(item => item.id);
  const skipped = target > state.cursor
    ? addSkipped(state, state.activeLineIds.slice(state.cursor, target))
    : state.skippedLineIds;
  const next = withCursor({
    ...state,
    skippedLineIds: skipped,
    pendingSegmentIds: [],
    invalidatedSegmentIds: [...new Set([...state.invalidatedSegmentIds, ...pending])],
    epoch: state.epoch + 1,
    barrierTime: barrierFor(state, at),
    manualClockUnknown: !finiteTime(at),
    status: finiteTime(at) ? 'following' : 'paused',
    statusMessage: finiteTime(at) ? reason : 'Manual navigation works. Voice follow is paused until recognition can reanchor.',
  }, target);
  return next;
}

/** Manually advance the independent reader cursor and invalidate pending ASR. */
export function manualNext(state: AlignmentState, at?: number): AlignmentState {
  return manualMove(state, state.cursor + 1, at, 'Manual Next moved the reader; buffered speech was discarded.');
}

/** Manually move back without changing coverage or take decisions. */
export function manualPrevious(state: AlignmentState, at?: number): AlignmentState {
  return manualMove(state, state.cursor - 1, at, 'Manual Previous moved the reader; buffered speech was discarded.');
}

/** Reanchor to a stable script id, preserving all prior evidence and history. */
export function reanchorAlignment(state: AlignmentState, lineId: string, at?: number): AlignmentState {
  const target = state.activeLineIds.indexOf(lineId);
  if (target < 0) return state;
  return manualMove(state, target, at, `Manual reanchor selected ${lineId}; buffered speech was discarded.`);
}

export function resetAlignment(state: AlignmentState, options: ResetAlignmentOptions = {}): AlignmentState {
  const next = createAlignmentState({
    lines: options.lines ?? state.lines,
    sessionId: options.sessionId === undefined ? state.sessionId : options.sessionId,
    scriptRevision: options.scriptRevision === undefined ? state.scriptRevision : options.scriptRevision,
    pickupLineIds: options.pickupLineIds === undefined ? state.pickupLineIds : options.pickupLineIds,
    startLineId: options.startLineId,
    enabled: options.enabled === undefined ? state.enabled : options.enabled,
  });
  return { ...next, epoch: state.epoch + 1, statusMessage: options.reason ? `Follower reset for ${options.reason}.` : '' };
}

export function createAlignmentFollower(options: CreateAlignmentStateOptions): AlignmentFollower {
  let state = createAlignmentState(options);
  const follower: AlignmentFollower = {
    get state() { return state; },
    getState() { return state; },
    consume(event) { state = reduceAlignment(state, event); return state; },
    manualNext(at) { state = manualNext(state, at); return state; },
    manualPrevious(at) { state = manualPrevious(state, at); return state; },
    reanchor(lineId, at) { state = reanchorAlignment(state, lineId, at); return state; },
    setEnabled(enabled) {
      if (state.enabled === enabled) return state;
      state = { ...state, enabled, status: enabled ? 'idle' : 'idle', statusMessage: enabled ? '' : 'Voice follow is off.' };
      return state;
    },
    setPickupLineIds(lineIds) {
      state = resetAlignment(state, { reason: 'pickup', pickupLineIds: lineIds });
      return state;
    },
    reset(resetOptions) {
      state = resetAlignment(state, resetOptions);
      return state;
    },
  };
  return follower;
}

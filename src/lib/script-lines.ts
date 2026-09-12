import { extractBracketedCues } from './transcript-workflow.ts';

export { extractBracketedCues };

/**
 * The prompter in `camera.tsx` chunks an accepted script with this expression.
 * Editable lines must split identically, so the handoff to capture stays compatible.
 */
const LINE_CHUNKS = /[^.!?\n]+[.!?]?/g;

/** A comfortable on-camera reading pace. It is a planning estimate, not a measurement. */
export const WORDS_PER_MINUTE = 150;

const STRUCTURE_VERSION = 1;

/**
 * A required action is only ever resolved by the creator saying it happened.
 * `skipped` records an honest decision to move on; it never counts as resolved.
 */
export type ActionCueStatus = 'pending' | 'done' | 'skipped';

export interface ScriptActionCue {
  id: string;
  text: string;
  /** Cues are optional unless the creator explicitly marks them required. */
  required: boolean;
  status: ActionCueStatus;
}

/**
 * An unclosed bracket such as `[hold up`. The text stays spoken until the creator
 * corrects it, so nothing a creator typed is ever silently removed from the script.
 */
export interface AmbiguousCue {
  id: string;
  /** The text after the unclosed bracket. */
  text: string;
  /** The unclosed fragment exactly as it appears in the line. */
  raw: string;
  /** Index of the unclosed bracket inside the line text, used to rewrite it. */
  start: number;
}

export interface ScriptDocumentLine {
  id: string;
  /** The line exactly as the creator typed it, brackets included. */
  text: string;
  /** What the creator says out loud. Action cue text is never part of it. */
  spokenText: string;
  actionCues: ScriptActionCue[];
  ambiguousCues: AmbiguousCue[];
  kind: 'spoken' | 'action-only';
  /** Spoken words only. */
  wordCount: number;
}

export type ScriptNextStep = 'add-script' | 'add-spoken-line' | 'ready-to-record';

export interface ScriptDocument {
  /** The raw draft text. It is the source of truth; every line is derived from it. */
  text: string;
  lines: ScriptDocumentLine[];
  /** Deleted lines are kept so coverage owners can retain their historical takes. */
  removedLines: ScriptDocumentLine[];
  spokenWordCount: number;
  readTimeSeconds: number;
  /** `m:ss` for display. */
  readTime: string;
  nextStep: ScriptNextStep;
  /** Counter behind minted line ids. Serialized so ids stay unique across sessions. */
  nextLineNumber: number;
}

/** Published so coverage and persistence owners can react to a script change. */
export interface ScriptChangeIntent {
  editedLineIds: string[];
  deletedLineIds: string[];
  addedLineIds: string[];
  /** The previous order of the surviving lines, present only when that order changed. */
  reorderedFrom?: string[];
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

export function formatReadTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function readTimeSeconds(words: number): number {
  return Math.ceil((words / WORDS_PER_MINUTE) * 60);
}

/**
 * Every unclosed bracket in a line. A bracket with a closing partner is already
 * handled by `extractBracketedCues`, so only the leftovers are ambiguous.
 */
function findAmbiguousCues(lineId: string, text: string): AmbiguousCue[] {
  const cues: AmbiguousCue[] = [];
  for (let index = text.indexOf('['); index >= 0; index = text.indexOf('[', index + 1)) {
    if (text.indexOf(']', index) >= 0) continue;
    const cueText = normalize(text.slice(index + 1));
    if (!cueText) continue;
    cues.push({ id: `${lineId}:ambiguous:${cues.length}`, text: cueText, raw: text.slice(index), start: index });
  }
  return cues;
}

function buildLine(id: string, text: string, carried: readonly ScriptActionCue[] = []): ScriptDocumentLine {
  const parsed = extractBracketedCues(id, text);
  const available = carried.slice();
  const actionCues = parsed.cues.map((cue, index) => {
    const cueText = (cue.text ?? '').trim();
    const matchIndex = available.findIndex((previous) => previous.text === cueText);
    const previous = matchIndex >= 0 ? available.splice(matchIndex, 1)[0] : undefined;
    return {
      id: `${id}:cue:${index}`,
      text: cueText,
      required: previous?.required ?? false,
      status: previous?.status ?? 'pending',
    } satisfies ScriptActionCue;
  });
  const spokenText = normalize(parsed.spokenText);
  return {
    id,
    text,
    spokenText,
    actionCues,
    ambiguousCues: findAmbiguousCues(id, text),
    kind: spokenText === '' && actionCues.length > 0 ? 'action-only' : 'spoken',
    wordCount: countWords(spokenText),
  };
}

function summarize(
  text: string,
  lines: ScriptDocumentLine[],
  removedLines: ScriptDocumentLine[],
  nextLineNumber: number,
): ScriptDocument {
  const spokenWordCount = lines.reduce((total, line) => total + line.wordCount, 0);
  const seconds = readTimeSeconds(spokenWordCount);
  return {
    text,
    lines,
    removedLines,
    spokenWordCount,
    readTimeSeconds: seconds,
    readTime: formatReadTime(seconds),
    nextStep: lines.length === 0 ? 'add-script' : spokenWordCount === 0 ? 'add-spoken-line' : 'ready-to-record',
    nextLineNumber,
  };
}

function chunk(text: string): string[] {
  return (text.match(LINE_CHUNKS) ?? []).map((part) => part.trim()).filter(Boolean);
}

/**
 * Parse raw draft text into ordered lines.
 *
 * Ids survive edits: a chunk whose text is unchanged keeps its id, an edited chunk
 * keeps the id of the line that sat at its position, and anything left over is new.
 */
export function parseScript(text: string, previous?: ScriptDocument): ScriptDocument {
  const chunks = chunk(text);
  const previousLines = previous?.lines ?? [];
  const claimed = new Set<string>();
  const assigned: (ScriptDocumentLine | undefined)[] = chunks.map(() => undefined);

  const byText = new Map<string, ScriptDocumentLine[]>();
  for (const line of previousLines) {
    const key = normalize(line.text);
    const bucket = byText.get(key);
    if (bucket) bucket.push(line);
    else byText.set(key, [line]);
  }

  chunks.forEach((chunkText, index) => {
    const bucket = byText.get(normalize(chunkText));
    const match = bucket?.find((line) => !claimed.has(line.id));
    if (!match) return;
    claimed.add(match.id);
    assigned[index] = match;
  });

  chunks.forEach((_chunkText, index) => {
    if (assigned[index]) return;
    const candidate = previousLines[index];
    if (!candidate || claimed.has(candidate.id)) return;
    claimed.add(candidate.id);
    assigned[index] = candidate;
  });

  let nextLineNumber = previous?.nextLineNumber ?? 1;
  const lines = chunks.map((chunkText, index) => {
    const match = assigned[index];
    if (match) return buildLine(match.id, chunkText, match.actionCues);
    const id = `line-${nextLineNumber}`;
    nextLineNumber += 1;
    return buildLine(id, chunkText);
  });

  const dropped = previousLines.filter((line) => !claimed.has(line.id));
  return summarize(text, lines, mergeRemoved(previous?.removedLines ?? [], dropped), nextLineNumber);
}

function mergeRemoved(
  history: readonly ScriptDocumentLine[],
  dropped: readonly ScriptDocumentLine[],
): ScriptDocumentLine[] {
  const known = new Set(history.map((line) => line.id));
  return history.concat(dropped.filter((line) => !known.has(line.id)));
}

/** Rebuild the raw text so the camera prompter chunks it back into the same lines. */
function rebuild(document: ScriptDocument, lines: ScriptDocumentLine[], removedLines: ScriptDocumentLine[]): ScriptDocument {
  return summarize(lines.map((line) => line.text).join('\n'), lines, removedLines, document.nextLineNumber);
}

export function deleteLine(document: ScriptDocument, lineId: string): ScriptDocument {
  const removed = document.lines.find((line) => line.id === lineId);
  if (!removed) return document;
  return rebuild(
    document,
    document.lines.filter((line) => line.id !== lineId),
    mergeRemoved(document.removedLines, [removed]),
  );
}

export function reorderLines(document: ScriptDocument, orderedIds: readonly string[]): ScriptDocument {
  if (orderedIds.length !== document.lines.length) return document;
  const lines: ScriptDocumentLine[] = [];
  for (const id of orderedIds) {
    const line = document.lines.find((candidate) => candidate.id === id);
    if (!line || lines.includes(line)) return document;
    lines.push(line);
  }
  return rebuild(document, lines, document.removedLines);
}

export function moveLine(document: ScriptDocument, lineId: string, offset: number): ScriptDocument {
  const from = document.lines.findIndex((line) => line.id === lineId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= document.lines.length) return document;
  const order = document.lines.map((line) => line.id);
  order.splice(to, 0, ...order.splice(from, 1));
  return reorderLines(document, order);
}

function mapCue(
  document: ScriptDocument,
  cueId: string,
  change: (cue: ScriptActionCue) => ScriptActionCue,
): ScriptDocument {
  let changed = false;
  const lines = document.lines.map((line) => {
    if (!line.actionCues.some((cue) => cue.id === cueId)) return line;
    changed = true;
    return { ...line, actionCues: line.actionCues.map((cue) => (cue.id === cueId ? change(cue) : cue)) };
  });
  return changed ? { ...document, lines } : document;
}

export function setCueRequired(document: ScriptDocument, cueId: string, required: boolean): ScriptDocument {
  return mapCue(document, cueId, (cue) => ({ ...cue, required }));
}

/** Status is always a creator decision. Nothing here infers that an action happened. */
export function setCueStatus(document: ScriptDocument, cueId: string, status: ActionCueStatus): ScriptDocument {
  return mapCue(document, cueId, (cue) => ({ ...cue, status }));
}

/** Required cues that wrap must still ask about. A skipped cue stays unresolved. */
export function unresolvedRequiredCueIds(document: ScriptDocument): string[] {
  return document.lines.flatMap((line) =>
    line.actionCues.filter((cue) => cue.required && cue.status !== 'done').map((cue) => cue.id),
  );
}

/**
 * Resolve an unclosed bracket the creator's way: close it into an action cue, or
 * drop the stray bracket and keep the words as spoken text.
 */
export function correctAmbiguousCue(
  document: ScriptDocument,
  cueId: string,
  as: 'action' | 'spoken',
): ScriptDocument {
  const line = document.lines.find((candidate) => candidate.ambiguousCues.some((cue) => cue.id === cueId));
  const cue = line?.ambiguousCues.find((candidate) => candidate.id === cueId);
  if (!line || !cue) return document;
  const head = line.text.slice(0, cue.start);
  const corrected = as === 'action' ? `${head}[${cue.text}]` : `${head}${line.text.slice(cue.start + 1)}`;
  const lines = document.lines.map((candidate) =>
    candidate.id === line.id ? { ...candidate, text: corrected } : candidate,
  );
  return parseScript(lines.map((candidate) => candidate.text).join('\n'), { ...document, lines });
}

export function scriptChangeIntent(previous: ScriptDocument, next: ScriptDocument): ScriptChangeIntent {
  const before = new Map(previous.lines.map((line) => [line.id, line]));
  const after = new Map(next.lines.map((line) => [line.id, line]));

  const intent: ScriptChangeIntent = {
    editedLineIds: next.lines
      .filter((line) => {
        const earlier = before.get(line.id);
        return earlier !== undefined && normalize(earlier.text) !== normalize(line.text);
      })
      .map((line) => line.id),
    deletedLineIds: previous.lines.filter((line) => !after.has(line.id)).map((line) => line.id),
    addedLineIds: next.lines.filter((line) => !before.has(line.id)).map((line) => line.id),
  };

  const survivingBefore = previous.lines.filter((line) => after.has(line.id)).map((line) => line.id);
  const survivingAfter = next.lines.filter((line) => before.has(line.id)).map((line) => line.id);
  if (survivingBefore.some((id, index) => id !== survivingAfter[index])) {
    intent.reorderedFrom = survivingBefore;
  }
  return intent;
}

interface StoredCue {
  text: string;
  required: boolean;
  status: ActionCueStatus;
}

interface StoredLine {
  id: string;
  text: string;
  cues: StoredCue[];
}

interface StoredDocument {
  version: number;
  nextLineNumber: number;
  lines: StoredLine[];
  removedLines: StoredLine[];
}

function storeLine(line: ScriptDocumentLine): StoredLine {
  return {
    id: line.id,
    text: line.text,
    cues: line.actionCues.map((cue) => ({ text: cue.text, required: cue.required, status: cue.status })),
  };
}

/** Line ids and cue statuses only. The raw draft text stays the source of truth. */
export function serializeScriptDocument(document: ScriptDocument): string {
  return JSON.stringify({
    version: STRUCTURE_VERSION,
    nextLineNumber: document.nextLineNumber,
    lines: document.lines.map(storeLine),
    removedLines: document.removedLines.map(storeLine),
  } satisfies StoredDocument);
}

function hydrate(stored: readonly StoredLine[]): ScriptDocumentLine[] {
  return stored.map((line) =>
    buildLine(
      line.id,
      line.text,
      (line.cues ?? []).map((cue, index) => ({
        id: `${line.id}:cue:${index}`,
        text: cue.text,
        required: cue.required === true,
        status: cue.status === 'done' || cue.status === 'skipped' ? cue.status : 'pending',
      })),
    ),
  );
}

function readStructure(serialized: string | null | undefined): StoredDocument | null {
  if (!serialized) return null;
  try {
    const parsed = JSON.parse(serialized) as StoredDocument;
    if (!parsed || parsed.version !== STRUCTURE_VERSION || !Array.isArray(parsed.lines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Rebuild a document from the saved raw draft plus the saved structure.
 * A missing, stale or unreadable structure only costs line ids and cue statuses:
 * the creator's text is always restored.
 */
export function restoreScriptDocument(text: string, serialized: string | null | undefined): ScriptDocument {
  const stored = readStructure(serialized);
  if (!stored) return parseScript(text);
  const lines = hydrate(stored.lines);
  const removedLines = hydrate(Array.isArray(stored.removedLines) ? stored.removedLines : []);
  const nextLineNumber = Number.isInteger(stored.nextLineNumber) && stored.nextLineNumber > 0
    ? stored.nextLineNumber
    : 1;
  return parseScript(text, summarize(text, lines, removedLines, nextLineNumber));
}

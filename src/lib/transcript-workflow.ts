/**
 * Pure transcript, script coverage, and review decisions.
 *
 * The module deliberately does not read media, run a recognizer, or splice a
 * file.  It receives those observations from the capture/native layers and
 * keeps the evidence and creator decisions separate.
 */

export type TranscriptSource = 'live' | 'refined';
export type TimingSource = 'live-estimate' | 'saved-audio';

export interface TranscriptSegment {
  id: string;
  t0: number;
  t1: number;
  /** Raw recognizer text.  Manual caption edits never replace this value. */
  text: string;
  /** `false` is provisional and cannot establish script coverage. */
  isFinal: boolean;
  /** Monotonic revision for this stable segment id. */
  revision: number;
  /** `null` means the creator has not edited this caption. */
  manualCorrection: string | null;
  source: TranscriptSource;
  timingSource: TimingSource;
}

export interface TranscriptSegmentInput {
  id: string;
  t0: number;
  t1: number;
  text: string;
  isFinal: boolean;
  revision?: number;
  manualCorrection?: string | null;
  source?: TranscriptSource;
  timingSource?: TimingSource;
}

export interface TranscriptRefinement extends TranscriptSegmentInput {}

export function createTranscriptSegment(input: TranscriptSegmentInput): TranscriptSegment {
  validateId(input.id, 'transcript segment id');
  validateRange(input.t0, input.t1, 'transcript segment');
  if (typeof input.text !== 'string') {
    throw new TypeError('transcript segment text must be a string');
  }
  if (typeof input.isFinal !== 'boolean') {
    throw new TypeError('transcript segment isFinal must be a boolean');
  }

  const revision = input.revision ?? 0;
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RangeError('transcript segment revision must be a non-negative integer');
  }

  return {
    id: input.id,
    t0: input.t0,
    t1: input.t1,
    text: input.text,
    isFinal: input.isFinal,
    revision,
    manualCorrection: input.manualCorrection ?? null,
    source: input.source ?? 'live',
    timingSource: input.timingSource ?? 'live-estimate',
  };
}

export function displayTranscriptText(segment: TranscriptSegment): string {
  return segment.manualCorrection ?? segment.text;
}

/**
 * Apply one creator caption edit without touching the recognizer evidence.
 * An empty correction is valid and means the creator intentionally cleared
 * the displayed caption.
 */
export function editCaption(
  segments: readonly TranscriptSegment[],
  segmentId: string,
  correction: string,
): TranscriptSegment[] {
  if (typeof correction !== 'string') {
    throw new TypeError('caption correction must be a string');
  }
  let found = false;
  const result = segments.map((segment) => {
    if (segment.id !== segmentId) return segment;
    found = true;
    return { ...segment, manualCorrection: correction };
  });
  if (!found) throw new Error(`unknown transcript segment: ${segmentId}`);
  return result;
}

/**
 * Merge offline or late recognizer output by stable id.
 * Older revisions are ignored, final state is sticky, and creator text is
 * intentionally carried over even when the raw text or timings change.
 */
export function applyTranscriptRefinement(
  segments: readonly TranscriptSegment[],
  refinements: readonly TranscriptRefinement[],
): TranscriptSegment[] {
  const result = segments.slice();
  const indexes = new Map(result.map((segment, index) => [segment.id, index]));

  for (const refinement of refinements) {
    const incoming = createTranscriptSegment({
      ...refinement,
      source: refinement.source ?? 'refined',
      timingSource: refinement.timingSource ?? 'saved-audio',
    });
    const index = indexes.get(incoming.id);
    if (index === undefined) {
      indexes.set(incoming.id, result.length);
      result.push(incoming);
      continue;
    }

    const current = result[index];
    if (incoming.revision <= current.revision) continue;
    if (current.isFinal && !incoming.isFinal) continue;
    result[index] = {
      ...current,
      t0: incoming.t0,
      t1: incoming.t1,
      text: incoming.text,
      isFinal: current.isFinal || incoming.isFinal,
      revision: incoming.revision,
      source: incoming.source,
      timingSource: incoming.timingSource,
    };
  }
  return result;
}

export interface ActionCueInput {
  id?: string;
  text: string;
  required?: boolean;
  resolved?: boolean;
}

export interface ActionCue {
  id: string;
  text: string;
  /** Cues are optional unless the creator explicitly marks them required. */
  required: boolean;
  /** Required cues stay unresolved until a creator confirms them. */
  resolved: boolean;
}

export interface ScriptLineInput {
  id: string;
  /** Bracketed cues such as `[smile]` are separated from spoken text. */
  text: string;
  actionCues?: readonly ActionCueInput[];
}

export interface ScriptLine {
  id: string;
  spokenText: string;
  actionCues: ActionCue[];
}

export function createScriptLine(input: ScriptLineInput): ScriptLine {
  validateId(input.id, 'script line id');
  if (typeof input.text !== 'string') throw new TypeError('script line text must be a string');

  const parsed = extractBracketedCues(input.id, input.text);
  const cueInputs = input.actionCues ?? parsed.cues;
  const actionCues = cueInputs.map((cue, index) => {
    if (typeof cue.text !== 'string' || !cue.text.trim()) {
      throw new TypeError('action cue text must be non-empty');
    }
    return {
      id: cue.id?.trim() || `${input.id}:cue:${index}`,
      text: cue.text.trim(),
      required: cue.required ?? false,
      resolved: cue.resolved ?? false,
    };
  });
  ensureUnique(actionCues.map((cue) => cue.id), 'action cue id');

  return {
    id: input.id,
    spokenText: parsed.spokenText.trim().replace(/\s+/g, ' '),
    actionCues,
  };
}

export type ScriptEdit =
  | { type: 'update'; lineId: string; text: string; actionCues?: readonly ActionCueInput[] }
  | { type: 'insert'; line: ScriptLineInput; beforeLineId?: string }
  | { type: 'delete'; lineId: string }
  | { type: 'reorder'; lineIds: readonly string[] };

/**
 * Apply explicit script edits while keeping existing line ids stable.
 * Takes are intentionally outside this function, so deleting or reordering
 * visible lines cannot destroy historical media evidence.
 */
export function applyScriptEdits(
  lines: readonly ScriptLine[],
  edits: readonly ScriptEdit[],
): ScriptLine[] {
  let result = lines.slice();
  ensureUnique(result.map((line) => line.id), 'script line id');

  for (const edit of edits) {
    if (edit.type === 'update') {
      const index = result.findIndex((line) => line.id === edit.lineId);
      if (index < 0) throw new Error(`unknown script line: ${edit.lineId}`);
      const current = result[index];
      result = result.slice();
      result[index] = createScriptLine({
        id: current.id,
        text: edit.text,
        actionCues: edit.actionCues ?? current.actionCues,
      });
      continue;
    }

    if (edit.type === 'delete') {
      const index = result.findIndex((line) => line.id === edit.lineId);
      if (index < 0) throw new Error(`unknown script line: ${edit.lineId}`);
      result = result.slice(0, index).concat(result.slice(index + 1));
      continue;
    }

    if (edit.type === 'insert') {
      const inserted = createScriptLine(edit.line);
      if (result.some((line) => line.id === inserted.id)) {
        throw new Error(`duplicate script line: ${inserted.id}`);
      }
      const index = edit.beforeLineId === undefined
        ? result.length
        : result.findIndex((line) => line.id === edit.beforeLineId);
      if (index < 0) throw new Error(`unknown script line: ${edit.beforeLineId}`);
      result = result.slice(0, index).concat(inserted, result.slice(index));
      continue;
    }

    const ids = [...edit.lineIds];
    ensureUnique(ids, 'script line id in reorder');
    if (ids.length !== result.length || ids.some((id) => !result.some((line) => line.id === id))) {
      throw new Error('reorder must contain every current script line exactly once');
    }
    result = ids.map((id) => result.find((line) => line.id === id)!);
  }
  return result;
}

export type ScriptMatchKind = 'exact' | 'normalized' | 'ambiguous' | 'none';

export interface ScriptMatch {
  kind: ScriptMatchKind;
  lineIds: string[];
  /** Why a candidate was or was not accepted, for review diagnostics. */
  reason: 'whole-utterance' | 'number-or-brand-normalization' | 'ambiguous' | 'no-whole-match';
}

export interface ScriptMatchOptions {
  /** Explicit whole-token aliases for project-specific brand forms. */
  aliases?: Readonly<Record<string, string>>;
}

/**
 * Match a complete utterance against one line or a consecutive run of lines.
 * There is no substring score: a candidate is accepted only when the whole
 * canonical token sequence is equal.  This keeps false coverage conservative.
 */
export function matchTranscriptToScript(
  segment: TranscriptSegment,
  lines: readonly ScriptLine[],
  options: ScriptMatchOptions = {},
): ScriptMatch {
  const utterance = canonicalTokens(segment.text, options.aliases);
  if (utterance.length === 0) {
    return { kind: 'none', lineIds: [], reason: 'no-whole-match' };
  }

  const candidates: string[][] = [];
  for (let start = 0; start < lines.length; start += 1) {
    const tokens: string[] = [];
    for (let end = start; end < lines.length; end += 1) {
      const lineTokens = canonicalTokens(lines[end].spokenText, options.aliases);
      if (lineTokens.length === 0) {
        if (end === start) continue;
        break;
      }
      tokens.push(...lineTokens);
      if (sameTokens(tokens, utterance)) {
        candidates.push(lines.slice(start, end + 1).map((line) => line.id));
      }
      if (tokens.length > utterance.length) break;
    }
  }

  if (candidates.length === 0) {
    return { kind: 'none', lineIds: [], reason: 'no-whole-match' };
  }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', lineIds: [], reason: 'ambiguous' };
  }

  const lineText = candidates[0]
    .map((id) => lines.find((line) => line.id === id)?.spokenText ?? '')
    .join(' ')
    .trim();
  const exact = segment.text.trim().toLocaleLowerCase() === lineText.toLocaleLowerCase();
  return {
    kind: exact ? 'exact' : 'normalized',
    lineIds: candidates[0],
    reason: exact ? 'whole-utterance' : 'number-or-brand-normalization',
  };
}

export type TakeQuality = 'clean' | 'flub' | 'scratched';

export interface TakeEvidence {
  id: string;
  t0: number;
  t1: number;
  /** A non-empty URI and `playable: true` are both required for coverage. */
  mediaUri: string | null;
  playable: boolean;
  quality: TakeQuality;
  /** Off-frame takes remain history but lose to suitable in-frame takes. */
  inFrame: boolean;
  transcriptSegmentIds: readonly string[];
  /** Optional result of `matchTranscriptToScript`, retained for persistence. */
  lineIds?: readonly string[];
}

export interface SilenceInterval {
  id: string;
  t0: number;
  t1: number;
  /** True only when an independent detector verified both cut boundaries. */
  verifiedBoundary?: boolean;
}

export interface FillerMark {
  id: string;
  text: string;
  t0: number;
  t1: number;
  /** Mid-sentence or recognizer-only boundaries must remain un-suggested. */
  safeBoundary?: boolean;
}

export type ReviewSuggestionKind = 'long-silence' | 'repeated-attempt' | 'filler';
export type BoundaryConfidence = 'safe' | 'uncertain';

export interface ReviewSuggestion {
  id: string;
  kind: ReviewSuggestionKind;
  t0: number;
  t1: number;
  segmentIds: string[];
  reason: string;
  /** This is evidence quality, never a claim that a cut is automatically safe. */
  safeBoundary: BoundaryConfidence;
}

export function generateReviewSuggestions(input: {
  segments: readonly TranscriptSegment[];
  silences?: readonly SilenceInterval[];
  fillerMarks?: readonly FillerMark[];
  minSilenceSeconds?: number;
}): ReviewSuggestion[] {
  const minSilence = input.minSilenceSeconds ?? 1.2;
  if (!Number.isFinite(minSilence) || minSilence <= 0) {
    throw new RangeError('minSilenceSeconds must be positive');
  }

  const suggestions: ReviewSuggestion[] = [];
  for (const silence of input.silences ?? []) {
    validateId(silence.id, 'silence id');
    validateRange(silence.t0, silence.t1, 'silence interval');
    if (silence.t1 - silence.t0 < minSilence) continue;
    suggestions.push({
      id: `silence:${silence.id}`,
      kind: 'long-silence',
      t0: silence.t0,
      t1: silence.t1,
      segmentIds: [],
      reason: `A ${(silence.t1 - silence.t0).toFixed(1)} second quiet interval may be reviewable.`,
      safeBoundary: silence.verifiedBoundary ? 'safe' : 'uncertain',
    });
  }

  const finalSegments = input.segments
    .filter((segment) => segment.isFinal)
    .slice()
    .sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));
  for (let index = 1; index < finalSegments.length; index += 1) {
    const previous = finalSegments[index - 1];
    const current = finalSegments[index];
    if (!sameTokens(canonicalTokens(previous.text), canonicalTokens(current.text))) continue;
    suggestions.push({
      id: `repeat:${previous.id}:${current.id}`,
      kind: 'repeated-attempt',
      t0: Math.min(previous.t0, current.t0),
      t1: Math.max(previous.t1, current.t1),
      segmentIds: [previous.id, current.id],
      reason: 'The same final utterance appears twice; choose the take after listening.',
      safeBoundary: 'uncertain',
    });
  }

  for (const filler of input.fillerMarks ?? []) {
    validateId(filler.id, 'filler mark id');
    validateRange(filler.t0, filler.t1, 'filler mark');
    if (!filler.safeBoundary) continue;
    suggestions.push({
      id: `filler:${filler.id}`,
      kind: 'filler',
      t0: filler.t0,
      t1: filler.t1,
      segmentIds: [],
      reason: `The marked filler “${filler.text}” has independently verified quiet boundaries.`,
      safeBoundary: 'safe',
    });
  }

  return suggestions.sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));
}

export type CoverageStatus = 'needed' | 'pending' | 'covered';

export interface LineReview {
  id: string;
  spokenText: string;
  status: CoverageStatus;
  selectedTakeId: string | null;
  candidateTakeIds: string[];
  rejectedTakeIds: string[];
  missingMediaTakeIds: string[];
  matchedSegmentIds: string[];
  actionCueIds: string[];
  unresolvedRequiredActionCueIds: string[];
  pendingReasons: string[];
}

export type ReviewDecision =
  | { id: string; type: 'take-selection'; lineId: string; takeId: string }
  | { id: string; type: 'cleanup'; suggestionId: string; action: 'accept' };

export interface ReviewState {
  lines: LineReview[];
  transcript: TranscriptSegment[];
  takes: TakeEvidence[];
  suggestions: ReviewSuggestion[];
  decisions: ReviewDecision[];
  unresolvedRequiredActionCueIds: string[];
  safeToWrap: boolean;
}

export interface WorkflowInput {
  lines: readonly ScriptLine[];
  segments: readonly TranscriptSegment[];
  takes: readonly TakeEvidence[];
  decisions?: readonly ReviewDecision[];
  silences?: readonly SilenceInterval[];
  fillerMarks?: readonly FillerMark[];
}

interface TakeObservation {
  take: TakeEvidence;
  lineIds: string[];
  evidenceByLine: Map<string, { finalSegmentIds: string[]; provisionalSegmentIds: string[] }>;
}

/**
 * Derive review state from immutable observations and explicit decisions.
 * A line is covered only by a clean, final, playable take.  Timer expiry,
 * provisional text, a missing file, and a scratched/flubbed take do not count.
 */
export function deriveReviewState(input: WorkflowInput): ReviewState {
  const lineIds = input.lines.map((line) => line.id);
  ensureUnique(lineIds, 'script line id');
  const lineSet = new Set(lineIds);
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const observations: TakeObservation[] = input.takes.map((take) => {
    validateRange(take.t0, take.t1, 'take');
    const linkedSegments = take.transcriptSegmentIds
      .map((id) => segmentById.get(id))
      .filter((segment): segment is TranscriptSegment => segment !== undefined);
    const declaredIds = (take.lineIds ?? []).filter((id) => lineSet.has(id));
    const evidenceByLine = new Map<string, { finalSegmentIds: string[]; provisionalSegmentIds: string[] }>();
    for (const segment of linkedSegments) {
      const derivedIds = matchTranscriptToScript(segment, input.lines).lineIds;
      const segmentLineIds = derivedIds.length > 0 ? derivedIds : declaredIds;
      for (const lineId of segmentLineIds) {
        const evidence = evidenceByLine.get(lineId) ?? { finalSegmentIds: [], provisionalSegmentIds: [] };
        const target = segment.isFinal ? evidence.finalSegmentIds : evidence.provisionalSegmentIds;
        if (!target.includes(segment.id)) target.push(segment.id);
        evidenceByLine.set(lineId, evidence);
      }
    }
    return {
      take,
      lineIds: [...evidenceByLine.keys()],
      evidenceByLine,
    };
  });

  const decisions = [...(input.decisions ?? [])];
  const lines = input.lines.map((line) => {
    const matching = observations.filter((observation) => observation.lineIds.includes(line.id));
    const candidate = matching.filter(({ take }) => take.quality === 'clean');
    const rejected = matching.filter(({ take }) => take.quality !== 'clean');
    const missingMedia = candidate.filter(({ take }) => !isPlayableTake(take));
    const playableFinal = candidate.filter(
      ({ take, evidenceByLine }) => isPlayableTake(take) && (evidenceByLine.get(line.id)?.finalSegmentIds.length ?? 0) > 0,
    );
    const chosenDecision = lastTakeDecision(decisions, line.id);
    let selected: TakeObservation | undefined;
    let pendingReason: string | undefined;

    if (chosenDecision) {
      selected = playableFinal.find(({ take }) => take.id === chosenDecision.takeId);
      if (!selected) pendingReason = 'selected take is unavailable or not final';
    } else {
      selected = chooseBestTake(playableFinal);
    }

    const pendingReasons: string[] = [];
    if (candidate.some(({ evidenceByLine }) => (evidenceByLine.get(line.id)?.provisionalSegmentIds.length ?? 0) > 0)) {
      pendingReasons.push('provisional transcript');
    }
    if (missingMedia.length > 0) pendingReasons.push('media unavailable');
    if (pendingReason) pendingReasons.push(pendingReason);

    const status: CoverageStatus = selected
      ? 'covered'
      : pendingReasons.length > 0
        ? 'pending'
        : 'needed';
    const unresolvedRequiredActionCueIds = line.actionCues
      .filter((cue) => cue.required && !cue.resolved)
      .map((cue) => cue.id);

    return {
      id: line.id,
      spokenText: line.spokenText,
      status,
      selectedTakeId: selected?.take.id ?? null,
      candidateTakeIds: candidate.map(({ take }) => take.id),
      rejectedTakeIds: rejected.map(({ take }) => take.id),
      missingMediaTakeIds: missingMedia.map(({ take }) => take.id),
      matchedSegmentIds: [...new Set(matching.flatMap(({ evidenceByLine }) => {
        const evidence = evidenceByLine.get(line.id);
        return evidence ? [...evidence.finalSegmentIds, ...evidence.provisionalSegmentIds] : [];
      }))],
      actionCueIds: line.actionCues.map((cue) => cue.id),
      unresolvedRequiredActionCueIds,
      pendingReasons,
    };
  });

  const unresolvedRequiredActionCueIds = lines.flatMap((line) => line.unresolvedRequiredActionCueIds);
  return {
    lines,
    transcript: input.segments.slice(),
    takes: input.takes.slice(),
    suggestions: generateReviewSuggestions({
      segments: input.segments,
      silences: input.silences,
      fillerMarks: input.fillerMarks,
    }),
    decisions,
    unresolvedRequiredActionCueIds,
    safeToWrap: lines.every((line) => line.status === 'covered') && unresolvedRequiredActionCueIds.length === 0,
  };
}

/**
 * Record a creator take choice.  This only records a reversible decision and
 * validates basic media availability; deriving coverage still requires final
 * transcript evidence for the selected line.
 */
export function selectTake(
  decisions: readonly ReviewDecision[],
  lineId: string,
  takeId: string,
  takes: readonly TakeEvidence[],
): ReviewDecision[] {
  const take = takes.find((candidate) => candidate.id === takeId);
  if (!take || take.quality !== 'clean' || !isPlayableTake(take)) {
    throw new Error(`take ${takeId} is not playable clean media`);
  }
  const next = decisions.filter((decision) => !(decision.type === 'take-selection' && decision.lineId === lineId));
  next.push({ id: `take:${lineId}`, type: 'take-selection', lineId, takeId });
  return next;
}

/** Explicitly accept a review suggestion while retaining the original evidence. */
export function acceptSuggestion(
  decisions: readonly ReviewDecision[],
  suggestion: ReviewSuggestion,
): ReviewDecision[] {
  const next = decisions.filter(
    (decision) => !(decision.type === 'cleanup' && decision.suggestionId === suggestion.id),
  );
  next.push({ id: `cleanup:${suggestion.id}`, type: 'cleanup', suggestionId: suggestion.id, action: 'accept' });
  return next;
}

/** Remove one explicit decision and fall back to the derived default. */
export function restoreDecision(
  decisions: readonly ReviewDecision[],
  decisionId: string,
): ReviewDecision[] {
  return decisions.filter((decision) => decision.id !== decisionId);
}

function chooseBestTake(observations: readonly TakeObservation[]): TakeObservation | undefined {
  return observations
    .slice()
    .sort((a, b) => Number(b.take.inFrame) - Number(a.take.inFrame)
      || a.take.t0 - b.take.t0
      || a.take.id.localeCompare(b.take.id))[0];
}

function lastTakeDecision(decisions: readonly ReviewDecision[], lineId: string): Extract<ReviewDecision, { type: 'take-selection' }> | undefined {
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index];
    if (decision.type === 'take-selection' && decision.lineId === lineId) return decision;
  }
  return undefined;
}

function isPlayableTake(take: TakeEvidence): boolean {
  return take.playable && typeof take.mediaUri === 'string' && take.mediaUri.trim().length > 0;
}

/** Bracketed direction parsing lives here so script and review share one regex. */
export function extractBracketedCues(lineId: string, text: string): { spokenText: string; cues: ActionCueInput[] } {
  let index = 0;
  const cues: ActionCueInput[] = [];
  const spokenText = text.replace(/\[([^\]\n]+)\]/g, (_match, cueText: string) => {
    const trimmed = cueText.trim();
    if (trimmed) {
      cues.push({ id: `${lineId}:cue:${index}`, text: trimmed });
      index += 1;
    }
    return ' ';
  });
  return { spokenText, cues };
}

const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
  'open ai': 'openai',
  'i phone': 'iphone',
  'wi fi': 'wifi',
  'you tube': 'youtube',
  'e mail': 'email',
};

function canonicalTokens(text: string, aliases: Readonly<Record<string, string>> = {}): string[] {
  const raw = text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!raw) return [];
  const tokens = normalizeNumberPhrases(raw.split(/\s+/));
  const mergedAliases = { ...DEFAULT_ALIASES, ...aliases };
  const entries = Object.entries(mergedAliases)
    .map(([from, to]) => ({ from: normalizeNumberPhrases(from.split(/\s+/)), to: to.toLocaleLowerCase() }))
    .sort((a, b) => b.from.length - a.from.length);
  const output: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const alias = entries.find((entry) => entry.from.length > 0 && sameTokens(tokens.slice(index, index + entry.from.length), entry.from));
    if (alias) {
      output.push(alias.to);
      index += alias.from.length;
    } else {
      output.push(tokens[index]);
      index += 1;
    }
  }
  return output;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function normalizeNumberPhrases(tokens: readonly string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const value = NUMBER_WORDS[tokens[index]];
    if (value === undefined) {
      output.push(tokens[index]);
      index += 1;
      continue;
    }

    let total = 0;
    let current = 0;
    let consumed = 0;
    while (index + consumed < tokens.length) {
      const token = tokens[index + consumed];
      const number = NUMBER_WORDS[token];
      if (number !== undefined) {
        current += number;
        consumed += 1;
        continue;
      }
      if (token === 'hundred' && consumed > 0) {
        current *= 100;
        consumed += 1;
        continue;
      }
      if ((token === 'thousand' || token === 'million') && consumed > 0) {
        total += current * (token === 'thousand' ? 1000 : 1_000_000);
        current = 0;
        consumed += 1;
        continue;
      }
      break;
    }
    output.push(String(total + current));
    index += Math.max(consumed, 1);
  }
  return output;
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

function validateId(id: string, label: string): void {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError(`${label} must be non-empty`);
}

function validateRange(t0: number, t1: number, label: string): void {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 < 0 || t1 < t0) {
    throw new RangeError(`${label} must have finite seconds with 0 <= t0 <= t1`);
  }
}

function ensureUnique(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} values must be unique`);
}

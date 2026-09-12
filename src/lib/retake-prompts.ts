/**
 * Pure retake-prompt scheduling and prompter readability rules.
 *
 * The module never reads media, runs a recognizer or decides coverage.  It
 * receives coverage verdicts that another lane produced, plus the times at
 * which lines ended, and answers one question: what may honestly be shown to
 * the creator right now.  A verdict that arrives too late to be useful in the
 * pause is batched for after the take instead of interrupting the read.
 */

import type { CoverageStatus } from './transcript-workflow.ts';

/** A verdict must land within this many milliseconds of the line end to be promptable. */
export const PROMPT_BUDGET_MS = 1200;

/** How long an `again` prompt stays on screen when the next line has not started. */
export const PROMPT_HOLD_MS = 4000;

/** The current line never renders smaller than this, in scale-independent pixels. */
export const MIN_LINE_FONT_SIZE = 16;

/** The acceptance target for #19: 18 timely prompts out of 20 line ends. */
export const PROMPT_TARGET = { prompted: 18, lineEnds: 20 } as const;

export type PrompterEngineState = 'ready' | 'delayed' | 'unavailable';

export interface PromptLine {
  id: string;
  /** 1-based position the creator sees.  The coverage strip and every prompt
   * use this number, so it must be the same value in both places. */
  number: number;
  status: CoverageStatus;
}

export interface PrompterActionCue {
  id: string;
  text: string;
  /** Required cues are only ever resolved by an explicit creator confirmation. */
  required: boolean;
  resolved: boolean;
}

/** The component-facing line shape.  Action cue text is never part of `spokenText`. */
export interface PrompterLine extends PromptLine {
  spokenText: string;
  actionCues: PrompterActionCue[];
}

export interface LineEnd {
  lineId: string;
  /** Milliseconds, on the same clock as the verdicts. */
  endedAt: number;
  /** When the creator began the following line, when that is known. */
  nextStartsAt?: number;
}

export interface LineVerdict {
  lineId: string;
  status: CoverageStatus;
  arrivedAt: number;
}

export interface PromptInput {
  /** Script order.  Prompt text uses each line's own `number`, not its index. */
  lines: readonly PromptLine[];
  lineEnds?: readonly LineEnd[];
  verdicts?: readonly LineVerdict[];
  now: number;
  /** True while the creator is speaking; no `again` prompt may interrupt. */
  midLine?: boolean;
  /** False during the take.  The full batched list is only for after it. */
  takeEnded?: boolean;
  engineState?: PrompterEngineState;
  budgetMs?: number;
  holdMs?: number;
}

export type PromptDecision =
  | { kind: 'again'; lineId: string; lineNumber: number; text: string }
  /** A quiet count while the take is still running.  It names no line and asks
   * for nothing, so it cannot compete with the line the creator is reading. */
  | { kind: 'deferred'; lineIds: string[]; lineNumbers: number[]; count: number; text: string }
  | { kind: 'batched'; lineIds: string[]; lineNumbers: number[]; text: string };

/**
 * Decide what the prompter may show at `now`.
 *
 * An `again` prompt is only offered while the take is still running, when the
 * verdict arrived within the budget after the line ended, before the next line
 * started, while the creator is not speaking, and while the engine is keeping
 * up.  Everything else that still
 * needs a read waits: a quiet `deferred` count during the take, and the full
 * `We will check lines N, M after this take` list once `takeEnded` is true.
 */
export function decideRetakePrompt(input: PromptInput): PromptDecision | null {
  const numbers = new Map(input.lines.map((line) => [line.id, line.number]));
  const budget = input.budgetMs ?? PROMPT_BUDGET_MS;
  const hold = input.holdMs ?? PROMPT_HOLD_MS;
  const engineReady = (input.engineState ?? 'ready') === 'ready';

  const needed = input.lines.filter((line) => line.status === 'needed');
  // While the engine is behind, a line that is still being checked is honestly
  // unconfirmed, so it joins the after-the-take list instead of disappearing.
  const unconfirmed = engineReady
    ? needed
    : input.lines.filter((line) => line.status === 'needed' || line.status === 'pending');
  if (unconfirmed.length === 0) return null;

  // An `again` prompt only makes sense while the creator can still act on it.
  // Once the take has ended, everything unconfirmed belongs in the list.
  if (engineReady && !input.midLine && !input.takeEnded) {
    const neededIds = new Set(needed.map((line) => line.id));
    const candidates = (input.lineEnds ?? [])
      .filter((lineEnd) => neededIds.has(lineEnd.lineId))
      .slice()
      .sort((a, b) => b.endedAt - a.endedAt);

    for (const lineEnd of candidates) {
      const verdict = lastVerdict(input.verdicts ?? [], lineEnd.lineId);
      if (!verdict || verdict.status !== 'needed') continue;
      if (!promptArrivedInTime(lineEnd, verdict, budget)) continue;
      const closesAt = Math.min(lineEnd.nextStartsAt ?? Infinity, verdict.arrivedAt + hold);
      if (input.now < verdict.arrivedAt || input.now >= closesAt) continue;
      const lineNumber = numbers.get(lineEnd.lineId)!;
      return { kind: 'again', lineId: lineEnd.lineId, lineNumber, text: `Again, line ${lineNumber}` };
    }
  }

  const lineIds = unconfirmed.map((line) => line.id);
  const lineNumbers = lineIds.map((id) => numbers.get(id)!);
  if (!input.takeEnded) {
    return {
      kind: 'deferred',
      lineIds,
      lineNumbers,
      count: lineIds.length,
      text: `${lineIds.length} ${lineIds.length === 1 ? 'line' : 'lines'} to check after this take`,
    };
  }
  return { kind: 'batched', lineIds, lineNumbers, text: batchedText(lineNumbers) };
}

export type PromptMissReason =
  | 'no-verdict'
  | 'before-line-end'
  | 'late-verdict'
  | 'next-line-started'
  | 'delayed-engine';

export interface PromptSessionLog {
  lines: readonly PromptLine[];
  lineEnds: readonly LineEnd[];
  verdicts: readonly LineVerdict[];
  engineState?: PrompterEngineState;
  budgetMs?: number;
}

export interface PromptTimingReport {
  lineEnds: number;
  /** Line ends whose settled status still needs a read, so a prompt is warranted. */
  eligible: number;
  promptedBeforeNextLine: number;
  /** Line ends that were resolved in time without needing a prompt. */
  resolvedWithoutPrompt: number;
  missed: { lineId: string; lineNumber: number; reason: PromptMissReason }[];
  mode: 'live' | 'batched';
  ratio: number;
  /** False until the log holds at least 20 promptable line ends. */
  sampleComplete: boolean;
  meetsTarget: boolean;
}

/**
 * Report how many line ends in a recorded log got a prompt before the next
 * line, so the 18/20 acceptance measurement can be replayed.  This measures a
 * log; it is not by itself evidence about a device, a room or a recognizer.
 */
export function evaluatePromptTiming(log: PromptSessionLog): PromptTimingReport {
  const numbers = new Map(log.lines.map((line) => [line.id, line.number]));
  const statuses = new Map(log.lines.map((line) => [line.id, line.status]));
  const budget = log.budgetMs ?? PROMPT_BUDGET_MS;
  const mode = (log.engineState ?? 'ready') === 'ready' ? 'live' : 'batched';

  let eligible = 0;
  let prompted = 0;
  let resolvedWithoutPrompt = 0;
  const missed: PromptTimingReport['missed'] = [];

  for (const lineEnd of log.lineEnds) {
    const lineNumber = numbers.get(lineEnd.lineId) ?? 0;
    const verdict = lastVerdict(log.verdicts, lineEnd.lineId);
    if (statuses.get(lineEnd.lineId) !== 'needed') {
      if (verdict && promptArrivedInTime(lineEnd, verdict, budget)) resolvedWithoutPrompt += 1;
      continue;
    }
    eligible += 1;
    if (mode === 'batched') {
      missed.push({ lineId: lineEnd.lineId, lineNumber, reason: 'delayed-engine' });
      continue;
    }
    if (!verdict) {
      missed.push({ lineId: lineEnd.lineId, lineNumber, reason: 'no-verdict' });
      continue;
    }
    if (verdict.arrivedAt < lineEnd.endedAt) {
      missed.push({ lineId: lineEnd.lineId, lineNumber, reason: 'before-line-end' });
      continue;
    }
    if (verdict.arrivedAt - lineEnd.endedAt > budget) {
      missed.push({ lineId: lineEnd.lineId, lineNumber, reason: 'late-verdict' });
      continue;
    }
    if (lineEnd.nextStartsAt !== undefined && verdict.arrivedAt >= lineEnd.nextStartsAt) {
      missed.push({ lineId: lineEnd.lineId, lineNumber, reason: 'next-line-started' });
      continue;
    }
    prompted += 1;
  }

  const sampleComplete = eligible >= PROMPT_TARGET.lineEnds;
  const requiredRatio = PROMPT_TARGET.prompted / PROMPT_TARGET.lineEnds;
  return {
    lineEnds: log.lineEnds.length,
    eligible,
    promptedBeforeNextLine: prompted,
    resolvedWithoutPrompt,
    missed,
    mode,
    ratio: eligible === 0 ? 0 : prompted / eligible,
    sampleComplete,
    meetsTarget: mode === 'live' && sampleComplete && prompted >= Math.ceil(eligible * requiredRatio),
  };
}

/**
 * Status marks for the coverage strip.  Every status has its own glyph and its
 * own word, so the strip is readable without perceiving colour.
 */
export const COVERAGE_MARKS: Record<CoverageStatus, { symbol: string; short: string; description: string }> = {
  needed: { symbol: '▲', short: 'Again', description: 'needs another read' },
  pending: { symbol: '◐', short: 'Checking', description: 'still being checked' },
  covered: { symbol: '●', short: 'Done', description: 'covered' },
};

export function coverageCellLabel(input: {
  number: number;
  status: CoverageStatus;
  position?: 'current' | 'next' | null;
}): string {
  const parts = [`Line ${input.number}`, COVERAGE_MARKS[input.status].description];
  if (input.position === 'current') parts.push('current line');
  if (input.position === 'next') parts.push('next line');
  return parts.join(', ');
}

export function coverageSummaryText(lines: readonly PromptLine[]): string {
  if (lines.length === 0) return 'No lines yet';
  const covered = lines.filter((line) => line.status === 'covered').length;
  const pending = lines.filter((line) => line.status === 'pending').length;
  const needed = lines.filter((line) => line.status === 'needed').length;
  const parts = [`${covered} of ${lines.length} lines covered`];
  if (pending > 0) parts.push(`${pending} checking`);
  if (needed > 0) parts.push(`${needed} to read again`);
  return parts.join(', ');
}

/** Spoken label for one action cue.  Cue text is never announced as dialogue. */
export function actionCueLabel(cue: PrompterActionCue, lineNumber: number): string {
  const parts = [`Action for line ${lineNumber}`, lowerFirst(cue.text)];
  if (!cue.required) parts.push('optional');
  else parts.push('required', cue.resolved ? 'marked done' : 'not done yet');
  return parts.join(', ');
}

/**
 * Shrink a declared size on narrow screens or at large system text, never
 * below 16.  The returned value is still scale-independent, so the operating
 * system enlarges it again for the creator.
 */
export function readableFontSize(base: number, options: { width: number; fontScale: number }): number {
  const narrow = Math.min(1, options.width / 390);
  const crowded = options.fontScale > 1.3 ? 1.3 / options.fontScale : 1;
  return Math.max(MIN_LINE_FONT_SIZE, Math.round(base * narrow * crowded));
}

/** `numberOfLines` for a prompter line; 0 means show everything. */
export function lineClamp(options: { fontScale: number; compact?: boolean; expanded?: boolean }): number {
  if (options.expanded) return 0;
  const base = options.fontScale >= 1.6 ? 2 : options.fontScale >= 1.3 ? 3 : 4;
  return options.compact ? Math.max(1, base - 2) : base;
}

/** How many coverage cells fit before the strip has to hide some. */
export function stripCapacity(width: number, fontScale: number): number {
  const cell = 48 * Math.max(1, Math.min(fontScale, 2));
  return Math.max(3, Math.min(12, Math.floor((width - 32) / cell)));
}

/**
 * The visible slice of the coverage strip.  The current line and the one after
 * it always stay in view; earlier lines scroll out first and are reported as
 * hidden so the strip can say so instead of silently dropping them.
 */
export function stripWindow(count: number, currentIndex: number, capacity: number): {
  start: number; end: number; hiddenBefore: number; hiddenAfter: number;
} {
  if (count <= capacity) return { start: 0, end: count, hiddenBefore: 0, hiddenAfter: 0 };
  const start = Math.max(0, Math.min(currentIndex - (capacity - 2), count - capacity));
  const end = Math.min(count, start + capacity);
  return { start, end, hiddenBefore: start, hiddenAfter: count - end };
}

function promptArrivedInTime(lineEnd: LineEnd, verdict: LineVerdict, budget: number): boolean {
  // A verdict cannot honestly describe a line that has not finished yet.
  if (verdict.arrivedAt < lineEnd.endedAt) return false;
  if (verdict.arrivedAt - lineEnd.endedAt > budget) return false;
  return lineEnd.nextStartsAt === undefined || verdict.arrivedAt < lineEnd.nextStartsAt;
}

function lastVerdict(verdicts: readonly LineVerdict[], lineId: string): LineVerdict | undefined {
  let latest: LineVerdict | undefined;
  for (const verdict of verdicts) {
    if (verdict.lineId !== lineId) continue;
    if (!latest || verdict.arrivedAt >= latest.arrivedAt) latest = verdict;
  }
  return latest;
}

function batchedText(lineNumbers: readonly number[]): string {
  const list = lineNumbers.join(', ');
  return lineNumbers.length === 1
    ? `We will check line ${list} after this take`
    : `We will check lines ${list} after this take`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase() + text.slice(1);
}

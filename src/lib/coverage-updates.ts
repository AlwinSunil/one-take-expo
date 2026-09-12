/**
 * Coverage ledger updates for script changes and media that goes away.
 *
 * `deriveReviewState` answers "what do the current observations prove?".  This
 * module answers the separate question "what happens to that answer when the
 * script is edited or a recording can no longer be found?".  It never deletes
 * take evidence: a line can lose its coverage while keeping every attempt.
 */

import {
  compareTakePreference,
  type CoverageStatus,
  type LineReview,
  type ReviewState,
  type TakeEvidence,
  type TakeQuality,
} from './transcript-workflow.ts';

export type CoverageReason =
  /** A clean, playable take with final transcript evidence supports the line. */
  | 'clean-take'
  /** Only provisional recognizer text exists; a timer cannot promote it. */
  | 'provisional-transcript'
  /** A take exists but its file is not playable yet. */
  | 'media-unavailable'
  /** A take that used to support the line no longer has playable media. */
  | 'media-missing'
  /** An explicitly selected take is no longer available or no longer final. */
  | 'selection-unavailable'
  /** Attempts exist, but all of them were flubbed or scratched. */
  | 'no-clean-take'
  /** Nothing has been recorded for the line. */
  | 'no-evidence'
  /** The creator changed the words, so earlier takes no longer prove the line. */
  | 'script-edited'
  /** The line was just added to the script. */
  | 'line-added'
  /** The line was removed from the script; the entry is history only. */
  | 'line-deleted';

export interface CoverageTakeRecord {
  takeId: string;
  quality: TakeQuality;
  inFrame: boolean;
  playable: boolean;
  t0: number;
  t1: number;
  /** True while the take could still be selected as this line's coverage. */
  eligible: boolean;
  /** True once the take was recorded against wording the line no longer has. */
  stale: boolean;
}

export interface CoverageEntry {
  lineId: string;
  status: CoverageStatus;
  selectedTakeId: string | null;
  /**
   * The take the creator chose explicitly, whether or not it is currently
   * usable.  A recomputation never replaces an explicit choice with another
   * take; only the creator can change it.
   */
  explicitTakeId: string | null;
  reason: CoverageReason;
  /** Every take that ever referenced this line, in observation order. */
  history: CoverageTakeRecord[];
}

export interface CoverageLedger {
  entries: CoverageEntry[];
  /** Deleted lines keep their take history so review evidence is never lost. */
  retired: CoverageEntry[];
}

/**
 * The change description published by the script editor.  `reorderedFrom` is
 * the line order *before* the change; coverage is keyed by line id, so a
 * reorder is only validated here and never rewrites an entry.
 */
export interface ScriptChangeIntent {
  editedLineIds: string[];
  deletedLineIds: string[];
  addedLineIds: string[];
  reorderedFrom?: string[];
}

export interface CoverageCut {
  takeId: string;
  lineIds: string[];
  t0: number;
  t1: number;
}

/** Snapshot the derived review state as a ledger that survives later changes. */
export function coverageLedger(review: ReviewState): CoverageLedger {
  const takeById = new Map(review.takes.map((take) => [take.id, take]));
  const chosenByLine = new Map(review.decisions
    .filter((decision) => decision.type === 'take-selection')
    .map((decision) => [decision.lineId, decision.takeId]));
  const entries = review.lines.map((line) => ({
    lineId: line.id,
    status: line.status,
    selectedTakeId: line.selectedTakeId,
    explicitTakeId: chosenByLine.get(line.id) ?? null,
    reason: derivedReason(line),
    history: historyFor(line, review.takes, takeById),
  }));
  return { entries, retired: [] };
}

/**
 * Apply one published script change.  Editing a line resets it to `needed`
 * because the recorded words no longer match the script, deleting a line
 * retires it with its takes, adding a line starts it at `needed`, and a
 * reorder preserves every id and every verdict.
 */
export function applyScriptChangeIntent(
  ledger: CoverageLedger,
  intent: ScriptChangeIntent,
): CoverageLedger {
  const edited = requireIds(intent.editedLineIds, 'editedLineIds');
  const deleted = requireIds(intent.deletedLineIds, 'deletedLineIds');
  const added = requireIds(intent.addedLineIds, 'addedLineIds');
  const known = new Set(ledger.entries.map((entry) => entry.lineId));

  for (const lineId of [...edited, ...deleted]) {
    if (!known.has(lineId)) throw new Error(`unknown script line in change intent: ${lineId}`);
  }
  for (const lineId of added) {
    if (known.has(lineId) || ledger.retired.some((entry) => entry.lineId === lineId)) {
      throw new Error(`script line ${lineId} is already in the coverage ledger`);
    }
  }
  if (intent.reorderedFrom !== undefined) {
    const previous = requireIds(intent.reorderedFrom, 'reorderedFrom');
    if (previous.length !== known.size || previous.some((lineId) => !known.has(lineId))) {
      throw new Error('reorderedFrom must list every current script line exactly once');
    }
  }

  const editedSet = new Set(edited);
  const deletedSet = new Set(deleted);
  const entries: CoverageEntry[] = [];
  const retired = ledger.retired.slice();

  for (const entry of ledger.entries) {
    // Every take of an edited line was recorded against the earlier wording, so
    // it stays in history as stale evidence and can never cover the line again.
    const current = editedSet.has(entry.lineId)
      ? {
        ...entry,
        status: 'needed' as const,
        selectedTakeId: null,
        explicitTakeId: null,
        reason: 'script-edited' as const,
        history: entry.history.map((record) => ({ ...record, eligible: false, stale: true })),
      }
      : entry;
    if (deletedSet.has(entry.lineId)) {
      retired.push({ ...current, reason: 'line-deleted' });
      continue;
    }
    entries.push(current);
  }

  for (const lineId of added) {
    entries.push({
      lineId,
      status: 'needed',
      selectedTakeId: null,
      explicitTakeId: null,
      reason: 'line-added',
      history: [],
    });
  }

  return { entries, retired };
}

/**
 * Recompute coverage after the capture layer reports that media is gone.
 * A line falls back to its next eligible take, and otherwise returns to
 * `needed` with `media-missing` while keeping the unavailable take in history.
 */
export function applyMediaAvailability(
  ledger: CoverageLedger,
  unavailableTakeIds: readonly string[],
): CoverageLedger {
  const unavailable = new Set(requireIds(unavailableTakeIds, 'unavailableTakeIds'));
  if (unavailable.size === 0) return ledger;

  return {
    entries: ledger.entries.map((entry) => recomputeEntry(entry, unavailable)),
    retired: ledger.retired.map((entry) => ({
      ...entry,
      history: markUnavailable(entry.history, unavailable),
    })),
  };
}

/**
 * The selected takes in script order, never in recording order.  Consecutive
 * lines covered by one take stay one unbroken media segment, and a take that
 * covers non-adjacent lines is still played once, at its first script position.
 */
export function selectedCutOrder(ledger: CoverageLedger): CoverageCut[] {
  const cuts: CoverageCut[] = [];
  const byTakeId = new Map<string, CoverageCut>();

  for (const entry of ledger.entries) {
    if (entry.status !== 'covered' || entry.selectedTakeId === null) continue;
    const existing = byTakeId.get(entry.selectedTakeId);
    if (existing) {
      existing.lineIds.push(entry.lineId);
      continue;
    }
    const record = entry.history.find((item) => item.takeId === entry.selectedTakeId);
    if (!record) throw new Error(`selected take ${entry.selectedTakeId} is missing from history`);
    const cut: CoverageCut = {
      takeId: record.takeId,
      lineIds: [entry.lineId],
      t0: record.t0,
      t1: record.t1,
    };
    byTakeId.set(record.takeId, cut);
    cuts.push(cut);
  }
  return cuts;
}

/**
 * A wrap is only safe when the script has lines, every current line is covered
 * and no required action cue is still waiting for manual confirmation.
 * Retired lines are history and never gate a wrap.
 */
export function coverageSafeToWrap(
  ledger: CoverageLedger,
  unresolvedRequiredActionCueIds: readonly string[] = [],
): boolean {
  return ledger.entries.length > 0
    && ledger.entries.every((entry) => entry.status === 'covered')
    && unresolvedRequiredActionCueIds.length === 0;
}

/**
 * Losing a file can only ever take coverage away.  A replacement take is
 * chosen in exactly one case: the line was covered by a take this module
 * itself picked, and that take is the one that disappeared.
 */
function recomputeEntry(entry: CoverageEntry, unavailable: ReadonlySet<string>): CoverageEntry {
  if (!entry.history.some((record) => unavailable.has(record.takeId))) return entry;
  const history = markUnavailable(entry.history, unavailable);
  const lost = { ...entry, history, status: 'needed' as const, selectedTakeId: null, reason: 'media-missing' as const };

  // An explicit creator choice is never silently swapped for another take.
  if (entry.explicitTakeId !== null) {
    return unavailable.has(entry.explicitTakeId) ? lost : { ...entry, history };
  }

  // A line that is not covered by a derived clean take cannot be promoted here.
  // An edited, added or retired line keeps its own reason.
  if (entry.status !== 'covered' || entry.reason !== 'clean-take') {
    return history.some((record) => record.playable) ? { ...entry, history } : lost;
  }

  const kept = history.find((record) => record.takeId === entry.selectedTakeId && record.eligible);
  if (kept) return { ...entry, history };

  const replacement = history
    .filter((record) => record.eligible)
    .slice()
    .sort((a, b) => compareTakePreference(preferenceOf(a), preferenceOf(b)))[0];
  if (!replacement) return lost;
  return {
    ...entry,
    history,
    status: 'covered',
    selectedTakeId: replacement.takeId,
    reason: 'clean-take',
  };
}

function markUnavailable(
  history: readonly CoverageTakeRecord[],
  unavailable: ReadonlySet<string>,
): CoverageTakeRecord[] {
  return history.map((record) => (unavailable.has(record.takeId)
    ? { ...record, playable: false, eligible: false }
    : record));
}

function preferenceOf(record: CoverageTakeRecord) {
  return { id: record.takeId, t0: record.t0, inFrame: record.inFrame };
}

function historyFor(
  line: LineReview,
  takes: readonly TakeEvidence[],
  takeById: ReadonlyMap<string, TakeEvidence>,
): CoverageTakeRecord[] {
  const referenced = new Set([...line.candidateTakeIds, ...line.rejectedTakeIds]);
  const eligible = new Set(line.eligibleTakeIds);
  return takes
    .filter((take) => referenced.has(take.id) && takeById.has(take.id))
    .map((take) => ({
      takeId: take.id,
      quality: take.quality,
      inFrame: take.inFrame,
      playable: take.playable && typeof take.mediaUri === 'string' && take.mediaUri.trim().length > 0,
      t0: take.t0,
      t1: take.t1,
      eligible: eligible.has(take.id),
      stale: false,
    }));
}

function derivedReason(line: LineReview): CoverageReason {
  if (line.status === 'covered') return 'clean-take';
  if (line.status === 'pending') {
    if (line.pendingReasons.includes('provisional transcript')) return 'provisional-transcript';
    if (line.pendingReasons.includes('media unavailable')) return 'media-unavailable';
    return 'selection-unavailable';
  }
  return line.candidateTakeIds.length + line.rejectedTakeIds.length > 0 ? 'no-clean-take' : 'no-evidence';
}

function requireIds(ids: readonly string[], label: string): string[] {
  if (!Array.isArray(ids)) throw new TypeError(`${label} must be an array of line ids`);
  for (const id of ids) {
    if (typeof id !== 'string' || !id.trim()) throw new TypeError(`${label} entries must be non-empty ids`);
  }
  if (new Set(ids).size !== ids.length) throw new Error(`${label} values must be unique`);
  return [...ids];
}

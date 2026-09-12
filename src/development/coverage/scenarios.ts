/**
 * Deterministic coverage scenarios for replay.
 *
 * Every scenario is a fixed list of inputs - script lines, recognizer
 * utterances, media availability, framing observations and script changes -
 * plus the coverage and cut order it must produce.  Nothing here records
 * audio, inspects a frame or measures accuracy: the framing values are
 * declared fixture observations, not vision results.
 *
 * `runScenario` is pure, so replaying a scenario any number of times returns
 * identical coverage and an identical cut order.
 */

import {
  applyMediaAvailability,
  applyScriptChangeIntent,
  coverageLedger,
  coverageSafeToWrap,
  selectedCutOrder,
  type CoverageCut,
  type CoverageEntry,
  type CoverageReason,
  type ScriptChangeIntent,
} from '../../lib/coverage-updates.ts';
import {
  createScriptLine,
  createTranscriptSegment,
  deriveReviewState,
  type CoverageStatus,
  type ScriptLineInput,
  type TakeEvidence,
  type TakeQuality,
  type TranscriptSegmentInput,
} from '../../lib/transcript-workflow.ts';

export const scenarioIds = [
  'clean',
  'flub-reread',
  'pending-timer',
  'out-of-order',
  'missing-file',
  'two-lines-one-breath',
  'off-frame-vs-in-frame',
  'scratched-take',
  'script-edit-after-coverage',
  'required-action',
] as const;

export type ScenarioId = typeof scenarioIds[number];

/** A declared fixture observation of framing, never a vision measurement. */
export type ScenarioFraming = 'in-frame' | 'off-frame' | 'unobserved';

export interface ScenarioTake {
  id: string;
  t0: number;
  t1: number;
  quality: TakeQuality;
  media: 'available' | 'unavailable';
  framing: ScenarioFraming;
  segmentIds: string[];
  lineIds: string[];
}

export interface ScenarioCoverage {
  lineId: string;
  status: CoverageStatus;
  selectedTakeId: string | null;
  reason: CoverageReason;
}

export interface ScenarioExpectation {
  coverage: ScenarioCoverage[];
  cuts: CoverageCut[];
  safeToWrap: boolean;
}

export interface CoverageScenario {
  id: ScenarioId;
  title: string;
  description: string;
  lines: ScriptLineInput[];
  segments: TranscriptSegmentInput[];
  takes: ScenarioTake[];
  /** A script change published after the takes were recorded. */
  changeIntent?: ScriptChangeIntent;
  /** Takes whose media the capture layer later reports as gone. */
  lostMediaTakeIds?: string[];
  /** How long a pending take may wait before the replay calls it timed out. */
  pendingTimeoutSeconds?: number;
  expected: ScenarioExpectation;
}

export interface ScenarioResult {
  id: ScenarioId;
  coverage: ScenarioCoverage[];
  cuts: CoverageCut[];
  history: { lineId: string; takeIds: string[] }[];
  retiredLineIds: string[];
  unresolvedRequiredActionCueIds: string[];
  /**
   * Pending takes whose analysis window has elapsed.  This is reported so a
   * replay can show that an expired timer changes nothing about coverage.
   */
  timedOutTakeIds: string[];
  safeToWrap: boolean;
}

export interface ScenarioOptions {
  /** Simulated wall clock in recording seconds.  Coverage never reads it. */
  nowSeconds?: number;
}

const DEFAULT_PENDING_TIMEOUT_SECONDS = 30;

const LINE_ONE = 'A good take starts with a clear idea.';
const LINE_TWO = 'Say it simply, and make it yours.';
const LINE_THREE = 'Then stop recording.';
const BOTH_LINES = `${LINE_ONE} ${LINE_TWO}`;

/**
 * Replay one scenario.  Coverage is derived from the observations only; the
 * simulated clock is threaded through so a caller can prove that advancing it
 * past any analysis timeout cannot promote a pending line to covered.
 */
export function runScenario(scenario: CoverageScenario, options: ScenarioOptions = {}): ScenarioResult {
  const lines = scenario.lines.map((line) => createScriptLine(line));
  const segments = scenario.segments.map((segment) => createTranscriptSegment(segment));
  const takes = scenario.takes.map(toTakeEvidence);
  const review = deriveReviewState({ lines, segments, takes });

  let ledger = coverageLedger(review);
  if (scenario.changeIntent) ledger = applyScriptChangeIntent(ledger, scenario.changeIntent);
  if (scenario.lostMediaTakeIds?.length) {
    ledger = applyMediaAvailability(ledger, scenario.lostMediaTakeIds);
  }

  const liveLineIds = new Set(ledger.entries.map((entry) => entry.lineId));
  const unresolvedRequiredActionCueIds = review.lines
    .filter((line) => liveLineIds.has(line.id))
    .flatMap((line) => line.unresolvedRequiredActionCueIds);

  return {
    id: scenario.id,
    coverage: ledger.entries.map(summarizeEntry),
    cuts: selectedCutOrder(ledger),
    history: ledger.entries.map((entry) => ({
      lineId: entry.lineId,
      takeIds: entry.history.map((record) => record.takeId),
    })),
    retiredLineIds: ledger.retired.map((entry) => entry.lineId),
    unresolvedRequiredActionCueIds,
    timedOutTakeIds: timedOutTakeIds(ledger.entries, scenario, options.nowSeconds ?? 0),
    safeToWrap: coverageSafeToWrap(ledger, unresolvedRequiredActionCueIds),
  };
}

export function createScenario(id: ScenarioId): CoverageScenario {
  switch (id) {
    case 'clean':
      return {
        id,
        title: 'Clean read',
        description: 'Both lines are read once, in script order, with playable media.',
        lines: [
          { id: 'line-1', text: LINE_ONE },
          { id: 'line-2', text: LINE_TWO },
        ],
        segments: [
          finalSegment('s-1', 0.5, 4, LINE_ONE),
          finalSegment('s-2', 5, 8.5, LINE_TWO),
        ],
        takes: [
          cleanTake('take-1', 0.5, 4, ['s-1'], ['line-1']),
          cleanTake('take-2', 5, 8.5, ['s-2'], ['line-2']),
        ],
        expected: {
          coverage: [
            covered('line-1', 'take-1'),
            covered('line-2', 'take-2'),
          ],
          cuts: [
            { takeId: 'take-1', lineIds: ['line-1'], t0: 0.5, t1: 4 },
            { takeId: 'take-2', lineIds: ['line-2'], t0: 5, t1: 8.5 },
          ],
          safeToWrap: true,
        },
      };

    case 'flub-reread':
      return {
        id,
        title: 'Flub and re-read',
        description: 'A flubbed first attempt, a clean re-read of both lines, then a flubbed late re-read.',
        lines: [
          { id: 'line-1', text: LINE_ONE },
          { id: 'line-2', text: LINE_TWO },
        ],
        segments: [
          finalSegment('s-1', 0.5, 8, BOTH_LINES),
          finalSegment('s-2', 9, 15.5, BOTH_LINES),
          finalSegment('s-3', 16, 18, LINE_ONE),
        ],
        takes: [
          { ...cleanTake('take-1', 0.5, 8, ['s-1'], ['line-1', 'line-2']), quality: 'flub' },
          cleanTake('take-2', 9, 15.5, ['s-2'], ['line-1', 'line-2']),
          { ...cleanTake('take-3', 16, 18, ['s-3'], ['line-1']), quality: 'flub' },
        ],
        expected: {
          coverage: [
            covered('line-1', 'take-2'),
            covered('line-2', 'take-2'),
          ],
          cuts: [{ takeId: 'take-2', lineIds: ['line-1', 'line-2'], t0: 9, t1: 15.5 }],
          safeToWrap: true,
        },
      };

    case 'pending-timer':
      return {
        id,
        title: 'Pending analysis',
        description: 'The second line only has provisional recognizer text, however long the wait becomes.',
        lines: [
          { id: 'line-1', text: LINE_ONE },
          { id: 'line-2', text: LINE_TWO },
        ],
        segments: [
          finalSegment('s-1', 0.5, 4, LINE_ONE),
          { id: 's-2', t0: 5, t1: 8.5, text: LINE_TWO, isFinal: false, revision: 1 },
        ],
        takes: [
          cleanTake('take-1', 0.5, 4, ['s-1'], ['line-1']),
          cleanTake('take-2', 5, 8.5, ['s-2'], ['line-2']),
        ],
        pendingTimeoutSeconds: DEFAULT_PENDING_TIMEOUT_SECONDS,
        expected: {
          coverage: [
            covered('line-1', 'take-1'),
            { lineId: 'line-2', status: 'pending', selectedTakeId: null, reason: 'provisional-transcript' },
          ],
          cuts: [{ takeId: 'take-1', lineIds: ['line-1'], t0: 0.5, t1: 4 }],
          safeToWrap: false,
        },
      };

    case 'out-of-order':
      return {
        id,
        title: 'Out of order recording',
        description: 'The last line is recorded first; coverage and cuts still follow the script.',
        lines: [
          { id: 'line-1', text: LINE_ONE },
          { id: 'line-2', text: LINE_TWO },
          { id: 'line-3', text: LINE_THREE },
        ],
        segments: [
          finalSegment('s-c', 1, 2, LINE_THREE),
          finalSegment('s-a', 5, 6, LINE_ONE),
          finalSegment('s-b', 7, 8, LINE_TWO),
        ],
        takes: [
          cleanTake('take-c', 1, 2, ['s-c'], ['line-3']),
          cleanTake('take-a', 5, 6, ['s-a'], ['line-1']),
          cleanTake('take-b', 7, 8, ['s-b'], ['line-2']),
        ],
        expected: {
          coverage: [
            covered('line-1', 'take-a'),
            covered('line-2', 'take-b'),
            covered('line-3', 'take-c'),
          ],
          cuts: [
            { takeId: 'take-a', lineIds: ['line-1'], t0: 5, t1: 6 },
            { takeId: 'take-b', lineIds: ['line-2'], t0: 7, t1: 8 },
            { takeId: 'take-c', lineIds: ['line-3'], t0: 1, t1: 2 },
          ],
          safeToWrap: true,
        },
      };

    case 'missing-file':
      return {
        id,
        title: 'Missing media',
        description: 'One take was never playable and another loses its file after recording.',
        lines: [
          { id: 'line-1', text: LINE_ONE },
          { id: 'line-2', text: LINE_TWO },
        ],
        segments: [
          finalSegment('s-1', 0.5, 4, LINE_ONE),
          finalSegment('s-2', 5, 8.5, LINE_TWO),
        ],
        takes: [
          cleanTake('take-1', 0.5, 4, ['s-1'], ['line-1']),
          { ...cleanTake('take-2', 5, 8.5, ['s-2'], ['line-2']), media: 'unavailable' },
        ],
        lostMediaTakeIds: ['take-1'],
        expected: {
          coverage: [
            { lineId: 'line-1', status: 'needed', selectedTakeId: null, reason: 'media-missing' },
            { lineId: 'line-2', status: 'pending', selectedTakeId: null, reason: 'media-unavailable' },
          ],
          cuts: [],
          safeToWrap: false,
        },
      };

    case 'two-lines-one-breath':
      return {
        id,
        title: 'Two lines, one breath',
        description: 'One continuous utterance covers both lines and stays one unbroken cut.',
        lines: [
          { id: 'line-1', text: LINE_ONE },
          { id: 'line-2', text: LINE_TWO },
        ],
        segments: [finalSegment('s-1', 0.5, 8.5, BOTH_LINES)],
        takes: [cleanTake('take-1', 0.5, 8.5, ['s-1'], ['line-1', 'line-2'])],
        expected: {
          coverage: [
            covered('line-1', 'take-1'),
            covered('line-2', 'take-1'),
          ],
          cuts: [{ takeId: 'take-1', lineIds: ['line-1', 'line-2'], t0: 0.5, t1: 8.5 }],
          safeToWrap: true,
        },
      };

    case 'off-frame-vs-in-frame':
      return {
        id,
        title: 'Off-frame against in-frame',
        description: 'A later in-frame take wins over an earlier, otherwise suitable off-frame take.',
        lines: [{ id: 'line-1', text: LINE_ONE }],
        segments: [
          finalSegment('s-1', 0.5, 4, LINE_ONE),
          finalSegment('s-2', 6, 9.5, LINE_ONE),
        ],
        takes: [
          { ...cleanTake('off-frame-take', 0.5, 4, ['s-1'], ['line-1']), framing: 'off-frame' },
          cleanTake('in-frame-take', 6, 9.5, ['s-2'], ['line-1']),
        ],
        expected: {
          coverage: [covered('line-1', 'in-frame-take')],
          cuts: [{ takeId: 'in-frame-take', lineIds: ['line-1'], t0: 6, t1: 9.5 }],
          safeToWrap: true,
        },
      };

    case 'scratched-take':
      return {
        id,
        title: 'Scratched takes',
        description: 'Scratched attempts never cover a line and are never removed from history.',
        lines: [
          { id: 'line-1', text: LINE_ONE },
          { id: 'line-2', text: LINE_TWO },
        ],
        segments: [
          finalSegment('s-1', 0.5, 4, LINE_ONE),
          finalSegment('s-2', 6, 9.5, LINE_ONE),
          finalSegment('s-3', 11, 14, LINE_TWO),
        ],
        takes: [
          { ...cleanTake('scratched-take', 0.5, 4, ['s-1'], ['line-1']), quality: 'scratched' },
          cleanTake('clean-take', 6, 9.5, ['s-2'], ['line-1']),
          { ...cleanTake('scratched-only-take', 11, 14, ['s-3'], ['line-2']), quality: 'scratched' },
        ],
        expected: {
          coverage: [
            covered('line-1', 'clean-take'),
            { lineId: 'line-2', status: 'needed', selectedTakeId: null, reason: 'no-clean-take' },
          ],
          cuts: [{ takeId: 'clean-take', lineIds: ['line-1'], t0: 6, t1: 9.5 }],
          safeToWrap: false,
        },
      };

    case 'script-edit-after-coverage':
      return {
        id,
        title: 'Script edited after coverage',
        description: 'One covered line is edited, one is deleted, one is added, and the order changes.',
        lines: [
          { id: 'line-1', text: LINE_ONE },
          { id: 'line-2', text: LINE_TWO },
          { id: 'line-3', text: LINE_THREE },
        ],
        segments: [
          finalSegment('s-1', 0.5, 4, LINE_ONE),
          finalSegment('s-2', 5, 8.5, LINE_TWO),
          finalSegment('s-3', 9, 12, LINE_THREE),
        ],
        takes: [
          cleanTake('take-1', 0.5, 4, ['s-1'], ['line-1']),
          cleanTake('take-2', 5, 8.5, ['s-2'], ['line-2']),
          cleanTake('take-3', 9, 12, ['s-3'], ['line-3']),
        ],
        changeIntent: {
          editedLineIds: ['line-1'],
          deletedLineIds: ['line-3'],
          addedLineIds: ['line-4'],
          reorderedFrom: ['line-1', 'line-2', 'line-3'],
        },
        expected: {
          coverage: [
            { lineId: 'line-1', status: 'needed', selectedTakeId: null, reason: 'script-edited' },
            covered('line-2', 'take-2'),
            { lineId: 'line-4', status: 'needed', selectedTakeId: null, reason: 'line-added' },
          ],
          cuts: [{ takeId: 'take-2', lineIds: ['line-2'], t0: 5, t1: 8.5 }],
          safeToWrap: false,
        },
      };

    case 'required-action':
      return {
        id,
        title: 'Required action cue',
        description: 'Every line is covered, but a required action still needs manual confirmation.',
        lines: [
          {
            id: 'line-1',
            text: `${LINE_ONE} [show the product label]`,
            actionCues: [{ id: 'cue-product-label', text: 'show the product label', required: true }],
          },
          { id: 'line-2', text: LINE_TWO },
        ],
        segments: [
          finalSegment('s-1', 0.5, 4, LINE_ONE),
          finalSegment('s-2', 5, 8.5, LINE_TWO),
        ],
        takes: [
          cleanTake('take-1', 0.5, 4, ['s-1'], ['line-1']),
          cleanTake('take-2', 5, 8.5, ['s-2'], ['line-2']),
        ],
        expected: {
          coverage: [
            covered('line-1', 'take-1'),
            covered('line-2', 'take-2'),
          ],
          cuts: [
            { takeId: 'take-1', lineIds: ['line-1'], t0: 0.5, t1: 4 },
            { takeId: 'take-2', lineIds: ['line-2'], t0: 5, t1: 8.5 },
          ],
          safeToWrap: false,
        },
      };
  }
}

function finalSegment(id: string, t0: number, t1: number, text: string): TranscriptSegmentInput {
  return { id, t0, t1, text, isFinal: true, revision: 1 };
}

function cleanTake(
  id: string,
  t0: number,
  t1: number,
  segmentIds: string[],
  lineIds: string[],
): ScenarioTake {
  return { id, t0, t1, quality: 'clean', media: 'available', framing: 'in-frame', segmentIds, lineIds };
}

function covered(lineId: string, selectedTakeId: string): ScenarioCoverage {
  return { lineId, status: 'covered', selectedTakeId, reason: 'clean-take' };
}

function toTakeEvidence(take: ScenarioTake): TakeEvidence {
  const available = take.media === 'available';
  return {
    id: take.id,
    t0: take.t0,
    t1: take.t1,
    mediaUri: available ? `file:///fixtures/${take.id}.mp4` : null,
    playable: available,
    quality: take.quality,
    // Only an explicit in-frame observation counts as in-frame evidence.
    inFrame: take.framing === 'in-frame',
    transcriptSegmentIds: take.segmentIds,
    lineIds: take.lineIds,
  };
}

function summarizeEntry(entry: CoverageEntry): ScenarioCoverage {
  return {
    lineId: entry.lineId,
    status: entry.status,
    selectedTakeId: entry.selectedTakeId,
    reason: entry.reason,
  };
}

function timedOutTakeIds(
  entries: readonly CoverageEntry[],
  scenario: CoverageScenario,
  nowSeconds: number,
): string[] {
  const timeout = scenario.pendingTimeoutSeconds ?? DEFAULT_PENDING_TIMEOUT_SECONDS;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== 'pending') continue;
    for (const record of entry.history) {
      if (nowSeconds - record.t1 > timeout) ids.add(record.takeId);
    }
  }
  return [...ids].sort();
}

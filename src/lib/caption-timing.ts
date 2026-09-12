/**
 * Separate timing for the three stages between the end of speech and a
 * coverage verdict.
 *
 * The stages are deliberately measured independently: a slow pause detector,
 * a slow recognizer and a slow coverage pass are different problems and must
 * not be collapsed into one "latency" number.  Nothing here estimates a stage
 * it was not told about; an unobserved stage stays `null` rather than being
 * inferred from its neighbours.
 *
 * Timestamps are milliseconds on a single monotonic clock owned by the
 * caller.  The module never reads a clock itself, which keeps replay of a
 * recorded session byte-identical to the live run that produced it.
 */

export type CaptionTimingStage =
  | 'speech-end'
  | 'pause-detected'
  | 'final-segment'
  | 'coverage-verdict';

export interface CaptionTimingEvent {
  utteranceId: string;
  stage: CaptionTimingStage;
  at: number;
}

export interface CaptionUtteranceTiming {
  utteranceId: string;
  /** Speech end to pause detected. */
  pauseDetectionMs: number | null;
  /** Pause detected to the final recognized segment. */
  finalizationMs: number | null;
  /** Final segment to the coverage verdict callback. */
  coverageMs: number | null;
  complete: boolean;
  delayed: boolean;
}

export interface CaptionTimingReport {
  utterances: CaptionUtteranceTiming[];
  /** The state of the most recently measured utterance, not a session total. */
  delayed: boolean;
  /** One `caption-timing:` line per completed utterance, in completion order. */
  lines: string[];
}

export interface CaptionTimingState {
  readonly order: readonly string[];
  readonly stages: ReadonlyMap<string, ReadonlyMap<CaptionTimingStage, number>>;
}

/** Recognition finalization above this is reported as a delayed review state. */
export const FINALIZATION_DELAY_MS = 1_500;

/** Coverage processing above this is reported as a delayed review state. */
export const COVERAGE_DELAY_MS = 500;

const STAGES: readonly CaptionTimingStage[] = [
  'speech-end',
  'pause-detected',
  'final-segment',
  'coverage-verdict',
];

export function captionTimingState(): CaptionTimingState {
  return { order: [], stages: new Map() };
}

/**
 * Accept one stage observation.
 *
 * A stage already recorded for that utterance is ignored and the same state
 * object is returned, so a duplicated or re-delivered event cannot change a
 * measurement that has already been reported.
 */
export function reduceCaptionTiming(
  state: CaptionTimingState,
  event: CaptionTimingEvent,
): CaptionTimingState {
  validateEvent(event);
  const existing = state.stages.get(event.utteranceId);
  if (existing?.has(event.stage)) return state;

  const previous = previousStageTime(existing, event.stage);
  if (previous !== null && event.at < previous) {
    throw new RangeError(`Caption timing for utterance ${event.utteranceId} moved backwards.`);
  }

  const stages = new Map(state.stages);
  const utterance = new Map(existing ?? []);
  utterance.set(event.stage, event.at);
  stages.set(event.utteranceId, utterance);
  return {
    order: existing ? state.order : [...state.order, event.utteranceId],
    stages,
  };
}

export function captionTimingReport(state: CaptionTimingState): CaptionTimingReport {
  const utterances = state.order.map(utteranceId => {
    const stages = state.stages.get(utteranceId);
    const pauseDetectionMs = duration(stages, 'speech-end', 'pause-detected');
    const finalizationMs = duration(stages, 'pause-detected', 'final-segment');
    const coverageMs = duration(stages, 'final-segment', 'coverage-verdict');
    return {
      utteranceId,
      pauseDetectionMs,
      finalizationMs,
      coverageMs,
      complete: STAGES.every(stage => stages?.has(stage) === true),
      delayed:
        (finalizationMs !== null && finalizationMs > FINALIZATION_DELAY_MS) ||
        (coverageMs !== null && coverageMs > COVERAGE_DELAY_MS),
    };
  });

  const measured = utterances.filter(
    utterance => utterance.finalizationMs !== null || utterance.coverageMs !== null,
  );
  return {
    utterances,
    delayed: measured.at(-1)?.delayed ?? false,
    lines: utterances.filter(utterance => utterance.complete).map(formatTimingLine),
  };
}

export function summarizeCaptionTiming(
  events: readonly CaptionTimingEvent[],
): CaptionTimingReport {
  if (!Array.isArray(events)) {
    throw new TypeError('Caption timing events must be an array.');
  }
  return captionTimingReport(events.reduce(reduceCaptionTiming, captionTimingState()));
}

/**
 * Relabel a listening session that is measurably behind.
 *
 * Every other status already describes something more specific - preparation,
 * shutdown or a failure - so timing never overwrites it.
 */
export function timingAdjustedStatus<Status extends string>(
  status: Status,
  report: CaptionTimingReport,
): Status | 'delayed' {
  return status === 'listening' && report.delayed ? 'delayed' : status;
}

function formatTimingLine(utterance: CaptionUtteranceTiming): string {
  return [
    'caption-timing:',
    `utterance=${utterance.utteranceId}`,
    `pause_detection_ms=${utterance.pauseDetectionMs}`,
    `finalization_ms=${utterance.finalizationMs}`,
    `coverage_processing_ms=${utterance.coverageMs}`,
    `state=${utterance.delayed ? 'delayed' : 'live'}`,
  ].join(' ');
}

function duration(
  stages: ReadonlyMap<CaptionTimingStage, number> | undefined,
  from: CaptionTimingStage,
  to: CaptionTimingStage,
): number | null {
  const start = stages?.get(from);
  const end = stages?.get(to);
  if (start === undefined || end === undefined) return null;
  return end - start;
}

function previousStageTime(
  stages: ReadonlyMap<CaptionTimingStage, number> | undefined,
  stage: CaptionTimingStage,
): number | null {
  if (!stages) return null;
  for (let index = STAGES.indexOf(stage) - 1; index >= 0; index -= 1) {
    const at = stages.get(STAGES[index]);
    if (at !== undefined) return at;
  }
  return null;
}

function validateEvent(event: CaptionTimingEvent): void {
  if (!event || typeof event !== 'object') {
    throw new TypeError('Caption timing event is invalid.');
  }
  if (typeof event.utteranceId !== 'string' || event.utteranceId.length === 0) {
    throw new TypeError('Caption timing event needs an utterance id.');
  }
  if (!STAGES.includes(event.stage)) {
    throw new TypeError(`Unknown caption timing stage: ${String(event.stage)}`);
  }
  if (!Number.isFinite(event.at) || event.at < 0) {
    throw new RangeError(`Caption timing for utterance ${event.utteranceId} has an invalid timestamp.`);
  }
}

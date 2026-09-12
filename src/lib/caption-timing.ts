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
  /**
   * Speech end to the final segment.  Not one of the three reported stages;
   * it is the only span both of whose endpoints have a native source today,
   * so it keeps the log useful while pause detection has none.
   */
  recognizedMs: number | null;
  complete: boolean;
  delayed: boolean;
}

export interface CaptionTimingLine {
  /**
   * Stable identity of this exact line.  An utterance produces at most two:
   * a partial one when recognition finalized it, and a final one when the
   * coverage verdict arrived.  Keying by identity rather than by position is
   * what keeps logging correct when utterances complete out of order.
   */
  key: string;
  utteranceId: string;
  complete: boolean;
  line: string;
}

export interface CaptionTimingReport {
  utterances: CaptionUtteranceTiming[];
  /**
   * The state of the most recently measured utterance, not a session total.
   * One slow utterance therefore does not pin the session to delayed once a
   * later utterance has been measured as fast again.
   */
  delayed: boolean;
  /** Loggable `caption-timing:` lines, in first-observation order. */
  lines: CaptionTimingLine[];
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
      recognizedMs: duration(stages, 'speech-end', 'final-segment'),
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
    // A line is emitted as soon as recognition finalized the utterance, with
    // any stage that was never reported shown as n/a, so the device log is
    // not empty while pause detection has no native source. The coverage
    // verdict then produces the one completed line.
    lines: utterances
      .filter(utterance => utterance.recognizedMs !== null || utterance.complete)
      .map(utterance => ({
        key: `${utterance.utteranceId}:${utterance.complete ? 'complete' : 'partial'}`,
        utteranceId: utterance.utteranceId,
        complete: utterance.complete,
        line: formatTimingLine(utterance),
      })),
  };
}

/**
 * The lines that have not been logged yet.
 *
 * Selection is by line identity rather than by count, because utterances
 * complete in coverage order, not in the order they were first observed.
 */
export function selectNewTimingLines(
  report: CaptionTimingReport,
  logged: ReadonlySet<string>,
): CaptionTimingLine[] {
  return report.lines.filter(line => !logged.has(line.key));
}

/**
 * Place a wall-clock instant on the audio-stream clock.
 *
 * Every stage timestamp must share one origin: the moment the microphone
 * stream started, which is when the native module reports `listening`.
 * Segment end times are already on that clock, so mixing in a wall clock
 * anchored at `start()` would inflate pause detection by the whole
 * preparation interval. Returns `null` before the stream exists, so a caller
 * drops the observation instead of recording a wrong one.
 */
export function streamElapsedMs(
  nowWallMs: number,
  streamStartWallMs: number | null,
): number | null {
  if (streamStartWallMs === null || !Number.isFinite(nowWallMs) || !Number.isFinite(streamStartWallMs)) {
    return null;
  }
  return Math.max(0, Math.round(nowWallMs - streamStartWallMs));
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
  const value = (ms: number | null) => (ms === null ? 'n/a' : String(ms));
  return [
    'caption-timing:',
    `utterance=${utterance.utteranceId}`,
    `pause_detection_ms=${value(utterance.pauseDetectionMs)}`,
    `finalization_ms=${value(utterance.finalizationMs)}`,
    `coverage_processing_ms=${value(utterance.coverageMs)}`,
    `recognized_ms=${value(utterance.recognizedMs)}`,
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

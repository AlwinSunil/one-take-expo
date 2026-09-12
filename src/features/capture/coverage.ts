import type { ScriptDocument } from '../../lib/script-lines';
import type { Project } from '../../lib/session';
import {
  createScriptLine,
  createTranscriptSegment,
  deriveReviewState,
  matchTranscriptToScript,
  type ReviewState,
  type ScriptLine,
  type TranscriptSegment,
  type TakeEvidence,
} from '../../lib/transcript-workflow.ts';
import { cleanReview } from '../../lib/clean-review.ts';
import { coverageLedger, coverageSafeToWrap } from '../../lib/coverage-updates.ts';
import type { LineEnd, LineVerdict, PrompterLine } from '../../lib/retake-prompts';

export interface CaptureCoverageSnapshot {
  /** All lines, including action-only lines for the prompter. */
  lines: PrompterLine[];
  /** Spoken lines only, which are the lines represented in the coverage strip. */
  spokenLines: PrompterLine[];
  review: ReviewState;
  lineEnds: LineEnd[];
  verdicts: LineVerdict[];
  unresolvedRequiredActionCueIds: string[];
  safeToWrap: boolean;
}

export interface CaptureCoverageInput {
  document: ScriptDocument;
  takeId: string;
  videoUri: string | null;
  transcript: readonly TranscriptSegment[];
  scratched?: boolean;
  inFrame?: boolean;
  lineEnds?: readonly LineEnd[];
  verdicts?: readonly LineVerdict[];
}

/**
 * Keep the capture route's script handoff in the shared review vocabulary.
 * Action-only lines remain available to the prompter, while the coverage
 * engine receives spoken lines only because an action is never speech evidence.
 */
export function captureScriptLines(document: ScriptDocument): ScriptLine[] {
  return document.lines.map(line => createScriptLine({
    id: line.id,
    text: line.text,
    actionCues: line.actionCues.map(cue => ({
      id: cue.id,
      text: cue.text,
      required: cue.required,
      resolved: cue.status === 'done',
    })),
  }));
}

/**
 * Convert the caption hook's stable final/provisional segments into the shared
 * workflow input. Kept here so the camera route never creates a second match
 * or coverage implementation.
 */
export function captureTranscriptSegments(
  segments: readonly { id: string; t0: number; t1: number; text: string; isFinal: boolean }[],
): TranscriptSegment[] {
  return segments.map(segment => createTranscriptSegment({
    ...segment,
    source: 'live',
    timingSource: 'live-estimate',
  }));
}

/**
 * A take cannot establish coverage until the camera has returned a real URI.
 * This snapshot is what the route uses while a recording is still running.
 */
export function pendingCaptureCoverage(document: ScriptDocument): CaptureCoverageSnapshot {
  const review = deriveReviewState({ lines: spokenWorkflowLines(document), segments: [], takes: [] });
  return makeSnapshot(document, review, [], [], true);
}

/**
 * Derive post-stop coverage through the shared transcript engine. A missing
 * URI deliberately leaves a clean transcript as needed, and provisional or
 * scratched evidence remains pending/needed according to that engine's rules.
 */
export function deriveCaptureCoverage(input: CaptureCoverageInput): CaptureCoverageSnapshot {
  if (typeof input.takeId !== 'string' || !input.takeId.trim()) throw new TypeError('Capture coverage needs a take id.');
  const lines = spokenWorkflowLines(input.document);
  const takes: TakeEvidence[] = input.transcript.map((segment, index) => {
    const lineIds = matchLineIds(segment, lines);
    return {
      id: `${input.takeId}:segment:${segment.id || index}`,
      t0: segment.t0,
      t1: segment.t1,
      mediaUri: input.videoUri,
      playable: typeof input.videoUri === 'string' && input.videoUri.trim().length > 0,
      quality: input.scratched ? 'scratched' : 'clean',
      inFrame: input.inFrame === true,
      transcriptSegmentIds: [segment.id],
      lineIds,
    };
  });
  const review = deriveReviewState({ lines, segments: input.transcript, takes });
  return makeSnapshot(input.document, review, input.lineEnds ?? [], input.verdicts ?? [], false);
}

/**
 * Rebuild the same snapshot after a project pickup, retaining every original
 * recording and take in the review input. A pickup is scoped by the store, so
 * older lines remain eligible evidence while the new take gets its own URI.
 */
export function deriveProjectCaptureCoverage(
  document: ScriptDocument,
  project: Project,
): CaptureCoverageSnapshot {
  const review = cleanReview(project);
  return makeSnapshot(document, review, [], [], false);
}

function spokenWorkflowLines(document: ScriptDocument): ScriptLine[] {
  return captureScriptLines(document).filter(line => line.spokenText.trim().length > 0);
}

function matchLineIds(segment: TranscriptSegment, lines: readonly ScriptLine[]): string[] {
  return matchTranscriptToScript(segment, lines).lineIds;
}

function makeSnapshot(
  document: ScriptDocument,
  review: ReviewState,
  lineEnds: readonly LineEnd[],
  verdicts: readonly LineVerdict[],
  pending: boolean,
): CaptureCoverageSnapshot {
  const reviewById = new Map(review.lines.map(line => [line.id, line]));
  const lines = document.lines.map((line, index) => {
    const state = reviewById.get(line.id);
    return {
      id: line.id,
      number: index + 1,
      status: pending ? 'pending' as const : state?.status ?? 'needed',
      spokenText: line.spokenText,
      actionCues: line.actionCues.map(cue => ({
        id: cue.id,
        text: cue.text,
        required: cue.required,
        resolved: cue.status === 'done',
      })),
    } satisfies PrompterLine;
  });
  const spokenLines = lines.filter(line => line.spokenText.trim().length > 0);
  const unresolvedRequiredActionCueIds = document.lines.flatMap(line =>
    line.actionCues.filter(cue => cue.required && cue.status !== 'done').map(cue => cue.id));
  const ledger = coverageLedger(review);
  return {
    lines,
    spokenLines,
    review,
    lineEnds: [...lineEnds],
    verdicts: [...verdicts],
    unresolvedRequiredActionCueIds,
    safeToWrap: !pending && coverageSafeToWrap(ledger, unresolvedRequiredActionCueIds),
  };
}

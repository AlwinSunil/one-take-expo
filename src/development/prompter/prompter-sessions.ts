/**
 * Camera-free prompter fixtures.
 *
 * Each session is a replayable log: the lines the creator sees, when each line
 * ended, and when a coverage verdict arrived.  Nothing here records a real
 * read, a real recognizer or a real device; the timings are written by hand so
 * the prompt scheduler can be exercised without a camera.
 */

import { createSample } from '../sessions/samples.ts';
import type {
  LineEnd,
  LineVerdict,
  PrompterActionCue,
  PrompterEngineState,
  PrompterLine,
} from '../../lib/retake-prompts.ts';

export const prompterSessionIds = ['clean', 'flub', 'long-line', 'delayed-verdict', 'action'] as const;
export type PrompterSessionId = typeof prompterSessionIds[number];

export interface PrompterSession {
  id: PrompterSessionId;
  title: string;
  description: string;
  lines: PrompterLine[];
  lineEnds: LineEnd[];
  verdicts: LineVerdict[];
  engineState: PrompterEngineState;
  /** The moment the harness replays, in the same milliseconds as the log. */
  now: number;
  /** True when the creator is speaking at `now`, so no prompt may interrupt. */
  midLine: boolean;
  currentLineId: string;
}

const LONG_LINE = [
  'If you remember one thing from this, remember that the first sentence has to earn',
  'the second one, and the second one has to earn the third, because nobody owes you',
  'the rest of the minute just because they started watching it.',
].join(' ');

export function createPrompterSession(id: PrompterSessionId): PrompterSession {
  switch (id) {
    case 'clean':
      return {
        id,
        title: 'Clean read',
        description: 'Two lines, both confirmed in the pause. The prompter stays quiet.',
        lines: linesFromSample('clean'),
        lineEnds: [
          { lineId: 'line-1', endedAt: 4000, nextStartsAt: 4800 },
          { lineId: 'line-2', endedAt: 8500 },
        ],
        verdicts: [
          { lineId: 'line-1', status: 'covered', arrivedAt: 4300 },
          { lineId: 'line-2', status: 'covered', arrivedAt: 8800 },
        ],
        engineState: 'ready',
        now: 9000,
        midLine: false,
        currentLineId: 'line-2',
      };
    case 'flub':
      return {
        id,
        title: 'Flub and re-read',
        description: 'The second line needs another go and the verdict lands inside the pause.',
        lines: linesFromSample('reread', { 'line-2': 'needed' }),
        lineEnds: [
          { lineId: 'line-1', endedAt: 4000, nextStartsAt: 4800 },
          { lineId: 'line-2', endedAt: 8000, nextStartsAt: 11000 },
        ],
        verdicts: [
          { lineId: 'line-1', status: 'covered', arrivedAt: 4300 },
          { lineId: 'line-2', status: 'needed', arrivedAt: 8700 },
        ],
        engineState: 'ready',
        now: 8800,
        midLine: false,
        currentLineId: 'line-2',
      };
    case 'long-line': {
      const lines = linesFromSample('clean', { 'line-2': 'needed' });
      lines[1] = { ...lines[1], spokenText: LONG_LINE };
      return {
        id,
        title: 'Long line',
        description: 'A line longer than the prompter can show. It truncates with a More control instead of clipping.',
        lines,
        lineEnds: [
          { lineId: 'line-1', endedAt: 4000, nextStartsAt: 4800 },
          { lineId: 'line-2', endedAt: 21000, nextStartsAt: 24000 },
        ],
        verdicts: [
          { lineId: 'line-1', status: 'covered', arrivedAt: 4300 },
          { lineId: 'line-2', status: 'needed', arrivedAt: 21900 },
        ],
        engineState: 'ready',
        now: 22000,
        midLine: false,
        currentLineId: 'line-2',
      };
    }
    case 'delayed-verdict':
      return {
        id,
        title: 'Delayed verdict',
        description: 'The engine is behind the read, so line 2 is batched for after the take rather than guessed at.',
        lines: linesFromSample('pending'),
        lineEnds: [
          { lineId: 'line-1', endedAt: 4000, nextStartsAt: 5000 },
          { lineId: 'line-2', endedAt: 8500, nextStartsAt: 12000 },
        ],
        verdicts: [{ lineId: 'line-1', status: 'covered', arrivedAt: 4400 }],
        engineState: 'delayed',
        now: 9000,
        midLine: false,
        currentLineId: 'line-2',
      };
    case 'action':
      return {
        id,
        title: 'Action cue',
        description: 'A required action sits beside the line as a Do row. Advancing never completes it.',
        lines: linesFromSample('action-cue'),
        lineEnds: [
          { lineId: 'line-1', endedAt: 4000, nextStartsAt: 5200 },
          { lineId: 'line-2', endedAt: 8500 },
        ],
        verdicts: [
          { lineId: 'line-1', status: 'covered', arrivedAt: 4300 },
          { lineId: 'line-2', status: 'covered', arrivedAt: 8800 },
        ],
        engineState: 'ready',
        now: 9000,
        midLine: false,
        currentLineId: 'line-2',
      };
  }
}

/**
 * Build prompter lines from a shared sample session.  An action item belongs to
 * the spoken line it follows, and its text stays out of `spokenText` so a cue
 * can never be read aloud as dialogue.
 */
function linesFromSample(
  sampleId: Parameters<typeof createSample>[0],
  statusOverrides: Record<string, PrompterLine['status']> = {},
): PrompterLine[] {
  const sample = createSample(sampleId);
  const lines: PrompterLine[] = [];
  for (const item of sample.script) {
    if (item.kind === 'action') {
      const owner = lines[lines.length - 1];
      if (owner) owner.actionCues.push(cueFrom(item));
      continue;
    }
    const coverage = sample.coverage.find((entry) => entry.lineId === item.id);
    const status = statusOverrides[item.id]
      ?? (coverage?.status === 'covered' ? 'covered' : coverage?.status === 'pending' ? 'pending' : 'needed');
    lines.push({ id: item.id, number: lines.length + 1, status, spokenText: item.text, actionCues: [] });
  }
  return lines;
}

function cueFrom(item: { id: string; text: string; required?: boolean; confirmed?: boolean }): PrompterActionCue {
  return { id: item.id, text: item.text, required: item.required ?? false, resolved: item.confirmed ?? false };
}

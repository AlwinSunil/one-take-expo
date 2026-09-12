import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIN_LINE_FONT_SIZE,
  PROMPT_BUDGET_MS,
  actionCueLabel,
  coverageCellLabel,
  coverageSummaryText,
  decideRetakePrompt,
  evaluatePromptTiming,
  lineClamp,
  readableFontSize,
  stripCapacity,
  stripWindow,
} from '../src/lib/retake-prompts.ts';
import { createPrompterSession, prompterSessionIds } from '../src/development/prompter/prompter-sessions.ts';

function lines(...statuses) {
  return statuses.map((status, index) => ({ id: `line-${index + 1}`, number: index + 1, status }));
}

test('a needed verdict inside the pause budget asks for the line again', () => {
  const decision = decideRetakePrompt({
    lines: lines('covered', 'needed', 'covered'),
    lineEnds: [{ lineId: 'line-2', endedAt: 8000, nextStartsAt: 10500 }],
    verdicts: [{ lineId: 'line-2', status: 'needed', arrivedAt: 8900 }],
    now: 9000,
  });
  assert.deepEqual(decision, { kind: 'again', lineId: 'line-2', lineNumber: 2, text: 'Again, line 2' });
});

test('a verdict that misses the 1200 ms budget batches the line for after the take', () => {
  const decision = decideRetakePrompt({
    lines: lines('covered', 'needed', 'needed'),
    lineEnds: [{ lineId: 'line-2', endedAt: 8000, nextStartsAt: 12000 }],
    verdicts: [{ lineId: 'line-2', status: 'needed', arrivedAt: 8000 + PROMPT_BUDGET_MS + 1 }],
    now: 9500,
    takeEnded: true,
  });
  assert.deepEqual(decision, {
    kind: 'batched',
    lineIds: ['line-2', 'line-3'],
    lineNumbers: [2, 3],
    text: 'We will check lines 2, 3 after this take',
  });
});

test('a verdict that lands after the next line started never interrupts mid-line', () => {
  const decision = decideRetakePrompt({
    lines: lines('needed', 'covered'),
    lineEnds: [{ lineId: 'line-1', endedAt: 4000, nextStartsAt: 4400 }],
    verdicts: [{ lineId: 'line-1', status: 'needed', arrivedAt: 4600 }],
    now: 4700,
    takeEnded: true,
  });
  assert.equal(decision.kind, 'batched');
  assert.equal(decision.text, 'We will check line 1 after this take');
});

test('an in-budget verdict is still held back while the creator is speaking', () => {
  const input = {
    lines: lines('covered', 'needed'),
    lineEnds: [{ lineId: 'line-2', endedAt: 8000 }],
    verdicts: [{ lineId: 'line-2', status: 'needed', arrivedAt: 8500 }],
    now: 8600,
  };
  assert.equal(decideRetakePrompt({ ...input, midLine: true }).kind, 'deferred');
  assert.equal(decideRetakePrompt({ ...input, midLine: false }).kind, 'again');
});

test('a delayed engine forces batched mode even when the timing would fit', () => {
  const decision = decideRetakePrompt({
    lines: lines('covered', 'needed'),
    lineEnds: [{ lineId: 'line-2', endedAt: 8000, nextStartsAt: 11000 }],
    verdicts: [{ lineId: 'line-2', status: 'needed', arrivedAt: 8400 }],
    now: 8500,
    engineState: 'delayed',
    takeEnded: true,
  });
  assert.deepEqual(decision, {
    kind: 'batched',
    lineIds: ['line-2'],
    lineNumbers: [2],
    text: 'We will check line 2 after this take',
  });
});

test('covered and pending lines never produce a prompt', () => {
  assert.equal(decideRetakePrompt({
    lines: lines('covered', 'pending'),
    lineEnds: [{ lineId: 'line-1', endedAt: 4000 }],
    verdicts: [{ lineId: 'line-1', status: 'covered', arrivedAt: 4300 }],
    now: 4400,
  }), null);
});

test('an again prompt stops showing once its hold window has passed', () => {
  const input = {
    lines: lines('covered', 'needed'),
    lineEnds: [{ lineId: 'line-2', endedAt: 8000 }],
    verdicts: [{ lineId: 'line-2', status: 'needed', arrivedAt: 8400 }],
    holdMs: 3000,
  };
  assert.equal(decideRetakePrompt({ ...input, now: 11000 }).kind, 'again');
  assert.equal(decideRetakePrompt({ ...input, now: 11500 }).kind, 'deferred');
});

test('the most recent eligible pause wins when two verdicts are live', () => {
  const decision = decideRetakePrompt({
    lines: lines('needed', 'needed'),
    lineEnds: [{ lineId: 'line-1', endedAt: 4000 }, { lineId: 'line-2', endedAt: 8000 }],
    verdicts: [
      { lineId: 'line-1', status: 'needed', arrivedAt: 4500 },
      { lineId: 'line-2', status: 'needed', arrivedAt: 8500 },
    ],
    now: 8600,
  });
  assert.deepEqual(decision, { kind: 'again', lineId: 'line-2', lineNumber: 2, text: 'Again, line 2' });
});

test('every prompter sample session produces its documented decision', () => {
  assert.deepEqual([...prompterSessionIds], ['clean', 'flub', 'long-line', 'delayed-verdict', 'action']);

  const decisions = Object.fromEntries(prompterSessionIds.map((id) => {
    const session = createPrompterSession(id);
    return [id, decideRetakePrompt({ ...session, now: session.now })];
  }));

  assert.equal(decisions.clean, null);
  assert.deepEqual(decisions.flub, { kind: 'again', lineId: 'line-2', lineNumber: 2, text: 'Again, line 2' });
  assert.equal(decisions['long-line'].kind, 'again');
  assert.equal(decisions['long-line'].text, 'Again, line 2');
  assert.deepEqual(decisions['delayed-verdict'], {
    kind: 'deferred',
    lineIds: ['line-2'],
    lineNumbers: [2],
    count: 1,
    text: '1 line to check after this take',
  });
  const delayed = createPrompterSession('delayed-verdict');
  assert.deepEqual(decideRetakePrompt({ ...delayed, now: delayed.now, takeEnded: true }), {
    kind: 'batched',
    lineIds: ['line-2'],
    lineNumbers: [2],
    text: 'We will check line 2 after this take',
  });
  assert.equal(decisions.action, null);
});

test('the action sample keeps cues out of the spoken lines and unresolved until confirmed', () => {
  const session = createPrompterSession('action');
  const cues = session.lines.flatMap((line) => line.actionCues);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues.map((cue) => cue.required), [true, false]);
  assert.ok(cues.every((cue) => !cue.resolved));
  for (const line of session.lines) {
    for (const cue of line.actionCues) assert.ok(!line.spokenText.includes(cue.text));
  }
});

test('the long-line sample keeps one long spoken line the prompter must truncate', () => {
  const session = createPrompterSession('long-line');
  assert.ok(session.lines[1].spokenText.split(' ').length > 30);
});

test('the timing evaluator reports prompts shown before the next line', () => {
  const log = promptLog(20, 18);
  const report = evaluatePromptTiming(log);
  assert.equal(report.lineEnds, 20);
  assert.equal(report.eligible, 20);
  assert.equal(report.promptedBeforeNextLine, 18);
  assert.equal(report.mode, 'live');
  assert.equal(report.sampleComplete, true);
  assert.equal(report.meetsTarget, true);
  assert.equal(report.missed.length, 2);
  assert.deepEqual(report.missed.map((miss) => miss.reason), ['late-verdict', 'late-verdict']);
});

test('the timing evaluator fails the target at 17 of 20 and refuses small samples', () => {
  assert.equal(evaluatePromptTiming(promptLog(20, 17)).meetsTarget, false);
  const small = evaluatePromptTiming(promptLog(10, 10));
  assert.equal(small.sampleComplete, false);
  assert.equal(small.meetsTarget, false);
  assert.equal(small.ratio, 1);
});

test('a delayed engine reports batched mode and never meets the live target', () => {
  const report = evaluatePromptTiming({ ...promptLog(20, 20), engineState: 'delayed' });
  assert.equal(report.mode, 'batched');
  assert.equal(report.meetsTarget, false);
  assert.equal(report.promptedBeforeNextLine, 0);
  assert.deepEqual(new Set(report.missed.map((miss) => miss.reason)), new Set(['delayed-engine']));
});

test('covered line ends are counted separately from the ones needing a prompt', () => {
  const report = evaluatePromptTiming({
    lines: lines('covered', 'needed'),
    lineEnds: [
      { lineId: 'line-1', endedAt: 0, nextStartsAt: 3000 },
      { lineId: 'line-2', endedAt: 4000, nextStartsAt: 7000 },
    ],
    verdicts: [
      { lineId: 'line-1', status: 'covered', arrivedAt: 300 },
      { lineId: 'line-2', status: 'needed', arrivedAt: 4300 },
    ],
  });
  assert.equal(report.lineEnds, 2);
  assert.equal(report.eligible, 1);
  assert.equal(report.resolvedWithoutPrompt, 1);
  assert.equal(report.promptedBeforeNextLine, 1);
});

test('a line end with no verdict at all is reported as missed', () => {
  const report = evaluatePromptTiming({
    lines: lines('needed'),
    lineEnds: [{ lineId: 'line-1', endedAt: 0, nextStartsAt: 3000 }],
    verdicts: [],
  });
  assert.deepEqual(report.missed, [{ lineId: 'line-1', lineNumber: 1, reason: 'no-verdict' }]);
});

test('the evaluator reports the sample sessions without claiming device evidence', () => {
  const report = evaluatePromptTiming(createPrompterSession('flub'));
  assert.equal(report.eligible, 1);
  assert.equal(report.promptedBeforeNextLine, 1);
  assert.equal(report.sampleComplete, false);
  assert.equal(report.meetsTarget, false);
});

test('an unconfirmed line waits quietly during the take and is only listed after it', () => {
  const input = {
    lines: lines('needed', 'covered', 'needed'),
    lineEnds: [{ lineId: 'line-1', endedAt: 5000, nextStartsAt: 5400 }],
    verdicts: [{ lineId: 'line-1', status: 'needed', arrivedAt: 6000 }],
    now: 60000,
  };
  assert.deepEqual(decideRetakePrompt(input), {
    kind: 'deferred',
    lineIds: ['line-1', 'line-3'],
    lineNumbers: [1, 3],
    count: 2,
    text: '2 lines to check after this take',
  });
  assert.deepEqual(decideRetakePrompt({ ...input, takeEnded: true }), {
    kind: 'batched',
    lineIds: ['line-1', 'line-3'],
    lineNumbers: [1, 3],
    text: 'We will check lines 1, 3 after this take',
  });
});

test('the deferred count never names a line or asks for a retake mid-take', () => {
  const decision = decideRetakePrompt({
    lines: lines('covered', 'needed'),
    lineEnds: [{ lineId: 'line-2', endedAt: 8000 }],
    verdicts: [{ lineId: 'line-2', status: 'needed', arrivedAt: 20000 }],
    now: 30000,
  });
  assert.equal(decision.kind, 'deferred');
  assert.equal(decision.text, '1 line to check after this take');
  assert.ok(!decision.text.includes('line 2'));
  assert.ok(!decision.text.toLowerCase().includes('again'));
});

test('prompt numbers are the line numbers the strip shows, not array positions', () => {
  const scriptLines = [
    { id: 'l4', number: 4, status: 'covered' },
    { id: 'l5', number: 5, status: 'needed' },
    { id: 'l6', number: 6, status: 'needed' },
  ];
  const again = decideRetakePrompt({
    lines: scriptLines,
    lineEnds: [{ lineId: 'l5', endedAt: 8000, nextStartsAt: 11000 }],
    verdicts: [{ lineId: 'l5', status: 'needed', arrivedAt: 8500 }],
    now: 8600,
  });
  assert.deepEqual(again, { kind: 'again', lineId: 'l5', lineNumber: 5, text: 'Again, line 5' });

  const batched = decideRetakePrompt({ lines: scriptLines, now: 20000, takeEnded: true });
  assert.equal(batched.text, 'We will check lines 5, 6 after this take');

  const report = evaluatePromptTiming({
    lines: scriptLines,
    lineEnds: [{ lineId: 'l6', endedAt: 12000, nextStartsAt: 13000 }],
    verdicts: [],
  });
  assert.deepEqual(report.missed, [{ lineId: 'l6', lineNumber: 6, reason: 'no-verdict' }]);
});

test('a verdict that predates its own line end is never promptable', () => {
  const input = {
    lines: lines('covered', 'needed'),
    lineEnds: [{ lineId: 'line-2', endedAt: 8000, nextStartsAt: 11000 }],
    verdicts: [{ lineId: 'line-2', status: 'needed', arrivedAt: 7600 }],
    now: 8100,
  };
  assert.equal(decideRetakePrompt(input).kind, 'deferred');
  const report = evaluatePromptTiming({ lines: input.lines, lineEnds: input.lineEnds, verdicts: input.verdicts });
  assert.deepEqual(report.missed, [{ lineId: 'line-2', lineNumber: 2, reason: 'before-line-end' }]);
  assert.equal(report.promptedBeforeNextLine, 0);
});

test('coverage cells carry a label and a shape, never colour alone', () => {
  assert.equal(coverageCellLabel({ number: 2, status: 'needed', position: 'current' }),
    'Line 2, needs another read, current line');
  assert.equal(coverageCellLabel({ number: 3, status: 'pending', position: 'next' }),
    'Line 3, still being checked, next line');
  assert.equal(coverageCellLabel({ number: 1, status: 'covered' }), 'Line 1, covered');
});

test('the coverage summary counts every status in words', () => {
  assert.equal(coverageSummaryText(lines('covered', 'pending', 'needed', 'needed')),
    '1 of 4 lines covered, 1 checking, 2 to read again');
  assert.equal(coverageSummaryText(lines('covered', 'covered')), '2 of 2 lines covered');
  assert.equal(coverageSummaryText([]), 'No lines yet');
});

test('action cue labels say what to do and whether it is still open', () => {
  assert.equal(actionCueLabel({ id: 'c1', text: 'Hold up the product', required: true, resolved: false }, 2),
    'Action for line 2, hold up the product, required, not done yet');
  assert.equal(actionCueLabel({ id: 'c1', text: 'Smile', required: false, resolved: false }, 1),
    'Action for line 1, smile, optional');
  assert.equal(actionCueLabel({ id: 'c1', text: 'Smile', required: true, resolved: true }, 1),
    'Action for line 1, smile, required, marked done');
});

test('the current line never renders below 16 sp however small or scaled the screen is', () => {
  assert.equal(readableFontSize(28, { width: 320, fontScale: 2.4 }), MIN_LINE_FONT_SIZE);
  assert.equal(readableFontSize(28, { width: 390, fontScale: 1 }), 28);
  assert.ok(readableFontSize(28, { width: 320, fontScale: 1 }) < 28);
  assert.ok(readableFontSize(28, { width: 390, fontScale: 1.6 }) >= MIN_LINE_FONT_SIZE);
});

test('large system text shows fewer lines rather than clipping them', () => {
  assert.equal(lineClamp({ fontScale: 1 }), 4);
  assert.equal(lineClamp({ fontScale: 1.4 }), 3);
  assert.equal(lineClamp({ fontScale: 2 }), 2);
  assert.equal(lineClamp({ fontScale: 2, expanded: true }), 0);
  assert.equal(lineClamp({ fontScale: 1, compact: true }), 2);
});

test('the strip keeps the current line visible and reports what it hid', () => {
  assert.deepEqual(stripWindow(12, 8, 5), { start: 5, end: 10, hiddenBefore: 5, hiddenAfter: 2 });
  assert.deepEqual(stripWindow(3, 0, 5), { start: 0, end: 3, hiddenBefore: 0, hiddenAfter: 0 });
  assert.deepEqual(stripWindow(12, 0, 4), { start: 0, end: 4, hiddenBefore: 0, hiddenAfter: 8 });
  assert.deepEqual(stripWindow(12, 11, 4), { start: 8, end: 12, hiddenBefore: 8, hiddenAfter: 0 });
});

test('strip capacity shrinks on narrow screens and at large text', () => {
  assert.ok(stripCapacity(390, 1) > stripCapacity(320, 1));
  assert.ok(stripCapacity(390, 1) > stripCapacity(390, 2));
  assert.ok(stripCapacity(320, 2.5) >= 3);
});

function promptLog(count, promptedCount) {
  const lineList = [];
  const lineEnds = [];
  const verdicts = [];
  for (let index = 0; index < count; index += 1) {
    const lineId = `line-${index + 1}`;
    const endedAt = index * 5000;
    lineList.push({ id: lineId, number: index + 1, status: 'needed' });
    lineEnds.push({ lineId, endedAt, nextStartsAt: endedAt + 2500 });
    verdicts.push({ lineId, status: 'needed', arrivedAt: endedAt + (index < promptedCount ? 800 : 2000) });
  }
  return { lines: lineList, lineEnds, verdicts };
}

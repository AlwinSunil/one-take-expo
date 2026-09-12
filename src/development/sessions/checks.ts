import { summarizeSession, validateSession } from './contracts.ts';
import { createSample, sampleIds } from './samples.ts';

export function runSampleChecks(): { name: string; passed: boolean; error?: string }[] {
  const checks: { name: string; run: () => boolean }[] = sampleIds.map(id => ({
    name: `${id}: valid handoff`, run: () => validateSession(createSample(id)).length === 0,
  }));
  checks.push(
    { name: 'Two lines in one breath retain one audio segment', run: () => {
      const s = createSample('clean');
      return summarizeSession(s).covered === 2 && s.cut.length === 1 && s.cut[0].start === 0.5 && s.cut[0].end === 8.5;
    } },
    { name: 'Re-read excludes flagged audio and preserves its reason', run: () => {
      const s = createSample('reread');
      return s.takes.length === 2 && !!s.takes[0].reason && s.cut.every(c => c.takeId === 'take-2');
    } },
    { name: 'Pending verdict cannot declare safe to wrap', run: () => {
      const summary = summarizeSession(createSample('pending'));
      return summary.covered === 1 && summary.pending && !summary.safeToWrap;
    } },
    { name: 'Required action blocks wrap until manually confirmed', run: () => {
      const s = createSample('action-cue');
      if (summarizeSession(s).safeToWrap) return false;
      s.script = s.script.map(item => item.kind === 'action' && item.required ? { ...item, confirmed: true } : item);
      return summarizeSession(s).safeToWrap && summarizeSession(s).total === 2 && !s.speech.text.includes('product label');
    } },
    { name: 'Missing media preserves the ledger', run: () => {
      const s = createSample('missing-media');
      return s.media.status === 'missing' && s.takes.length === 1 && s.coverage.length === 2 && s.cut.length === 1;
    } },
    { name: 'Optional framing hint cannot reject clean speech', run: () => summarizeSession(createSample('off-frame')).safeToWrap },
    { name: 'Failed export preserves the original duration and cut', run: () => {
      const s = createSample('failure');
      return s.export.status === 'failed' && s.media.duration === 16 && s.cut[0].start === 0.5;
    } },
    { name: 'Fresh replay discards prior edits', run: () => {
      const s = createSample('clean'); s.script[0].text = 'Changed'; s.cut.length = 0;
      const fresh = createSample('clean');
      return fresh.script[0].text !== 'Changed' && fresh.cut.length === 1;
    } },
    { name: 'Dangling coverage is rejected and never counts as covered', run: () => {
      const s = createSample('clean'); s.coverage[0].takeId = 'absent';
      return validateSession(s).length > 0 && summarizeSession(s).covered === 1;
    } },
    { name: 'Action cues cannot be speech takes', run: () => {
      const s = createSample('action-cue'); s.takes[0].lineIds.push('action-1');
      return validateSession(s).length > 0;
    } },
    { name: 'Out-of-range and repeated audio cuts are rejected', run: () => {
      const s = createSample('clean'); s.cut.push({ ...s.cut[0] });
      const repeated = validateSession(s).length > 0;
      s.cut = [{ ...s.cut[0], end: 99 }];
      return repeated && validateSession(s).length > 0;
    } },
    { name: 'Empty and unavailable analysis never declare safe to wrap', run: () => {
      const s = createSample('clean'); s.speech.status = 'unavailable';
      const unavailable = !summarizeSession(s).safeToWrap;
      s.speech.status = 'ready'; s.script = []; s.coverage = [];
      return unavailable && !summarizeSession(s).safeToWrap;
    } },
  );
  return checks.map(check => {
    try { return { name: check.name, passed: check.run() }; }
    catch (error) { return { name: check.name, passed: false, error: String(error) }; }
  });
}

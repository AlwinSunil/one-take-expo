import type { SampleSession } from './contracts.ts';

export const sampleIds = ['clean', 'reread', 'pending', 'missing-media', 'action-cue', 'off-frame', 'failure'] as const;
export type SampleId = typeof sampleIds[number];

export function createSample(id: SampleId): SampleSession {
  const session: SampleSession = {
    id, title: 'Clean read', description: 'Two lines, one breath. Coverage is separate; the audio stays together.',
    script: [
      { id: 'line-1', kind: 'spoken', text: 'A good take starts with a clear idea.' },
      { id: 'line-2', kind: 'spoken', text: 'Say it simply, and make it yours.' },
    ],
    speech: { status: 'ready', text: 'A good take starts with a clear idea. Say it simply, and make it yours.' },
    takes: [{ id: 'take-1', lineIds: ['line-1', 'line-2'], start: 0.5, end: 8.5, verdict: 'clean' }],
    coverage: [
      { lineId: 'line-1', status: 'covered', takeId: 'take-1' },
      { lineId: 'line-2', status: 'covered', takeId: 'take-1' },
    ],
    camera: { status: 'stopped', vision: 'in-frame', processor: 'fixture' },
    media: { status: 'sample', duration: 16 },
    cut: [{ takeId: 'take-1', start: 0.5, end: 8.5 }],
    export: { status: 'not-started' },
  };
  switch (id) {
    case 'reread':
      session.title = 'Flub & re-read';
      session.description = 'The first attempt stays in the ledger. The clean re-read supplies both lines.';
      session.takes[0] = { ...session.takes[0], verdict: 'flagged', reason: 'The second line was incomplete.' };
      session.takes.push({ id: 'take-2', lineIds: ['line-1', 'line-2'], start: 9, end: 15.5, verdict: 'clean' });
      session.coverage = session.coverage.map(entry => ({ ...entry, takeId: 'take-2' }));
      session.cut = [{ takeId: 'take-2', start: 9, end: 15.5 }];
      break;
    case 'pending':
      session.title = 'Pending analysis';
      session.description = 'The second line is still being checked. Pending results never mean covered.';
      session.speech.status = 'pending';
      session.takes = [
        { id: 'take-1', lineIds: ['line-1'], start: 0.5, end: 4, verdict: 'clean' },
        { id: 'take-2', lineIds: ['line-2'], start: 5, end: 8.5, verdict: 'pending' },
      ];
      session.coverage[1] = { lineId: 'line-2', status: 'pending', takeId: 'take-2' };
      session.cut = [{ takeId: 'take-1', start: 0.5, end: 4 }];
      break;
    case 'missing-media':
      session.title = 'Missing recording';
      session.description = 'The project still has its script and take decisions, but the recording is unavailable.';
      session.media.status = 'missing';
      break;
    case 'action-cue':
      session.title = 'Action cue';
      session.description = 'Actions are separate from dialogue. Required actions need manual confirmation.';
      session.script.splice(1, 0, { id: 'action-1', kind: 'action', text: 'Show the product label', required: true, confirmed: false });
      session.script.push({ id: 'action-2', kind: 'action', text: 'Smile at the camera', required: false, confirmed: false });
      break;
    case 'off-frame':
      session.title = 'Off-frame signal';
      session.description = 'Framing is an optional review hint. It does not erase clean speech or block coverage.';
      session.camera.vision = 'off-frame';
      break;
    case 'failure':
      session.title = 'Export failure';
      session.description = 'An interrupted export keeps the original and cut decisions available for another attempt.';
      session.export = { status: 'failed', reason: 'There is not enough free space to finish the export.' };
      break;
  }
  return session;
}

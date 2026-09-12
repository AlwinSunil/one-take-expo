import type { Project } from './session';
import type { Tier1Evidence } from './t1-contracts';

/** Invented transcript and provider output. No media is implied by this fixture. */
export function createTier1ReviewFixture(): Project {
  const id = 't1-review-fixture';
  const evidence: Tier1Evidence = {
    version: 1, projectId: id, revision: 'fixture-v1', provider: 'fixture', status: 'pending',
    reasons: [{ id: 'reason-1', takeId: 'take:segment-1', message: 'Fixture: possible reread; listen before choosing.', status: 'uncertain', footage: { recordingId: id, t0: 0, t1: 3 } }],
    mustSay: [{ lineId: 'line-1', required: true, status: 'pending', evidence: [] }],
    scratchHistory: [], cleanup: [], firstTakeStartedAt: 1000, wrapRequestedAt: 46000,
  };
  return {
    id, mode: 'script', script: 'Our bottle stays cold.', duration: 6, createdAt: 1000,
    videoUri: null, mediaMissing: true, clips: [],
    scriptLines: [{ id: 'line-1', spokenText: 'Our bottle stays cold.', actionCues: [{ id: 'action-1', text: 'Show bottle', required: true, resolved: false }] }],
    transcript: [{ id: 'segment-1', t0: 0, t1: 3, text: 'Our battle stays cold.', isFinal: true, timingSource: 'saved-audio' }],
    tier1Evidence: evidence,
  };
}

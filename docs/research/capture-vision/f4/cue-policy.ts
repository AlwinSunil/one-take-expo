export type Cue = 'face-clipping' | 'product-clipping' | 'focus' | 'exposure' | 'horizon';
export interface CoachingInput {
  enabled: boolean;
  intentionalLook: boolean;
  recording: boolean;
  betweenLines: boolean;
  mode: 'single-person' | 'group' | 'product-only' | 'handheld';
  detector: 'ready' | 'pending' | 'unavailable';
  frameAgeMs: number;
  stableIssueMs: number;
  sinceLastPromptMs: number;
  candidates: Cue[];
  dismissed: Cue[];
}

const priority: Cue[] = ['face-clipping', 'product-clipping', 'focus', 'exposure', 'horizon'];
const wording: Record<Cue, string> = {
  'face-clipping': 'Give your face a little more room.',
  'product-clipping': 'Bring the product fully into view.',
  focus: 'Check focus on your subject.',
  exposure: 'Try facing the light.',
  horizon: 'Try leveling the phone.',
};

// Inputs are fixture observations, never a claim that these detectors exist or passed evaluation.
export function chooseCoachingCue(input: CoachingInput): { cue: Cue; text: string } | null {
  if (!input.enabled || input.intentionalLook || input.detector !== 'ready') return null;
  if (!Number.isFinite(input.frameAgeMs) || input.frameAgeMs < 0 || input.frameAgeMs > 500) return null;
  if (!Number.isFinite(input.stableIssueMs) || input.stableIssueMs < 1500) return null;
  if (!Number.isFinite(input.sinceLastPromptMs) || input.sinceLastPromptMs < 15000) return null;
  if (input.recording && !input.betweenLines) return null;
  // Without subject selection, advice for groups and moving cameras has no reliable target.
  if (input.mode === 'group' || input.mode === 'handheld') return null;
  const cue = priority.find(candidate => input.candidates.includes(candidate)
    && !input.dismissed.includes(candidate)
    && !(input.mode === 'product-only' && candidate === 'face-clipping'));
  return cue ? { cue, text: wording[cue] } : null;
}

export function runCoachingChecks(): { name: string; passed: boolean; error?: string }[] {
  const base: CoachingInput = { enabled: true, intentionalLook: false, recording: false,
    betweenLines: false, mode: 'single-person', detector: 'ready', frameAgeMs: 100,
    stableIssueMs: 1800, sinceLastPromptMs: 20000,
    candidates: ['exposure', 'face-clipping'], dismissed: [] };
  const pick = (change: Partial<CoachingInput>) => chooseCoachingCue({ ...base, ...change });
  const checks: { name: string; run: () => boolean }[] = [
    { name: 'Highest-priority actionable cue wins', run: () => pick({})?.cue === 'face-clipping' },
    { name: 'Intentional crop and blur suppress automatic advice', run: () => pick({ intentionalLook: true }) === null },
    { name: 'Groups need subject selection before advice', run: () => pick({ mode: 'group' }) === null },
    { name: 'Product-only shots never ask for a face', run: () => pick({ mode: 'product-only', candidates: ['face-clipping', 'product-clipping'] })?.cue === 'product-clipping' },
    { name: 'No face in product shot is normal', run: () => pick({ mode: 'product-only', candidates: ['face-clipping'] }) === null },
    { name: 'Pending and unavailable detector mean silence', run: () => pick({ detector: 'pending' }) === null && pick({ detector: 'unavailable' }) === null },
    { name: 'Stale and invalid frame timestamps suppress advice', run: () => [501, -1, NaN].every(frameAgeMs => pick({ frameAgeMs }) === null) },
    { name: 'Transient issue does not prompt', run: () => pick({ stableIssueMs: 1499 }) === null },
    { name: 'Prompt cooldown prevents repetition', run: () => pick({ sinceLastPromptMs: 14999 }) === null },
    { name: 'Recording waits for an explicit between-lines signal', run: () => pick({ recording: true }) === null && pick({ recording: true, betweenLines: true })?.cue === 'face-clipping' },
    { name: 'Disabled coaching clears advice immediately', run: () => pick({ enabled: false }) === null },
    { name: 'Dismissed cue remains muted for take', run: () => pick({ dismissed: ['face-clipping'] })?.cue === 'exposure' },
    { name: 'Handheld motion suppresses uncertain advice', run: () => pick({ mode: 'handheld', candidates: ['horizon', 'focus'] }) === null },
    { name: 'Recovery clears advice without a success badge', run: () => pick({ candidates: [] }) === null },
  ];
  return checks.map(check => {
    try { return { name: check.name, passed: check.run() }; }
    catch (error) { return { name: check.name, passed: false, error: String(error) }; }
  });
}

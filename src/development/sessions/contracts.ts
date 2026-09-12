// Proposed engine-neutral handoffs. Times are seconds relative to recording start.
export type ScriptItem =
  | { id: string; kind: 'spoken'; text: string }
  | { id: string; kind: 'action'; text: string; required: boolean; confirmed: boolean };

export interface Take {
  id: string;
  lineIds: string[];
  start: number;
  end: number;
  verdict: 'clean' | 'flagged' | 'pending';
  reason?: string;
}

export interface SampleSession {
  id: string;
  title: string;
  description: string;
  script: ScriptItem[];
  speech: { status: 'ready' | 'pending' | 'unavailable'; text: string };
  takes: Take[];
  coverage: { lineId: string; status: 'covered' | 'missing' | 'pending'; takeId?: string }[];
  camera: { status: 'stopped'; vision: 'in-frame' | 'off-frame' | 'unavailable'; processor: 'fixture' };
  media: { status: 'sample' | 'missing'; duration: number };
  // Each segment is an explicitly supplied safe audio boundary, never an ASR word boundary.
  cut: { takeId: string; start: number; end: number }[];
  export: { status: 'not-started' | 'failed'; reason?: string };
}

export function summarizeSession(session: SampleSession) {
  const lines = session.script.filter(item => item.kind === 'spoken');
  const covered = lines.filter(line => session.coverage.some(entry =>
    entry.lineId === line.id && entry.status === 'covered' && session.takes.some(take =>
      take.id === entry.takeId && take.verdict === 'clean' && take.lineIds.includes(line.id)
    )
  )).length;
  const outstandingActions = session.script.filter(item =>
    item.kind === 'action' && item.required && !item.confirmed
  ).length;
  const pending = session.speech.status === 'pending' || session.coverage.some(entry => entry.status === 'pending');
  return {
    covered,
    total: lines.length,
    outstandingActions,
    pending,
    safeToWrap: lines.length > 0 && covered === lines.length && outstandingActions === 0 && session.speech.status === 'ready' && !pending,
  };
}

export function validateSession(session: SampleSession): string[] {
  const errors: string[] = [];
  const lineIds = session.script.filter(item => item.kind === 'spoken').map(item => item.id);
  if (new Set(session.script.map(item => item.id)).size !== session.script.length) errors.push('Duplicate script ID');
  if (new Set(session.takes.map(take => take.id)).size !== session.takes.length) errors.push('Duplicate take ID');
  if (!Number.isFinite(session.media.duration) || session.media.duration <= 0) errors.push('Invalid duration');
  for (const take of session.takes) {
    if (!take.lineIds.length || take.lineIds.some(id => !lineIds.includes(id))) errors.push('Take references a non-spoken or missing line');
    if (!Number.isFinite(take.start) || !Number.isFinite(take.end) || take.start < 0 || take.end <= take.start || take.end > session.media.duration) errors.push('Invalid take interval');
  }
  for (const line of lineIds) {
    if (session.coverage.filter(entry => entry.lineId === line).length !== 1) errors.push('Each spoken line needs one coverage entry');
  }
  for (const entry of session.coverage) {
    if (!lineIds.includes(entry.lineId)) errors.push('Coverage references a non-spoken or missing line');
    if (entry.status === 'covered' && !session.takes.some(take => take.id === entry.takeId && take.verdict === 'clean' && take.lineIds.includes(entry.lineId))) errors.push('Covered line has no clean take');
  }
  for (const segment of session.cut) {
    const take = session.takes.find(item => item.id === segment.takeId);
    if (!take || take.verdict !== 'clean' || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < take.start || segment.end > take.end || segment.start >= segment.end) errors.push('Cut has no valid clean source interval');
  }
  for (let i = 1; i < session.cut.length; i++) {
    if (session.cut.slice(0, i).some(previous => session.cut[i].start < previous.end && session.cut[i].end > previous.start)) errors.push('Cut repeats source audio');
  }
  return errors;
}

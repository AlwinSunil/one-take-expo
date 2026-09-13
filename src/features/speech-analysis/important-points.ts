import type { ScriptDocument } from '../../lib/script-lines.ts';
import { matchEnglish } from './alignment.ts';
import { sameAnalysisScope, type AnalysisScope, type ImportantPoint, type PickupRequest, type PointMatch, type ScriptSpan, type SpeechObservation } from './contracts.ts';

/** Transparent extractive baseline: suggest each complete spoken line, never invent text. */
export function suggestImportantPoints(doc: ScriptDocument, scriptRevision: string, previous: readonly ImportantPoint[] = []): ImportantPoint[] {
  const points = previous.map(point => ({ ...point, span: { ...point.span } }));
  for (const [order, line] of doc.lines.entries()) {
    if (!line.spokenText.trim()) continue;
    const span: ScriptSpan = { id: `${line.id}:spoken`, lineId: line.id, scriptRevision, start: 0, end: line.spokenText.length, text: line.spokenText, order };
    const existing = points.filter(point => point.span.lineId === line.id);
    if (existing.length) {
      for (const point of existing) {
        // A revision change never silently reattaches creator intent to new text.
        if (point.span.text !== line.spokenText.slice(point.span.start, point.span.end) || point.span.scriptRevision !== scriptRevision) point.state = 'pending';
      }
      continue;
    }
    const complete = /[.!?]$/.test(line.spokenText.trim()) && line.wordCount >= 3;
    points.push({ id: `point:${line.id}`, revision: 1, span, text: line.spokenText,
      reason: complete ? 'A complete spoken script line; review whether this idea matters.' : 'A short or unfinished line; select manually if important.',
      importance: complete ? 'important' : 'optional', origin: 'baseline', creatorEdited: false, removed: false, state: complete ? 'available' : 'unknown' });
  }
  const present = new Set(doc.lines.map(line => line.id));
  for (const point of points) if (!present.has(point.span.lineId)) point.state = 'unavailable';
  return points;
}

export function editImportantPoint(points: readonly ImportantPoint[], id: string, patch: Partial<Pick<ImportantPoint, 'text' | 'importance' | 'removed'>>): ImportantPoint[] {
  if (!points.some(point => point.id === id)) throw new Error('Unknown important point');
  return points.map(point => point.id === id ? { ...point, ...patch, revision: point.revision + 1, creatorEdited: true } : point);
}

/** Manual selection uses actual script offsets and a caller-minted durable point id. */
export function addImportantPoint(points: readonly ImportantPoint[], id: string, span: ScriptSpan): ImportantPoint[] {
  if (!id.trim() || points.some(point => point.id === id)) throw new Error('Unique point id required');
  validateSpan(span);
  return [...points, { id, revision: 1, span: { ...span }, text: span.text, reason: 'Selected by the creator from the script.', importance: 'important', origin: 'creator', creatorEdited: true, removed: false, state: 'available' }];
}

/** Explicitly confirm a changed script attachment; old evidence remains revision-addressable. */
export function reattachImportantPoint(points: readonly ImportantPoint[], id: string, span: ScriptSpan): ImportantPoint[] {
  validateSpan(span);
  if (!points.some(point => point.id === id)) throw new Error('Unknown important point');
  return points.map(point => point.id === id ? { ...point, span: { ...span }, revision: point.revision + 1, state: 'available', creatorEdited: true } : point);
}

export function matchImportantPoints(points: readonly ImportantPoint[], observations: readonly SpeechObservation[], scope: AnalysisScope, availability: 'available' | 'pending' | 'unavailable' | 'unknown' = observations.length ? 'available' : 'unknown'): PointMatch[] {
  return points.filter(point => !point.removed).map(point => {
    const base = { scope: { ...scope }, pointId: point.id, pointRevision: point.revision, scriptRevision: point.span.scriptRevision, observationIds: [] as string[] };
    if (point.span.scriptRevision !== scope.scriptRevision || point.state === 'pending' || point.state === 'unavailable') return { ...base, state: 'pending', verdict: 'missing', reason: 'Script attachment needs creator review.' };
    if (availability !== 'available') return { ...base, state: availability, verdict: 'missing', reason: 'Speech analysis is not available yet.' };
    const scoped = observations.filter(item => item.sourceId === scope.sourceId);
    if (new Set(scoped.map(item => item.id)).size !== scoped.length) return { ...base, state: 'pending', verdict: 'missing', reason: 'Resolve duplicate utterance revisions before matching points.' };
    const candidates = observations.filter(item => item.sourceId === scope.sourceId && Number.isFinite(item.t0) && Number.isFinite(item.t1) && item.t0 >= 0 && item.t1 > item.t0);
    // Match adjacent whole-line context as well as single points without splitting the utterance.
    const ordered = points.filter(p => !p.removed && p.state !== 'pending' && p.state !== 'unavailable' && p.span.scriptRevision === scope.scriptRevision).slice().sort((a, b) => a.span.order - b.span.order);
    const contexts: ImportantPoint[][] = [[point]];
    const index = ordered.findIndex(p => p.id === point.id);
    for (let start = Math.max(0, index - 3); start <= index; start++) {
      for (let end = index + 1; end <= Math.min(ordered.length, start + 4); end++) {
        const group = ordered.slice(start, end);
        if (group.length > 1 && group.every((p, i) => i === 0 || p.span.order === group[i - 1].span.order + 1)) contexts.push(group);
      }
    }
    let partial: SpeechObservation | undefined;
    for (const item of candidates) {
      const matches = contexts.map(group => matchEnglish(group.map(p => p.text).join(' '), item.text));
      const matchedGroups = contexts.filter((_, index) => matches[index].verdict === 'matched');
      const ambiguousSingle = matchedGroups.length > 0 && matchedGroups.every(group => group.length === 1)
        && ordered.some(other => other.id !== point.id && matchEnglish(other.text, item.text).verdict === 'matched');
      if (ambiguousSingle) { partial ??= item; continue; }
      if (matches.some(m => m.verdict === 'matched')) {
        if (item.isFinal && !item.uncertain) return { ...base, observationIds: [item.id], state: 'available', verdict: 'covered', reason: 'Final speech matches the captured idea; this is not a must-say or action verdict.' };
        partial = item;
      } else if (matches.some(m => m.verdict === 'partial')) partial ??= item;
    }
    return partial ? { ...base, observationIds: [partial.id], state: partial.isFinal ? 'available' : 'provisional', verdict: 'partial', reason: 'Only partial or uncertain evidence supports this point.' }
      : { ...base, state: 'available', verdict: 'missing', reason: 'No supported complete match was observed.' };
  });
}

export interface MissingPointPickupInput {
  id: string;
  scope: AnalysisScope;
  points: readonly ImportantPoint[];
  matches: readonly PointMatch[];
  selectedPointIds?: readonly string[];
  context: readonly ScriptSpan[];
  unresolvedActionIds?: readonly string[];
  /** Required to reuse coverage from a different source's transcript snapshot. */
  currentTranscriptRevisions?: Readonly<Record<string, string>>;
}

export function createMissingPointPickup(input: MissingPointPickupInput): PickupRequest {
  if (!input.id.trim()) throw new Error('Pickup request identity is required');
  if (input.context.some(span => span.scriptRevision !== input.scope.scriptRevision)) throw new Error('Pickup context belongs to a stale script revision');
  const selected = input.selectedPointIds && new Set(input.selectedPointIds);
  const points = input.points.filter(point => !point.removed && point.importance === 'important' && (!selected || selected.has(point.id)) && !input.matches.some(match => (match.scope.sourceId === input.scope.sourceId ? match.scope.transcriptRevision === input.scope.transcriptRevision : input.currentTranscriptRevisions?.[match.scope.sourceId] !== undefined && match.scope.transcriptRevision === input.currentTranscriptRevisions[match.scope.sourceId]) && match.scope.projectId === input.scope.projectId && match.scope.scriptRevision === input.scope.scriptRevision && match.scope.editRevision === input.scope.editRevision && match.pointId === point.id && match.pointRevision === point.revision && match.scriptRevision === input.scope.scriptRevision && match.state === 'available' && match.verdict === 'covered'));
  if (points.some(point => !point.text.trim() || point.span.scriptRevision !== input.scope.scriptRevision || point.state === 'pending' || point.state === 'unavailable')) throw new Error('Review stale points before recording pickups');
  return { id: input.id, scope: { ...input.scope }, pointIds: points.map(point => point.id), lineIds: [...new Set(points.map(point => point.span.lineId))], points: points.map(point => ({ ...point, span: { ...point.span } })), context: input.context.map(span => ({ ...span })), unresolvedActionIds: [...(input.unresolvedActionIds ?? [])] };
}

export interface PickupInsertionIntent {
  requestId: string;
  scope: AnalysisScope;
  state: 'available' | 'pending';
  conflicts: string[];
  insertions: Array<{ id: string; sourceId: string; takeId: string; observationId: string; pointIds: string[]; lineIds: string[]; scriptOrder: number; t0: number; t1: number; provenance: SpeechObservation['provenance']; uncertaintySeconds: number | null; verifiedBoundary: boolean }>;
}

/** Describes desired order only. The timeline owner resolves existing edits and applies nothing automatically. */
export interface PickupInsertionInput {
  request: PickupRequest;
  currentScope: AnalysisScope;
  pickupSourceId: string;
  observations: readonly SpeechObservation[];
  matches: readonly PointMatch[];
  changedTargetPointIds?: readonly string[];
  currentPointRevisions?: Readonly<Record<string, number>>;
  /** Must match the pickup match's captured transcript revision, including absence. */
  pickupTranscriptRevision?: string;
}

export function proposePickupInsertion(input: PickupInsertionInput): PickupInsertionIntent {
  const { request } = input;
  const conflicts: string[] = [];
  if (!sameAnalysisScope(request.scope, input.currentScope)) conflicts.push('Script or edit revision changed; resolve against current timeline.');
  const insertions: PickupInsertionIntent['insertions'] = [];
  const byUtterance = new Map<string, ImportantPoint[]>();
  for (const point of request.points) {
    if (input.currentPointRevisions && input.currentPointRevisions[point.id] !== point.revision) { conflicts.push(`Point ${point.id} was edited or removed after the pickup request.`); continue; }
    const match = input.matches.find(m => m.scope.transcriptRevision === input.pickupTranscriptRevision && m.scope.sourceId === input.pickupSourceId && m.scope.projectId === request.scope.projectId && m.scope.scriptRevision === request.scope.scriptRevision && m.scope.editRevision === request.scope.editRevision && m.pointId === point.id && m.pointRevision === point.revision && m.scriptRevision === request.scope.scriptRevision && m.verdict === 'covered' && m.state === 'available');
    if (!match) { conflicts.push(`No current final pickup match for ${point.id}.`); continue; }
    if (input.changedTargetPointIds?.includes(point.id)) conflicts.push(`Creator changed target ${point.id}.`);
    if (match.observationIds.length !== 1) { conflicts.push(`Point ${point.id} has no single whole-utterance boundary.`); continue; }
    const id = match.observationIds[0];
    byUtterance.set(id, [...(byUtterance.get(id) ?? []), point]);
  }
  for (const [id, points] of byUtterance) {
    const matchingObservations = input.observations.filter(o => o.id === id && o.sourceId === input.pickupSourceId);
    if (matchingObservations.length > 1) { conflicts.push(`Resolve duplicate utterance revisions for ${id}.`); continue; }
    const observation = matchingObservations[0];
    if (!observation || !observation.isFinal || observation.uncertain || !Number.isFinite(observation.t0) || !Number.isFinite(observation.t1) || observation.t0 < 0 || observation.t1 <= observation.t0) { conflicts.push(`Unavailable pickup utterance ${id}.`); continue; }
    const otherCovered = input.matches.filter(match => match.scope.sourceId === input.pickupSourceId && match.scope.projectId === request.scope.projectId && match.state === 'available' && match.verdict === 'covered' && match.observationIds.includes(id) && !points.some(point => point.id === match.pointId));
    if (otherCovered.length) conflicts.push(`Utterance ${id} also covers points outside this pickup slot; preserve whole audio and review overlap.`);
    points.sort((a, b) => a.span.order - b.span.order);
    if (points.some((point, index) => index > 0 && point.span.order !== points[index - 1].span.order + 1)) conflicts.push(`Nonadjacent points share utterance ${id}; boundary review or another pickup required.`);
    if (!observation.verifiedBoundary || !['independent-silence', 'manual-review'].includes(observation.provenance)) conflicts.push(`Verify whole-utterance boundaries for ${id}.`);
    insertions.push({ id: `${request.id}:${id}`, sourceId: observation.sourceId, takeId: observation.takeId, observationId: id, pointIds: points.map(p => p.id), lineIds: [...new Set(points.map(p => p.span.lineId))], scriptOrder: points[0].span.order, t0: observation.t0, t1: observation.t1, provenance: observation.provenance, uncertaintySeconds: observation.uncertaintySeconds, verifiedBoundary: observation.verifiedBoundary });
  }
  for (let left = 0; left < insertions.length; left++) {
    for (let right = left + 1; right < insertions.length; right++) {
      const a = insertions[left], b = insertions[right];
      if (a.sourceId === b.sourceId && a.t0 < b.t1 && b.t0 < a.t1) conflicts.push(`Pickup utterances ${a.observationId} and ${b.observationId} overlap; review boundaries before insertion.`);
    }
  }
  return { requestId: request.id, scope: { ...request.scope }, state: conflicts.length ? 'pending' : 'available', conflicts, insertions: insertions.sort((a, b) => a.scriptOrder - b.scriptOrder) };
}

function validateSpan(span: ScriptSpan): void {
  if (!span.id.trim() || !span.lineId.trim() || !span.scriptRevision.trim()
    || !span.text.trim() || !Number.isInteger(span.start) || span.start < 0
    || !Number.isInteger(span.end) || span.end - span.start !== span.text.length
    || !Number.isInteger(span.order) || span.order < 0) {
    throw new Error('Valid captured script span required');
  }
}

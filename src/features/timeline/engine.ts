/** Pure runtime timeline commands. A owns serialization, durable schemas and storage. */
export type TimelineClip = {
  id: string; sourceId: string; t0: number; t1: number; included: boolean;
  reasonIds: string[]; spanIds: string[]; pointIds: string[]; utteranceIds: string[];
  takeId?: string; parentClipId?: string;
};
export type TimelineReason = { id: string; kind: string; text: string; actor: 'creator' | 'analysis' };
export type TimelineSnapshot = { revision: number; clips: TimelineClip[] };
export type TimelineCommand = {
  id: string; kind: string; baseRevision: number; revision: number;
  before: TimelineClip[]; after: TimelineClip[]; reasonIds: string[];
  metadata?: TimelineCommandMetadata;
};
export type TimelineHistory = { entries: TimelineCommand[]; cursor: number; abandonedEntries: TimelineCommand[] };
export type TimelineState = { snapshot: TimelineSnapshot; history: TimelineHistory; reasons: TimelineReason[] };
export type TimelineSource = { id: string; uri: string; duration: number | null; available: boolean };
export type TimelineSources = Readonly<Record<string, TimelineSource>>;
export type TimelineSegment = { clipId: string; sourceId: string; uri: string; t0: number; t1: number; outputT0: number; outputT1: number; takeId?: string };
export type TimelineIssue = { clipId: string; code: string; message: string; recovery: string };
export type ResolvedTimeline = { revision: number; segments: TimelineSegment[]; duration: number; issues: TimelineIssue[] };
export type TimelineAction = { id: string; baseRevision: number; reasons?: TimelineReason[]; metadata?: TimelineCommandMetadata } & (
  | { kind: 'trim'; clipId: string; t0: number; t1: number }
  | { kind: 'split'; clipId: string; at: number; leftId: string; rightId: string }
  | { kind: 'exclude' | 'restore'; clipId: string }
  | { kind: 'reorder'; clipId: string; index: number }
  | { kind: 'accept-proposal' | 'accept-pickup' | 'choose-take'; clips: TimelineClip[] }
);
export type TimelinePlayhead = { clipId: string; sourceId: string; sourceTime: number; outputTime: number };

export type TimelineMetadataValue = string | number | boolean | null | TimelineMetadataValue[] | { [key: string]: TimelineMetadataValue };
export type TimelineCommandMetadata = { [key: string]: TimelineMetadataValue };

const finite = (n: number) => Number.isFinite(n);
const validId = (id: unknown): id is string => typeof id === 'string' && !!id.trim();
const copyClip = (clip: TimelineClip): TimelineClip => ({ ...clip, reasonIds: [...clip.reasonIds], spanIds: [...clip.spanIds], pointIds: [...clip.pointIds], utteranceIds: [...clip.utteranceIds] });
const copyClips = (clips: readonly TimelineClip[]) => clips.map(copyClip);
const COMMAND_KINDS = new Set(['trim', 'split', 'exclude', 'restore', 'reorder', 'accept-proposal', 'accept-pickup', 'choose-take']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function copyMetadata(value: TimelineMetadataValue): TimelineMetadataValue {
  if (Array.isArray(value)) return value.map(copyMetadata);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyMetadata(item as TimelineMetadataValue)]));
  return value;
}

function assertMetadataValue(value: unknown): asserts value is TimelineMetadataValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (finite(value)) return;
    throw new Error('Timeline command metadata is invalid. Reopen the saved project.');
  }
  if (Array.isArray(value)) {
    value.forEach(assertMetadataValue);
    return;
  }
  if (!isRecord(value)) throw new Error('Timeline command metadata is invalid. Reopen the saved project.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Timeline command metadata is invalid. Reopen the saved project.');
  Object.values(value).forEach(assertMetadataValue);
}

function assertMetadata(metadata: unknown) {
  if (metadata === undefined) return;
  assertMetadataValue(metadata);
  if (!isRecord(metadata) || Array.isArray(metadata)) throw new Error('Timeline command metadata is invalid. Reopen the saved project.');
}

function copyCommand(command: TimelineCommand): TimelineCommand {
  return {
    ...command,
    before: copyClips(command.before),
    after: copyClips(command.after),
    reasonIds: [...command.reasonIds],
    ...(command.metadata === undefined ? {} : { metadata: copyMetadata(command.metadata) as TimelineCommandMetadata }),
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function assertRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new Error('Timeline revision is invalid. Reopen the saved project.');
}
function assertClipIdentity(clip: TimelineClip) {
  if (!isRecord(clip) || !validId(clip.id) || !validId(clip.sourceId) || typeof clip.t0 !== 'number' || !finite(clip.t0)
    || typeof clip.t1 !== 'number' || !finite(clip.t1) || typeof clip.included !== 'boolean'
    || ![clip.reasonIds, clip.spanIds, clip.pointIds, clip.utteranceIds].every(ids => Array.isArray(ids) && ids.every(validId) && new Set(ids).size === ids.length)) {
    throw new Error('Clip identity is invalid. Reopen the saved project.');
  }
  if ((clip.takeId !== undefined && !validId(clip.takeId)) || (clip.parentClipId !== undefined && !validId(clip.parentClipId))) {
    throw new Error('Clip identity is invalid. Reopen the saved project.');
  }
}
function assertReason(reason: TimelineReason) {
  if (!isRecord(reason) || !validId(reason.id) || !validId(reason.kind) || !validId(reason.text)
    || (reason.actor !== 'creator' && reason.actor !== 'analysis')) throw new Error('Timeline reasons are invalid. Reopen the saved project.');
}
function sameStrings(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function sameReason(a: TimelineReason, b: TimelineReason) {
  return a.id === b.id && a.kind === b.kind && a.text === b.text && a.actor === b.actor;
}
function sameClip(a: TimelineClip, b: TimelineClip) {
  return a.id === b.id && a.sourceId === b.sourceId && a.t0 === b.t0 && a.t1 === b.t1 && a.included === b.included
    && sameStrings(a.reasonIds, b.reasonIds) && sameStrings(a.spanIds, b.spanIds) && sameStrings(a.pointIds, b.pointIds)
    && sameStrings(a.utteranceIds, b.utteranceIds) && a.takeId === b.takeId && a.parentClipId === b.parentClipId;
}
function sameClips(a: readonly TimelineClip[], b: readonly TimelineClip[]) {
  return a.length === b.length && a.every((clip, index) => sameClip(clip, b[index]));
}
function intervalsOverlap(a: TimelineClip, b: TimelineClip) {
  return a.t0 < b.t1 && b.t0 < a.t1;
}
function creatorExcluded(clip: TimelineClip, reasons: readonly TimelineReason[]) {
  const byId = new Map(reasons.map(reason => [reason.id, reason]));
  return clip.reasonIds.some(id => {
    const reason = byId.get(id);
    return reason?.actor === 'creator' && reason.kind === 'exclude';
  });
}
function assertClipSnapshot(clips: unknown, knownReasons: ReadonlySet<string>) {
  if (!Array.isArray(clips)) throw new Error('Timeline history snapshot is invalid. Reopen the saved project.');
  const ids = new Set<string>();
  for (const rawClip of clips) {
    const clip = rawClip as TimelineClip;
    assertClipIdentity(clip);
    if (ids.has(clip.id)) throw new Error('Historical clip IDs must be unique within each snapshot. Reopen the saved project.');
    ids.add(clip.id);
    if (clip.reasonIds.some(id => !knownReasons.has(id))) throw new Error('A timeline history exclusion reason is missing. Reopen the saved project.');
  }
}
function assertCommand(command: TimelineCommand, knownReasons: ReadonlySet<string>, currentRevision: number) {
  if (!isRecord(command) || !validId(command.id) || typeof command.kind !== 'string' || !COMMAND_KINDS.has(command.kind)) {
    throw new Error('Timeline history command identity is invalid. Reopen the saved project.');
  }
  assertRevision(command.baseRevision);
  assertRevision(command.revision);
  if (command.revision !== command.baseRevision + 1) throw new Error('Timeline history command revision is invalid. Reopen the saved project.');
  if (command.revision > currentRevision) throw new Error('Timeline history is ahead of the current timeline. Reopen the saved project.');
  assertClipSnapshot(command.before, knownReasons);
  assertClipSnapshot(command.after, knownReasons);
  if (!Array.isArray(command.reasonIds) || new Set(command.reasonIds).size !== command.reasonIds.length || !command.reasonIds.every(validId)
    || command.reasonIds.some(id => !knownReasons.has(id))) throw new Error('Timeline history reason references are invalid. Reopen the saved project.');
  assertMetadata(command.metadata);
}
function rangeIssue(clip: TimelineClip, sources: TimelineSources): TimelineIssue | null {
  const source = sources[clip.sourceId];
  const issue = (code: string, message: string, recovery: string) => ({ clipId: clip.id, code, message, recovery });
  if (!source || source.id !== clip.sourceId || !source.available || !validId(source.uri)) return issue('unavailable', 'This source is unavailable.', 'Reopen to refresh media, choose another take, or exclude this clip.');
  if (source.duration === null || !finite(source.duration) || source.duration <= 0) return issue('unknown-duration', 'Source duration is unavailable.', 'Reopen to probe the original, or exclude this clip.');
  if (!finite(clip.t0) || !finite(clip.t1) || clip.t0 < 0 || clip.t1 <= clip.t0 || clip.t1 > source.duration) return issue('invalid-range', 'Clip bounds must be inside the source and have positive duration.', 'Adjust trim bounds, Undo, or exclude this clip.');
  return null;
}
function assertRange(clip: TimelineClip, sources: TimelineSources) {
  const issue = rangeIssue(clip, sources);
  if (issue) throw new Error(`${issue.message} ${issue.recovery}`);
}

/** Included invalid rows block consumption via issues; consumers must check before playing/exporting. */
export function resolveTimeline(snapshot: TimelineSnapshot, sources: TimelineSources): ResolvedTimeline {
  const segments: TimelineSegment[] = [], issues: TimelineIssue[] = [];
  let duration = 0;
  const ids = new Set<string>();
  try { assertRevision(snapshot.revision); } catch (e) { issues.push({ clipId: '', code: 'invalid-revision', message: String(e), recovery: 'Reopen the saved project.' }); }
  for (const clip of snapshot.clips) {
    try { assertClipIdentity(clip); } catch (e) { issues.push({ clipId: clip.id, code: 'invalid-identity', message: String(e), recovery: 'Reopen the saved project.' }); continue; }
    if (ids.has(clip.id)) { issues.push({ clipId: clip.id, code: 'duplicate-id', message: 'A clip identity appears twice.', recovery: 'Undo or reopen the saved project.' }); continue; }
    ids.add(clip.id);
    if (!clip.included) continue;
    const issue = rangeIssue(clip, sources);
    if (issue) { issues.push(issue); continue; }
    const outputT1 = duration + clip.t1 - clip.t0;
    if (!finite(outputT1)) { issues.push({ clipId: clip.id, code: 'invalid-duration', message: 'Output duration is invalid.', recovery: 'Undo or reopen the saved project.' }); continue; }
    segments.push({ clipId: clip.id, sourceId: clip.sourceId, uri: sources[clip.sourceId].uri, t0: clip.t0, t1: clip.t1, outputT0: duration, outputT1, ...(clip.takeId ? { takeId: clip.takeId } : {}) });
    duration = outputT1;
  }
  return freeze({ revision: snapshot.revision, segments, duration, issues });
}

export function createTimelineState(snapshot: TimelineSnapshot, reasons: TimelineReason[] = [], history: TimelineHistory = { entries: [], cursor: 0, abandonedEntries: [] }): TimelineState {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.clips)) throw new Error('Timeline snapshot is invalid. Reopen the saved project.');
  assertRevision(snapshot.revision);
  if (!Array.isArray(reasons)) throw new Error('Timeline reasons are invalid. Reopen the saved project.');
  reasons.forEach(assertReason);
  if (new Set(reasons.map(reason => reason.id)).size !== reasons.length) throw new Error('Timeline reasons are invalid. Reopen the saved project.');
  const knownReasons = new Set(reasons.map(reason => reason.id));
  assertClipSnapshot(snapshot.clips, knownReasons);
  if (!isRecord(history) || !Array.isArray(history.entries) || !Array.isArray(history.abandonedEntries)
    || !Number.isSafeInteger(history.cursor) || history.cursor < 0 || history.cursor > history.entries.length) {
    throw new Error('History cursor is invalid. Reopen the saved project.');
  }
  const commands = [...history.entries, ...history.abandonedEntries];
  const validateSequence = (sequence: TimelineCommand[]) => {
    let previousRevision = -1;
    for (const command of sequence) {
      assertCommand(command, knownReasons, snapshot.revision);
      if (command.revision <= previousRevision) throw new Error('Timeline history revisions are not monotonic. Reopen the saved project.');
      previousRevision = command.revision;
    }
  };
  validateSequence(history.entries);
  for (const command of history.abandonedEntries) assertCommand(command, knownReasons, snapshot.revision);
  if (history.entries.length) {
    const atCursor = history.cursor ? history.entries[history.cursor - 1].after : history.entries[0].before;
    if (!sameClips(snapshot.clips, atCursor)) throw new Error('History does not match the current timeline. Reopen the saved project.');
    for (let i = 1; i < history.entries.length; i++) if (!sameClips(history.entries[i - 1].after, history.entries[i].before)) throw new Error('History branch is disconnected. Reopen the saved project.');
  }
  if (new Set(commands.map(command => command.id)).size !== commands.length) throw new Error('History command IDs must be unique.');
  if (snapshot.clips.some(clip => clip.reasonIds.some(id => !knownReasons.has(id)))) throw new Error('A timeline exclusion reason is missing. Reopen the saved project.');
  return freeze({ snapshot: { revision: snapshot.revision, clips: copyClips(snapshot.clips) }, reasons: reasons.map(reason => ({ ...reason })),
    history: { entries: history.entries.map(copyCommand), cursor: history.cursor, abandonedEntries: history.abandonedEntries.map(copyCommand) } });
}

/** Creator-only commands. Proposals must pass their own scope/conflict review before this call. */
export function applyTimelineAction(state: TimelineState, action: TimelineAction, sources: TimelineSources): TimelineState {
  assertRevision(state.snapshot.revision);
  assertRevision(action.baseRevision);
  if (action.baseRevision !== state.snapshot.revision) throw new Error('This edit is stale. Review the current timeline and retry.');
  if (typeof action.kind !== 'string' || !COMMAND_KINDS.has(action.kind)) throw new Error('This timeline command kind is invalid. Review the current timeline and retry.');
  const allCommands = [...state.history.entries, ...state.history.abandonedEntries];
  if (!validId(action.id) || allCommands.some(command => command.id === action.id)) throw new Error('Use a new command identity for this edit.');
  assertMetadata(action.metadata);
  if (action.reasons !== undefined && !Array.isArray(action.reasons)) throw new Error('Timeline reasons are invalid. Reopen the saved project.');
  const reasons = state.reasons.map(reason => ({ ...reason }));
  const actionReasons = action.reasons ?? [];
  actionReasons.forEach(assertReason);
  if (new Set(actionReasons.map(reason => reason.id)).size !== actionReasons.length) throw new Error('Timeline reasons are invalid. Reopen the saved project.');
  for (const reason of actionReasons) {
    const previous = reasons.find(item => item.id === reason.id);
    if (previous && !sameReason(previous, reason)) throw new Error('An existing reason cannot be rewritten.');
    if (!previous) reasons.push({ ...reason });
  }
  const actionReason: TimelineReason = { id: `${action.id}:creator`, kind: action.kind, actor: 'creator', text: action.kind === 'exclude' ? 'Excluded by you. Original retained.' : action.kind === 'restore' ? 'Restored by you. Previous reasons retained.' : `Creator action: ${action.kind.replaceAll('-', ' ')}.` };
  if (reasons.some(reason => reason.id === actionReason.id)) throw new Error('Use a new reason identity for this edit.');
  reasons.push(actionReason);
  let clips = copyClips(state.snapshot.clips);
  const index = 'clipId' in action ? clips.findIndex(clip => clip.id === action.clipId) : -1;
  if ('clipId' in action && index < 0) throw new Error('This clip no longer exists. Review the current timeline.');
  const target = clips[index];
  switch (action.kind) {
    case 'trim': {
      const next = { ...target, t0: action.t0, t1: action.t1 };
      assertRange(next, sources); clips[index] = next; break;
    }
    case 'split': {
      assertRange(target, sources);
      if (!target.included || !finite(action.at) || action.at <= target.t0 || action.at >= target.t1) throw new Error('Split must be inside an included clip. Seek inside the clip and retry.');
      const used = new Set([...clips, ...allCommands.flatMap(command => [...command.before, ...command.after])].map(clip => clip.id));
      if (!validId(action.leftId) || !validId(action.rightId) || action.leftId === action.rightId || used.has(action.leftId) || used.has(action.rightId)) throw new Error('Split needs two new stable clip identities.');
      clips.splice(index, 1, { ...copyClip(target), id: action.leftId, t1: action.at, parentClipId: target.id }, { ...copyClip(target), id: action.rightId, t0: action.at, parentClipId: target.id });
      break;
    }
    case 'exclude': clips[index] = { ...target, included: false, reasonIds: [...new Set([...target.reasonIds, actionReason.id])] }; break;
    case 'restore': assertRange(target, sources); clips[index] = { ...target, included: true, reasonIds: [...new Set([...target.reasonIds, actionReason.id])] }; break;
    case 'reorder':
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= clips.length) throw new Error('Choose a position inside the timeline.');
      clips.splice(index, 1); clips.splice(action.index, 0, target); break;
    default: {
      if (!Array.isArray(action.clips)) throw new Error('The accepted timeline proposal is invalid. Review it and retry.');
      clips = copyClips(action.clips);
      const oldIds = new Map(state.snapshot.clips.map(clip => [clip.id, clip]));
      const historicalClipIds = new Set(allCommands.flatMap(command => [...command.before, ...command.after].map(clip => clip.id)));
      for (const clip of clips) {
        assertClipIdentity(clip);
        if (!oldIds.has(clip.id) && historicalClipIds.has(clip.id)) throw new Error('Accepted clips must use new stable identities. Review the proposal and retry.');
        if (clip.included) assertRange(clip, sources);
        const old = oldIds.get(clip.id);
        if (old && (old.sourceId !== clip.sourceId || old.parentClipId !== clip.parentClipId)) throw new Error('A stable clip cannot change its source or lineage.');
        if (old && !old.included && action.kind !== 'choose-take' && clip.included && creatorExcluded(old, state.reasons)) {
          throw new Error('This proposal would restore a creator-excluded clip. Restore it explicitly before accepting the proposal.');
        }
        if (old) clip.reasonIds = [...new Set([...old.reasonIds, ...clip.reasonIds])];
      }
      for (let i = 0; i < clips.length; i++) for (let j = i + 1; j < clips.length; j++) {
        const a = clips[i], b = clips[j];
        if (a.included && b.included && a.sourceId === b.sourceId && intervalsOverlap(a, b)
          && a.utteranceIds.some(id => b.utteranceIds.includes(id))) throw new Error('Shared utterance ranges overlap. Review the boundary or choose another take.');
        if ((action.kind === 'accept-proposal' || action.kind === 'accept-pickup') && a.included && b.included
          && a.sourceId === b.sourceId && !intervalsOverlap(a, b) && a.utteranceIds.some(id => b.utteranceIds.includes(id))
          && !(() => {
            const oldA = oldIds.get(a.id), oldB = oldIds.get(b.id);
            return !!oldA && !!oldB && sameClip(oldA, a) && sameClip(oldB, b);
          })()) {
          throw new Error('A proposal cannot automatically split or duplicate a shared utterance. Review the boundary.');
        }
      }
      // A whole proposal can exclude an alternative, but cannot erase its source context.
      for (const old of state.snapshot.clips) if (!clips.some(clip => clip.id === old.id)) clips.push({ ...copyClip(old), included: false, reasonIds: [...new Set([...old.reasonIds, actionReason.id])] });
    }
  }
  const command: TimelineCommand = { id: action.id, kind: action.kind, baseRevision: action.baseRevision, revision: action.baseRevision + 1,
    before: copyClips(state.snapshot.clips), after: copyClips(clips), reasonIds: [actionReason.id, ...actionReasons.map(reason => reason.id)],
    ...(action.metadata === undefined ? {} : { metadata: copyMetadata(action.metadata) as TimelineCommandMetadata }) };
  const history: TimelineHistory = { entries: [...state.history.entries.slice(0, state.history.cursor), command], cursor: state.history.cursor + 1,
    abandonedEntries: [...state.history.abandonedEntries, ...state.history.entries.slice(state.history.cursor)] };
  return createTimelineState({ revision: action.baseRevision + 1, clips }, reasons, history);
}

export function undoTimeline(state: TimelineState): TimelineState {
  if (!state.history.cursor) return state;
  return createTimelineState({ revision: state.snapshot.revision + 1, clips: state.history.entries[state.history.cursor - 1].before }, state.reasons, { ...state.history, cursor: state.history.cursor - 1 });
}
export function redoTimeline(state: TimelineState): TimelineState {
  if (state.history.cursor >= state.history.entries.length) return state;
  return createTimelineState({ revision: state.snapshot.revision + 1, clips: state.history.entries[state.history.cursor].after }, state.reasons, { ...state.history, cursor: state.history.cursor + 1 });
}

export function playheadAt(sequence: ResolvedTimeline, outputTime: number): TimelinePlayhead | null {
  if (sequence.issues.length || !sequence.segments.length || !finite(outputTime)) return null;
  const position = Math.max(0, Math.min(sequence.duration, outputTime));
  const segment = sequence.segments.find(item => position >= item.outputT0 && position < item.outputT1) ?? sequence.segments.at(-1)!;
  return { clipId: segment.clipId, sourceId: segment.sourceId, sourceTime: segment.t0 + position - segment.outputT0, outputTime: position };
}
export function preserveTimelinePlayhead(previous: TimelinePlayhead | null, next: TimelineState, sources: TimelineSources): TimelinePlayhead | null {
  const sequence = resolveTimeline(next.snapshot, sources);
  if (!previous) return playheadAt(sequence, 0);
  if (sequence.issues.length) return null;
  const ancestry = new Map([...next.history.entries, ...next.history.abandonedEntries].flatMap(command => [...command.before, ...command.after]).map(clip => [clip.id, clip.parentClipId]));
  const descends = (id: string) => {
    const seen = new Set<string>();
    while (id && !seen.has(id)) { if (id === previous.clipId) return true; seen.add(id); id = ancestry.get(id) ?? ''; }
    return false;
  };
  const match = sequence.segments.find(segment => segment.sourceId === previous.sourceId && descends(segment.clipId) && previous.sourceTime >= segment.t0 && previous.sourceTime < segment.t1);
  return match ? { clipId: match.clipId, sourceId: match.sourceId, sourceTime: previous.sourceTime, outputTime: match.outputT0 + previous.sourceTime - match.t0 } : playheadAt(sequence, previous.outputTime);
}

import type { TimelineAction, TimelineClip, TimelineSnapshot, TimelineSource } from './engine';
export type { TimelineClip, TimelineSnapshot, TimelineSource } from './engine';

/**
 * Pure runtime seam for inserting a saved pickup into a revisioned timeline.
 *
 * This module deliberately does not know about Project, storage, or the
 * editor.  A proposal is analysis output and remains pending until a creator
 * explicitly calls `acceptPickupProposal`.
 */

export type RevisionToken = number | string;

export type RevisionMap = ReadonlyMap<string, RevisionToken> | Readonly<Record<string, RevisionToken>>;
export type PickupSources = readonly TimelineSource[] | Readonly<Record<string, TimelineSource>>;

export interface PickupRevisionScope {
  projectId: string;
  scriptRevision: RevisionToken;
  editRevision: RevisionToken;
  pointRevision: RevisionToken;
  transcriptRevision: RevisionToken;
  /** Per-source transcript revisions prevent cross-recording reuse. */
  sourceTranscriptRevisions: RevisionMap;
  /** Point identities can advance independently within one script revision. */
  pointRevisions: RevisionMap;
}

/** One source-local capture range linked to stable producer identities. */
export interface PickupIntent {
  /** Stable identity for this intent, allocated by its producer. */
  id: string;
  /** Stable candidate clip identity, allocated by the command caller. */
  clipId?: string;
  sourceId: string;
  t0: number;
  t1: number;
  pointIds: readonly string[];
  spanIds: readonly string[];
  utteranceIds: readonly string[];
  takeId?: string;
  parentClipId?: string;
  reasonIds?: readonly string[];
  /** Optional fallback when a producer has no point-order map entry. */
  position?: number;
}

export type ManualTimelineEditKind = 'reorder' | 'split' | 'delete';

/** A manual edit retained by the history owner for stale-proposal checks. */
export interface ManualTimelineEdit {
  id: string;
  kind: ManualTimelineEditKind;
  /** Revision at which this edit was committed, when available. */
  revision?: number;
  clipIds?: readonly string[];
  pointIds?: readonly string[];
  spanIds?: readonly string[];
  utteranceIds?: readonly string[];
}

export type PickupConflictKind =
  | 'invalid-intent'
  | 'missing-media'
  | 'invalid-range'
  | 'overlapping-utterance'
  | 'non-adjacent-utterance'
  | 'duplicate-utterance'
  | 'stale-script'
  | 'stale-edit'
  | 'stale-point'
  | 'stale-transcript'
  | 'stale-project'
  | 'manual-reorder'
  | 'manual-split'
  | 'manual-delete';

export type PickupRecoveryAction =
  | 'retry-with-current-scope'
  | 'restore-media'
  | 'review-boundary'
  | 'review-manual-edit'
  | 'review-duplicate';

export interface PickupConflict {
  /** Stable machine-readable conflict kind. */
  kind: PickupConflictKind;
  /** Alias for consumers that use a code field for visible conflict badges. */
  code: PickupConflictKind;
  message: string;
  recovery: PickupRecoveryAction;
  intentIds: string[];
  sourceIds: string[];
  clipIds: string[];
  pointIds: string[];
  spanIds: string[];
  utteranceIds: string[];
}

export interface PickupProposal {
  id: string;
  baseRevision: number;
  createdAt: number;
  /** Analysis output is always pending until explicit creator acceptance. */
  status: 'pending' | 'conflict';
  clips: TimelineClip[];
  /** Normalized insertion intents retained for creator review and revalidation. */
  intents: PickupIntent[];
  /** Full ordered preview, including the current clips and proposed additions. */
  previewClips: TimelineClip[];
  /** Point positions captured with the proposal for deterministic insertion. */
  pointOrder: Record<string, number>;
  /** Kept on the proposal so a UI can display the scope it was based on. */
  scope: PickupRevisionScope;
  conflicts: PickupConflict[];
}

export interface PickupProposalInput {
  proposalId: string;
  snapshot: TimelineSnapshot;
  sources: PickupSources;
  intents: readonly PickupIntent[];
  /** Stable script order. Numeric values need not be contiguous. */
  pointOrder: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  scope: {
    captured: PickupRevisionScope;
    current: PickupRevisionScope;
  };
  manualEdits?: readonly ManualTimelineEdit[];
  /** Revision from which analysis was produced. Defaults to snapshot.revision. */
  baseRevision?: number;
  createdAt?: number;
}

export interface PickupProposalResult {
  status: 'pending' | 'conflict';
  proposal: PickupProposal;
  /** Convenience alias for proposal.clips for UI preview consumers. */
  candidateClips: TimelineClip[];
  /** Full ordered preview for the proposal card/source preview. */
  previewClips: TimelineClip[];
  conflicts: PickupConflict[];
}

export interface PickupAcceptanceInput {
  snapshot: TimelineSnapshot;
  proposal: PickupProposal;
  sources: PickupSources;
  /** Live scope check for proposals reviewed after analysis completed. */
  currentScope: PickupRevisionScope;
  commandId?: string;
  acceptedAt?: number;
}

/** Exact engine command plus proposal metadata for acceptance history. */
export type PickupAcceptanceCommand = Omit<TimelineAction, 'kind' | 'clips'> & {
  kind: 'accept-pickup'; clips: TimelineClip[]; proposalId: string;
};

export interface PickupAcceptance {
  proposalId: string;
  acceptedBy: 'creator';
  acceptedAt: number;
}

export interface PickupAcceptanceResult {
  status: 'accepted' | 'conflict';
  /** The clips a history owner should commit as one command. */
  after?: TimelineClip[];
  command?: PickupAcceptanceCommand;
  acceptance?: PickupAcceptance;
  conflicts: PickupConflict[];
}

const SCOPE_KEYS = [
  ['scriptRevision', 'stale-script'],
  ['editRevision', 'stale-edit'],
  ['pointRevision', 'stale-point'],
  ['transcriptRevision', 'stale-transcript'],
] as const;

const EPSILON = 1e-9;

type NormalizedIntent = PickupIntent & {
  clipId: string;
  pointIds: string[];
  spanIds: string[];
  utteranceIds: string[];
  reasonIds: string[];
};

type IntentGroup = {
  key: string;
  sourceId: string;
  t0: number;
  t1: number;
  intents: NormalizedIntent[];
  pointIds: string[];
  spanIds: string[];
  utteranceIds: string[];
  reasonIds: string[];
  clipId: string;
  takeId?: string;
  parentClipId?: string;
  position: number;
};

type PointOrder = ReadonlyMap<string, number> | Readonly<Record<string, number>>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.filter(isNonEmptyString))];
}

function isRevisionToken(value: unknown): value is RevisionToken {
  return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length > 0);
}

function cloneRevisionMap(map: RevisionMap | undefined): Record<string, RevisionToken> {
  if (!map || typeof map !== 'object') return {};
  const entries = map instanceof Map ? [...map.entries()] : Object.entries(map);
  return Object.fromEntries(entries.filter((entry): entry is [string, RevisionToken] => isNonEmptyString(entry[0]) && isRevisionToken(entry[1])));
}

function cloneRevisionScope(scope: PickupRevisionScope | undefined): PickupRevisionScope {
  return {
    projectId: scope?.projectId,
    scriptRevision: scope?.scriptRevision,
    editRevision: scope?.editRevision,
    pointRevision: scope?.pointRevision,
    transcriptRevision: scope?.transcriptRevision,
    sourceTranscriptRevisions: cloneRevisionMap(scope?.sourceTranscriptRevisions),
    pointRevisions: cloneRevisionMap(scope?.pointRevisions),
  } as PickupRevisionScope;
}

function isPointOrder(value: unknown): value is PointOrder {
  return value instanceof Map || (!!value && typeof value === 'object' && !Array.isArray(value));
}

function cloneClip(clip: TimelineClip): TimelineClip {
  return {
    ...clip,
    reasonIds: [...(clip.reasonIds ?? [])],
    spanIds: [...(clip.spanIds ?? [])],
    pointIds: [...(clip.pointIds ?? [])],
    utteranceIds: [...(clip.utteranceIds ?? [])],
  };
}

function cloneClips(clips: readonly TimelineClip[]): TimelineClip[] {
  return clips.map(cloneClip);
}

function orderValue(
  order: PointOrder,
  id: string,
): number | undefined {
  if (!isPointOrder(order)) return undefined;
  const value = order instanceof Map ? order.get(id) : (order as Readonly<Record<string, number>>)[id];
  return finiteNumber(value) ? value : undefined;
}

function orderRecord(
  order: PointOrder,
): Record<string, number> {
  if (!isPointOrder(order)) return {};
  const entries = order instanceof Map ? [...order.entries()] : Object.entries(order);
  return Object.fromEntries(entries.filter((entry): entry is [string, number] => isNonEmptyString(entry[0]) && finiteNumber(entry[1])));
}

function minOrder(
  ids: readonly string[],
  order: PointOrder,
): number | undefined {
  const values = ids.map(id => orderValue(order, id)).filter((value): value is number => value !== undefined);
  return values.length ? Math.min(...values) : undefined;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareGroups(a: IntentGroup, b: IntentGroup): number {
  return a.position - b.position || compareStrings(a.sourceId, b.sourceId) || compareStrings(a.clipId, b.clipId);
}

function conflict(
  kind: PickupConflictKind,
  message: string,
  recovery: PickupRecoveryAction,
  details: Partial<Pick<PickupConflict, 'intentIds' | 'sourceIds' | 'clipIds' | 'pointIds' | 'spanIds' | 'utteranceIds'>> = {},
): PickupConflict {
  return {
    kind,
    code: kind,
    message,
    recovery,
    intentIds: uniqueStrings(details.intentIds),
    sourceIds: uniqueStrings(details.sourceIds),
    clipIds: uniqueStrings(details.clipIds),
    pointIds: uniqueStrings(details.pointIds),
    spanIds: uniqueStrings(details.spanIds),
    utteranceIds: uniqueStrings(details.utteranceIds),
  };
}

function identityDetails(intents: readonly NormalizedIntent[]): Pick<PickupConflict, 'intentIds' | 'sourceIds' | 'clipIds' | 'pointIds' | 'spanIds' | 'utteranceIds'> {
  return {
    intentIds: intents.map(intent => intent.id),
    sourceIds: intents.map(intent => intent.sourceId),
    clipIds: intents.map(intent => intent.clipId),
    pointIds: intents.flatMap(intent => intent.pointIds),
    spanIds: intents.flatMap(intent => intent.spanIds),
    utteranceIds: intents.flatMap(intent => intent.utteranceIds),
  };
}

function intersects(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return b.some(value => set.has(value));
}

function intervalOverlaps(a: Pick<TimelineClip, 't0' | 't1'>, b: Pick<TimelineClip, 't0' | 't1'>): boolean {
  return a.t0 < b.t1 - EPSILON && b.t0 < a.t1 - EPSILON;
}

function exactRange(a: Pick<TimelineClip, 'sourceId' | 't0' | 't1'>, b: Pick<TimelineClip, 'sourceId' | 't0' | 't1'>): boolean {
  return a.sourceId === b.sourceId && Math.abs(a.t0 - b.t0) <= EPSILON && Math.abs(a.t1 - b.t1) <= EPSILON;
}

function sourceMap(sources: PickupSources): Map<string, TimelineSource> {
  const values = Array.isArray(sources)
    ? sources
    : sources && typeof sources === 'object'
      ? Object.values(sources)
      : [];
  return new Map(values.filter(source => source && isNonEmptyString(source.id)).map(source => [source.id, source]));
}

function normalizeIntent(raw: unknown): NormalizedIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const intent = raw as PickupIntent;
  if (!isNonEmptyString(intent.id) || !isNonEmptyString(intent.sourceId)) return null;
  const clipId = intent.clipId ?? intent.id;
  if (!isNonEmptyString(clipId)) return null;
  if (!finiteNumber(intent.t0) || !finiteNumber(intent.t1)) return null;
  if (!Array.isArray(intent.pointIds) || !Array.isArray(intent.spanIds) || !Array.isArray(intent.utteranceIds)) return null;
  if (![...intent.pointIds, ...intent.spanIds, ...intent.utteranceIds].every(isNonEmptyString)) return null;
  if (intent.reasonIds !== undefined && (!Array.isArray(intent.reasonIds) || !intent.reasonIds.every(isNonEmptyString))) return null;
  if (intent.takeId !== undefined && !isNonEmptyString(intent.takeId)) return null;
  if (intent.parentClipId !== undefined && !isNonEmptyString(intent.parentClipId)) return null;
  if (intent.position !== undefined && !finiteNumber(intent.position)) return null;
  return {
    ...intent,
    clipId,
    pointIds: uniqueStrings(intent.pointIds),
    spanIds: uniqueStrings(intent.spanIds),
    utteranceIds: uniqueStrings(intent.utteranceIds),
    reasonIds: uniqueStrings(intent.reasonIds),
  };
}

function staleScopeConflicts(input: PickupProposalInput, intents: readonly NormalizedIntent[] = []): PickupConflict[] {
  const conflicts = SCOPE_KEYS.flatMap(([key, kind]) => {
    const captured = input.scope?.captured?.[key];
    const current = input.scope?.current?.[key];
    if (!isRevisionToken(captured) || !isRevisionToken(current)) {
      return [conflict(kind, `Pickup proposal is missing the current ${key.replace('Revision', '')} revision. Refresh the proposal before accepting it.`, 'retry-with-current-scope')];
    }
    if (captured === current) return [];
    return [conflict(
      kind,
      `Pickup proposal is based on an older ${key.replace('Revision', '')} revision. Refresh the proposal before accepting it.`,
      'retry-with-current-scope',
    )];
  });
  const capturedProject = input.scope?.captured?.projectId;
  const currentProject = input.scope?.current?.projectId;
  if (!isNonEmptyString(capturedProject) || !isNonEmptyString(currentProject) || capturedProject !== currentProject) {
    conflicts.push(conflict(
      'stale-project',
      !isNonEmptyString(capturedProject) || !isNonEmptyString(currentProject)
        ? 'Pickup proposal is missing its project identity. Open the original project and retry the pickup.'
        : 'Pickup evidence belongs to a different project. Open the original project and retry the pickup.',
      'retry-with-current-scope',
      { sourceIds: intents.map(intent => intent.sourceId), intentIds: intents.map(intent => intent.id) },
    ));
  }
  conflicts.push(...perIdentityScopeConflicts(input, intents));
  return conflicts;
}

function revisionMapValue(map: RevisionMap | undefined, id: string): RevisionToken | undefined {
  if (!map) return undefined;
  const value = map instanceof Map ? map.get(id) : (map as Readonly<Record<string, RevisionToken>>)[id];
  return isRevisionToken(value) ? value : undefined;
}

function perIdentityScopeConflicts(input: PickupProposalInput, intents: readonly NormalizedIntent[] = []): PickupConflict[] {
  const capturedSources = input.scope?.captured?.sourceTranscriptRevisions;
  const currentSources = input.scope?.current?.sourceTranscriptRevisions;
  const capturedPoints = input.scope?.captured?.pointRevisions;
  const currentPoints = input.scope?.current?.pointRevisions;
  const result: PickupConflict[] = [];
  for (const sourceId of uniqueStrings(intents.map(intent => intent.sourceId))) {
    const captured = revisionMapValue(capturedSources, sourceId);
    const current = revisionMapValue(currentSources, sourceId);
    if (!capturedSources || !currentSources || captured === undefined || current === undefined || captured !== current) {
      result.push(conflict(
        'stale-transcript',
        `Pickup evidence for source ${sourceId} is from an older transcript revision. Re-run analysis for this source.`,
        'retry-with-current-scope',
        { sourceIds: [sourceId], intentIds: intents.filter(intent => intent.sourceId === sourceId).map(intent => intent.id), utteranceIds: intents.filter(intent => intent.sourceId === sourceId).flatMap(intent => intent.utteranceIds) },
      ));
    }
  }
  for (const pointId of uniqueStrings(intents.flatMap(intent => intent.pointIds))) {
    const captured = revisionMapValue(capturedPoints, pointId);
    const current = revisionMapValue(currentPoints, pointId);
    if (!capturedPoints || !currentPoints || captured === undefined || current === undefined || captured !== current) {
      result.push(conflict(
        'stale-point',
        `Pickup point ${pointId} is from an older point revision. Refresh the missing-point proposal.`,
        'retry-with-current-scope',
        { pointIds: [pointId], intentIds: intents.filter(intent => intent.pointIds.includes(pointId)).map(intent => intent.id) },
      ));
    }
  }
  return result;
}

function manualConflicts(input: PickupProposalInput, intents: readonly NormalizedIntent[]): PickupConflict[] {
  const baseRevision = input.baseRevision ?? input.snapshot.revision;
  return (input.manualEdits ?? []).flatMap(edit => {
    if (!isNonEmptyString(edit.id)) return [];
    if (edit.revision !== undefined && edit.revision <= baseRevision) return [];
    const targetIds = [
      ...uniqueStrings(edit.clipIds),
      ...uniqueStrings(edit.pointIds),
      ...uniqueStrings(edit.spanIds),
      ...uniqueStrings(edit.utteranceIds),
    ];
    const touches = targetIds.length > 0 && intents.some(intent =>
      intersects(intent.pointIds, edit.pointIds ?? [])
      || intersects(intent.spanIds, edit.spanIds ?? [])
      || intersects(intent.utteranceIds, edit.utteranceIds ?? [])
      || targetIds.includes(intent.clipId)
      || targetIds.includes(intent.id),
    );
    // A reorder changes the insertion context even when its explicit target
    // does not carry the pickup's point identity.  It therefore always waits
    // for visible creator resolution when it happened after proposal creation.
    // Reorder changes the insertion context even when its explicit target is
    // unrelated. Split/delete only conflict when their retained target is in
    // this proposal, so an unrelated manual split never blocks a pickup.
    if (!touches && edit.kind !== 'reorder') return [];
    const details = identityDetails(intents);
    return [conflict(
      `manual-${edit.kind}`,
      `A creator ${edit.kind} changed the timeline while this pickup was being prepared. Review the edit and pickup together.`,
      'review-manual-edit',
      { ...details, clipIds: [...details.clipIds, ...uniqueStrings(edit.clipIds)] },
    )];
  });
}

function validateIntent(
  intent: NormalizedIntent,
  sources: Map<string, TimelineSource>,
): PickupConflict[] {
  const details = identityDetails([intent]);
  if (intent.t1 <= intent.t0 || intent.t0 < 0) {
    return [conflict('invalid-range', `Pickup ${intent.id} has a zero-length or negative source range. Choose a positive source-local boundary.`, 'review-boundary', details)];
  }
  const source = sources.get(intent.sourceId);
  if (!source || !isNonEmptyString(source.uri) || source.available !== true) {
    return [conflict('missing-media', `Pickup ${intent.id} cannot be previewed because its source media is unavailable. Restore the source and retry.`, 'restore-media', details)];
  }
  if (source.duration === null || !finiteNumber(source.duration) || source.duration <= 0) {
    return [conflict('invalid-range', `Pickup ${intent.id} cannot be validated because source ${source.id} has no usable duration. Reopen to probe the source, then retry.`, 'retry-with-current-scope', details)];
  }
  if (intent.t1 > source.duration + EPSILON) {
    return [conflict('invalid-range', `Pickup ${intent.id} extends beyond the available source range. Choose a boundary inside ${source.id}.`, 'review-boundary', details)];
  }
  if (!intent.pointIds.length && !intent.spanIds.length && !intent.utteranceIds.length) {
    return [conflict('invalid-intent', `Pickup ${intent.id} has no stable point, span or utterance identity. Refresh the pickup result.`, 'retry-with-current-scope', details)];
  }
  return [];
}

function groupIntents(
  intents: readonly NormalizedIntent[],
  pointOrder: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
): IntentGroup[] {
  const groups = new Map<string, IntentGroup>();
  for (const intent of intents) {
    const key = `${intent.sourceId}\u0000${intent.t0}\u0000${intent.t1}`;
    const existing = [...groups.values()].find(group => group.sourceId === intent.sourceId
      && Math.abs(group.t0 - intent.t0) <= EPSILON && Math.abs(group.t1 - intent.t1) <= EPSILON);
    const position = minOrder(intent.pointIds, pointOrder) ?? minOrder(intent.spanIds, pointOrder) ?? minOrder(intent.utteranceIds, pointOrder) ?? intent.position ?? Number.POSITIVE_INFINITY;
    if (!existing) {
      groups.set(key, {
        key,
        sourceId: intent.sourceId,
        t0: intent.t0,
        t1: intent.t1,
        intents: [intent],
        pointIds: [...intent.pointIds],
        spanIds: [...intent.spanIds],
        utteranceIds: [...intent.utteranceIds],
        reasonIds: [...intent.reasonIds],
        clipId: intent.clipId,
        takeId: intent.takeId,
        parentClipId: intent.parentClipId,
        position,
      });
      continue;
    }
    existing.intents.push(intent);
    existing.pointIds = uniqueStrings([...existing.pointIds, ...intent.pointIds]);
    existing.spanIds = uniqueStrings([...existing.spanIds, ...intent.spanIds]);
    existing.utteranceIds = uniqueStrings([...existing.utteranceIds, ...intent.utteranceIds]);
    existing.reasonIds = uniqueStrings([...existing.reasonIds, ...intent.reasonIds]);
    existing.position = Math.min(existing.position, position);
  }
  return [...groups.values()].sort(compareGroups);
}

function groupClip(group: IntentGroup): TimelineClip {
  return {
    id: group.clipId,
    sourceId: group.sourceId,
    t0: group.t0,
    t1: group.t1,
    included: true,
    reasonIds: [...group.reasonIds],
    spanIds: [...group.spanIds],
    pointIds: [...group.pointIds],
    utteranceIds: [...group.utteranceIds],
    ...(group.takeId ? { takeId: group.takeId } : {}),
    ...(group.parentClipId ? { parentClipId: group.parentClipId } : {}),
  };
}

function checkGroupConflicts(
  groups: readonly IntentGroup[],
  snapshot: TimelineSnapshot,
  pointOrder: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
): PickupConflict[] {
  const result: PickupConflict[] = [];
  const clipIds = new Map<string, IntentGroup>();
  for (const group of groups) {
    const previous = clipIds.get(group.clipId);
    if (previous) {
      result.push(conflict(
        'invalid-intent',
        `Pickup intents reuse clip identity ${group.clipId} for different source ranges. Allocate one stable clip id per range.`,
        'retry-with-current-scope',
        identityDetails([...previous.intents, ...group.intents]),
      ));
    } else {
      clipIds.set(group.clipId, group);
    }
  }
  for (let i = 0; i < groups.length; i += 1) {
    const a = groups[i];
    const aClip = groupClip(a);
    for (let k = 0; k < a.intents.length; k += 1) {
      const first = a.intents[k];
      for (const second of a.intents.slice(k + 1)) {
        if (intersects(first.utteranceIds, second.utteranceIds)) continue;
        result.push(conflict(
          'overlapping-utterance',
          'Two different pickup utterances occupy the same source range. Review the boundary; the engine will not split or duplicate a whole utterance.',
          'review-boundary',
          identityDetails([first, second]),
        ));
      }
    }
    for (let j = i + 1; j < groups.length; j += 1) {
      const b = groups[j];
      if (a.sourceId !== b.sourceId || !intervalOverlaps(aClip, b)) continue;
      const sharedUtterance = intersects(a.utteranceIds, b.utteranceIds);
      if (sharedUtterance && exactRange(aClip, groupClip(b))) continue;
      result.push(conflict(
        'overlapping-utterance',
        'Pickup utterances overlap in one source. Review the boundary; the engine will not split or duplicate a shared utterance.',
        'review-boundary',
        identityDetails([...a.intents, ...b.intents]),
      ));
    }
  }

  const utteranceGroups = new Map<string, IntentGroup[]>();
  for (const group of groups) {
    for (const utteranceId of group.utteranceIds) {
      const key = `${group.sourceId}\u0000${utteranceId}`;
      const bucket = utteranceGroups.get(key);
      if (bucket) bucket.push(group);
      else utteranceGroups.set(key, [group]);
    }
  }
  for (const [key, bucket] of utteranceGroups) {
    const utteranceId = key.slice(key.indexOf('\u0000') + 1);
    const pointIds = uniqueStrings(bucket.flatMap(group => group.pointIds));
    const orders = pointIds.map(id => orderValue(pointOrder, id)).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
    const knownOrders = new Set(orders);
    const allPointOrders = [...new Set(Object.values(orderRecord(pointOrder)))].sort((a, b) => a - b);
    const min = orders[0];
    const max = orders[orders.length - 1];
    const hasGap = min !== undefined && max !== undefined && allPointOrders.some(order => order > min + EPSILON && order < max - EPSILON && !knownOrders.has(order));
    const separatedRanges = bucket.some((group, index) => bucket.slice(index + 1).some(other =>
      group.sourceId !== other.sourceId || !intervalOverlaps(group, other) && !exactRange(group, other),
    ));
    if (hasGap || separatedRanges) {
      const intents = bucket.flatMap(group => group.intents);
      result.push(conflict(
        'non-adjacent-utterance',
        `Shared utterance ${utteranceId} maps to non-adjacent points or ranges. Choose a boundary or another pickup; it will remain one whole utterance.`,
        'review-boundary',
        identityDetails(intents),
      ));
    }
  }
  return result;
}

function sharesClipLineage(a: TimelineClip, b: TimelineClip, clips: readonly TimelineClip[]): boolean {
  const parents = new Map(clips.filter(clip => isNonEmptyString(clip.parentClipId)).map(clip => [clip.id, clip.parentClipId!]));
  const ancestors = (id: string) => {
    const result = new Set<string>();
    let current = id;
    while (current && !result.has(current)) {
      result.add(current);
      current = parents.get(current) ?? '';
    }
    return result;
  };
  const aAncestors = ancestors(a.id);
  const bAncestors = ancestors(b.id);
  return aAncestors.has(b.id) || bAncestors.has(a.id) || [...aAncestors].some(id => bAncestors.has(id));
}

function checkAgainstSnapshot(groups: readonly IntentGroup[], snapshot: TimelineSnapshot): PickupConflict[] {
  const result: PickupConflict[] = [];
  for (const group of groups) {
    const candidate = groupClip(group);
    for (const existing of snapshot.clips) {
      if (existing.sourceId !== candidate.sourceId || !intervalOverlaps(existing, candidate)) continue;
      const sharedUtterance = intersects(existing.utteranceIds ?? [], candidate.utteranceIds);
      if (exactRange(existing, candidate) && sharedUtterance) {
        if (!existing.included) {
          result.push(conflict(
            'manual-delete',
            'This pickup would restore a range the creator excluded. Review the excluded clip and choose Restore explicitly.',
            'review-manual-edit',
            { intentIds: group.intents.map(intent => intent.id), sourceIds: [group.sourceId], clipIds: [existing.id, candidate.id], pointIds: candidate.pointIds, spanIds: candidate.spanIds, utteranceIds: candidate.utteranceIds },
          ));
        }
        continue;
      }
      result.push(conflict(
          'overlapping-utterance',
          'This pickup overlaps an existing source range. Review the whole utterance before inserting it.',
        'review-boundary',
        { intentIds: group.intents.map(intent => intent.id), sourceIds: [group.sourceId], clipIds: [existing.id, candidate.id], pointIds: [...(existing.pointIds ?? []), ...candidate.pointIds], spanIds: [...(existing.spanIds ?? []), ...candidate.spanIds], utteranceIds: [...(existing.utteranceIds ?? []), ...candidate.utteranceIds] },
      ));
    }
    for (const existing of snapshot.clips) {
      if (existing.sourceId !== candidate.sourceId || intervalOverlaps(existing, candidate)) continue;
      if (!intersects(existing.utteranceIds ?? [], candidate.utteranceIds)) continue;
      if (exactRange(existing, candidate) || sharesClipLineage(existing, candidate, [...snapshot.clips, candidate])) continue;
      result.push(conflict(
        'duplicate-utterance',
        'This pickup repeats a source-local utterance already present in the timeline. Review the existing whole utterance before inserting it.',
        'review-duplicate',
        {
          intentIds: group.intents.map(intent => intent.id),
          sourceIds: [group.sourceId],
          clipIds: [existing.id, candidate.id],
          pointIds: [...(existing.pointIds ?? []), ...candidate.pointIds],
          spanIds: [...(existing.spanIds ?? []), ...candidate.spanIds],
          utteranceIds: [...(existing.utteranceIds ?? []), ...candidate.utteranceIds],
        },
      ));
    }
  }
  const seen = new Map<string, TimelineClip>();
  for (const clip of snapshot.clips) {
    for (const utteranceId of clip.utteranceIds ?? []) {
      // Utterance ids are scoped to a source. A pickup and the original can
      // use the same semantic id without becoming a cross-source duplicate.
      const key = `${clip.sourceId}\u0000${utteranceId}`;
      const previous = seen.get(key);
      if (previous && (!exactRange(previous, clip) || previous.id !== clip.id) && !sharesClipLineage(previous, clip, snapshot.clips)) {
        result.push(conflict(
          'duplicate-utterance',
          `Utterance ${utteranceId} already appears in more than one clip. Resolve the existing duplicate before accepting a pickup.`,
          'review-duplicate',
          { clipIds: [previous.id, clip.id], sourceIds: [previous.sourceId, clip.sourceId], pointIds: [...(previous.pointIds ?? []), ...(clip.pointIds ?? [])], spanIds: [...(previous.spanIds ?? []), ...(clip.spanIds ?? [])], utteranceIds: [utteranceId] },
        ));
      } else {
        seen.set(key, clip);
      }
    }
  }
  return result;
}

function insertByPointOrder(
  existing: readonly TimelineClip[],
  additions: readonly { clip: TimelineClip; position: number }[],
  pointOrder: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
): TimelineClip[] {
  const output = cloneClips(existing);
  for (const addition of [...additions].sort((a, b) => a.position - b.position || compareStrings(a.clip.sourceId, b.clip.sourceId) || compareStrings(a.clip.id, b.clip.id))) {
    const position = addition.position;
    if (!finiteNumber(position)) {
      output.push(cloneClip(addition.clip));
      continue;
    }
    const index = output.findIndex(clip => {
      const clipPosition = minOrder(clip.pointIds ?? [], pointOrder);
      return clipPosition !== undefined && clipPosition > position + EPSILON;
    });
    if (index < 0) output.push(cloneClip(addition.clip));
    else output.splice(index, 0, cloneClip(addition.clip));
  }
  return output;
}

function mergeCandidateClips(
  snapshot: TimelineSnapshot,
  groups: readonly IntentGroup[],
  pointOrder: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
): TimelineClip[] {
  const additions: { clip: TimelineClip; position: number }[] = [];
  const output = cloneClips(snapshot.clips);
  for (const group of groups) {
    const candidate = groupClip(group);
    const existing = output.find(clip => exactRange(clip, candidate) && intersects(clip.utteranceIds ?? [], candidate.utteranceIds));
    if (existing) {
      existing.pointIds = uniqueStrings([...(existing.pointIds ?? []), ...candidate.pointIds]);
      existing.spanIds = uniqueStrings([...(existing.spanIds ?? []), ...candidate.spanIds]);
      existing.utteranceIds = uniqueStrings([...(existing.utteranceIds ?? []), ...candidate.utteranceIds]);
      existing.reasonIds = uniqueStrings([...(existing.reasonIds ?? []), ...candidate.reasonIds]);
      continue;
    }
    additions.push({ clip: candidate, position: group.position });
  }
  return insertByPointOrder(output, additions, pointOrder);
}

/**
 * Validate and assemble a pickup proposal without changing the canonical
 * timeline.  A conflict result remains inspectable and includes a recovery
 * action for the editor.
 */
export function buildPickupProposal(input: PickupProposalInput): PickupProposalResult {
  const proposalId = input.proposalId;
  const baseRevision = input.baseRevision ?? input.snapshot.revision;
  const createdAt = input.createdAt ?? 0;
  const scope = cloneRevisionScope(input.scope?.captured);
  const pointOrder: PointOrder = isPointOrder(input.pointOrder) ? input.pointOrder : {};
  const sources = sourceMap(input.sources);
  const conflicts: PickupConflict[] = [];
  const intents: NormalizedIntent[] = [];

  if (!isNonEmptyString(proposalId)) {
    conflicts.push(conflict('invalid-intent', 'Pickup proposal needs a stable producer id. Retry the analysis before accepting it.', 'retry-with-current-scope'));
  }
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    conflicts.push(conflict('invalid-intent', 'Pickup proposal has an invalid base revision. Reload the project and retry.', 'retry-with-current-scope'));
  }
  if (Number.isInteger(baseRevision) && baseRevision !== input.snapshot.revision) {
    conflicts.push(conflict('stale-edit', 'Pickup analysis was prepared from an older timeline revision. Refresh it before accepting.', 'retry-with-current-scope'));
  }
  if (!isPointOrder(input.pointOrder)) {
    conflicts.push(conflict('invalid-intent', 'Pickup result has no valid point order. Refresh the pickup analysis before accepting it.', 'retry-with-current-scope'));
  }
  for (const rawIntent of Array.isArray(input.intents) ? input.intents : []) {
    const intent = normalizeIntent(rawIntent);
    if (!intent) {
      conflicts.push(conflict('invalid-intent', 'Pickup result has an invalid stable identity or source range. Retry the pickup analysis.', 'retry-with-current-scope'));
      continue;
    }
    intents.push(intent);
    conflicts.push(...validateIntent(intent, sources));
  }
  conflicts.push(...staleScopeConflicts(input, intents));
  conflicts.push(...manualConflicts(input, intents));

  const groups = groupIntents(intents, pointOrder);
  conflicts.push(...checkGroupConflicts(groups, input.snapshot, pointOrder));
  conflicts.push(...checkAgainstSnapshot(groups, input.snapshot));
  const uniqueConflicts = dedupeConflicts(conflicts);
  const candidateClips = uniqueConflicts.length ? [] : groups.map(groupClip);
  const previewClips = uniqueConflicts.length ? [] : mergeCandidateClips(input.snapshot, groups, pointOrder);
  const status = uniqueConflicts.length ? 'conflict' : 'pending';
  const proposal: PickupProposal = {
    id: proposalId,
    baseRevision,
    createdAt,
    status,
    intents: intents.map(intent => ({
      ...intent,
      pointIds: [...intent.pointIds],
      spanIds: [...intent.spanIds],
      utteranceIds: [...intent.utteranceIds],
      reasonIds: [...intent.reasonIds],
    })),
    clips: cloneClips(candidateClips),
    previewClips: cloneClips(previewClips),
    pointOrder: orderRecord(pointOrder),
    scope: cloneRevisionScope(scope),
    conflicts: uniqueConflicts.map(cloneConflict),
  };
  return { status, proposal, candidateClips: cloneClips(candidateClips), previewClips: cloneClips(previewClips), conflicts: uniqueConflicts.map(cloneConflict) };
}

function cloneConflict(item: PickupConflict): PickupConflict {
  return {
    ...item,
    intentIds: [...item.intentIds],
    sourceIds: [...item.sourceIds],
    clipIds: [...item.clipIds],
    pointIds: [...item.pointIds],
    spanIds: [...item.spanIds],
    utteranceIds: [...item.utteranceIds],
  };
}

function dedupeConflicts(items: readonly PickupConflict[]): PickupConflict[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = [item.kind, item.intentIds.join(','), item.clipIds.join(','), item.pointIds.join(','), item.spanIds.join(','), item.utteranceIds.join(','), item.sourceIds.join(',')].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function staleAcceptanceConflict(snapshot: TimelineSnapshot, proposal: PickupProposal): PickupConflict {
  const clips = Array.isArray(proposal.clips) ? proposal.clips : [];
  return conflict(
    'stale-edit',
    'The project changed after this pickup proposal was prepared. Refresh the proposal before accepting it.',
    'retry-with-current-scope',
    {
      clipIds: clips.map(clip => clip && typeof clip === 'object' && isNonEmptyString(clip.id) ? clip.id : '').filter(isNonEmptyString),
      sourceIds: clips.map(clip => clip && typeof clip === 'object' && isNonEmptyString(clip.sourceId) ? clip.sourceId : '').filter(isNonEmptyString),
      pointIds: clips.flatMap(clip => clip && typeof clip === 'object' ? clipStringIds(clip.pointIds) : []),
      spanIds: clips.flatMap(clip => clip && typeof clip === 'object' ? clipStringIds(clip.spanIds) : []),
      utteranceIds: clips.flatMap(clip => clip && typeof clip === 'object' ? clipStringIds(clip.utteranceIds) : []),
    },
  );
}

function normalizeClipIntent(raw: unknown): NormalizedIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const clip = raw as Partial<TimelineClip>;
  if (clip.included !== true || !Array.isArray(clip.reasonIds)) return null;
  return normalizeIntent({
    ...clip,
    id: clip.id,
    clipId: clip.id,
    pointIds: clip.pointIds,
    spanIds: clip.spanIds,
    utteranceIds: clip.utteranceIds,
    reasonIds: clip.reasonIds,
  });
}

function proposalIntents(proposal: PickupProposal): NormalizedIntent[] {
  if (!Array.isArray(proposal.intents)) return [];
  return proposal.intents.flatMap(raw => {
    const intent = normalizeIntent(raw);
    return intent ? [intent] : [];
  });
}

function acceptanceScopeConflicts(
  proposal: PickupProposal,
  current: PickupRevisionScope,
  retainedIntents: readonly NormalizedIntent[] = proposalIntents(proposal),
): PickupConflict[] {
  const intents = retainedIntents;
  const result: PickupConflict[] = [];
  for (const [key, kind] of SCOPE_KEYS) {
    const captured = proposal.scope?.[key];
    const now = current?.[key];
    if (!isRevisionToken(captured) || !isRevisionToken(now) || captured !== now) {
      result.push(conflict(kind, !isRevisionToken(captured) || !isRevisionToken(now)
        ? `Pickup proposal is missing the current ${key.replace('Revision', '')} revision. Refresh the proposal before accepting it.`
        : `Pickup proposal is based on an older ${key.replace('Revision', '')} revision. Refresh the proposal before accepting it.`, 'retry-with-current-scope', identityDetails(intents)));
    }
  }
  if (!isNonEmptyString(proposal.scope?.projectId) || !isNonEmptyString(current?.projectId) || proposal.scope.projectId !== current.projectId) {
    result.push(conflict(
      'stale-project',
      !isNonEmptyString(proposal.scope?.projectId) || !isNonEmptyString(current?.projectId)
        ? 'Pickup proposal is missing its project identity. Open the original project and retry the pickup.'
        : 'Pickup evidence belongs to a different project. Open the original project and retry the pickup.',
      'retry-with-current-scope',
      identityDetails(intents),
    ));
  }
  const capturedSources = proposal.scope?.sourceTranscriptRevisions;
  const currentSources = current?.sourceTranscriptRevisions;
  for (const sourceId of uniqueStrings(intents.map(intent => intent.sourceId))) {
    const captured = revisionMapValue(capturedSources, sourceId);
    const now = revisionMapValue(currentSources, sourceId);
    if (!capturedSources || !currentSources || captured === undefined || now === undefined || captured !== now) {
      result.push(conflict('stale-transcript', `Pickup evidence for source ${sourceId} is from an older transcript revision. Re-run analysis for this source.`, 'retry-with-current-scope', { sourceIds: [sourceId], intentIds: intents.filter(intent => intent.sourceId === sourceId).map(intent => intent.id), utteranceIds: intents.filter(intent => intent.sourceId === sourceId).flatMap(intent => intent.utteranceIds) }));
    }
  }
  const capturedPoints = proposal.scope?.pointRevisions;
  const currentPoints = current?.pointRevisions;
  for (const pointId of uniqueStrings(intents.flatMap(intent => intent.pointIds))) {
    const captured = revisionMapValue(capturedPoints, pointId);
    const now = revisionMapValue(currentPoints, pointId);
    if (!capturedPoints || !currentPoints || captured === undefined || now === undefined || captured !== now) {
      result.push(conflict('stale-point', `Pickup point ${pointId} is from an older point revision. Refresh the missing-point proposal.`, 'retry-with-current-scope', { pointIds: [pointId], intentIds: intents.filter(intent => intent.pointIds.includes(pointId)).map(intent => intent.id) }));
    }
  }
  return result;
}

function invalidCandidateConflict(raw: unknown): PickupConflict {
  const value = raw && typeof raw === 'object' ? raw as Partial<TimelineClip> : {};
  return conflict(
    'invalid-intent',
    'The reviewed pickup contains an invalid stable clip identity or range. Rebuild the proposal before accepting it.',
    'retry-with-current-scope',
    {
      clipIds: isNonEmptyString(value.id) ? [value.id] : [],
      sourceIds: isNonEmptyString(value.sourceId) ? [value.sourceId] : [],
    },
  );
}

function sameOrderedStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function clipStringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

function sameProposalClip(actual: TimelineClip, expected: TimelineClip): boolean {
  return actual.included === expected.included
    && actual.sourceId === expected.sourceId
    && Math.abs(actual.t0 - expected.t0) <= EPSILON
    && Math.abs(actual.t1 - expected.t1) <= EPSILON
    && actual.takeId === expected.takeId
    && actual.parentClipId === expected.parentClipId
    && sameOrderedStrings(clipStringIds(actual.reasonIds), expected.reasonIds)
    && sameOrderedStrings(clipStringIds(actual.spanIds), expected.spanIds)
    && sameOrderedStrings(clipStringIds(actual.pointIds), expected.pointIds)
    && sameOrderedStrings(clipStringIds(actual.utteranceIds), expected.utteranceIds);
}

function proposalShapeConflicts(groups: readonly IntentGroup[], candidateClips: readonly TimelineClip[]): PickupConflict[] {
  const expectedClips = groups.map(groupClip);
  const rawCandidateClips = candidateClips as readonly unknown[];
  const candidateIdentity = (raw: unknown, key: 'id' | 'sourceId'): string | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const value = (raw as Record<string, unknown>)[key];
    return isNonEmptyString(value) ? value : undefined;
  };
  const result: PickupConflict[] = [];
  if (expectedClips.length !== candidateClips.length) {
    result.push(conflict(
      'invalid-intent',
      'The reviewed pickup no longer matches its retained stable insertion identities. Rebuild the proposal before accepting it.',
      'retry-with-current-scope',
      {
        clipIds: [...expectedClips.map(clip => clip.id), ...rawCandidateClips.map(raw => candidateIdentity(raw, 'id')).filter(isNonEmptyString)],
        sourceIds: [...expectedClips.map(clip => clip.sourceId), ...rawCandidateClips.map(raw => candidateIdentity(raw, 'sourceId')).filter(isNonEmptyString)],
        pointIds: expectedClips.flatMap(clip => clip.pointIds),
        spanIds: expectedClips.flatMap(clip => clip.spanIds),
        utteranceIds: expectedClips.flatMap(clip => clip.utteranceIds),
      },
    ));
  }
  const candidatesById = new Map<string, TimelineClip>();
  for (const rawCandidate of rawCandidateClips) {
    if (!rawCandidate || typeof rawCandidate !== 'object') {
      result.push(invalidCandidateConflict(rawCandidate));
      continue;
    }
    const candidate = rawCandidate as TimelineClip;
    if (isNonEmptyString(candidate.id)) {
      if (candidatesById.has(candidate.id)) {
        result.push(invalidCandidateConflict(candidate));
      } else {
        candidatesById.set(candidate.id, candidate);
      }
    }
  }
  for (const expected of expectedClips) {
    const actual = candidatesById.get(expected.id);
    if (!actual || !sameProposalClip(actual, expected)) {
      result.push(conflict(
        'invalid-intent',
        `Reviewed pickup clip ${expected.id} changed its source range or stable identities. Rebuild the proposal before accepting it.`,
        'retry-with-current-scope',
        {
          clipIds: [expected.id, ...(actual && isNonEmptyString(actual.id) ? [actual.id] : [])],
          sourceIds: [expected.sourceId, ...(actual && isNonEmptyString(actual.sourceId) ? [actual.sourceId] : [])],
          pointIds: [...expected.pointIds, ...clipStringIds(actual?.pointIds)],
          spanIds: [...expected.spanIds, ...clipStringIds(actual?.spanIds)],
          utteranceIds: [...expected.utteranceIds, ...clipStringIds(actual?.utteranceIds)],
        },
      ));
    }
  }
  return result;
}

/**
 * Apply a previously reviewed proposal as one creator command.  The caller's
 * history/persistence owner can pass the returned engine command to
 * `applyTimelineAction`, which records the before/after history entry without
 * needing proposal-specific storage here.
 */
export function acceptPickupProposal(input: PickupAcceptanceInput): PickupAcceptanceResult {
  const { snapshot, proposal } = input;
  if (proposal.status !== 'pending') {
    const conflicts = Array.isArray(proposal.conflicts) ? proposal.conflicts.map(cloneConflict) : [conflict(
      'invalid-intent',
      'The pickup proposal is malformed. Rebuild the proposal before accepting it.',
      'retry-with-current-scope',
    )];
    return { status: 'conflict', conflicts };
  }
  if (!input.sources || !input.currentScope) {
    return {
      status: 'conflict',
      conflicts: [conflict('invalid-intent', 'Acceptance needs the current source inventory and revision scope. Reload the project and retry.', 'retry-with-current-scope')],
    };
  }
  if (!Array.isArray(snapshot?.clips) || !Array.isArray(proposal.clips) || !Array.isArray(proposal.intents) || !isPointOrder(proposal.pointOrder)) {
    return {
      status: 'conflict',
      conflicts: [conflict('invalid-intent', 'The pickup proposal is missing its retained clips, intents or point order. Rebuild the proposal before accepting it.', 'retry-with-current-scope')],
    };
  }
  if (snapshot.revision !== proposal.baseRevision) {
    const stale = staleAcceptanceConflict(snapshot, proposal);
    return { status: 'conflict', conflicts: [stale] };
  }
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
    return {
      status: 'conflict',
      conflicts: [conflict('invalid-intent', 'The current timeline revision is invalid. Reload the project before accepting this pickup.', 'retry-with-current-scope')],
    };
  }
  const sources = sourceMap(input.sources);
  const pointOrder: PointOrder = proposal.pointOrder;
  const retainedIntents = proposalIntents(proposal);
  const candidateIntents: NormalizedIntent[] = [];
  const revalidationConflicts: PickupConflict[] = [];
  for (const rawIntent of proposal.intents) {
    if (!normalizeIntent(rawIntent)) {
      revalidationConflicts.push(conflict('invalid-intent', 'The pickup proposal retained an invalid insertion intent. Rebuild it before accepting the pickup.', 'retry-with-current-scope'));
    }
  }
  for (const rawClip of proposal.clips) {
    const intent = normalizeClipIntent(rawClip);
    if (!intent) revalidationConflicts.push(invalidCandidateConflict(rawClip));
    else candidateIntents.push(intent);
  }
  if (retainedIntents.length !== proposal.intents.length) {
    revalidationConflicts.push(conflict('invalid-intent', 'The pickup proposal retained an invalid insertion intent. Rebuild it before accepting the pickup.', 'retry-with-current-scope'));
  }
  if (candidateIntents.length !== proposal.clips.length) {
    revalidationConflicts.push(conflict('invalid-intent', 'The reviewed pickup contains an invalid stable clip identity or range. Rebuild the proposal before accepting it.', 'retry-with-current-scope'));
  }
  const scopeIntents = [...retainedIntents, ...candidateIntents];
  revalidationConflicts.push(...acceptanceScopeConflicts(proposal, input.currentScope, scopeIntents));
  revalidationConflicts.push(...retainedIntents.flatMap(intent => validateIntent(intent, sources)));
  revalidationConflicts.push(...candidateIntents.flatMap(intent => validateIntent(intent, sources)));

  const retainedGroups = groupIntents(retainedIntents, pointOrder);
  const candidateGroups = groupIntents(candidateIntents, pointOrder);
  // Re-run the same identity, whole-utterance and snapshot checks at the
  // acceptance boundary.  The proposal is review data and may have gone
  // stale or been malformed after analysis completed.
  revalidationConflicts.push(...checkGroupConflicts(retainedGroups, snapshot, pointOrder));
  revalidationConflicts.push(...checkAgainstSnapshot(retainedGroups, snapshot));
  revalidationConflicts.push(...checkGroupConflicts(candidateGroups, snapshot, pointOrder));
  revalidationConflicts.push(...checkAgainstSnapshot(candidateGroups, snapshot));
  revalidationConflicts.push(...proposalShapeConflicts(retainedGroups, proposal.clips));
  const uniqueRevalidationConflicts = dedupeConflicts(revalidationConflicts);
  if (uniqueRevalidationConflicts.length) return { status: 'conflict', conflicts: uniqueRevalidationConflicts.map(cloneConflict) };

  const after = mergeCandidateClips(snapshot, candidateGroups, pointOrder);
  const command: PickupAcceptanceCommand = {
    id: input.commandId ?? `${proposal.id}:accept`,
    kind: 'accept-pickup',
    baseRevision: snapshot.revision,
    clips: cloneClips(after),
    proposalId: proposal.id,
  };
  const acceptedAt = input.acceptedAt ?? 0;
  return {
    status: 'accepted',
    after: cloneClips(after),
    command,
    acceptance: { proposalId: proposal.id, acceptedBy: 'creator', acceptedAt },
    conflicts: [],
  };
}

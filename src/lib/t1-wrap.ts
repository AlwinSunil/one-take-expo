import type { Project } from './session';
import { projectReview, projectScriptLines } from './project-workflow.ts';
import type {
  EvidenceStatus,
  FootageReference,
  MustSayResult,
  Tier1ScriptLineSnapshot,
  TakeReason,
  Tier1Evidence,
  WrapAcknowledgement,
} from './t1-contracts.ts';

const EVIDENCE_STATUSES = ['pending', 'available', 'uncertain', 'unavailable', 'failed'] as const;
const MUST_SAY_STATUSES = ['satisfied', 'missing', 'pending', 'uncertain', 'unavailable'] as const;
const SCRATCH_STATES = ['proposed', 'applied', 'restored'] as const;
const CLEANUP_STATES = ['kept', 'removed', 'restored'] as const;

type MustSayDisplayStatus = MustSayResult['status'] | 'unknown' | 'not-required';
export type WrapCoverageStatus = 'covered' | 'needed' | 'pending' | 'unavailable';
export type WrapFlagKind = 'coverage' | 'must-say' | 'action' | 'evidence' | 'acknowledgement' | 'script';

export interface WrapFootage extends FootageReference {
  /** Source media is available at review time.  A reference never implies this by itself. */
  playable: boolean;
}

export interface WrapLineReport {
  id: string;
  spokenText: string;
  coverage: WrapCoverageStatus;
  mustSay: {
    required: boolean | null;
    status: MustSayDisplayStatus;
  };
  takeCount: number;
  takeIds: string[];
  missingMediaTakeIds: string[];
  matchedSegmentIds: string[];
  evidence: WrapFootage[];
  reasons: TakeReason[];
}

export interface WrapActionReport {
  id: string;
  text: string;
  required: boolean;
  confirmed: boolean;
  status: 'confirmed' | 'unresolved';
  blocksWrap: boolean;
}

export interface WrapFlag {
  id: string;
  kind: WrapFlagKind;
  message: string;
  lineId?: string;
  actionId?: string;
  source: 'current' | 'acknowledged';
}

export interface WrapReport {
  projectId: string;
  evidenceStatus: EvidenceStatus;
  evidenceProvider: Tier1Evidence['provider'] | null;
  evidenceRevision: string | null;
  contextKey: string | null;
  evidenceError: string | null;
  mediaAvailable: boolean;
  lines: WrapLineReport[];
  actions: WrapActionReport[];
  requiredActions: WrapActionReport[];
  optionalActions: WrapActionReport[];
  firstTakeStartedAt: number | null;
  wrapRequestedAt: number | null;
  recordingToWrapMs: number | null;
  recordingToWrapLabel: string;
  currentFlagIds: string[];
  /** Current flags plus flags retained by a prior explicit acknowledgement. */
  remainingFlags: string[];
  flags: WrapFlag[];
  acknowledgement: WrapAcknowledgement | null;
  acknowledgementValid: boolean;
  qualifiedAllClear: boolean;
  /** True when a wrap is allowed either by an unqualified clear or valid explicit acknowledgement. */
  wrapAllowed: boolean;
  /** Alias for consumers that use the review terminology. */
  safeToWrap: boolean;
}

interface EvidenceInspection {
  valid: boolean;
  value?: Tier1Evidence;
  error?: string;
}

interface AcknowledgementInspection {
  valid: boolean;
  value: WrapAcknowledgement | null;
  error?: string;
}

const unique = (values: readonly string[]) => new Set(values).size === values.length;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isEvidenceStatus(value: unknown): value is EvidenceStatus {
  return typeof value === 'string' && (EVIDENCE_STATUSES as readonly string[]).includes(value);
}

function isMustSayStatus(value: unknown): value is MustSayResult['status'] {
  return typeof value === 'string' && (MUST_SAY_STATUSES as readonly string[]).includes(value);
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function copyFootage(value: unknown, label: string): FootageReference {
  if (!isRecord(value) || !isNonEmptyString(value.recordingId)
    || typeof value.t0 !== 'number' || !Number.isFinite(value.t0) || value.t0 < 0
    || typeof value.t1 !== 'number' || !Number.isFinite(value.t1) || value.t1 <= value.t0) {
    throw new Error(`${label} is invalid.`);
  }
  return { recordingId: value.recordingId, t0: value.t0, t1: value.t1 };
}

function validateEvidence(
  projectId: string,
  scriptLines: readonly { id: string; spokenText: string }[],
  value: unknown,
): EvidenceInspection {
  if (value === undefined) return { valid: false, error: 'No Tier 1 evidence snapshot is available.' };
  if (!isRecord(value)) return { valid: false, error: 'The Tier 1 evidence snapshot is malformed.' };
  if (value.version !== 1) return { valid: false, error: 'The Tier 1 evidence snapshot version is unsupported.' };
  if (value.projectId !== projectId) return { valid: false, error: 'The Tier 1 evidence belongs to another project.' };
  if (!isNonEmptyString(value.revision)) return { valid: false, error: 'The Tier 1 evidence revision is missing.' };
  const provider = value.provider;
  if (provider !== 'fixture' && provider !== 'integrated') {
    return { valid: false, error: 'The Tier 1 evidence provider is invalid.' };
  }
  if (!isEvidenceStatus(value.status)) return { valid: false, error: 'The Tier 1 evidence status is invalid.' };
  if (!Array.isArray(value.scriptSnapshot)) {
    return { valid: false, error: 'The Tier 1 script snapshot is unavailable.' };
  }
  const spokenLines = scriptLines.filter(line => line.spokenText.trim().length > 0);
  const spokenLineIds = spokenLines.map(line => line.id);
  const scriptSnapshot: Tier1ScriptLineSnapshot[] = [];
  for (let index = 0; index < value.scriptSnapshot.length; index += 1) {
    const line = value.scriptSnapshot[index];
    if (!isRecord(line) || !isNonEmptyString(line.lineId) || !spokenLineIds.includes(line.lineId)
      || typeof line.spokenText !== 'string' || !line.spokenText.trim()) {
      return { valid: false, error: `Tier 1 script snapshot line ${index + 1} is malformed or stale.` };
    }
    scriptSnapshot.push({ lineId: line.lineId, spokenText: line.spokenText });
  }
  if (!unique(scriptSnapshot.map(line => line.lineId)) || scriptSnapshot.length !== spokenLines.length
    || scriptSnapshot.some((line, index) => line.lineId !== spokenLines[index].id
      || line.spokenText !== spokenLines[index].spokenText)) {
    return { valid: false, error: 'The Tier 1 script snapshot does not match the current spoken lines.' };
  }
  if (!Array.isArray(value.reasons) || !Array.isArray(value.mustSay)
    || !Array.isArray(value.scratchHistory) || !Array.isArray(value.cleanup)) {
    return { valid: false, error: 'The Tier 1 evidence collections are malformed.' };
  }

  const reasons: TakeReason[] = [];
  for (let index = 0; index < value.reasons.length; index += 1) {
    const reason = value.reasons[index];
    if (!isRecord(reason) || !isNonEmptyString(reason.id) || !isNonEmptyString(reason.takeId)
      || !isNonEmptyString(reason.message) || !isEvidenceStatus(reason.status)) {
      return { valid: false, error: `Tier 1 take reason ${index + 1} is malformed.` };
    }
    let footage: FootageReference | undefined;
    if (reason.footage !== undefined) {
      try { footage = copyFootage(reason.footage, `Tier 1 take reason ${index + 1} footage`); }
      catch (error) { return { valid: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    reasons.push({ id: reason.id, takeId: reason.takeId, message: reason.message, status: reason.status, footage });
  }
  if (!unique(reasons.map(reason => reason.id))) return { valid: false, error: 'Tier 1 take reason IDs are duplicated.' };

  const mustSay: MustSayResult[] = [];
  for (let index = 0; index < value.mustSay.length; index += 1) {
    const result = value.mustSay[index];
    if (!isRecord(result) || !isNonEmptyString(result.lineId) || !spokenLineIds.includes(result.lineId)
      || typeof result.required !== 'boolean' || !isMustSayStatus(result.status) || !Array.isArray(result.evidence)) {
      return { valid: false, error: `Tier 1 must-say result ${index + 1} is malformed or stale.` };
    }
    const evidence: FootageReference[] = [];
    for (let evidenceIndex = 0; evidenceIndex < result.evidence.length; evidenceIndex += 1) {
      try { evidence.push(copyFootage(result.evidence[evidenceIndex], `Tier 1 must-say evidence ${index + 1}.${evidenceIndex + 1}`)); }
      catch (error) { return { valid: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    mustSay.push({ lineId: result.lineId, required: result.required, status: result.status, evidence });
  }
  if (!unique(mustSay.map(result => result.lineId))) return { valid: false, error: 'Tier 1 must-say line IDs are duplicated.' };

  for (let index = 0; index < value.scratchHistory.length; index += 1) {
    const event = value.scratchHistory[index];
    if (!isRecord(event) || !isNonEmptyString(event.id) || !isNonEmptyString(event.takeId)
      || !isNonEmptyString(event.commandSegmentId) || !SCRATCH_STATES.includes(event.state as typeof SCRATCH_STATES[number])) {
      return { valid: false, error: `Tier 1 scratch event ${index + 1} is malformed.` };
    }
  }
  if (!unique(value.scratchHistory.map((event) => (event as Record<string, unknown>).id as string))) {
    return { valid: false, error: 'Tier 1 scratch event IDs are duplicated.' };
  }

  for (let index = 0; index < value.cleanup.length; index += 1) {
    const decision = value.cleanup[index];
    if (!isRecord(decision) || !isNonEmptyString(decision.id) || !isNonEmptyString(decision.suggestionId)
      || !CLEANUP_STATES.includes(decision.state as typeof CLEANUP_STATES[number])
      || typeof decision.boundariesReviewed !== 'boolean') {
      return { valid: false, error: `Tier 1 cleanup decision ${index + 1} is malformed.` };
    }
    try { copyFootage(decision.footage, `Tier 1 cleanup decision ${index + 1} footage`); }
    catch (error) { return { valid: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  if (!unique(value.cleanup.map((decision) => (decision as Record<string, unknown>).id as string))) {
    return { valid: false, error: 'Tier 1 cleanup decision IDs are duplicated.' };
  }

  for (const key of ['firstTakeStartedAt', 'wrapRequestedAt'] as const) {
    if (value[key] !== undefined && !validTimestamp(value[key])) {
      return { valid: false, error: `Tier 1 ${key} is invalid.` };
    }
  }
  if (validTimestamp(value.firstTakeStartedAt) && validTimestamp(value.wrapRequestedAt)
    && value.wrapRequestedAt < value.firstTakeStartedAt) {
    return { valid: false, error: 'Tier 1 wrap timing is earlier than the first take.' };
  }
  const firstTakeStartedAt = validTimestamp(value.firstTakeStartedAt) ? value.firstTakeStartedAt : undefined;
  const wrapRequestedAt = validTimestamp(value.wrapRequestedAt) ? value.wrapRequestedAt : undefined;

  return {
    valid: true,
    value: {
      version: 1,
      projectId,
      revision: value.revision,
      provider,
      status: value.status,
      scriptSnapshot,
      reasons,
      mustSay,
      scratchHistory: value.scratchHistory.map(event => ({
        id: event.id as string,
        takeId: event.takeId as string,
        commandSegmentId: event.commandSegmentId as string,
        state: event.state as typeof SCRATCH_STATES[number],
      })),
      cleanup: value.cleanup.map(decision => ({
        id: decision.id as string,
        suggestionId: decision.suggestionId as string,
        footage: copyFootage(decision.footage, 'Tier 1 cleanup footage'),
        state: decision.state as typeof CLEANUP_STATES[number],
        boundariesReviewed: decision.boundariesReviewed as boolean,
      })),
      ...(firstTakeStartedAt === undefined ? {} : { firstTakeStartedAt }),
      ...(wrapRequestedAt === undefined ? {} : { wrapRequestedAt }),
    },
  };
}

function inspectAcknowledgement(value: unknown): AcknowledgementInspection {
  if (value === undefined) return { valid: true, value: null };
  if (!isRecord(value) || !isNonEmptyString(value.evidenceRevision) || !validTimestamp(value.acknowledgedAt)
    || !Array.isArray(value.remainingFlags) || value.remainingFlags.some(flag => !isNonEmptyString(flag))
    || (value.contextKey !== undefined && !isNonEmptyString(value.contextKey))) {
    return { valid: false, value: null, error: 'The saved Wrap anyway acknowledgement is malformed.' };
  }
  const remainingFlags = value.remainingFlags as string[];
  if (!unique(remainingFlags)) return { valid: false, value: null, error: 'The saved Wrap anyway flags are duplicated.' };
  return {
    valid: true,
    value: {
      evidenceRevision: value.evidenceRevision,
      ...(value.contextKey === undefined ? {} : { contextKey: value.contextKey }),
      acknowledgedAt: value.acknowledgedAt,
      remainingFlags: remainingFlags.slice(),
    },
  };
}

function stableFlagIds(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function flagMessage(id: string, line?: WrapLineReport, action?: WrapActionReport): string {
  if (id.startsWith('coverage:')) {
    if (line?.missingMediaTakeIds.length || line?.evidence.some(footage => !footage.playable)) {
      return line ? `Supporting media is unavailable for “${line.spokenText}”.` : 'Supporting media is unavailable.';
    }
    return line ? `Line needs review: “${line.spokenText}”.` : 'A spoken line needs review.';
  }
  if (id.startsWith('must-say:')) return line ? `Required wording is not confirmed for “${line.spokenText}”.` : 'Required wording is not confirmed.';
  if (id.startsWith('must-say-evidence:')) return line ? `Required wording has no supporting footage for “${line.spokenText}”.` : 'Required wording has no supporting footage.';
  if (id.startsWith('action:')) return action ? `Required action needs manual confirmation: “${action.text}”.` : 'A required action needs manual confirmation.';
  if (id === 'script:missing') return 'No spoken script lines are available to wrap.';
  if (id.startsWith('acknowledgement:')) return 'The previous Wrap anyway acknowledgement is no longer valid.';
  if (id.startsWith('evidence:')) return 'Evidence is not ready for an unqualified wrap.';
  return 'A previous wrap flag remains acknowledged for review.';
}

function buildFlags(
  currentFlagIds: readonly string[],
  lines: readonly WrapLineReport[],
  actions: readonly WrapActionReport[],
  acknowledgement: WrapAcknowledgement | null,
): WrapFlag[] {
  const lineById = new Map(lines.map(line => [line.id, line]));
  const actionById = new Map(actions.map(action => [action.id, action]));
  const flags: WrapFlag[] = currentFlagIds.map(id => {
    const lineId = id.split(':')[1];
    const actionId = id.startsWith('action:') ? id.slice('action:'.length) : undefined;
    const line = lineById.get(id.startsWith('coverage:') || id.startsWith('must-say:') || id.startsWith('must-say-evidence:') ? lineId : '');
    const action = actionId ? actionById.get(actionId) : undefined;
    const kind: WrapFlagKind = id.startsWith('coverage:') ? 'coverage'
      : id.startsWith('must-say') ? 'must-say'
        : id.startsWith('action:') ? 'action'
          : id.startsWith('evidence:') ? 'evidence'
            : id.startsWith('script:') ? 'script' : 'acknowledgement';
    return {
      id,
      kind,
      message: flagMessage(id, line, action),
      ...(line ? { lineId: line.id } : {}),
      ...(action ? { actionId: action.id } : {}),
      source: 'current' as const,
    };
  });
  for (const id of acknowledgement?.remainingFlags ?? []) {
    if (currentFlagIds.includes(id)) continue;
    flags.push({ id, kind: 'acknowledgement', message: flagMessage(id), source: 'acknowledged' });
  }
  return flags;
}

function projectMediaAvailable(project: Project): boolean {
  return typeof project.videoUri === 'string' && project.videoUri.trim().length > 0 && project.mediaMissing === false;
}

function contextValue(value: unknown): { state: string; value?: string | number | boolean | null } {
  if (value === undefined) return { state: 'missing' };
  if (value === null) return { state: 'null', value: null };
  if (typeof value === 'number' && !Number.isFinite(value)) return { state: 'invalid-number', value: String(value) };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { state: 'value', value };
  }
  return { state: typeof value };
}

/**
 * Stable binding for a creator acknowledgement.
 * The key includes only project decisions that can change what the report means.
 */
export function createWrapContextKey(
  project: Project,
  scriptLines: readonly { id: string; spokenText: string; actionCues: readonly { id: string; text: string; required: boolean; resolved: boolean }[] }[] = projectScriptLines(project),
): string {
  const spokenLines = scriptLines
    .filter(line => line.spokenText.trim().length > 0)
    .map(line => ({ lineId: line.id, spokenText: line.spokenText }));
  const actions = scriptLines.flatMap(line => line.actionCues.map(action => ({
    lineId: line.id,
    actionId: action.id,
    text: action.text,
    required: action.required,
    resolved: action.resolved,
  })));
  return `t1-wrap-context:v1:${JSON.stringify({
    sourceUri: contextValue(project.videoUri),
    duration: contextValue(project.duration),
    mediaMissing: contextValue(project.mediaMissing),
    spokenLines,
    actions,
  })}`;
}

function elapsedLabel(milliseconds: number | null): string {
  return milliseconds === null ? 'Unknown' : `${(milliseconds / 1000).toFixed(3)}s`;
}

/**
 * Format a supplied recording interval without inventing a start or end time.
 * The numeric value remains available on the report for exact consumers.
 */
export function formatWrapElapsed(milliseconds: number | null): string {
  return elapsedLabel(milliseconds);
}

/** Build an honest report from the existing conservative project review and a Tier 1 evidence snapshot. */
export function buildWrapReport(project: Project): WrapReport {
  const projectId = typeof project?.id === 'string' ? project.id : '';
  const mediaAvailable = !!project && projectMediaAvailable(project);
  let baseReview: ReturnType<typeof projectReview> | null = null;
  let scriptLines: ReturnType<typeof projectScriptLines> = [];
  let baselineError: string | null = null;
  try {
    scriptLines = projectScriptLines(project);
    baseReview = projectReview(project);
  } catch (error) {
    baselineError = error instanceof Error ? error.message : String(error);
  }

  const evidenceInspection = validateEvidence(projectId, scriptLines, project?.tier1Evidence);
  const evidence = evidenceInspection.valid ? evidenceInspection.value! : undefined;
  const acknowledgementInspection = inspectAcknowledgement(project?.wrapAcknowledgement);
  const acknowledgement = acknowledgementInspection.valid ? acknowledgementInspection.value : null;
  const evidenceError = baselineError ?? evidenceInspection.error ?? acknowledgementInspection.error ?? null;
  const evidenceStatus: EvidenceStatus = evidenceInspection.valid ? evidence!.status : 'unavailable';
  const evidenceProvider = evidenceInspection.valid ? evidence!.provider : null;
  const contextKey = project && !baselineError ? createWrapContextKey(project, scriptLines) : null;

  const evidenceByLine = new Map((evidence?.mustSay ?? []).map(result => [result.lineId, result]));
  const reasonsByTake = new Map<string, TakeReason[]>();
  for (const reason of evidence?.reasons ?? []) {
    const reasons = reasonsByTake.get(reason.takeId) ?? [];
    reasons.push(reason);
    reasonsByTake.set(reason.takeId, reasons);
  }
  const lines: WrapLineReport[] = (baseReview?.lines ?? scriptLines.map(line => ({
    id: line.id,
    spokenText: line.spokenText,
    status: 'unavailable' as const,
    selectedTakeId: null,
    candidateTakeIds: [],
    rejectedTakeIds: [],
    missingMediaTakeIds: [],
    matchedSegmentIds: [],
    actionCueIds: [],
    unresolvedRequiredActionCueIds: [],
    pendingReasons: [],
  }))).map(line => {
    const mustSay = evidenceByLine.get(line.id);
    const mustSayStatus: MustSayDisplayStatus = !mustSay
      ? 'unknown'
      : mustSay.required ? mustSay.status : 'not-required';
    const takeIds = [...line.candidateTakeIds, ...line.rejectedTakeIds]
      .filter((takeId, index, all) => all.indexOf(takeId) === index);
    const reasons = takeIds.flatMap(takeId => reasonsByTake.get(takeId) ?? []);
    const suppliedFootage = [
      ...(mustSay?.evidence ?? []),
      ...reasons.flatMap(reason => reason.footage ? [reason.footage] : []),
    ];
    const evidenceLinks = suppliedFootage
      .filter((footage, index, all) => all.findIndex(candidate => candidate.recordingId === footage.recordingId
        && candidate.t0 === footage.t0 && candidate.t1 === footage.t1) === index)
      .map(footage => ({
        ...footage,
        playable: mediaAvailable
          && footage.recordingId === projectId
          && typeof project.duration === 'number'
          && Number.isFinite(project.duration)
          && project.duration > 0
          && footage.t1 <= project.duration,
      }));
    const coverage: WrapCoverageStatus = !mediaAvailable && line.status === 'covered'
      ? 'pending'
      : line.status;
    return {
      id: line.id,
      spokenText: line.spokenText,
      coverage,
      mustSay: { required: mustSay?.required ?? null, status: mustSayStatus },
      takeCount: takeIds.length,
      takeIds,
      missingMediaTakeIds: line.missingMediaTakeIds.slice(),
      matchedSegmentIds: line.matchedSegmentIds.slice(),
      evidence: evidenceLinks,
      reasons,
    };
  });

  const actions: WrapActionReport[] = scriptLines.flatMap(line => line.actionCues.map(cue => ({
    id: cue.id,
    text: cue.text,
    required: cue.required,
    confirmed: cue.resolved,
    status: cue.resolved ? 'confirmed' as const : 'unresolved' as const,
    blocksWrap: cue.required && !cue.resolved,
  })));
  const requiredActions = actions.filter(action => action.required);
  const optionalActions = actions.filter(action => !action.required);

  const firstTakeStartedAt = evidence?.firstTakeStartedAt ?? null;
  const wrapRequestedAt = evidence?.wrapRequestedAt ?? null;
  const recordingToWrapMs = firstTakeStartedAt !== null && wrapRequestedAt !== null
    ? wrapRequestedAt - firstTakeStartedAt
    : null;

  const currentFlagIds: string[] = [];
  if (baselineError || !projectId) currentFlagIds.push('script:invalid');
  if (!scriptLines.some(line => line.spokenText.trim().length > 0)) currentFlagIds.push('script:missing');
  if (!evidenceInspection.valid) currentFlagIds.push('evidence:unavailable');
  else if (evidence!.status !== 'available') currentFlagIds.push(`evidence:${evidence!.status}`);
  if (evidenceInspection.valid) {
    for (const reason of evidence!.reasons) {
      if (reason.status !== 'available') currentFlagIds.push(`evidence:${reason.status}`);
    }
  }
  for (const line of lines) {
    if (line.coverage !== 'covered') currentFlagIds.push(`coverage:${line.id}`);
    if (line.mustSay.required !== true || line.mustSay.status === 'not-required') {
      if (line.mustSay.required === null) currentFlagIds.push(`must-say:${line.id}`);
    } else if (line.mustSay.status !== 'satisfied') {
      currentFlagIds.push(`must-say:${line.id}`);
    } else if (line.evidence.length === 0 || line.evidence.some(footage => !footage.playable)) {
      currentFlagIds.push(`must-say-evidence:${line.id}`);
    }
  }
  for (const action of requiredActions) {
    if (!action.confirmed) currentFlagIds.push(`action:${action.id}`);
  }

  const normalizedCurrentFlagIds = stableFlagIds(currentFlagIds);
  const acknowledgementValid = !!acknowledgement
    && evidenceInspection.valid
    && acknowledgement.evidenceRevision === evidence!.revision
    && !!contextKey
    && acknowledgement.contextKey === contextKey
    && arraysEqual(acknowledgement.remainingFlags, normalizedCurrentFlagIds);
  const staleAcknowledgement = !!acknowledgement && !acknowledgementValid;
  if (acknowledgementInspection.error) normalizedCurrentFlagIds.push('acknowledgement:invalid');
  else if (staleAcknowledgement) normalizedCurrentFlagIds.push('acknowledgement:stale');
  const currentFlagsWithAckGuard = stableFlagIds(normalizedCurrentFlagIds);
  const qualifiedAllClear = evidenceInspection.valid
    && evidence!.status === 'available'
    && !baselineError
    && mediaAvailable
    && lines.length > 0
    && lines.every(line => line.coverage === 'covered'
      && (line.mustSay.required === false
        || (line.mustSay.required === true && line.mustSay.status === 'satisfied'
          && line.evidence.length > 0 && line.evidence.every(footage => footage.playable))))
    && requiredActions.every(action => action.confirmed)
    && !staleAcknowledgement
    && !acknowledgementInspection.error
    && currentFlagsWithAckGuard.length === 0;
  const wrapAllowed = qualifiedAllClear || (acknowledgementValid && currentFlagsWithAckGuard.length > 0);
  const remainingFlags = stableFlagIds([...currentFlagsWithAckGuard, ...(acknowledgement?.remainingFlags ?? [])]);

  return {
    projectId,
    evidenceStatus,
    evidenceProvider,
    evidenceRevision: evidence?.revision ?? null,
    contextKey,
    evidenceError,
    mediaAvailable,
    lines,
    actions,
    requiredActions,
    optionalActions,
    firstTakeStartedAt,
    wrapRequestedAt,
    recordingToWrapMs,
    recordingToWrapLabel: elapsedLabel(recordingToWrapMs),
    currentFlagIds: currentFlagsWithAckGuard,
    remainingFlags,
    flags: buildFlags(currentFlagsWithAckGuard, lines, actions, acknowledgement),
    acknowledgement,
    acknowledgementValid,
    qualifiedAllClear,
    wrapAllowed,
    safeToWrap: qualifiedAllClear,
  };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Persist only an explicit creator acknowledgement of the current flags. */
export function acknowledgeWrapAnyway(project: Project, acknowledgedAt = Date.now()): Project {
  if (!validTimestamp(acknowledgedAt)) throw new RangeError('Wrap anyway acknowledgement time is invalid.');
  const report = buildWrapReport({ ...project, wrapAcknowledgement: undefined });
  if (!report.evidenceRevision || !report.contextKey || report.evidenceError) {
    throw new Error('Wrap anyway requires a valid evidence snapshot.');
  }
  if (report.currentFlagIds.length === 0) {
    throw new Error('Wrap anyway is only needed while flags remain.');
  }
  return {
    ...project,
    wrapAcknowledgement: {
      evidenceRevision: report.evidenceRevision,
      contextKey: report.contextKey,
      acknowledgedAt,
      remainingFlags: report.currentFlagIds.slice(),
    },
  };
}

/** Clear an acknowledgement when a creator intentionally starts a fresh review. */
export function clearWrapAcknowledgement(project: Project): Project {
  const next = { ...project };
  delete next.wrapAcknowledgement;
  return next;
}

export function isWrapAcknowledgementCurrent(report: WrapReport): boolean {
  return report.acknowledgementValid;
}

/** Compatibility aliases for consumers that use report-oriented names. */
export const createWrapReport = buildWrapReport;
export const persistWrapAnyway = acknowledgeWrapAnyway;

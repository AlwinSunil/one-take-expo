/**
 * Must-say metadata and evidence rules.
 *
 * This module is deliberately independent from persistence, capture and the
 * editor.  A line id is the identity boundary.  Required wording is derived
 * from the line's spoken text, while recognition evidence is always read from
 * raw final speech.  Caption corrections and bracketed directions never enter
 * the comparison.
 */

export const MUST_SAY_METADATA_VERSION = 1 as const;

export type MustSayStatus = 'off' | 'needed' | 'pending' | 'covered' | 'unavailable';

/** A structural input accepted from either the script-line or legacy line shape. */
export interface MustSayScriptLine {
  id: string;
  text?: string;
  spokenText?: string;
}

/**
 * Durable creator intent for one stable script line.
 *
 * `requiredText` is the current spoken wording snapshot.  `revision` advances
 * when its safely-normalized token sequence changes, which invalidates prior
 * recognition evidence without losing the creator's toggle choice.
 */
export interface MustSayRequirement {
  lineId: string;
  enabled: boolean;
  requiredText: string;
  revision: number;
}

/**
 * The versioned envelope the shared persistence owner can store in a draft or
 * project.  `archived` retains deleted line identity and intent for recovery;
 * it is never matched to a replacement line by position or text.
 */
export interface MustSayMetadata {
  version: typeof MUST_SAY_METADATA_VERSION;
  requirements: MustSayRequirement[];
  archived: MustSayRequirement[];
}

export type MustSayQuality = 'clean' | 'flub' | 'scratched';

/**
 * Recognition evidence supplied by capture or saved-audio refinement.
 * `text` is raw recognizer output.  A caller may include `manualCorrection`
 * for convenience, but this module intentionally ignores it.
 */
export interface MustSayTranscriptSegment {
  id: string;
  text: string;
  isFinal: boolean;
  t0?: number;
  t1?: number;
  takeId?: string;
  lineIds?: readonly string[];
  /**
   * Optional owner-authored context for one breath across consecutive lines.
   * `lineIds` alone is not enough to permit a substring match: this snapshot
   * must equal the complete normalized script context.
   */
  scriptContext?: {
    lineIds: readonly string[];
    normalizedText: string;
  };
  /** Revision snapshot used to prevent old reads satisfying edited wording. */
  requirementRevisions?: Readonly<Record<string, number>>;
  /** These optional fields are accepted from capture adapters; all are required for coverage. */
  playable?: boolean;
  mediaUri?: string | null;
  quality?: MustSayQuality;
  manualCorrection?: string | null;
}

export interface MustSayEvaluationInput {
  segments: readonly MustSayTranscriptSegment[];
  /** Native/live caption status. Unknown strings remain safe and unresolved. */
  recognitionStatus?: string;
  recognitionMessage?: string;
  /** Optional source-level media state supplied by the project owner. */
  mediaAvailable?: boolean;
}

export interface MustSayEvidence {
  /** Recognition provenance, never a claim that these timestamps are cut boundaries. */
  source: 'final-raw' | 'provisional-raw';
  lineId: string;
  requirementRevision: number | null;
  segmentIds: string[];
  takeIds: string[];
  rawText: string;
  t0: number | null;
  t1: number | null;
}

export interface MustSayEvaluation {
  lineId: string;
  revision: number;
  requiredText: string;
  normalizedRequiredText: string;
  status: MustSayStatus;
  /** Missing canonical tokens explain why a final read remains needed. */
  missingTokens: string[];
  /** Raw evidence for review; manual caption text is never included. */
  evidence: MustSayEvidence | null;
  reason: string;
}

/** Shared copy for the script editor and a read-only capture/review badge. */
export function mustSayToggleLabel(
  enabled: boolean,
  status: MustSayStatus = enabled ? 'needed' : 'off',
): string {
  if (!enabled || status === 'off') return 'Must-say off';
  if (status === 'covered') return 'Must-say covered';
  if (status === 'pending') return 'Must-say required · checking recognition';
  if (status === 'unavailable') return 'Must-say unavailable · review required';
  return 'Must-say required · exact wording needed';
}

/**
 * Safe normalization is intentionally narrow: Unicode compatibility folding,
 * lowercasing, sentence punctuation and whitespace normalization.  Decimal
 * separators, hyphens, apostrophes and negation are retained when they are
 * internal to a token.  It does not stem, remove stop words, convert number
 * words, use aliases/synonyms, or accept a fuzzy/partial match.
 */
export function normalizeMustSayText(text: string): string {
  if (typeof text !== 'string') throw new TypeError('must-say text must be a string');
  const normalized = text.normalize('NFKC').toLocaleLowerCase().replace(/’/g, "'");
  const output: string[] = [];
  let token = '';
  const chars = Array.from(normalized);
  const isWord = (value: string | undefined): boolean => value !== undefined && /[\p{L}\p{N}]/u.test(value);
  const isDigit = (value: string | undefined): boolean => value !== undefined && /\p{N}/u.test(value);
  const numericSymbols = new Set(['%', '$', '€', '£', '₹', '¥', '/', '+', '−']);
  const flush = () => {
    if (token) output.push(token);
    token = '';
  };

  chars.forEach((char, index) => {
    if (isWord(char)) {
      token += char;
      return;
    }
    const previous = chars[index - 1];
    const next = chars[index + 1];
    const internalApostrophe = char === "'" && isWord(previous) && isWord(next);
    const internalDecimal = (char === '.' || char === ',') && isDigit(previous) && isDigit(next);
    const internalHyphen = char === '-' && isWord(previous) && isWord(next);
    if (internalApostrophe || internalDecimal || internalHyphen) {
      token += char;
      return;
    }
    if (numericSymbols.has(char) || (char === '-' && isDigit(next) && !isWord(previous))) {
      flush();
      output.push(char);
      return;
    }
    flush();
  });
  flush();
  return output.join(' ');
}

/**
 * Prefer the parser's cue-free `spokenText`.  The fallback only removes closed
 * bracket pairs, so an unclosed/ambiguous bracket remains spoken until the
 * script editor resolves it explicitly.
 */
export function spokenTextForMustSayLine(line: MustSayScriptLine): string {
  validateId(line?.id, 'script line id');
  if (typeof line.spokenText === 'string') return line.spokenText.trim();
  if (typeof line.text !== 'string') return '';
  return line.text.replace(/\[([^\]\n]+)\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function createMustSayMetadata(lines: readonly MustSayScriptLine[]): MustSayMetadata {
  const seen = new Set<string>();
  const requirements = lines.map((line) => {
    validateId(line?.id, 'script line id');
    if (seen.has(line.id)) throw new Error(`duplicate script line id: ${line.id}`);
    seen.add(line.id);
    return {
      lineId: line.id,
      enabled: false,
      requiredText: spokenTextForMustSayLine(line),
      revision: 0,
    } satisfies MustSayRequirement;
  });
  return { version: MUST_SAY_METADATA_VERSION, requirements, archived: [] };
}

/**
 * Reconcile durable metadata against the current ordered lines.
 *
 * Existing entries are looked up only by stable line id.  A deleted entry is
 * archived, a new id starts disabled, and a changed safely-normalized phrase
 * increments its revision while retaining `enabled: true` if the creator had
 * marked it required.  Reordering therefore has no effect on intent.
 */
export function reconcileMustSayMetadata(
  metadata: MustSayMetadata | null | undefined,
  lines: readonly MustSayScriptLine[],
): MustSayMetadata {
  const base = metadata == null ? createMustSayMetadata([]) : validateMetadata(metadata);
  const seenLines = new Set<string>();
  const activeById = new Map(base.requirements.map((entry) => [entry.lineId, entry]));
  const archivedById = new Map(base.archived.map((entry) => [entry.lineId, entry]));
  const requirements: MustSayRequirement[] = [];
  const activeIds = new Set<string>();

  for (const line of lines) {
    validateId(line?.id, 'script line id');
    if (seenLines.has(line.id)) throw new Error(`duplicate script line id: ${line.id}`);
    seenLines.add(line.id);
    const currentText = spokenTextForMustSayLine(line);
    const previous = activeById.get(line.id) ?? archivedById.get(line.id);
    const changed = previous !== undefined
      && normalizeMustSayText(previous.requiredText) !== normalizeMustSayText(currentText);
    const next = previous
      ? {
          ...previous,
          requiredText: currentText,
          revision: previous.revision + (changed ? 1 : 0),
        }
      : {
          lineId: line.id,
          enabled: false,
          requiredText: currentText,
          revision: 0,
        };
    requirements.push(next);
    activeIds.add(line.id);
  }

  const archived: MustSayRequirement[] = [];
  const archivedIds = new Set<string>();
  for (const entry of base.archived.concat(base.requirements)) {
    if (activeIds.has(entry.lineId) || archivedIds.has(entry.lineId)) continue;
    archived.push({ ...entry });
    archivedIds.add(entry.lineId);
  }
  return { version: MUST_SAY_METADATA_VERSION, requirements, archived };
}

/** Change only creator intent.  The line entry and its revision remain stable. */
export function setMustSayEnabled(
  metadata: MustSayMetadata,
  lineId: string,
  enabled: boolean,
): MustSayMetadata {
  validateId(lineId, 'must-say line id');
  if (typeof enabled !== 'boolean') throw new TypeError('must-say enabled must be a boolean');
  const current = validateMetadata(metadata);
  const index = current.requirements.findIndex((entry) => entry.lineId === lineId);
  if (index < 0) throw new Error(`unknown must-say line: ${lineId}`);
  if (enabled && normalizeMustSayText(current.requirements[index].requiredText) === '') {
    throw new Error('an action-only line cannot be marked must-say');
  }
  const requirements = current.requirements.slice();
  requirements[index] = { ...requirements[index], enabled };
  return { ...current, requirements };
}

/**
 * Serialize only the versioned, durable fields.  Review evidence is derived
 * from the current transcript and is intentionally never persisted here.
 */
export function serializeMustSayMetadata(metadata: MustSayMetadata): string {
  const valid = validateMetadata(metadata);
  return JSON.stringify(valid);
}

/**
 * Missing storage is represented by `null`; a present but malformed envelope
 * throws so callers cannot silently turn a required line off after a read error.
 */
export function deserializeMustSayMetadata(serialized: string | null | undefined): MustSayMetadata | null {
  if (serialized == null || serialized === '') return null;
  if (typeof serialized !== 'string') throw new TypeError('must-say metadata must be serialized text');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('Must-say metadata is unreadable.');
  }
  return validateMetadata(parsed);
}

/**
 * Derive a strict wording verdict.  Final raw speech must equal the required
 * phrase unless the capture owner explicitly links the segment to multiple
 * consecutive lines, in which case the required canonical token sequence must
 * occur contiguously.  A paraphrase, a manual caption edit, a provisional
 * result, or non-playable/flubbed media cannot establish `covered`.
 */
export function evaluateMustSay(
  requirement: MustSayRequirement,
  input: MustSayEvaluationInput,
): MustSayEvaluation {
  const valid = validateRequirement(requirement, 'must-say requirement');
  const normalizedRequiredText = normalizeMustSayText(valid.requiredText);
  const base: Omit<MustSayEvaluation, 'status' | 'missingTokens' | 'evidence' | 'reason'> = {
    lineId: valid.lineId,
    revision: valid.revision,
    requiredText: valid.requiredText,
    normalizedRequiredText,
  };

  if (!valid.enabled) {
    return {
      ...base,
      status: 'off',
      missingTokens: [],
      evidence: null,
      reason: 'Exact wording is off; ordinary script coverage still applies.',
    };
  }
  if (!normalizedRequiredText) {
    return {
      ...base,
      status: 'needed',
      missingTokens: [],
      evidence: null,
      reason: 'This required line has no spoken words after cue removal.',
    };
  }
  if (!input || !Array.isArray(input.segments)) {
    throw new TypeError('must-say evaluation segments must be an array');
  }

  const target = normalizedRequiredText.split(' ');
  const candidates = input.segments.filter((segment) => {
    if (!segment || typeof segment.id !== 'string' || !segment.id.trim()) return false;
    if (typeof segment.text !== 'string' || typeof segment.isFinal !== 'boolean') return false;
    return !segment.lineIds || segment.lineIds.includes(valid.lineId);
  });
  const finals = candidates.filter((segment) => segment.isFinal);
  const provisional = candidates.filter((segment) => !segment.isFinal);
  const finalMatches = finals.filter((segment) => matchesRequiredPhrase(segment, valid.lineId, target));
  const provisionalMatches = provisional.filter((segment) => matchesRequiredPhrase(segment, valid.lineId, target));
  const currentFinalMatches = finalMatches.filter((segment) => isCurrentRequirementEvidence(segment, valid));
  const currentProvisionalMatches = provisionalMatches.filter((segment) => isCurrentRequirementEvidence(segment, valid));
  const finalMatch = currentFinalMatches.find((segment) => isUsableMedia(segment, input.mediaAvailable));
  const provisionalMatch = currentProvisionalMatches[0];

  if (finalMatch) {
    return {
      ...base,
      status: 'covered',
      missingTokens: [],
      evidence: buildEvidence('final-raw', valid, [finalMatch]),
      reason: 'The required wording appears in final raw speech from a playable clean take.',
    };
  }

  if (finalMatches.length > 0) {
    const finalMatch = currentFinalMatches[0];
    if (!finalMatch) {
      return {
        ...base,
        status: 'needed',
        missingTokens: [],
        evidence: buildEvidence('final-raw', valid, [finalMatches[0]]),
        reason: 'A matching raw read belongs to an older wording revision and cannot satisfy this line.',
      };
    }
    const evidence = buildEvidence('final-raw', valid, [finalMatch]);
    if (finalMatch.quality === 'flub' || finalMatch.quality === 'scratched') {
      return {
        ...base,
        status: 'needed',
        missingTokens: [],
        evidence,
        reason: 'The required wording was heard, but the matching take is not clean.',
      };
    }
    return {
      ...base,
      status: 'pending',
      missingTokens: [],
      evidence,
      reason: 'The wording was recognized, but explicit playable clean media evidence is unavailable.',
    };
  }

  const status = input.recognitionStatus?.toLocaleLowerCase() ?? '';
  const unavailable = status === 'unavailable' || status === 'error' || status === 'failed' || status === 'interrupted';
  const processing = status === 'preparing' || status === 'listening' || status === 'processing'
    || status === 'delayed' || status === 'stopping';
  const terminal = status === '' || status === 'idle' || status === 'ready' || status === 'stopped'
    || status === 'complete' || status === 'no-speech';
  const hasPendingEvidence = provisional.length > 0 || processing;

  if (provisionalMatch || hasPendingEvidence) {
    return {
      ...base,
      status: 'pending',
      missingTokens: missingTokens(target, provisionalMatch ? normalizeMustSayText(provisionalMatch.text).split(' ') : []),
      evidence: provisionalMatch ? buildEvidence('provisional-raw', valid, [provisionalMatch]) : null,
      reason: 'Recognition is still provisional; a final raw read is required before wrap.',
    };
  }
  if (unavailable || !terminal) {
    return {
      ...base,
      status: 'unavailable',
      missingTokens: missingTokens(target, finals.flatMap((segment) => normalizeMustSayText(segment.text).split(' '))),
      evidence: null,
      reason: input.recognitionMessage || 'Recognition is unavailable or in an unknown state; the required wording remains unresolved.',
    };
  }

  return {
    ...base,
    status: 'needed',
    missingTokens: missingTokens(target, finals.flatMap((segment) => normalizeMustSayText(segment.text).split(' '))),
    evidence: null,
    reason: 'No final raw speech contains the complete required wording.',
  };
}

/** Evidence from an older wording revision cannot satisfy a changed line. */
export function isCurrentMustSayEvidence(
  requirement: MustSayRequirement,
  evidence: MustSayEvidence | null | undefined,
): boolean {
  if (!evidence) return false;
  return evidence.lineId === requirement.lineId
    && evidence.requirementRevision === requirement.revision;
}

function validateMetadata(value: unknown): MustSayMetadata {
  if (!value || typeof value !== 'object') throw new Error('Must-say metadata is unreadable.');
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== MUST_SAY_METADATA_VERSION
    || !Array.isArray(candidate.requirements)
    || !Array.isArray(candidate.archived)) {
    throw new Error('Must-say metadata is unreadable.');
  }
  const requirements = candidate.requirements.map((entry, index) => validateRequirement(entry, `must-say requirement ${index + 1}`));
  const archived = candidate.archived.map((entry, index) => validateRequirement(entry, `archived must-say requirement ${index + 1}`));
  const ids = new Set<string>();
  for (const entry of requirements.concat(archived)) {
    if (ids.has(entry.lineId)) throw new Error('Must-say metadata contains duplicate line ids.');
    ids.add(entry.lineId);
  }
  return { version: MUST_SAY_METADATA_VERSION, requirements, archived };
}

function validateRequirement(value: unknown, label: string): MustSayRequirement {
  if (!value || typeof value !== 'object') throw new Error('Must-say metadata is unreadable.');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.lineId !== 'string' || !candidate.lineId.trim()
    || typeof candidate.enabled !== 'boolean'
    || typeof candidate.requiredText !== 'string'
    || !Number.isInteger(candidate.revision) || (candidate.revision as number) < 0) {
    throw new Error(`${label} is unreadable.`);
  }
  return {
    lineId: candidate.lineId,
    enabled: candidate.enabled,
    requiredText: candidate.requiredText,
    revision: candidate.revision as number,
  };
}

function validateId(id: unknown, label: string): asserts id is string {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError(`${label} must be non-empty`);
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

function matchesRequiredPhrase(
  segment: MustSayTranscriptSegment,
  lineId: string,
  target: readonly string[],
): boolean {
  const normalized = normalizeMustSayText(segment.text);
  if (!segment.lineIds || segment.lineIds.length <= 1 || !segment.scriptContext) {
    // Without explicit multi-line ownership, require the entire utterance to
    // equal the required phrase.  This prevents "do not <required phrase>"
    // and other surrounding dialogue from being accepted accidentally.
    return sameTokens(normalized ? normalized.split(' ') : [], target);
  }
  // A capture owner may explicitly link one final segment to consecutive lines
  // read in one breath.  Only then is a contiguous sub-sequence acceptable, and
  // only if the owner supplied the complete expected context.  Declared ids
  // without that context remain exact-whole-utterance matches above.
  const context = normalizeMustSayText(segment.scriptContext.normalizedText);
  const contextIds = segment.scriptContext.lineIds;
  return segment.lineIds.includes(lineId)
    && contextIds.includes(lineId)
    && sameTokens(normalized ? normalized.split(' ') : [], context ? context.split(' ') : [])
    && containsTokens(context, target);
}

function isCurrentRequirementEvidence(
  segment: MustSayTranscriptSegment,
  requirement: MustSayRequirement,
): boolean {
  return segment.requirementRevisions?.[requirement.lineId] === requirement.revision;
}

function containsTokens(haystack: string, needle: readonly string[]): boolean {
  const tokens = haystack ? haystack.split(' ') : [];
  if (needle.length === 0 || needle.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - needle.length; start += 1) {
    if (sameTokens(tokens.slice(start, start + needle.length), needle)) return true;
  }
  return false;
}

function missingTokens(target: readonly string[], observed: readonly string[]): string[] {
  const available = new Map<string, number>();
  for (const token of observed) available.set(token, (available.get(token) ?? 0) + 1);
  const missing: string[] = [];
  for (const token of target) {
    const count = available.get(token) ?? 0;
    if (count === 0) missing.push(token);
    else available.set(token, count - 1);
  }
  return missing;
}

function isUsableMedia(segment: MustSayTranscriptSegment, sourceAvailable?: boolean): boolean {
  const { t0, t1 } = segment;
  return sourceAvailable !== false
    && segment.playable === true
    && segment.quality === 'clean'
    && typeof segment.takeId === 'string'
    && segment.takeId.trim().length > 0
    && typeof segment.mediaUri === 'string'
    && segment.mediaUri.trim().length > 0
    && typeof t0 === 'number'
    && typeof t1 === 'number'
    && Number.isFinite(t0)
    && Number.isFinite(t1)
    && t0 >= 0
    && t1 > t0;
}

function buildEvidence(
  source: MustSayEvidence['source'],
  requirement: MustSayRequirement,
  segments: readonly MustSayTranscriptSegment[],
): MustSayEvidence {
  const times = segments.flatMap((segment) => [segment.t0, segment.t1])
    .filter((time): time is number => Number.isFinite(time));
  return {
    source,
    lineId: requirement.lineId,
    requirementRevision: segments[0]?.requirementRevisions?.[requirement.lineId] ?? -1,
    segmentIds: segments.map((segment) => segment.id),
    takeIds: [...new Set(segments.map((segment) => segment.takeId).filter((id): id is string => !!id))],
    rawText: segments.map((segment) => segment.text).join(' ').trim(),
    t0: times.length > 0 ? Math.min(...times) : null,
    t1: times.length > 0 ? Math.max(...times) : null,
  };
}

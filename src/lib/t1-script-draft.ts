import {
  restoreScriptDocument,
  serializeScriptDocument,
  type ScriptActionCue,
  type ScriptDocument,
  type ScriptDocumentLine,
} from './script-lines.ts';
import {
  deserializeMustSayMetadata,
  reconcileMustSayMetadata,
  serializeMustSayMetadata,
  type MustSayMetadata,
} from '../features/speech-control/must-say.ts';

/** The durable envelope version for the atomic Tier 1 script draft seam. */
export const T1_SCRIPT_DRAFT_SNAPSHOT_VERSION = 1 as const;

/**
 * One storage value contains the raw script and the derived structures that
 * carry stable line/cue identity and must-say intent.  The two derived values
 * stay serialized with their owner modules so this envelope does not create a
 * second script or must-say schema.
 */
export interface ScriptDraftSnapshot {
  version: typeof T1_SCRIPT_DRAFT_SNAPSHOT_VERSION;
  /** Project or draft identity chosen by the persistence owner. */
  identity: string;
  /** Raw text consumed by the camera route. */
  text: string;
  /** `serializeScriptDocument(document)` output. */
  structure: string;
  /** `serializeMustSayMetadata(metadata)` output. */
  mustSay: string;
}

export interface CreateScriptDraftSnapshotInput {
  identity: string;
  document: ScriptDocument;
  mustSay: MustSayMetadata;
}

export interface RestoreScriptDraftSnapshotOptions {
  /** Reject a snapshot written for another project or draft. */
  expectedIdentity?: string;
  /** Reject a snapshot whose raw script is no longer the caller's text. */
  expectedText?: string;
}

export interface RestoredScriptDraftSnapshot {
  version: typeof T1_SCRIPT_DRAFT_SNAPSHOT_VERSION;
  identity: string;
  text: string;
  document: ScriptDocument;
  mustSay: MustSayMetadata;
}

export type ScriptDraftSnapshotErrorCode =
  | 'malformed'
  | 'identity-mismatch'
  | 'text-mismatch'
  | 'structure-mismatch'
  | 'must-say-mismatch';

/** A present snapshot error is recoverable, but must not silently downgrade intent. */
export class ScriptDraftSnapshotError extends Error {
  readonly code: ScriptDraftSnapshotErrorCode;

  constructor(code: ScriptDraftSnapshotErrorCode, message: string) {
    super(message);
    this.name = 'ScriptDraftSnapshotError';
    this.code = code;
  }
}

interface StoredCue {
  text: string;
  required: boolean;
  status: ScriptActionCue['status'];
}

interface StoredLine {
  id: string;
  text: string;
  cues: StoredCue[];
}

interface StoredStructure {
  version: number;
  nextLineNumber: number;
  lines: StoredLine[];
  removedLines: StoredLine[];
}

interface ValidatedEnvelope {
  envelope: ScriptDraftSnapshot;
  structure: StoredStructure;
  document: ScriptDocument;
  mustSay: MustSayMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ScriptDraftSnapshotError('malformed', `${label} is missing or invalid.`);
  }
  return value;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ScriptDraftSnapshotError('malformed', `${label} is unreadable.`);
  }
}

function validateStoredCue(value: unknown, label: string): StoredCue {
  if (!isRecord(value)
    || typeof value.text !== 'string'
    || typeof value.required !== 'boolean'
    || (value.status !== 'pending' && value.status !== 'done' && value.status !== 'skipped')) {
    throw new ScriptDraftSnapshotError('structure-mismatch', `${label} is malformed.`);
  }
  return {
    text: value.text,
    required: value.required,
    status: value.status,
  };
}

function validateStoredLine(value: unknown, label: string): StoredLine {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || !value.id.trim()
    || typeof value.text !== 'string'
    || !Array.isArray(value.cues)) {
    throw new ScriptDraftSnapshotError('structure-mismatch', `${label} is malformed.`);
  }
  return {
    id: value.id,
    text: value.text,
    cues: value.cues.map((cue, index) => validateStoredCue(cue, `${label} cue ${index + 1}`)),
  };
}

function validateStoredStructure(serialized: unknown): StoredStructure {
  if (typeof serialized !== 'string') {
    throw new ScriptDraftSnapshotError('structure-mismatch', 'The script structure is missing.');
  }
  const parsed = parseJson(serialized, 'The script structure');
  const nextLineNumber = isRecord(parsed) ? parsed.nextLineNumber : undefined;
  if (!isRecord(parsed)
    || parsed.version !== 1
    || typeof nextLineNumber !== 'number'
    || !Number.isSafeInteger(nextLineNumber)
    || nextLineNumber < 1
    || !Array.isArray(parsed.lines)
    || !Array.isArray(parsed.removedLines)) {
    throw new ScriptDraftSnapshotError('structure-mismatch', 'The script structure is malformed.');
  }

  const lines = parsed.lines.map((line, index) => validateStoredLine(line, `Script line ${index + 1}`));
  const removedLines = parsed.removedLines.map((line, index) => validateStoredLine(line, `Removed script line ${index + 1}`));
  const ids = new Set<string>();
  for (const line of lines.concat(removedLines)) {
    if (ids.has(line.id)) {
      throw new ScriptDraftSnapshotError('structure-mismatch', `The script structure repeats line id ${line.id}.`);
    }
    ids.add(line.id);
  }
  return {
    version: 1,
    nextLineNumber,
    lines,
    removedLines,
  };
}

function sameStoredLine(stored: StoredLine, restored: ScriptDocumentLine): boolean {
  return stored.id === restored.id
    && stored.text === restored.text
    && stored.cues.length === restored.actionCues.length
    && stored.cues.every((cue, index) => {
      const restoredCue = restored.actionCues[index];
      return cue.text === restoredCue.text
        && cue.required === restoredCue.required
        && cue.status === restoredCue.status;
    });
}

/**
 * `restoreScriptDocument` intentionally falls back to a fresh parse for legacy
 * reads.  An atomic Tier 1 value cannot take that fallback because it could
 * erase cue identity and the must-say intent that was saved beside it.
 */
function restoreStrict(text: string, structureText: string, structure: StoredStructure): ScriptDocument {
  const document = restoreScriptDocument(text, structureText);
  if (document.text !== text
    || document.lines.length !== structure.lines.length
    || document.removedLines.length !== structure.removedLines.length
    || !document.lines.every((line, index) => sameStoredLine(structure.lines[index], line))
    || !document.removedLines.every((line, index) => sameStoredLine(structure.removedLines[index], line))) {
    throw new ScriptDraftSnapshotError(
      'structure-mismatch',
      'The script structure does not belong to the saved raw script.',
    );
  }
  return document;
}

function assertActiveMetadataIdentity(metadata: MustSayMetadata, document: ScriptDocument): void {
  const lineIds = new Set(document.lines.map(line => line.id));
  const removedLineIds = new Set(document.removedLines.map(line => line.id));
  // Active entries may refer to an intentionally deleted line until the
  // normal reconciliation step archives it.  An unrelated active id is stale.
  for (const entry of metadata.requirements) {
    if (!lineIds.has(entry.lineId) && !removedLineIds.has(entry.lineId)) {
      throw new ScriptDraftSnapshotError(
        'must-say-mismatch',
        `Must-say metadata has stale active line ${entry.lineId}.`,
      );
    }
  }
}

function preserveEnabledIntent(before: MustSayMetadata, after: MustSayMetadata): void {
  const beforeEnabled = new Set(
    before.requirements.concat(before.archived)
      .filter(entry => entry.enabled)
      .map(entry => entry.lineId),
  );
  const afterEnabled = new Set(
    after.requirements.concat(after.archived)
      .filter(entry => entry.enabled)
      .map(entry => entry.lineId),
  );
  for (const lineId of beforeEnabled) {
    if (!afterEnabled.has(lineId)) {
      throw new ScriptDraftSnapshotError(
        'must-say-mismatch',
        `Must-say requirement ${lineId} would be disabled while restoring the draft.`,
      );
    }
  }
}

/** Reconcile an in-memory edit before writing a new atomic snapshot. */
function reconcileMetadataForCreate(metadata: MustSayMetadata, document: ScriptDocument): MustSayMetadata {
  try {
    assertActiveMetadataIdentity(metadata, document);
    const reconciled = reconcileMustSayMetadata(metadata, document.lines);
    preserveEnabledIntent(metadata, reconciled);
    return reconciled;
  } catch (error) {
    if (error instanceof ScriptDraftSnapshotError) throw error;
    throw new ScriptDraftSnapshotError(
      'must-say-mismatch',
      error instanceof Error ? error.message : 'Must-say metadata is unreadable.',
    );
  }
}

/**
 * Validate a present atomic value without repairing it.  Reconciliation is
 * still run as a consistency check, but any change it would make means the
 * raw script and must-say value were not written atomically and the caller
 * must keep the old value or surface recovery instead of disabling a flag.
 */
function validateMetadataForDocument(metadata: MustSayMetadata, document: ScriptDocument): MustSayMetadata {
  const lineIds = new Set(document.lines.map(line => line.id));
  const metadataIds = new Set(metadata.requirements.concat(metadata.archived).map(entry => entry.lineId));
  assertActiveMetadataIdentity(metadata, document);
  for (const lineId of lineIds) {
    if (!metadataIds.has(lineId)) {
      throw new ScriptDraftSnapshotError(
        'must-say-mismatch',
        `Must-say metadata is missing script line ${lineId}.`,
      );
    }
  }

  try {
    const serialized = serializeMustSayMetadata(metadata);
    const reconciled = reconcileMustSayMetadata(metadata, document.lines);
    if (serializeMustSayMetadata(reconciled) !== serialized) {
      throw new ScriptDraftSnapshotError(
        'must-say-mismatch',
        'Must-say metadata does not match the saved script wording or revisions.',
      );
    }
    return metadata;
  } catch (error) {
    if (error instanceof ScriptDraftSnapshotError) throw error;
    throw new ScriptDraftSnapshotError(
      'must-say-mismatch',
      error instanceof Error ? error.message : 'Must-say metadata is unreadable.',
    );
  }
}

function readMustSay(serialized: unknown): MustSayMetadata {
  if (typeof serialized !== 'string') {
    throw new ScriptDraftSnapshotError('must-say-mismatch', 'Must-say metadata is missing.');
  }
  try {
    const metadata = deserializeMustSayMetadata(serialized);
    if (!metadata) throw new Error('Must-say metadata is missing.');
    return metadata;
  } catch (error) {
    throw new ScriptDraftSnapshotError(
      'must-say-mismatch',
      error instanceof Error ? error.message : 'Must-say metadata is unreadable.',
    );
  }
}

function validateEnvelope(value: unknown): ValidatedEnvelope {
  if (!isRecord(value)
    || value.version !== T1_SCRIPT_DRAFT_SNAPSHOT_VERSION
    || typeof value.text !== 'string') {
    throw new ScriptDraftSnapshotError('malformed', 'The Tier 1 script draft snapshot is malformed.');
  }
  const identity = requireNonEmptyString(value.identity, 'The script draft identity');
  const structureText = requireNonEmptyString(value.structure, 'The script structure');
  const envelope: ScriptDraftSnapshot = {
    version: T1_SCRIPT_DRAFT_SNAPSHOT_VERSION,
    identity,
    text: value.text,
    structure: structureText,
    mustSay: typeof value.mustSay === 'string' ? value.mustSay : '',
  };
  if (!envelope.mustSay) {
    throw new ScriptDraftSnapshotError('must-say-mismatch', 'Must-say metadata is missing.');
  }
  const structure = validateStoredStructure(envelope.structure);
  const document = restoreStrict(envelope.text, envelope.structure, structure);
  const mustSay = validateMetadataForDocument(readMustSay(envelope.mustSay), document);
  return { envelope, structure, document, mustSay };
}

/**
 * Build one atomic value from the current raw document and must-say intent.
 * Callers should reconcile their metadata before creating a new line; this
 * function still reconciles wording revisions so edits retain enabled intent.
 */
export function createScriptDraftSnapshot(input: CreateScriptDraftSnapshotInput): ScriptDraftSnapshot {
  if (!input || typeof input !== 'object') {
    throw new ScriptDraftSnapshotError('malformed', 'Script draft snapshot input is missing.');
  }
  const identity = requireNonEmptyString(input.identity, 'The script draft identity');
  if (!input.document || typeof input.document !== 'object') {
    throw new ScriptDraftSnapshotError('malformed', 'The script document is missing.');
  }
  if (typeof input.document.text !== 'string') {
    throw new ScriptDraftSnapshotError('structure-mismatch', 'The script document text is invalid.');
  }
  if (!input.mustSay || typeof input.mustSay !== 'object') {
    throw new ScriptDraftSnapshotError('must-say-mismatch', 'Must-say metadata is missing.');
  }
  let structure: string;
  try {
    structure = serializeScriptDocument(input.document);
  } catch (error) {
    throw new ScriptDraftSnapshotError(
      'structure-mismatch',
      error instanceof Error ? error.message : 'The script document is unreadable.',
    );
  }
  const validatedDocument = restoreStrict(input.document.text, structure, validateStoredStructure(structure));
  const metadata = reconcileMetadataForCreate(input.mustSay, validatedDocument);
  return {
    version: T1_SCRIPT_DRAFT_SNAPSHOT_VERSION,
    identity,
    text: validatedDocument.text,
    structure,
    mustSay: serializeMustSayMetadata(metadata),
  };
}

/** Validate and serialize the complete atomic envelope for persistence. */
export function serializeScriptDraftSnapshot(snapshot: ScriptDraftSnapshot): string {
  const validated = validateEnvelope(snapshot);
  return JSON.stringify({
    ...validated.envelope,
    structure: serializeScriptDocument(validated.document),
    mustSay: serializeMustSayMetadata(validated.mustSay),
  } satisfies ScriptDraftSnapshot);
}

/**
 * Restore a present atomic value.  A missing legacy value returns `null`, so
 * the caller can keep its existing raw string and legacy loading behavior.
 */
export function deserializeScriptDraftSnapshot(
  serialized: string | null | undefined,
  options: RestoreScriptDraftSnapshotOptions = {},
): RestoredScriptDraftSnapshot | null {
  if (serialized == null) return null;
  if (typeof serialized !== 'string') {
    throw new ScriptDraftSnapshotError('malformed', 'The Tier 1 script draft snapshot is not serialized text.');
  }
  const parsed = parseJson(serialized, 'The Tier 1 script draft snapshot');
  const validated = validateEnvelope(parsed);
  if (options.expectedIdentity !== undefined) {
    if (typeof options.expectedIdentity !== 'string' || !options.expectedIdentity.trim()) {
      throw new ScriptDraftSnapshotError('malformed', 'The expected script draft identity is invalid.');
    }
    if (validated.envelope.identity !== options.expectedIdentity) {
      throw new ScriptDraftSnapshotError(
        'identity-mismatch',
        'The Tier 1 script draft snapshot belongs to another project or draft.',
      );
    }
  }
  if (options.expectedText !== undefined) {
    if (typeof options.expectedText !== 'string') {
      throw new ScriptDraftSnapshotError('malformed', 'The expected raw script is invalid.');
    }
    if (validated.envelope.text !== options.expectedText) {
      throw new ScriptDraftSnapshotError(
        'text-mismatch',
        'The Tier 1 script draft snapshot is stale for the current raw script.',
      );
    }
  }
  return {
    version: T1_SCRIPT_DRAFT_SNAPSHOT_VERSION,
    identity: validated.envelope.identity,
    text: validated.envelope.text,
    document: validated.document,
    mustSay: validated.mustSay,
  };
}

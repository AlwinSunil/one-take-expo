/** Proposed transport seams. Producers retain ownership of recognition/vision semantics. */
export type EvidenceStatus = 'pending' | 'available' | 'uncertain' | 'unavailable' | 'failed';
export interface FootageReference {
  recordingId: string;
  /** Seconds relative to the original recording, never recognition arrival time. */
  t0: number;
  t1: number;
}
export interface TakeReason {
  id: string;
  takeId: string;
  message: string;
  status: EvidenceStatus;
  footage?: FootageReference;
}
export interface MustSayResult {
  lineId: string;
  required: boolean;
  status: 'satisfied' | 'missing' | 'pending' | 'uncertain' | 'unavailable';
  evidence: FootageReference[];
}
export interface ScratchEvent {
  id: string;
  takeId: string;
  commandSegmentId: string;
  state: 'proposed' | 'applied' | 'restored';
}
export interface CleanupDecision {
  id: string;
  suggestionId: string;
  footage: FootageReference;
  state: 'kept' | 'removed' | 'restored';
  /** Must be explicit creator review, never inferred from ASR timestamps. */
  boundariesReviewed: boolean;
}
export interface Tier1Evidence {
  version: 1;
  projectId: string;
  /** Immutable producer snapshot identity, changed whenever evidence changes. */
  revision: string;
  provider: 'fixture' | 'integrated';
  status: EvidenceStatus;
  reasons: TakeReason[];
  mustSay: MustSayResult[];
  scratchHistory: ScratchEvent[];
  cleanup: CleanupDecision[];
  /** Epoch milliseconds, supplied by capture. Missing means duration unknown. */
  firstTakeStartedAt?: number;
  wrapRequestedAt?: number;
}
export interface WrapAcknowledgement {
  evidenceRevision: string;
  acknowledgedAt: number;
  remainingFlags: string[];
}

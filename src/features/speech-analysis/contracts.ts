/** Producer DTOs only. Session 3 owns durable schemas and timeline application. */
export type EvidenceState = 'unknown' | 'provisional' | 'pending' | 'available' | 'unavailable';
export interface AnalysisScope {
  projectId: string;
  sourceId: string;
  scriptRevision: string;
  editRevision: string;
}
export interface ScriptSpan {
  id: string;
  lineId: string;
  scriptRevision: string;
  /** UTF-16 offsets into the captured line's spokenText, end exclusive. */
  start: number;
  end: number;
  text: string;
  order: number;
}
export interface SourceTiming {
  /** Seconds relative to the immutable original source, never timeline time. */
  t0: number;
  t1: number;
  provenance: 'recognition' | 'saved-audio' | 'independent-silence' | 'manual-review';
  uncertaintySeconds: number | null;
  /** Recognition timestamps alone cannot establish this. */
  verifiedBoundary: boolean;
}
export interface SpeechObservation extends SourceTiming {
  id: string;
  sourceId: string;
  takeId: string;
  text: string;
  isFinal: boolean;
  uncertain?: boolean;
  intentionalRepeat?: boolean;
}
export interface ImportantPoint {
  id: string;
  revision: number;
  span: ScriptSpan;
  text: string;
  reason: string;
  importance: 'important' | 'optional';
  origin: 'baseline' | 'creator';
  creatorEdited: boolean;
  removed: boolean;
  state: EvidenceState;
}
export interface PointMatch {
  pointId: string;
  pointRevision: number;
  scriptRevision: string;
  state: EvidenceState;
  verdict: 'covered' | 'missing' | 'partial' | 'mismatch';
  observationIds: string[];
  reason: string;
}
export interface PickupRequest {
  id: string;
  scope: AnalysisScope;
  pointIds: string[];
  lineIds: string[];
  points: ImportantPoint[];
  context: ScriptSpan[];
  unresolvedActionIds: string[];
}
export interface RangeProposal {
  id: string;
  scope: AnalysisScope;
  jobId: string;
  revision: number;
  state: EvidenceState;
  ranges: Array<SourceTiming & {
    id: string;
    sourceId: string;
    observationIds: string[];
    disposition: 'retained' | 'excluded';
    reason: string;
  }>;
  /** A whole proposal can be accepted; no automatic timeline mutation. */
  requiresCreatorAcceptance: true;
}
export function sameAnalysisScope(a: AnalysisScope, b: AnalysisScope): boolean {
  return a.projectId === b.projectId && a.sourceId === b.sourceId
    && a.scriptRevision === b.scriptRevision && a.editRevision === b.editRevision;
}

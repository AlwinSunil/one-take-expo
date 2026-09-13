import type { RevisionVector } from './t15-schema';

/** The entire captured vector is retained, including every source transcript revision. */
export interface AnalysisRequest {
  id: string;
  projectId: string;
  sourceId: string;
  attempt: number;
  idempotencyKey: string;
  base: RevisionVector;
  producer: string;
  producerVersion: string;
}
export interface AnalysisResult {
  id: string;
  jobId: string;
  attempt: number;
  projectId: string;
  sourceId: string;
  base: RevisionVector;
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  observationIds: string[];
  proposalIds: string[];
  reasonIds: string[];
  /** Full producer envelope or references to previously checkpointed pages. */
  payload?: unknown;
}
export type AnalysisStatus = 'queued' | 'running' | 'ready' | 'partial' | 'failed' | 'cancelled' | 'retryable';
export interface AnalysisJob {
  request: AnalysisRequest;
  status: AnalysisStatus;
  lease: string | null;
  resultId?: string;
  error?: string;
}
export interface StoredAnalysisResult {
  result: AnalysisResult;
  disposition: 'awaiting-review' | 'historical';
}

/** Opaque producer revision strings are adapters, never values parsed back from arbitrary text. */
export function producerScope(request: AnalysisRequest) {
  return { projectId: request.projectId, sourceId: request.sourceId,
    scriptRevision: String(request.base.scriptRevision), editRevision: String(request.base.timelineRevision),
    transcriptRevision: String(request.base.transcriptRevision[request.sourceId]) };
}

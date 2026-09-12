import type { ReviewDecision, ScriptLine } from './transcript-workflow';

export type Mode = 'script' | 'assisted';

export type GazeLabel = 'camera' | 'left' | 'right' | 'up' | 'down' | 'away';

export interface TranscriptSeg {
  id?: string;
  t0: number;
  t1: number;
  text: string;
  isFinal?: boolean;
  rawText?: string;
  correctedText?: string;
  manualCorrection?: string | null;
  revision?: number;
  needsListening?: boolean;
  source?: 'live' | 'refined';
  timingSource?: 'live-estimate' | 'saved-audio';
}

export interface SessionState {
  mode: Mode;
  script?: string;
  startedAt: number;
  transcript: TranscriptSeg[];
  silence: { t0: number; t1: number }[];
  fillers: { t: number; word: string }[];
  repeats: { a: TranscriptSeg; b: TranscriptSeg }[];
  gaze: { t: number; label: GazeLabel }[];
}

export interface Clip {
  id: string;
  t0: number;
  t1: number;
  label: string;
  recommended: boolean;
}

export interface Project {
  schemaVersion?: number;
  recordingStatus?: 'complete' | 'interrupted';
  duration?: number;
  mediaMissing?: boolean;
  recoveryMessage?: string;
  captionRevision?: number;
  scriptLines?: ScriptLine[];
  reviewDecisions?: ReviewDecision[];
  rawTranscript?: TranscriptSeg[];
  refinementCandidate?: TranscriptSeg[];
  previousReviewDecisions?: ReviewDecision[];
  cuts?: { t0: number; t1: number }[];
  cutsReviewed?: boolean;
  quietIntervals?: { t0: number; t1: number }[];
  refinement?: { status: 'running' | 'ready' | 'failed' | 'cancelled'; error?: string; model: string };
  trim?: { start: number; end: number };
  id: string;
  mode: Mode;
  script?: string;
  videoUri: string | null;
  clips: Clip[];
  transcript: TranscriptSeg[];
  createdAt: number;
}

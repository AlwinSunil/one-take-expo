import type { ReviewDecision, ScriptLine, TakeEvidence } from './transcript-workflow';

export type Mode = 'script' | 'assisted';

export type GazeLabel = 'camera' | 'left' | 'right' | 'up' | 'down' | 'away';

export interface TranscriptSeg {
  recordingId?: string;
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
  /** Raw versioned producer envelope. Never derive take identities during reopen. */
  speechControl?: import('./t1-speech-provider').T1SpeechProviderEnvelope;
  /** Exact accepted draft metadata; missing legacy snapshots remain supported. */
  scriptSnapshot?: import('./t1-script-draft').ScriptDraftSnapshot;
  framing?: { enabled: boolean; suggestions: import('./t1-framing').FramingSuggestion[] };
  tier1Evidence?: import('./t1-contracts').Tier1Evidence;
  wrapAcknowledgement?: import('./t1-contracts').WrapAcknowledgement;
  schemaVersion?: number;
  recordingStatus?: 'complete' | 'interrupted';
  duration?: number;
  mediaMissing?: boolean;
  /** File inventory refreshed by the store on load, never supplied by analysis. */
  availableMediaUris?: string[];
  recoveryMessage?: string;
  captionRevision?: number;
  scriptLines?: ScriptLine[];
  takes?: (TakeEvidence & { recordedAt?: number; eligibleLineIds?: string[] })[];
  recordings?: { id: string; mediaUri: string; duration: number; createdAt: number; evidenceStatus?: 'pending' | 'complete' }[];
  reviewSegments?: { uri: string; t0: number; t1: number; takeId?: string; crop?: import('./t1-framing').NativeFramingCrop; captions?: { t0: number; t1: number; text: string }[] }[];
  unavailableTakeIds?: string[];
  pickupRequest?: { lineIds: string[]; requestedAt: number };
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

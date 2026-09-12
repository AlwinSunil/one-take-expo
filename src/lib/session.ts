export type Mode = 'script' | 'assisted';

export type GazeLabel = 'camera' | 'left' | 'right' | 'up' | 'down' | 'away';

export interface TranscriptSeg {
  t0: number;
  t1: number;
  text: string;
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
  trim?: { start: number; end: number };
  id: string;
  mode: Mode;
  script?: string;
  videoUri: string | null;
  clips: Clip[];
  transcript: TranscriptSeg[];
  createdAt: number;
}

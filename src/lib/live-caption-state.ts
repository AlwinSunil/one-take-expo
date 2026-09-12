export interface CaptionUpdate {
  sessionId: string;
  sequence: number;
  text: string;
  isFinal: boolean;
}

export function captionState(sessionId: string): CaptionUpdate {
  return { sessionId, sequence: -1, text: '', isFinal: false };
}

export function reduceCaption(state: CaptionUpdate, update: CaptionUpdate): CaptionUpdate {
  if (update.sessionId !== state.sessionId || update.sequence <= state.sequence) return state;
  return update;
}

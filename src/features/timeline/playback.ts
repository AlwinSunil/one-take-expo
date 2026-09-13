/** Runtime preview slicing only. The authoritative resolver sequence is never changed. */
export type PreviewSegment = {
  clipId: string; sourceId: string; uri: string; t0: number; t1: number; outputT0: number; outputT1: number;
  captions?: { t0: number; t1: number; text: string }[];
  crop?: { left: number; right: number; bottom: number; top: number };
};

export function previewFromPosition(segments: readonly PreviewSegment[], outputPosition: number) {
  if (!Number.isFinite(outputPosition) || outputPosition < 0) throw new Error('Choose a valid preview position.');
  if (!segments.length) return { segments: [], offset: 0 };
  const duration = segments.at(-1)!.outputT1;
  const offset = outputPosition >= duration ? 0 : outputPosition;
  const index = segments.findIndex(segment => offset >= segment.outputT0 && offset < segment.outputT1);
  if (index < 0) throw new Error('This preview position is unavailable. Seek to an included clip.');
  const selected = segments.slice(index).map(segment => ({ ...segment, captions: segment.captions?.map(cue => ({ ...cue })) }));
  selected[0].t0 += offset - selected[0].outputT0;
  return { segments: selected, offset };
}

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';
export function shouldProtectTimelineBack(status: SaveStatus) { return status !== 'saved'; }

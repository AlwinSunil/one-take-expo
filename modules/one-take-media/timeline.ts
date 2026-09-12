export type ExportCut = { t0: number; t1: number };
export type ExportCaption = ExportCut & { text: string };
export type MappedExportCaption = { t0: number; t1: number; text: string };

const MAX_SOURCE_SECONDS = 24 * 60 * 60;

function validateInterval(value: ExportCut, label: string, index: number): void {
  if (!Number.isFinite(value.t0) || !Number.isFinite(value.t1) || value.t0 < 0 || value.t1 <= value.t0) {
    throw new Error(`Invalid ${label} interval at index ${index}`);
  }
  if (value.t1 > MAX_SOURCE_SECONDS) {
    throw new Error(`${label} interval exceeds the 24 hour source limit at index ${index}`);
  }
}

export function validateExportCuts(cuts: ExportCut[]): ExportCut[] {
  return cuts.map((cut, index) => {
    validateInterval(cut, 'cut', index);
    cuts.slice(0, index).forEach((previous, previousIndex) => {
      if (cut.t0 < previous.t1 && previous.t0 < cut.t1) {
        throw new Error(`Export cuts overlap at index ${index} (with index ${previousIndex})`);
      }
    });
    return cut;
  });
}

export function validateExportCaptions(captions: ExportCaption[]): ExportCaption[] {
  const ordered = [...captions].sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  let previous: ExportCaption | undefined;
  ordered.forEach((caption, index) => {
    validateInterval(caption, 'caption', index);
    if (!caption.text.trim()) throw new Error(`Caption text is blank at index ${index}`);
    if (previous && caption.t0 < previous.t1) {
      throw new Error(`Export captions overlap at index ${index}`);
    }
    previous = caption;
  });
  return ordered;
}

/**
 * Map original-source caption times to the output timeline. Explicit cuts
 * retain their supplied order, and captions crossing a removed gap are split
 * at each cut boundary.
 */
export function mapExportCaptions(
  captions: ExportCaption[],
  cuts: ExportCut[],
): MappedExportCaption[] {
  const orderedCaptions = validateExportCaptions(captions);
  const orderedCuts = validateExportCuts(cuts);
  if (orderedCuts.length === 0) return orderedCaptions.map(caption => ({ ...caption }));

  const mapped: MappedExportCaption[] = [];
  let outputOffset = 0;
  for (const cut of orderedCuts) {
    for (const caption of orderedCaptions) {
      const t0 = Math.max(cut.t0, caption.t0);
      const t1 = Math.min(cut.t1, caption.t1);
      if (t1 > t0) {
        mapped.push({
          t0: outputOffset + t0 - cut.t0,
          t1: outputOffset + t1 - cut.t0,
          text: caption.text,
        });
      }
    }
    outputOffset += cut.t1 - cut.t0;
  }
  return mapped;
}

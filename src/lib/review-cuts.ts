export function excludeInterval(cuts: readonly { t0: number; t1: number }[], removal: { t0: number; t1: number }) {
  if (!Number.isFinite(removal.t0) || !Number.isFinite(removal.t1) || removal.t0 < 0 || removal.t1 <= removal.t0) throw new Error('Invalid removal interval');
  return cuts.flatMap(cut => {
    if (removal.t1 <= cut.t0 || removal.t0 >= cut.t1) return [cut];
    const retained = [];
    if (removal.t0 > cut.t0) retained.push({ t0: cut.t0, t1: removal.t0 });
    if (removal.t1 < cut.t1) retained.push({ t0: removal.t1, t1: cut.t1 });
    return retained;
  });
}

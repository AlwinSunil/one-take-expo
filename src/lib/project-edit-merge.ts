import type { Project } from './session';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keyed = (value: unknown[]): value is (Record<string, unknown> & { id: string })[] => value.every(item => object(item) && typeof item.id === 'string') && new Set(value.map(item => (item as { id: string }).id)).size === value.length;

/** Apply only the fields changed by this render, retaining intervening edits. */
function merge(base: unknown, current: unknown, next: unknown): unknown {
  if (equal(base, next)) return current;
  if (object(base) && object(current) && object(next)) {
    const result = { ...current };
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
      if (equal(base[key], next[key])) continue;
      if (!(key in next)) delete result[key];
      else result[key] = merge(base[key], current[key], next[key]);
    }
    return result;
  }
  if (Array.isArray(base) && Array.isArray(current) && Array.isArray(next) && keyed(base) && keyed(current) && keyed(next)) {
    // This edit owns its explicit order/removals, while unchanged rows retain current fields.
    const rows = next.map(item => {
      const previous = base.find(row => row.id === item.id);
      const latest = current.find(row => row.id === item.id);
      // A callback from an older render cannot restore an identity removed since then.
      if (previous && !latest) return undefined;
      return merge(previous, latest, item);
    }).filter(item => item !== undefined);
    const added = current.filter(item => !base.some(row => row.id === item.id) && !next.some(row => row.id === item.id));
    return [...rows, ...added];
  }
  return next;
}

export function mergeProjectEdit(base: Project, current: Project, next: Project): Project {
  if (base.id !== current.id || next.id !== current.id) throw new Error('This edit belongs to another project.');
  return merge(base, current, next) as Project;
}

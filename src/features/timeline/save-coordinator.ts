/** UI save coordination. All durable writes belong to the injected owner API. */
export function createTimelineSaveCoordinator<T>(initial: T, persist: (value: T, operationId: string) => Promise<void>, mintId: () => string) {
  let current = initial;
  let generation = 0;
  let savedGeneration = 0;
  let pending: Promise<void> | null = null;
  let attempt: { generation: number; value: T; operationId: string } | null = null;
  let error: string | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  return {
    stage(value: T) { current = value; generation++; error = null; notify(); },
    read() { return { value: current, status: pending ? 'saving' as const : error ? 'error' as const : generation === savedGeneration ? 'saved' as const : 'dirty' as const, error }; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save(): Promise<void> {
      if (pending) return pending;
      if (generation === savedGeneration) return Promise.resolve();
      error = null;
      // Start in a microtask so pending is visible before invoking an injected writer.
      pending = Promise.resolve().then(async () => {
        while (generation !== savedGeneration) {
          // An uncertain failed write is retried with its original payload and ID first.
          attempt ??= { generation, value: current, operationId: mintId() };
          await persist(attempt.value, attempt.operationId);
          savedGeneration = attempt.generation;
          attempt = null;
        }
      }).catch(reason => {
        error = reason instanceof Error ? reason.message : String(reason);
        throw reason;
      }).finally(() => { pending = null; notify(); });
      notify();
      return pending;
    },
  };
}

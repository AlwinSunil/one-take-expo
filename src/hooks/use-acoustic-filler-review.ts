import { useEffect, useRef, useState } from 'react';
import Captions from '../../modules/one-take-captions';
import { validateAcousticFillerResult } from '@/features/speech-control/acoustic-fillers';
import { acousticFillerSources, replaceAcousticFillerReview, type AcousticFillerReview } from '@/lib/acoustic-filler-review';
import type { Project } from '@/lib/session';

type AnalysisToken = { id: string; projectId: string; sourceId: string; uri: string; duration?: number; revision: number; cancelled?: boolean };

export function useAcousticFillerReview(project: Project, onChange: (project: Project) => Promise<void> | void) {
  const sources = acousticFillerSources(project);
  const [selection, setSelection] = useState(sources[0]?.id ?? '');
  const sourceId = sources.some(source => source.id === selection) ? selection : sources[0]?.id ?? '';
  const source = sources.find(item => item.id === sourceId);
  const [capability, setCapability] = useState<{ available: boolean | null; reason?: string }>({ available: null });
  const [transientError, setTransientError] = useState<string>();
  const [active, setActive] = useState(false);
  const latest = useRef({ project, onChange });
  latest.current = { project, onChange };
  const mounted = useRef(true);
  const revisions = useRef(new Map<string, number>());
  const dismissalQueue = useRef(Promise.resolve());
  const job = useRef<AnalysisToken | null>(null);
  const row = project.acousticFillerReviews?.find(item => item.sourceId === sourceId && item.sourceUri === source?.uri
    && (item.sourceDuration === undefined || item.sourceDuration === source?.duration));

  useEffect(() => {
    mounted.current = true;
    if (!__DEV__ || !Captions?.acousticFillerStatus) {
      setCapability({ available: false, reason: 'Requires the Android acoustic filler development build.' });
    } else {
      void Captions.acousticFillerStatus().then(value => {
        if (mounted.current) setCapability(value);
      }).catch(error => {
        if (mounted.current) setCapability({ available: false, reason: String(error) });
      });
    }
    return () => {
      mounted.current = false;
      const previous = job.current;
      job.current = null;
      if (previous) void Captions?.cancelAcousticFillers(previous.id).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const previous = job.current;
    if (previous && (previous.projectId !== project.id || previous.sourceId !== sourceId || previous.uri !== source?.uri || previous.duration !== source?.duration)) {
      job.current = null;
      setActive(false);
      void Captions?.cancelAcousticFillers(previous.id).catch(() => {});
    }
    setTransientError(undefined);
  }, [project.id, sourceId, source?.uri, source?.duration]);

  async function save(next: AcousticFillerReview) {
    const current = latest.current;
    const updated = replaceAcousticFillerReview(current.project, next);
    latest.current = { ...current, project: updated };
    await current.onChange(updated);
  }

  async function analyze() {
    if (!__DEV__ || !capability.available || !Captions || !source || job.current) return;
    const current = latest.current.project;
    const revisionKey = `${current.id}:${source.id}`;
    const revision = Math.max(current.acousticFillerReviews?.find(item => item.sourceId === source.id)?.revision ?? 0, revisions.current.get(revisionKey) ?? 0) + 1;
    revisions.current.set(revisionKey, revision);
    const token: AnalysisToken = { id: `filler:${Date.now()}:${Math.random().toString(36).slice(2)}`, projectId: current.id,
      sourceId: source.id, uri: source.uri, duration: source.duration, revision };
    const pending: AcousticFillerReview = { sourceId: source.id, sourceUri: source.uri, sourceDuration: source.duration, revision,
      status: 'running', dismissedEventIds: [] };
    job.current = token;
    setActive(true);
    setTransientError(undefined);
    const isCurrent = () => mounted.current && job.current === token && !token.cancelled && latest.current.project.id === token.projectId
      && acousticFillerSources(latest.current.project).some(item => item.id === token.sourceId && item.uri === token.uri && item.duration === token.duration);
    let resultPublished = false;
    try {
      await save(pending);
      if (!isCurrent()) return;
      const result = validateAcousticFillerResult(await Captions.analyzeAcousticFillers(token.id, source.id, source.uri, revision),
        { sourceId: source.id, analysisRevision: revision });
      if (!isCurrent()) return;
      resultPublished = true;
      if (result.status !== 'ready') {
        await save({ ...pending, status: 'failed', result, error: result.unavailableReason ?? 'Acoustic analysis is unavailable.' });
        return;
      }
      await save({ ...pending, status: 'ready', result });
    } catch (error) {
      if (isCurrent()) {
        const message = error instanceof Error ? error.message : String(error);
        setTransientError(message);
        if (!resultPublished) {
          try { await save({ ...pending, status: 'failed', error: message }); } catch { /* Editor exposes the save failure. */ }
        }
      }
    } finally {
      if (job.current === token && !token.cancelled) { job.current = null; if (mounted.current) setActive(false); }
    }
  }

  async function cancel() {
    const previous = job.current;
    if (!previous || previous.cancelled) return;
    previous.cancelled = true;
    try {
      await Captions?.cancelAcousticFillers(previous.id);
      if (mounted.current && job.current === previous && latest.current.project.id === previous.projectId) {
        await save({ sourceId: previous.sourceId, sourceUri: previous.uri, sourceDuration: previous.duration, revision: previous.revision,
          status: 'cancelled', dismissedEventIds: [] });
      }
    } catch (error) { if (mounted.current) setTransientError(String(error)); }
    finally {
      if (job.current === previous) { job.current = null; if (mounted.current) setActive(false); }
    }
  }

  async function applyDismissed(eventId: string, dismissed: boolean) {
    const current = latest.current.project.acousticFillerReviews?.find(item => item.sourceId === sourceId && item.sourceUri === source?.uri
    && (item.sourceDuration === undefined || item.sourceDuration === source?.duration));
    if (!current?.result?.events.some(event => event.id === eventId) || current.status !== 'ready') return;
    const ids = new Set(current.dismissedEventIds);
    if (dismissed) ids.add(eventId); else ids.delete(eventId);
    try { await save({ ...current, dismissedEventIds: [...ids] }); }
    catch (error) { if (mounted.current) setTransientError(String(error)); }
  }

  function setDismissed(eventId: string, dismissed: boolean) {
    const pending = dismissalQueue.current.catch(() => {}).then(() => {
      if (!mounted.current || job.current) return;
      return applyDismissed(eventId, dismissed);
    });
    dismissalQueue.current = pending;
    return pending;
  }

  return { available: capability.available, unavailableReason: capability.reason, sources, sourceId,
    setSourceId: setSelection, status: active ? 'running' as const : row?.status === 'running' ? 'failed' as const : row?.status ?? 'idle' as const,
    error: transientError ?? row?.error ?? (row?.status === 'running' && !active ? 'Analysis was interrupted. Try again.' : undefined),
    result: row?.result, dismissedEventIds: row?.dismissedEventIds ?? [], analyze, cancel, setDismissed };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, View } from 'react-native';

import media, { type MediaExport } from '../../../modules/one-take-media';
import type { Project } from '@/lib/session';
import { getSetting, saveSetting, registerProjectWork, assertProjectExists } from '@/lib/store';
import { buildExportPlan, ExportPlanError, type ExportPlan } from '@/lib/export-plan';

const ACTIVE_STATUSES = new Set<MediaExport['status']>(['queued', 'running']);
const EXPORT_POLL_MS = 600;

export function ExportControls({ project, start, end, onMessage, framingEnabled = false }: {
  project: Project;
  framingEnabled?: boolean;
  start: number;
  end: number;
  onMessage?: (text: string) => void;
}) {
  const [job, setJob] = useState<MediaExport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const jobId = useRef<string | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const currentKey = `export:${project.id}`;
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;
  const latestJob = useRef<MediaExport | null>(null);
  latestJob.current = job;
  const latestProject = useRef(project);
  latestProject.current = project;
  const latestTrim = useRef({ start, end });
  latestTrim.current = { start, end };
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  const announce = useCallback((text: string) => {
    if (!mounted.current) return;
    setMessage(text);
    onMessageRef.current?.(text);
  }, []);

  const clearPoll = useCallback(() => {
    if (poll.current) clearTimeout(poll.current);
    poll.current = null;
  }, []);

  const refresh = useCallback(async (id: string) => {
    if (!media) {
      if (mounted.current) {
        setLoading(false);
        announce('Video export requires the Android development build.');
      }
      return;
    }
    try {
      const next = await media.getExport(id);
      if (!mounted.current || jobId.current !== id) return;
      latestJob.current = next;
      setJob(next);
      setLoading(false);
      clearPoll();
      if (ACTIVE_STATUSES.has(next.status)) {
        poll.current = setTimeout(() => { void refresh(id); }, EXPORT_POLL_MS);
      }
    } catch (error) {
      if (!mounted.current || jobId.current !== id) return;
      clearPoll();
      jobId.current = null;
      latestJob.current = null;
      setJob(null);
      setLoading(false);
      await saveSetting(currentKeyRef.current, '').catch(() => {});
      announce(`The saved export could not be reopened: ${errorMessage(error)}`);
    }
  }, [announce, clearPoll]);

  useEffect(() => {
    mounted.current = true;
    clearPoll();
    jobId.current = null;
    latestJob.current = null;
    setJob(null);
    setLoading(true);
    setMessage('');
    let active = true;
    getSetting(currentKey).then((savedId) => {
      if (!active || !mounted.current) return;
      const id = savedId.trim() || null;
      jobId.current = id;
      if (id) void refresh(id);
      else setLoading(false);
    }).catch((error) => {
      if (!active || !mounted.current) return;
      setLoading(false);
      announce(`Could not recover the previous export: ${errorMessage(error)}`);
    });
    return () => {
      active = false;
      mounted.current = false;
      clearPoll();
    };
  }, [announce, clearPoll, currentKey, refresh]);

  const selection = useMemo(() => {
    const cuts = project.reviewSegments ?? (project.cuts?.length === 0 ? [{ t0: 0, t1: project.duration ?? end }] : project.cuts ?? [{ t0: start, t1: end }]);
    const duration = Array.isArray(cuts)
      ? cuts.reduce((total, cut) => total + (Number.isFinite(cut?.t0) && Number.isFinite(cut?.t1) ? Math.max(0, cut.t1 - cut.t0) : 0), 0)
      : 0;
    const label = project.reviewSegments ? 'reviewed sequence' : project.cuts?.length === 0 ? 'complete source' : project.cuts !== undefined ? 'saved cuts' : `${formatSeconds(start)}–${formatSeconds(end)}`;
    return { duration, label };
  }, [end, project.cuts, project.reviewSegments, project.duration, start]);
  const cutsNeedReview = (Array.isArray(project.reviewSegments) || (Array.isArray(project.cuts)
    && project.cuts.length > 0))
    && !(project as Project & { cutsReviewed?: boolean }).cutsReviewed;

  function planForExport(): ExportPlan | null {
    try {
      const current = latestTrim.current;
      return buildExportPlan(latestProject.current, current.start, current.end, framingEnabled && media?.supportsFraming === true);
    } catch (error) {
      const messageText = errorMessage(error);
      if (error instanceof ExportPlanError && error.code === 'caption-overlap') {
        Alert.alert(
          'Caption timing needs a recheck',
          'The saved captions overlap, so One Take will not guess their render order. Recheck the saved audio, then try export again.',
          [{ text: 'OK', style: 'cancel' }],
        );
      } else {
        Alert.alert('Export unavailable', messageText, [{ text: 'OK', style: 'cancel' }]);
      }
      announce(messageText);
      return null;
    }
  }

  function requestExport() {
    if (loadingRef.current || busyRef.current || ACTIVE_STATUSES.has(latestJob.current?.status ?? 'cancelled')) return;

    if (latestProject.current.refinement?.status === 'running') {
      Alert.alert(
        'Audio recheck in progress',
        'Wait for the saved-audio recheck for better caption timing, or export the current captions with their existing timing.',
        [
          { text: 'Wait', style: 'cancel' },
          { text: 'Export current captions', onPress: () => confirmCaptionTiming() },
        ],
      );
      return;
    }
    confirmCaptionTiming();
  }

  function confirmCaptionTiming(estimatedConfirmed = false) {
    const plan = planForExport();
    if (!plan) return;
    if (!plan.hasEstimatedCaptions || estimatedConfirmed) {
      void startExport(plan);
      return;
    }
    Alert.alert(
      'Live caption timing is approximate',
      'These captions were timed while recording. The words may be readable, but their frame timing is not guaranteed. Recheck the saved audio first, or explicitly use the current estimates.',
      [
        { text: 'Recheck first', style: 'cancel', onPress: () => announce('Recheck saved audio before exporting frame-aligned captions.') },
        // Rebuild after the alert. A refinement can finish, or the editor can
        // change the trim, while this confirmation is open. If the latest
        // plan still uses estimated timing, this callback is the explicit
        // confirmation immediately preceding the export request.
        { text: 'Use current captions', onPress: () => { confirmCaptionTiming(true); } },
      ],
    );
  }

  async function startExport(plan: ExportPlan) {
    if (!media || busyRef.current || ACTIVE_STATUSES.has(latestJob.current?.status ?? 'cancelled')) {
      if (!media) announce('Video export requires the Android development build.');
      return;
    }
    busyRef.current = true;
    const id = makeExportId(latestProject.current.id);
    setBusy(true);
    setMessage('Starting export…');
    jobId.current = id;
    const initial: MediaExport = { id, status: 'queued', progress: 0 };
    latestJob.current = initial;
    setJob(initial);
    const projectId = latestProject.current.id;
    const exportKey = `export:${projectId}`;
    let deleted = false;
    let finishStart!: () => void;
    const started = new Promise<void>(resolve => { finishStart = resolve; });
    let unregister = () => {};
    try {
      unregister = registerProjectWork(projectId, async () => {
        deleted = true;
        await started;
        await media!.cancelExport(id);
      });
      await assertProjectExists(projectId);
      // Persist before starting the service so a process death after the
      // request is accepted still leaves a job id for recovery.
      await saveSetting(exportKey, id);
      const historyKey = `exports:${projectId}`;
      const history = JSON.parse(await getSetting(historyKey) || '[]') as string[];
      await saveSetting(historyKey, JSON.stringify([...new Set([...history, id])]));
      if (deleted) throw new Error('This project is being deleted.');
      await media.startExport({ id, sourceUri: plan.sourceUri, cuts: plan.cuts, captions: plan.captions, segments: plan.segments });
      finishStart();
      if (deleted || !mounted.current || jobId.current !== id) return;
      announce('Export queued. You can leave this screen while it runs.');
      busyRef.current = false;
      setBusy(false);
      await refresh(id);
    } catch (error) {
      if (jobId.current === id) {
        clearPoll();
        jobId.current = null;
        latestJob.current = null;
        setJob(null);
        await saveSetting(exportKey, '').catch(() => {});
      }
      busyRef.current = false;
      setBusy(false);
      announce(`Export could not start: ${errorMessage(error)}`);
    } finally {
      finishStart();
      unregister();
    }
  }

  async function cancel() {
    const id = jobId.current;
    if (!media || !id || !ACTIVE_STATUSES.has(latestJob.current?.status ?? 'cancelled')) return;
    clearPoll();
    setBusy(true);
    try {
      await media.cancelExport(id);
      const cancelled = await media.getExport(id);
      latestJob.current = cancelled;
      setJob(cancelled);
      announce(cancelled.status === 'completed' ? 'Export finished before cancellation. Your output is ready.' : 'Export cancelled. The original video remains available.');
    } catch (error) {
      announce(`Export could not be cancelled: ${errorMessage(error)}`);
      await refresh(id);
    } finally {
      setBusy(false);
    }
  }

  async function saveToGallery() {
    const id = jobId.current;
    if (!media || !id || latestJob.current?.status !== 'completed') return;
    setBusy(true);
    try {
      await media.saveToGallery(id);
      announce('Export saved to the gallery.');
    } catch (error) {
      announce(`Could not save the export to the gallery: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function share(open = false) {
    const id = jobId.current;
    if (!media || !id || latestJob.current?.status !== 'completed') return;
    setBusy(true);
    try {
      if (open) await media.openExport(id);
      else await media.shareExport(id);
      announce(open ? 'Video player opened.' : 'Share sheet opened.');
    } catch (error) {
      announce(`Could not ${open ? 'open' : 'share'} the export: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const status = job?.status;
  const active = ACTIVE_STATUSES.has(status ?? 'cancelled');
  const canRetry = status === 'failed' || status === 'cancelled' || status === 'interrupted';
  const statusText = cutsNeedReview ? 'Review and accept each cut before exporting.'
    : loading ? 'Checking previous export…'
    : active ? `${status === 'queued' ? 'Queued' : 'Exporting'} · ${Math.round(job?.progress ?? 0)}%`
      : status === 'completed' ? 'Ready to save or share'
        : status === 'failed' ? `Export failed${job?.error ? ` · ${job.error}` : ''}`
          : status === 'interrupted' ? 'Export interrupted · retry available'
            : status === 'cancelled' ? 'Export cancelled'
              : 'Create a captioned copy';

  return <View className="border-t border-neutral-800 mt-3 pt-3">
    <View className="flex-row items-center justify-between">
      <View className="flex-1 pr-3">
        <Text className="text-white font-semibold">Export</Text>
        <Text className="text-neutral-400 text-xs mt-1" numberOfLines={2}>{statusText}</Text>
      </View>
      {active && <ActivityIndicator color="#fbbf24" />}
    </View>
    <Text className="text-neutral-500 text-xs mt-2">
      {selection.label} · {formatSeconds(selection.duration)} output · original video is preserved
    </Text>
    <Text className="text-neutral-500 text-xs mt-2">Android · 720 × 1280 SDR MP4; source fits inside the frame. White captions on a dark background.</Text>
    {project.refinement?.status === 'running' && !active && <Text className="text-amber-200 text-xs mt-2">Saved-audio caption recheck is running. Export can wait or use current captions.</Text>}
    <View className="flex-row flex-wrap gap-2 mt-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={canRetry ? 'Retry video export' : 'Export video'}
        disabled={loading || busy || active || (!project.videoUri && !project.reviewSegments?.length) || cutsNeedReview}
        onPress={requestExport}
        className="bg-white rounded-lg px-4 py-3 disabled:opacity-40"
      >
        <Text className="text-black text-xs font-bold">{canRetry ? 'Retry export' : 'Export video'}</Text>
      </Pressable>
      {active && <Pressable accessibilityRole="button" accessibilityLabel="Cancel video export" disabled={busy} onPress={() => { void cancel(); }} className="bg-neutral-800 rounded-lg px-4 py-3 disabled:opacity-40">
        <Text className="text-white text-xs">Cancel</Text>
      </Pressable>}
      {status === 'completed' && <>
        <Pressable accessibilityRole="button" accessibilityLabel="Open exported video" disabled={busy} onPress={() => { void share(true); }} className="bg-neutral-800 rounded-lg px-4 py-3 disabled:opacity-40">
          <Text className="text-white text-xs">Open video</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Save exported video to gallery" disabled={busy} onPress={() => { void saveToGallery(); }} className="bg-neutral-800 rounded-lg px-4 py-3 disabled:opacity-40">
          <Text className="text-white text-xs">Save to gallery</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Share exported video" disabled={busy} onPress={() => { void share(); }} className="bg-neutral-800 rounded-lg px-4 py-3 disabled:opacity-40">
          <Text className="text-white text-xs">Share</Text>
        </Pressable>
      </>}
    </View>
    {!!job?.error && (status === 'failed' || status === 'interrupted') && <Text accessibilityRole="alert" className="text-red-300 text-xs mt-2">{job.error}</Text>}
    {!!message && <Text accessibilityRole="alert" className="text-neutral-200 text-xs mt-2">{message}</Text>}
  </View>;
}

function makeExportId(projectId: string): string {
  const safe = projectId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 55) || 'project';
  return `${safe}-${Date.now()}`;
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

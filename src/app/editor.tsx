import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { router, useNavigation, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoThumbnail } from 'expo-video';
import { ArrowLeft, Pause, Play, RotateCcw, SlidersHorizontal } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Keyboard, PanResponder, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fillerTimelineMarks, type TranscriptTimelineMark } from '@/lib/transcript-filler-timeline';
import { FillerBands, TranscriptFillerMarkers } from '@/components/review/transcript-filler-markers';
import { FillerPreview, type FillerPreviewStatus } from '@/components/review/filler-preview';
import { createFillerRemovalSnapshot, removeFillerFromSegments, restoreFillerRemoval, timelineFields, type FillerRemovalSnapshot, type TimelineFields } from '@/lib/filler-removal';
import { recordedMediaDuration } from '@/lib/recorded-media';
import { transcriptForSource } from '@/lib/review-source';
import { reviewExportSelection } from '@/lib/review-export-selection';
import { sanitizeExportCaption } from '@/lib/export-plan';
import { cleanReview, pickupLineIds, selectedReviewCuts, selectedReviewSegments } from '@/lib/clean-review';
import type { Project } from '@/lib/session';
import { getProject, saveProject, saveProjectMetadata } from '@/lib/store';
import { partitionCaptionTimeline, activeCaptionAt } from '@/lib/caption-timeline';
import { LOCAL_VIDEO_BUFFER } from '@/lib/video-buffer';
import { ExportControls } from '@/components/review/export-controls';
import media, { NativeCutPreview } from '../../modules/one-take-media';
import { TranscriptReview } from '@/components/review/transcript-review';
import { sourceDuration, sourceRangeFits } from '@/lib/source-duration';
import { ImportantPointsReview } from '@/components/prompter/important-points-review';
import { T1WrapReport } from '@/components/review/t1-wrap-report';
import { T1CleanupReview } from '@/components/review/t1-cleanup-review';
import { T1CaptionEditor } from '@/components/review/t1-caption-editor';
import { Tier1TakeReview } from '@/components/review/t1-take-review';
import { projectScriptLines } from '@/lib/project-workflow';
import { resolveReviewFootage } from '@/lib/t1-review';
import { applyProjectFraming } from '@/lib/t1-framing-selection';
import { projectWithSpeechEvidence } from '@/lib/t1-speech-review';
import { preserveStoredMediaEvidence, projectForMediaReview } from '@/lib/review-media-inventory';
import { mergeProjectEdit } from '@/lib/project-edit-merge';
import { tier1Enabled } from '@/lib/t1-gates';
import { useTimelineBackProtection } from '@/features/timeline/workspace';
import { TimelineDevelopmentFixture } from '@/features/timeline/development-fixture';
import { timelineDevelopmentAccess } from '@/features/timeline/access';

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

type PreviewSource = 'clean' | 'trim' | 'original';
type Peek = NonNullable<Project['reviewSegments']>[number];

type FillerPreviewSession = {
  mark: TranscriptTimelineMark;
  token: number;
  sourceUri: string;
  sourceStart: number;
  sourceEnd: number;
  sourceMin: number;
  sourceMax: number;
  sourceSegments: NonNullable<Project['reviewSegments']>;
  timelineBefore: TimelineFields;
  returnSource: PreviewSource;
  status: FillerPreviewStatus;
  error?: string;
};

function TrimHandle({ value, duration, width, onChange }: {
  value: number; duration: number; width: number; onChange: (value: number) => void;
}) {
  const latest = useRef({ value, duration, width, onChange });
  latest.current = { value, duration, width, onChange };
  const origin = useRef(value);
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { origin.current = latest.current.value; },
    onPanResponderMove: (_, gesture) => {
      const props = latest.current;
      if (props.width > 0) props.onChange(origin.current + gesture.dx / props.width * props.duration);
    },
  }), []);
  return <View {...pan.panHandlers}
    accessibilityRole="adjustable" accessibilityLabel="Trim boundary"
    accessibilityValue={{ min: 0, max: duration, now: value }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={e => onChange(value + (e.nativeEvent.actionName === 'increment' ? 0.5 : -0.5))}
    style={{ position: 'absolute', left: `${value / duration * 100}%`, top: -8, bottom: -8,
      width: 32, marginLeft: -16, alignItems: 'center', justifyContent: 'center', zIndex: 3 }}>
    <View style={{ width: 10, height: 64, backgroundColor: '#e5e5e5', borderRadius: 4 }} />
  </View>;
}

function SourceTabs({ value, onChange, cleanDisabled }: {
  value: PreviewSource; onChange: (v: PreviewSource) => void; cleanDisabled: boolean;
}) {
  const tabs: { id: PreviewSource; label: string; disabled?: boolean }[] = [
    { id: 'clean', label: 'Takes & captions', disabled: cleanDisabled },
    { id: 'trim', label: 'Trim' },
    { id: 'original', label: 'Original' },
  ];
  return <View accessibilityRole="tablist" className="flex-row bg-neutral-900 rounded-full p-1 gap-1">
    {tabs.map(tab => {
      const selected = value === tab.id;
      return <Pressable key={tab.id} accessibilityRole="button" accessibilityState={{ selected, disabled: tab.disabled }}
        disabled={tab.disabled} onPress={() => onChange(tab.id)}
        className={`flex-1 items-center rounded-full py-2.5 active:opacity-70 ${selected ? 'bg-white' : 'bg-transparent'} ${tab.disabled ? 'opacity-40' : ''}`}>
        <Text className={`text-xs font-semibold ${selected ? 'text-black' : 'text-neutral-300'}`}>{tab.label}</Text>
      </Pressable>;
    })}
  </View>;
}

function VideoEditor({ project: initialProject, uri }: { project: Project | null; uri: string }) {
  const [project, setProject] = useState(initialProject);
  const [failedMediaUris, setFailedMediaUris] = useState<string[]>([]);
  const latestProject = useRef(project);
  latestProject.current = project;
  const persistence = useRef(Promise.resolve());
  const writeLock = useRef(false);
  const writeGeneration = useRef(0);
  const mediaSaveRequired = useRef(false);
  const lastWrite = useRef<{ generation: number; mode: 'metadata' | 'media' } | null>(null);
  const persistenceErrorRef = useRef('');
  const [pendingWrites, setPendingWrites] = useState(0);
  const [persistenceError, setPersistenceError] = useState('');
  async function changeProject(next: Project, preserveMedia = false, retryGeneration?: number) {
    if (project && latestProject.current) next = preserveStoredMediaEvidence(latestProject.current, mergeProjectEdit(project, latestProject.current, next));
    const mode = preserveMedia ? 'media' : 'metadata';
    const generation = retryGeneration ?? writeGeneration.current + 1;
    writeGeneration.current = Math.max(writeGeneration.current, generation);
    lastWrite.current = { generation, mode };
    writeLock.current = true;
    latestProject.current = next;
    setProject(next);
    setPendingWrites(count => count + 1);
    const pending = persistence.current.catch(() => {}).then(async () => {
      if (mode === 'media' || mediaSaveRequired.current) {
        // A failed original/journal save must finish before a later metadata edit can report success.
        mediaSaveRequired.current = true;
        await saveProject(next);
        mediaSaveRequired.current = false;
      } else await saveProjectMetadata(next);
    });
    persistence.current = pending;
    try { await pending; persistenceErrorRef.current = ''; setPersistenceError(''); }
    catch (error) {
      persistenceErrorRef.current = 'Edits are not saved. Your changes are still here. Retry save before exporting.';
      setPersistenceError(persistenceErrorRef.current);
      throw error;
    }
    finally {
      if (persistence.current === pending) writeLock.current = false;
      setPendingWrites(count => count - 1);
    }
  }
  async function retrySave() {
    if (writeLock.current) { await persistence.current; return; }
    const current = latestProject.current;
    const previous = lastWrite.current;
    if (current) await changeProject(current, previous?.mode === 'media', previous?.generation);
  }
  const protectedBack = useTimelineBackProtection(
    pendingWrites > 0 ? 'saving' : persistenceError ? 'error' : 'saved',
    retrySave,
    () => router.back(),
    () => writeGeneration.current,
    () => !writeLock.current && !persistenceErrorRef.current,
  );
  const navigation = useNavigation();
  const player = useVideoPlayer(uri, p => { p.bufferOptions = LOCAL_VIDEO_BUFFER; p.timeUpdateEventInterval = 0.1; });
  const { status, error: playbackError } = useEvent(player, 'statusChange', { status: player.status });
  const source = useEvent(player, 'sourceLoad');
  const progress = useEvent(player, 'timeUpdate');
  const [durationChecks, setDurationChecks] = useState<Record<string, { duration?: number; error?: string }>>({});
  const sourceUris = useMemo(() => [...new Set([uri, ...(project?.recordings ?? []).map(recording => recording.mediaUri)])], [uri, project?.recordings]);
  useEffect(() => {
    let active = true;
    setDurationChecks({});
    void Promise.all(sourceUris.map(async sourceUri => {
      try { return [sourceUri, { duration: await recordedMediaDuration(sourceUri) }] as const; }
      catch { return [sourceUri, { error: 'Could not read the video file duration. Reopen this project to retry.' }] as const; }
    })).then(results => { if (active) setDurationChecks(Object.fromEntries(results)); });
    return () => { active = false; };
  }, [sourceUris]);
  const duration = sourceDuration(durationChecks[uri]?.duration, project?.duration, source?.duration ?? player.duration);
  const currentTime = progress?.currentTime ?? 0;
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: false });
  const [start, setStart] = useState(project?.trim?.start ?? 0);
  const [end, setEnd] = useState(project?.trim?.end ?? 0);
  const [width, setWidth] = useState(0);
  const [thumbnails, setThumbnails] = useState<VideoThumbnail[]>([]);
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(false);
  const [editTool, setEditTool] = useState<PreviewSource>('clean');
  const [tier1Test, setTier1Test] = useState(false);
  const [previewSource, setPreviewSource] = useState<PreviewSource>(
    Array.isArray(initialProject?.reviewSegments) || Array.isArray(initialProject?.cuts) ? 'clean' : 'trim',
  );
  const [peek, setPeek] = useState<Peek | null>(null);
  const [fillerPreview, setFillerPreview] = useState<FillerPreviewSession | null>(null);
  const [undoFillerRemoval, setUndoFillerRemoval] = useState<FillerRemovalSnapshot | null>(null);
  const fillerPlaybackToken = useRef(0);
  const fillerPlaybackObserved = useRef(0);
  const fillerReturnSource = useRef<PreviewSource>('clean');
  const cutIndex = useRef(0);
  const speechReview = useMemo(() => project ? projectWithSpeechEvidence(project, tier1Enabled('takeReview', __DEV__, tier1Test)) : null, [project, tier1Test]);
  const mediaProject = useMemo(() => speechReview ? projectForMediaReview(speechReview.project, status === 'error' ? [...failedMediaUris, uri] : failedMediaUris) : null, [speechReview, failedMediaUris, status, uri]);
  const review = useMemo(() => mediaProject ? cleanReview(mediaProject) : null, [mediaProject]);
  const clean = useMemo(() => review ? selectedReviewCuts(review, uri, duration > 0 ? duration : undefined) : null, [review, uri, duration]);
  const sequence = useMemo(() => project ? selectedReviewSegments({ ...mediaProject!, duration: duration > 0 ? duration : project.duration }, review!) : null, [project, mediaProject, review, duration]);
  const rawProposedSegments = useMemo<NonNullable<Project['reviewSegments']>>(() => project?.reviewSegments?.map(segment => ({ ...segment, captions: transcriptForSource(project, segment.uri).length ? transcriptForSource(project, segment.uri).filter(caption => caption.isFinal !== false).map(caption => ({ t0: caption.t0, t1: caption.t1, text: sanitizeExportCaption(caption.manualCorrection ?? caption.correctedText ?? caption.text) })).filter(caption => caption.text.trim()) : segment.captions })) ?? (project?.cuts?.length ? project.cuts.map(cut => ({ ...cut, uri, captions: transcriptForSource(project, uri).filter(segment => segment.isFinal !== false).map(segment => ({ t0: segment.t0, t1: segment.t1, text: sanitizeExportCaption(segment.manualCorrection ?? segment.correctedText ?? segment.text) })).filter(caption => caption.text.trim()) })) : project?.cuts ? [] : sequence?.segments ?? []), [project?.reviewSegments, project?.cuts, project?.transcript, uri, sequence]);
  const framingAllowed = tier1Enabled('reframing', __DEV__, tier1Test) && media?.supportsFraming === true;
  const proposedSegments = useMemo(() => project ? applyProjectFraming(project, rawProposedSegments, framingAllowed) : rawProposedSegments, [project, rawProposedSegments, framingAllowed]);
  const [activeSegments, setActiveSegments] = useState(proposedSegments);
  const [nativePlaying, setNativePlaying] = useState(true);
  const [nativeSeek, setNativeSeek] = useState(0);
  const [nativePosition, setNativePosition] = useState(0);
  const [nativeError, setNativeError] = useState('');
  const proposedLegacyCuts = new Set(proposedSegments.map(segment => segment.uri)).size === 1 && proposedSegments.every(segment => segment.uri === uri)
    ? proposedSegments.map(segment => ({ t0: segment.t0, t1: segment.t1 }))
    : undefined;
  const proposedCuts = project?.cuts ?? (!sequence?.conflicts.length && clean?.cuts.length ? clean.cuts : proposedLegacyCuts);
  const [activeCuts, setActiveCuts] = useState(proposedCuts);
  const updatesWaiting = JSON.stringify(proposedCuts) !== JSON.stringify(activeCuts) || JSON.stringify(proposedSegments) !== JSON.stringify(activeSegments);

  const availableMediaUris = mediaProject?.availableMediaUris ?? [];
  const hasPersistedCleanSequence = Array.isArray(project?.reviewSegments) || Array.isArray(project?.cuts);
  const cleanIssueFor = (segments: readonly { uri: string; t0: number; t1: number }[], checkDerivedSequence: boolean) => {
    if (!segments.length) return 'Clean sequence is empty. Restore an included clip to continue.';
    if (segments.some(segment => !Number.isFinite(segment.t0) || !Number.isFinite(segment.t1) || segment.t0 < 0 || segment.t1 <= segment.t0)) {
      return 'Clean sequence contains an invalid range. Adjust the clip bounds or restore another clip.';
    }
    for (const segment of segments) {
      const check = durationChecks[segment.uri];
      if (check?.error) return check.error;
      const savedDuration = segment.uri === uri ? project?.duration : project?.recordings?.find(recording => recording.mediaUri === segment.uri)?.duration;
      const bound = sourceDuration(check?.duration, savedDuration, segment.uri === uri ? duration : 0);
      if (!sourceRangeFits(segment, bound)) return check
        ? 'A cut extends beyond its source video. Adjust that cut to continue.'
        : 'Checking source video duration…';
    }
    if (segments.some(segment => !availableMediaUris.includes(segment.uri))) {
      return 'Clean sequence media is unavailable. Reopen to refresh media or choose another take.';
    }
    if (checkDerivedSequence && !hasPersistedCleanSequence && sequence?.conflicts.length) {
      return 'Clean sequence has conflicting takes. Review the conflicting source ranges before previewing or exporting.';
    }
    if (checkDerivedSequence && !hasPersistedCleanSequence && sequence?.unavailableTakeIds.length) {
      return 'Clean sequence is incomplete because a selected take is unavailable. Restore the source or choose another take.';
    }
    if (segments.some(segment => segment.uri !== uri) && !NativeCutPreview) {
      return 'Multi-recording clean preview needs the Android development build.';
    }
    return null;
  };
  const activeCleanIssue = nativeError
    ? `Clean preview failed: ${nativeError}. Restore the source or review another preview.`
    : cleanIssueFor(activeSegments, !updatesWaiting);
  const activeCleanReady = activeCleanIssue === null;
  const playingSegments = peek ? [peek] : activeSegments;
  const nativeSourcesAvailable = playingSegments.length > 0 && playingSegments.every(segment => availableMediaUris.includes(segment.uri));
  const activeUsesMultipleSources = new Set(activeSegments.map(segment => segment.uri)).size > 1;
  const activeLegacyCuts = activeCuts?.length
    ? activeCuts
    : activeUsesMultipleSources
      ? undefined
      : activeSegments.map(segment => ({ t0: segment.t0, t1: segment.t1 }));
  const hasClean = proposedSegments.length > 0;
  const nativeMode = !!NativeCutPreview && activeCleanReady && nativeSourcesAvailable && !peek && previewSource === 'clean' && playingSegments.length > 0;
  const peekNativeMode = !!NativeCutPreview && nativeSourcesAvailable && !!peek;
  const useNative = nativeMode || peekNativeMode;
  const playing = useNative ? nativePlaying : isPlaying;
  const nativeStarted = useRef(false);
  useEffect(() => {
    if (useNative && !nativeStarted.current && !isPlaying) { nativeStarted.current = true; setNativePlaying(true); }
  }, [useNative, isPlaying]);
  const valid = Number.isFinite(duration) && duration > 0;
  const limit = end || duration;
  const fillerSegments = useMemo(() => peek ? [peek] : previewSource === 'clean' ? activeSegments : valid ? [{ uri,
    t0: previewSource === 'trim' ? start : 0, t1: previewSource === 'trim' ? limit : duration }] : [],
    [peek, previewSource, activeSegments, valid, uri, duration, start, limit]);
  const fillerMarks = useMemo(() => project ? fillerTimelineMarks(project, fillerSegments) : [], [project, fillerSegments]);
  const fillerDuration = fillerSegments.reduce((sum, segment) => sum + segment.t1 - segment.t0, 0);
  const filmstripSegments = useMemo(() => editTool === 'clean' ? activeSegments : valid ? [{ uri, t0: 0, t1: duration }] : [],
    [editTool, activeSegments, valid, uri, duration]);
  const filmstripMarks = useMemo(() => project ? fillerTimelineMarks(project, filmstripSegments) : [], [project, filmstripSegments]);
  function beginFillerPlayback(session: FillerPreviewSession) {
    const token = ++fillerPlaybackToken.current;
    fillerPlaybackObserved.current = 0;
    const playingSession = { ...session, token, status: 'playing' as const, error: undefined };
    setFillerPreview(playingSession);
    setMessage('');
    player.pause();
    if (NativeCutPreview && availableMediaUris.includes(session.sourceUri)) {
      setPreviewSource('clean');
      setPeek({ uri: session.sourceUri, t0: session.sourceStart, t1: session.sourceEnd, captions: [] });
      setNativeSeek(value => value + 1);
      setNativePlaying(true);
      return;
    }
    if (session.sourceUri === uri) {
      setPeek(null);
      setPreviewSource('original');
      player.currentTime = session.sourceStart;
      player.play();
      return;
    }
    setFillerPreview({ ...playingSession, status: 'error', error: 'This recording cannot be previewed in the current build.' });
  }

  function previewTranscriptFiller(mark: TranscriptTimelineMark) {
    const currentProject = latestProject.current;
    if (!currentProject) {
      setMessage('The project is still loading. Try this filler again.');
      return;
    }
    const sourceSegment = typeof mark.sourceSegmentIndex === 'number' ? fillerSegments[mark.sourceSegmentIndex] : undefined;
    const sourceMin = sourceSegment?.uri === mark.sourceUri ? sourceSegment.t0 : mark.sourceTime;
    const sourceMax = sourceSegment?.uri === mark.sourceUri ? sourceSegment.t1 : (mark.sourceEnd ?? mark.sourceTime + Math.max(0.1, mark.t1 - mark.t0));
    const sourceStart = Math.max(sourceMin, Math.min(sourceMax, mark.sourceTime));
    const sourceEnd = Math.min(sourceMax, Math.max(sourceStart + 0.01, mark.sourceEnd ?? sourceStart + Math.max(0.1, mark.t1 - mark.t0)));
    if (!(sourceEnd > sourceStart) || !(sourceMax > sourceMin)) {
      setMessage('This filler range is no longer available. Reopen the editor and try again.');
      return;
    }
    const session: FillerPreviewSession = {
      mark, token: fillerPlaybackToken.current, sourceUri: mark.sourceUri, sourceStart, sourceEnd,
      sourceMin, sourceMax, sourceSegments: fillerSegments.map(segment => ({ ...segment })),
      timelineBefore: timelineFields(currentProject), returnSource: previewSource, status: 'ready',
    };
    fillerReturnSource.current = previewSource;
    beginFillerPlayback(session);
  }
  const nativeRequest = useMemo(() => JSON.stringify({ id: fillerPreview ? `filler-preview:${fillerPreview.token}` : 'preview', sourceUri: playingSegments[0]?.uri ?? uri, cuts: [], captions: [], segments: playingSegments }), [fillerPreview, playingSegments, uri]);
  useEffect(() => { if (useNative) player.pause(); else setNativePlaying(false); }, [useNative, player]);
  const previewCuts = !useNative && !peek && previewSource === 'clean' && activeCleanReady ? activeLegacyCuts : undefined;
  const autoStarted = useRef(false);
  useEffect(() => {
    if (playing || !updatesWaiting) return;
    setActiveCuts(proposedCuts); setActiveSegments(proposedSegments); cutIndex.current = 0;
  }, [playing, updatesWaiting, proposedCuts, proposedSegments]);
  useEffect(() => {
    if (useNative || peek || status !== 'readyToPlay' || isPlaying || previewSource !== 'clean' || !activeCleanReady || !nativeSourcesAvailable || !previewCuts?.length || autoStarted.current) return;
    autoStarted.current = true;
    player.currentTime = previewCuts[0].t0;
    player.play();
  }, [player, status, previewCuts, previewSource, peek, isPlaying, useNative, activeCleanReady, nativeSourcesAvailable]);
  const previewFullSource = !peek && previewSource === 'original';
  const cleanPreviewEmpty = !peek && previewSource === 'clean' && !activeCleanReady;
  const reviewProject = mediaProject ? { ...mediaProject, duration: valid ? duration : mediaProject.duration } : null;
  const captionCues = useMemo(() => {
    try { return partitionCaptionTimeline((project ? transcriptForSource(project, uri) : []).map(s => ({ ...s, text: sanitizeExportCaption(s.manualCorrection ?? s.correctedText ?? s.text) }))); }
    catch { return []; }
  }, [project, uri]);
  const captionText = activeCaptionAt(captionCues, currentTime)?.text ?? '';

  // Trim changes use the same serialized persistence queue as every other edit.
  // Persist immediately so navigating away cannot discard the last drag position.
  function updateTrim(nextStart: number, nextEnd: number) {
    setStart(nextStart); setEnd(nextEnd); setMessage('');
    const current = latestProject.current;
    if (current) void changeProject({ ...current, trim: { start: nextStart, end: nextEnd } }, true).catch(() => {});
  }

  function switchSource(next: PreviewSource) {
    setPeek(null); setNativePlaying(false); player.pause();
    setPreviewSource(next);
    if (next === 'trim') player.currentTime = start;
    if (next === 'original') player.currentTime = 0;
  }

  function clearPeek() {
    setPeek(null); setNativePlaying(false); setNativeSeek(0);
  }

  function closeFillerPreview() {
    fillerPlaybackToken.current += 1;
    setFillerPreview(null);
    player.pause();
    clearPeek();
    setPreviewSource(fillerReturnSource.current);
  }

  function adjustFillerBoundary(boundary: 'start' | 'end', delta: number) {
    const current = fillerPreview;
    if (!current) return;
    const sourceStart = boundary === 'start'
      ? Math.max(current.sourceMin, Math.min(current.sourceEnd - 0.01, current.sourceStart + delta))
      : current.sourceStart;
    const sourceEnd = boundary === 'end'
      ? Math.min(current.sourceMax, Math.max(current.sourceStart + 0.01, current.sourceEnd + delta))
      : current.sourceEnd;
    if (!(sourceEnd > sourceStart)) return;
    const token = ++fillerPlaybackToken.current;
    player.pause();
    clearPeek();
    setPreviewSource(current.returnSource);
    setFillerPreview({ ...current, token, sourceStart, sourceEnd, status: 'ready', error: undefined });
  }

  function removeSelectedFiller() {
    const session = fillerPreview;
    const current = latestProject.current;
    if (!session || session.status !== 'completed' || !current) return;
    if (session.returnSource !== 'clean' && (current.reviewSegments !== undefined || current.cuts !== undefined)) {
      setFillerPreview(previous => previous ? { ...previous, status: 'error',
        error: 'This video already has edits. Open Edited and preview the filler there to keep your other cuts.' } : previous);
      return;
    }
    if (JSON.stringify(timelineFields(current)) !== JSON.stringify(session.timelineBefore)) {
      closeFillerPreview();
      setMessage('This filler is based on an older timeline. Reopen the preview before deleting it.');
      return;
    }
    let reviewSegments: NonNullable<Project['reviewSegments']>;
    try {
      reviewSegments = removeFillerFromSegments(session.sourceSegments, {
        sourceUri: session.sourceUri,
        sourceStart: session.sourceStart,
        sourceEnd: session.sourceEnd,
        sourceSegmentIndex: session.mark.sourceSegmentIndex,
        sourceOccurrence: session.mark.sourceOccurrence,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'This filler is no longer available. Reopen the editor and try again.';
      setFillerPreview(previous => previous ? { ...previous, status: 'error', error: detail } : previous);
      return;
    }
    const before = timelineFields(current);
    const hasExistingTimeline = current.reviewSegments !== undefined || current.cuts !== undefined;
    const next: Project = { ...current, reviewSegments, cuts: undefined,
      cutsReviewed: session.returnSource !== 'clean' ? true : hasExistingTimeline ? current.cutsReviewed : false };
    const after = timelineFields(next);
    setUndoFillerRemoval(createFillerRemovalSnapshot(before, after));
    setActiveSegments(reviewSegments);
    setActiveCuts(undefined);
    closeFillerPreview();
    setEditing(true);
    setEditTool('clean');
    setPreviewSource('clean');
    setMessage('Filler removed from the clean sequence.');
    void changeProject(next).catch(() => setMessage('Filler removed here, but the edit was not saved. Retry save.'));
  }

  function undoLastFillerRemoval() {
    const snapshot = undoFillerRemoval;
    const current = latestProject.current;
    if (!snapshot || !current) return;
    const restored = restoreFillerRemoval(current, snapshot);
    if (!restored) {
      setUndoFillerRemoval(null);
      setMessage('Undo is unavailable because the timeline changed.');
      return;
    }
    setUndoFillerRemoval(null);
    const restoredSegments = restored.reviewSegments ?? restored.cuts?.map(cut => ({ ...cut, uri }));
    if (restoredSegments) setActiveSegments(restoredSegments);
    setActiveCuts(restored.cuts);
    setMessage('Filler removal undone.');
    void changeProject(restored).catch(() => setMessage('Undo is visible here, but it was not saved. Retry save.'));
  }

  const exportMode = previewSource === 'original' ? 'original' : previewSource === 'trim' ? 'trim' : 'cut';
  const exportBlockedReason = peek
    ? 'Peeking at a take. Return to export.'
    : updatesWaiting && playing
      ? 'New edits apply when paused.'
      : pendingWrites > 0
        ? 'Saving edits before export.'
        : previewSource === 'clean' && activeCleanIssue
          ? activeCleanIssue
        : null;
  const exportProject = project && !exportBlockedReason
    ? reviewExportSelection({ ...reviewProject!, duration: valid ? duration : project.duration }, exportMode, !!sequence?.segments.length)
    : null;

  const outputDuration = peek ? peek.t1 - peek.t0 : previewSource === 'original'
    ? (valid ? duration : 0)
    : previewSource === 'trim'
      ? (valid ? Math.max(0, limit - start) : 0)
      : activeCleanReady
        ? useNative
          ? playingSegments.reduce((sum, item) => sum + item.t1 - item.t0, 0)
          : previewCuts?.length
            ? previewCuts.reduce((sum, cut) => sum + cut.t1 - cut.t0, 0)
            : activeSegments.reduce((sum, segment) => sum + segment.t1 - segment.t0, 0)
        : 0;
  const statusLine = `${previewSource === 'original' ? 'Original' : previewSource === 'trim' ? 'Trimmed' : 'Edited'} · ${time(outputDuration)}`;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        player.pause(); setNativePlaying(false);
        const token = ++fillerPlaybackToken.current;
        setFillerPreview(previous => previous ? { ...previous, token, status: 'ready' } : previous);
      }
    });
    return () => subscription.remove();
  }, [player]);

  useEffect(() => navigation.addListener('blur', () => { player.pause(); setNativePlaying(false); }), [navigation, player]);

  useEffect(() => {
    if (status !== 'readyToPlay' || !valid) return;
    let active = true;
    player.generateThumbnailsAsync(Array.from({ length: 8 }, (_, i) => duration * i / 8), { maxWidth: 120 })
      .then(frames => { if (active) setThumbnails(frames); }).catch(() => {});
    return () => { active = false; };
  }, [player, status, duration, valid]);

  useEffect(() => {
    if (!isPlaying || useNative || peek) return;
    if (fillerPreview?.status === 'playing' && previewSource === 'original' && currentTime >= fillerPreview.sourceEnd - 0.03) {
      if (fillerPlaybackObserved.current !== fillerPreview.token) {
        player.currentTime = fillerPreview.sourceStart;
        return;
      }
      player.pause();
      player.currentTime = fillerPreview.sourceStart;
      setFillerPreview(previous => previous && previous.token === fillerPlaybackToken.current
        ? { ...previous, status: 'completed' }
        : previous);
      return;
    }
    if (fillerPreview?.status === 'playing' && previewSource === 'original'
      && currentTime >= fillerPreview.sourceStart - 0.02 && currentTime < fillerPreview.sourceEnd - 0.03) {
      fillerPlaybackObserved.current = fillerPreview.token;
    }
    if (previewCuts?.length) {
      const cut = previewCuts[cutIndex.current] ?? previewCuts[0];
      if (currentTime >= cut.t1) {
        const next = cutIndex.current + 1;
        if (next < previewCuts.length) { cutIndex.current = next; player.currentTime = previewCuts[next].t0; }
        else { player.pause(); cutIndex.current = 0; player.currentTime = previewCuts[0].t0; }
      }
    } else if (currentTime >= (previewFullSource ? duration : limit) || currentTime < (previewFullSource ? 0 : start)) {
      player.pause(); player.currentTime = previewFullSource ? 0 : start;
    }
  }, [player, isPlaying, currentTime, start, limit, duration, previewFullSource, previewCuts, useNative, peek, fillerPreview, previewSource]);

  function seek(value: number) {
    player.pause();
    if (previewFullSource) { player.currentTime = Math.max(0, Math.min(duration, value)); return; }
    if (previewCuts?.length) {
      let index = previewCuts.findIndex(cut => value >= cut.t0 && value < cut.t1);
      if (index < 0) index = previewCuts.reduce((best, cut, i) => Math.abs(cut.t0 - value) < Math.abs(previewCuts[best].t0 - value) ? i : best, 0);
      cutIndex.current = index;
      player.currentTime = Math.max(previewCuts[index].t0, Math.min(previewCuts[index].t1 - 0.01, value));
      return;
    }
    player.currentTime = Math.max(start, Math.min(limit, value));
  }

  const nativeRenderToken = fillerPlaybackToken.current;
  return <SafeAreaView className="flex-1 bg-black">
    <View className="flex-row items-center justify-between px-4 py-2">
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={protectedBack} className="p-3">
        <ArrowLeft size={22} color="white" />
      </Pressable>
      <Text className="text-white text-base font-semibold">Review</Text>
      <View style={{ minWidth: 48, alignItems: 'flex-end' }}>
        {persistenceError ? <Pressable accessibilityRole="button" onPress={() => { void retrySave().catch(() => {}); }} className="p-3"><Text className="text-amber-200 text-sm">Retry save</Text></Pressable>
          : pendingWrites > 0 ? <ActivityIndicator accessibilityLabel="Saving edits" color="#a3a3a3" /> : null}
      </View>
    </View>
    <View className="flex-1 bg-neutral-950">
      {useNative && NativeCutPreview ? <NativeCutPreview key={`preview:${nativeRenderToken}`} style={{ flex: 1 }} request={nativeRequest} playing={nativePlaying} seek={nativeSeek} onState={event => {
        if (nativeRenderToken !== fillerPlaybackToken.current) return;
        const state = event.nativeEvent;
        if (state.position !== undefined) setNativePosition(state.position);
        if (state.ended) {
          setNativePlaying(false);
          if (fillerPreview?.status === 'playing' && fillerPlaybackToken.current === fillerPreview.token) {
            setFillerPreview(previous => previous && previous.token === fillerPreview.token ? { ...previous, status: 'completed' } : previous);
          }
        }
        if (state.error) {
          if (fillerPreview?.status === 'playing' && fillerPlaybackToken.current === fillerPreview.token) {
            setFillerPreview(previous => previous && previous.token === fillerPreview.token ? { ...previous, status: 'error', error: state.error } : previous);
          }
          setNativeError(state.error); setNativePlaying(false); clearPeek(); setPreviewSource('clean');
          setFailedMediaUris(previous => [...new Set([...previous, ...playingSegments.map(segment => segment.uri)])]);
        }
      }} /> : cleanPreviewEmpty ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text accessibilityRole="alert" className="text-neutral-300 text-center">{activeCleanIssue ?? 'Clean preview is unavailable.'}</Text>
      </View> : <VideoView style={{ flex: 1 }} player={player} nativeControls={false} contentFit="contain" />}
      {!!captionText && previewSource !== 'original' && !cleanPreviewEmpty && !useNative && <View pointerEvents="none" style={{ position: 'absolute', bottom: '17%', left: '10%', right: '10%', alignItems: 'center' }}>
        <Text style={{ color: 'white', backgroundColor: '#000b', textAlign: 'center', fontWeight: 'bold', fontSize: 18, padding: 6 }}>{captionText}</Text>
      </View>}
      {!useNative && status === 'loading' && <ActivityIndicator style={{ position: 'absolute', alignSelf: 'center', top: '50%' }} color="white" />}
      {!!peek && <Pressable accessibilityRole="button" accessibilityLabel="Return from take peek" onPress={clearPeek}
        className="absolute top-3 self-center rounded-full bg-black/80 px-4 py-2 active:opacity-70">
        <Text className="text-white text-xs">Back to edit</Text>
      </Pressable>}
    </View>
    {fillerPreview && <FillerPreview visible label={fillerPreview.mark.label} start={fillerPreview.sourceStart} end={fillerPreview.sourceEnd}
      min={fillerPreview.sourceMin} max={fillerPreview.sourceMax} status={fillerPreview.status} error={fillerPreview.error}
      onPreview={() => { const current = fillerPreview; if (current) beginFillerPlayback(current); }}
      onAdjustStart={delta => adjustFillerBoundary('start', delta)} onAdjustEnd={delta => adjustFillerBoundary('end', delta)}
      onDelete={removeSelectedFiller} onClose={closeFillerPreview} />}
    {status === 'error' && <Text accessibilityRole="alert" className="text-red-300 px-6 py-2">{playbackError?.message ?? 'This video could not be opened. The file may no longer be available.'}</Text>}
    <View className="px-5 pt-2 w-full self-center" style={{ maxWidth: 600 }}>
      <View className="flex-row items-center justify-between mt-3 mb-2">
        <Text accessibilityLiveRegion="polite" className="text-neutral-300 text-xs flex-1 pr-3">{statusLine}</Text>
        <View className="flex-row items-center gap-1">
      <Pressable accessibilityRole="button" accessibilityLabel={editing ? 'Done editing' : 'Edit video'} accessibilityState={{ expanded: editing }} onPress={() => { Keyboard.dismiss(); if (editing) clearPeek(); setEditing(value => !value); player.pause(); setNativePlaying(false); }} className="flex-row items-center gap-2 px-3 py-3">
        <SlidersHorizontal size={16} color={editing ? 'white' : '#a3a3a3'} />
        <Text className="text-white text-sm font-medium">{editing ? 'Done' : 'Edit'}</Text>
      </Pressable>
          <Pressable disabled={!valid || status === 'error' || (previewSource === 'clean' && !peek && !activeCleanReady)} accessibilityRole="button" accessibilityLabel={playing ? 'Pause' : 'Play'} className="p-3 bg-neutral-800 rounded-full disabled:opacity-40" onPress={() => {
            if (useNative) {
              if (!nativePlaying && nativePosition >= outputDuration - 0.05) setNativeSeek(v => v + 1);
              setNativePlaying(value => !value); return;
            }
            if (isPlaying) player.pause();
            else {
              if (previewCuts?.length) {
                const cut = previewCuts[cutIndex.current] ?? previewCuts[0];
                if (player.currentTime < cut.t0 || player.currentTime >= cut.t1) player.currentTime = cut.t0;
              }
              else if (player.currentTime < (previewFullSource ? 0 : start) || player.currentTime >= (previewFullSource ? duration : limit)) player.currentTime = previewFullSource ? 0 : start;
              player.play();
            }
          }}>
            {playing ? <Pause size={22} color="white" /> : <Play size={22} color="white" />}
          </Pressable>
          {editing && editTool === 'trim' && <Pressable accessibilityRole="button" accessibilityLabel="Reset trim" className="p-3" onPress={() => updateTrim(0, duration)}>
            <RotateCcw size={20} color="#a3a3a3" />
          </Pressable>}
        </View>
      </View>
    </View>
    {project && <View className="px-5"><ImportantPointsReview project={reviewProject ?? project} compact /></View>}
    <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 20 }} className="px-5 pt-2 w-full self-center" style={{ maxWidth: 600, maxHeight: '38%', display: editing ? 'flex' : 'none' }}>
      <SourceTabs value={editTool} onChange={value => { setEditTool(value); if (value !== 'clean' || hasClean) switchSource(value); }} cleanDisabled={false} />
      {editTool === 'original' && <Text className="text-neutral-400 text-xs py-3">Full recording · retakes included</Text>}
      {(editTool === 'trim' || editTool === 'original') && <View className="pt-5">

        {valid && <View onLayout={e => setWidth(e.nativeEvent.layout.width)} style={{ height: 56, marginHorizontal: 12 }}>
          <View onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
            onResponderGrant={e => { if (width) seek(e.nativeEvent.locationX / width * duration); }}
            onResponderMove={e => { if (width) seek(e.nativeEvent.locationX / width * duration); }}
            style={{ flex: 1, backgroundColor: '#262626', overflow: 'hidden', borderRadius: 4 }}>
            <View pointerEvents="none" style={{ flex: 1, flexDirection: 'row' }}>
              {thumbnails.map((thumbnail, i) => <Image key={i} source={thumbnail} contentFit="cover" style={{ flex: 1, height: 56 }} />)}
            </View>
            <FillerBands marks={filmstripMarks} duration={duration} />
            {previewSource === 'trim' && <>
            <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${start / duration * 100}%`, backgroundColor: '#000b' }} />
            <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: `${(1 - limit / duration) * 100}%`, backgroundColor: '#000b' }} />
            <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: `${start / duration * 100}%`, width: `${(limit - start) / duration * 100}%`, borderTopWidth: 3, borderBottomWidth: 3, borderColor: '#e5e5e5' }} />
            </>}
            <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: `${Math.min(100, currentTime / duration * 100)}%`, width: 2, backgroundColor: 'white' }} />
          </View>
          {previewSource === 'trim' && <><TrimHandle value={start} duration={duration} width={width} onChange={v => {
            const next = Math.max(0, Math.min(limit - Math.min(0.25, duration), v));
            updateTrim(next, limit); player.pause(); player.currentTime = next;
          }} />
          <TrimHandle value={limit} duration={duration} width={width} onChange={v => {
            const next = Math.min(duration, Math.max(start + Math.min(0.25, duration), v));
            updateTrim(start, next); player.pause(); player.currentTime = next;
          }} /></>}
        </View>}
        {previewSource === 'trim' && <><View className="flex-row justify-between mt-3">
          <Text className="text-neutral-400 text-xs">{time(start)}</Text>
          <Text className="text-neutral-400 text-xs">{time(valid ? limit - start : 0)} selected</Text>
          <Text className="text-neutral-400 text-xs">{time(valid ? limit : 0)}</Text>
        </View>
        </>}
      </View>}
      <TranscriptFillerMarkers marks={fillerMarks} duration={fillerDuration} showTrack={previewSource === 'clean' || !!peek} onSelect={previewTranscriptFiller} />
      {!!undoFillerRemoval && <View className="mt-3 rounded-xl border border-red-900 bg-red-950/40 px-3 py-2">
        <Text className="text-red-200 text-xs">Filler removed from the clean sequence.</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Undo filler removal" onPress={undoLastFillerRemoval} className="py-2">
          <Text className="text-white text-xs font-semibold">Undo removal</Text>
        </Pressable>
      </View>}

      {project && reviewProject && tier1Enabled('reframing', __DEV__, tier1Test) && <View className="border-t border-neutral-800 py-3">
        <Text className="text-white font-semibold">Optional reframing</Text>
        <Text className="text-neutral-400 py-2">{!framingAllowed ? 'Reframing unavailable in this native build. Original frame retained.' : !(Array.isArray(project.framing?.suggestions) && project.framing.suggestions.length) ? 'No framing suggestions supplied. Original frame retained.' : project.framing.enabled ? 'Suggested static crops enabled. Unsafe or missing tracks use the original.' : 'Off · original frame'}</Text>
        <Pressable accessibilityRole="button" disabled={!framingAllowed || !(Array.isArray(project.framing?.suggestions) && project.framing.suggestions.length) || pendingWrites > 0} className="py-3 disabled:opacity-40" onPress={() => {
          setNativePlaying(false); player.pause(); clearPeek();
          void changeProject({ ...project, framing: { ...project.framing!, enabled: !project.framing?.enabled } }).catch(() => setMessage('Framing choice could not be saved.'));
        }}><Text className="text-white">{project.framing?.enabled ? 'Off / reset original frame' : 'Apply suggested framing'}</Text></Pressable>
      </View>}
      {__DEV__ && <Pressable accessibilityRole="button" className="py-3" onPress={() => setTier1Test(value => !value)}><Text className="text-amber-200">{tier1Test ? 'Disable Tier 1 development test' : 'Enable Tier 1 development test'}</Text></Pressable>}
      {!!speechReview?.error && <Text className="text-amber-200 py-3">Speech evidence unavailable: {speechReview.error}. Original media and saved metadata remain preserved.</Text>}
      {project && reviewProject && <T1CleanupReview project={reviewProject} onChange={changeProject} enabled={tier1Enabled('takeReview', __DEV__, tier1Test) && !speechReview?.error} disabled={pendingWrites > 0} onPreviewFootage={range => {
        const source = resolveReviewFootage(reviewProject, range);
        if (!source || !NativeCutPreview || !reviewProject.availableMediaUris?.includes(source.uri)) { setMessage('Cleanup footage is unavailable in this build.'); return; }
        player.pause(); clearPeek(); setPreviewSource('clean'); setPeek({ uri: source.uri, t0: range.t0, t1: range.t1 }); setNativeSeek(0); setNativePlaying(true);
      }} />}
      {project && reviewProject && <T1CaptionEditor project={reviewProject} onChange={changeProject} enabled={tier1Enabled('takeReview', __DEV__, tier1Test)} disabled={pendingWrites > 0} />}
      {project && reviewProject && <T1WrapReport project={reviewProject} onChange={changeProject} enabled={tier1Enabled('wrapReport', __DEV__, tier1Test)} disabled={pendingWrites > 0} onPickup={lineId => {
        const current = latestProject.current;
        if (!current || pendingWrites > 0) return;
        if (!pickupLineIds(cleanReview(current)).includes(lineId)) {
          setMessage('This producer flag needs a pickup that capture does not yet support. The flag remains for review.');
          return;
        }
        setNativePlaying(false); player.pause();
        void changeProject({ ...current, pickupRequest: { lineIds: [lineId], requestedAt: Date.now() } }).then(() => {
          router.push({ pathname: '/camera', params: { mode: 'script', script: current.script ?? '', pickupProjectId: current.id } });
        }).catch(() => setMessage('Pickup request could not be saved.'));
      }} onConfirmAction={(id, confirmed) => {
        const current = latestProject.current;
        if (!current || writeLock.current) return;
        void changeProject({ ...current, scriptLines: projectScriptLines(current).map(line => ({ ...line, actionCues: line.actionCues.map(cue => cue.id === id ? { ...cue, resolved: confirmed } : cue) })) }).catch(() => setMessage('Action confirmation could not be saved.'));
      }} onReviewFootage={range => {
        const source = resolveReviewFootage(reviewProject, range);
        if (!source || !NativeCutPreview || !reviewProject.availableMediaUris?.includes(source.uri)) { setMessage('Supporting footage preview is unavailable in this build.'); return; }
        player.pause(); clearPeek(); setPreviewSource('clean'); setPeek({ ...range, uri: source.uri }); setNativeSeek(0); setNativePlaying(true);
      }} />}
      {project && reviewProject && tier1Enabled('takeReview', __DEV__, tier1Test) && <Tier1TakeReview project={reviewProject} onChange={changeProject} onPreview={range => {
        const source = resolveReviewFootage(reviewProject, { ...range, recordingId: 'recordingId' in range ? String(range.recordingId) : project.id });
        if (!source || !NativeCutPreview || !reviewProject.availableMediaUris?.includes(source.uri)) { setMessage('Take preview is unavailable in this build.'); return; }
        player.pause(); clearPeek(); setPreviewSource('clean'); setPeek({ ...range, uri: source.uri }); setNativeSeek(0); setNativePlaying(true);
      }} />}
      <View style={{ display: editTool === 'clean' ? 'flex' : 'none' }}>
      {project && reviewProject && <TranscriptReview embedded project={reviewProject} duration={valid ? duration : undefined} onChange={changeProject} onPreviewRecording={NativeCutPreview && reviewProject.recordings?.every(recording => reviewProject.availableMediaUris?.includes(recording.mediaUri)) ? async (recordingUri) => {
        if (!reviewProject.availableMediaUris?.includes(recordingUri)) { setMessage('This pickup original is unavailable.'); return; }
        setNativePlaying(false); player.pause();
        try {
          const recordingDuration = await recordedMediaDuration(recordingUri);
          setPeek({ uri: recordingUri, t0: 0, t1: recordingDuration, captions: [] });
          setNativeError(''); setMessage(''); setPreviewSource('clean');
          setNativeSeek(v => v + 1); setNativePlaying(true);
        } catch (error) {
          setMessage(`Could not preview the saved original: ${error instanceof Error ? error.message : String(error)}`);
        }
      } : undefined} onPreviewTake={NativeCutPreview ? id => {
        const take = review?.takes.find(item => item.id === id);
        if (!take?.mediaUri || !take.playable || failedMediaUris.includes(take.mediaUri) || !reviewProject.availableMediaUris?.includes(take.mediaUri)) { setMessage('This take is unavailable. Reopen the project to refresh media.'); return; }
        setPeek({ uri: take.mediaUri, t0: take.t0, t1: take.t1, takeId: id, captions: [] });
        setPreviewSource('clean'); setNativeSeek(0); setNativePlaying(true);
      } : undefined} onSeek={value => {
        player.pause();
        const position = Math.max(0, Math.min(duration, value));
        if (NativeCutPreview && position < duration) {
          const cut = project.cuts?.find(item => position >= item.t0 && position < item.t1);
          setPeek({ uri, t0: position, t1: cut?.t1 ?? duration, captions: [] });
          setNativeSeek(0); setNativePlaying(true);
        } else {
          clearPeek(); setPreviewSource('original'); player.currentTime = position;
        }
      }} />}
      </View>
    </ScrollView>
    <View className="px-5 pb-3 w-full self-center" style={{ maxWidth: 600 }}>
      {!!message && <Text accessibilityRole="alert" className="text-neutral-200 text-xs py-2">{message}</Text>}
      {!!persistenceError && <Text accessibilityRole="alert" className="text-red-300 py-2">{persistenceError}</Text>}
      {!!exportBlockedReason && !cleanPreviewEmpty && <Text className="text-amber-200 text-xs py-2">{exportBlockedReason}</Text>}
      {project && valid && !persistenceError && !exportBlockedReason && exportProject
        ? <ExportControls compact onReviewCuts={() => { setEditing(true); setEditTool('clean'); player.pause(); setNativePlaying(false); }} label={exportMode === 'original' ? 'Export original' : 'Export video'} framingEnabled={framingAllowed && exportMode === 'cut'} project={exportProject} start={exportMode === 'original' ? 0 : start} end={exportMode === 'original' ? duration : limit} />
        : <Pressable accessibilityRole="button" disabled className="items-center rounded-xl bg-neutral-800 py-4"><Text className="text-neutral-500 font-semibold">Export video</Text></Pressable>}
    </View>
  </SafeAreaView>;
}

function MissingMediaReview({ project, onChange }: { project: Project; onChange: (next: Project) => Promise<void> }) {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewBase, setReviewBase] = useState(project);
  const latest = useRef(project);
  useEffect(() => { if (!busy) { latest.current = project; setReviewBase(project); } }, [project, busy]);
  const queue = useRef(Promise.resolve());
  const [preview, setPreview] = useState<Project['reviewSegments']>();
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const speechReview = projectWithSpeechEvidence(reviewBase, tier1Enabled('takeReview', __DEV__, enabled));
  const current = projectForMediaReview(speechReview.project, failed);
  function reviewFootage(range: { recordingId: string; t0: number; t1: number }) {
    const source = resolveReviewFootage(current, range);
    if (!source || !NativeCutPreview || !current.availableMediaUris?.includes(source.uri)) { setError('Supporting footage is unavailable.'); return; }
    setPreview([{ uri: source.uri, t0: range.t0, t1: range.t1 }]); setPlaying(true);
  }
  async function pickup(lineId: string) {
    if (!pickupLineIds(cleanReview(current)).includes(lineId)) { setError('Capture does not yet support a pickup for this producer-only flag.'); return; }
    try {
      await change({ ...current, pickupRequest: { lineIds: [lineId], requestedAt: Date.now() } });
      router.push({ pathname: '/camera', params: { mode: 'script', script: current.script ?? '', pickupProjectId: current.id } });
    } catch (e) { setError(String(e)); }
  }
  async function change(next: Project) {
    next = preserveStoredMediaEvidence(latest.current, mergeProjectEdit(reviewBase, latest.current, next));
    latest.current = next; setReviewBase(next); setBusy(true);
    const pending = queue.current.catch(() => {}).then(() => onChange(next));
    queue.current = pending;
    try { await pending; setSaveError(''); }
    catch (e) { setSaveError(String(e)); throw e; }
    finally { if (queue.current === pending) setBusy(false); }
  }
  useTimelineBackProtection(busy ? 'saving' : saveError ? 'error' : 'saved', () => change(latest.current), () => router.back());
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 48 }}>
    <Pressable accessibilityRole="button" disabled={busy} className="py-3 disabled:opacity-40" style={{ minHeight: 48 }} onPress={() => { void change(latest.current).catch(() => {}); }}><Text className="text-white">{busy ? 'Saving…' : saveError ? 'Retry save' : 'Save project'}</Text></Pressable>
    {!!saveError && <Text accessibilityRole="alert" className="text-red-300">Edits are still here. Retry save: {saveError}</Text>}
    {preview && NativeCutPreview && <View>
      <NativeCutPreview style={{ height: 240 }} request={JSON.stringify({ id: 'recovery-preview', sourceUri: preview[0].uri, cuts: [], captions: [], segments: preview })} playing={playing} seek={0} onState={event => {
        if (event.nativeEvent.ended) setPlaying(false);
        if (event.nativeEvent.error) { setError(event.nativeEvent.error); setFailed(previous => [...new Set([...previous, ...preview.map(segment => segment.uri)])]); setPreview(undefined); setPlaying(false); }
      }} />
      <Pressable accessibilityRole="button" onPress={() => { setPreview(undefined); setPlaying(false); }} className="py-3"><Text className="text-white">Close supporting footage</Text></Pressable>
    </View>}
    {__DEV__ && <Pressable accessibilityRole="button" className="py-3" onPress={() => setEnabled(value => !value)}><Text className="text-amber-200">{enabled ? 'Disable Tier 1 development test' : 'Enable Tier 1 development test'}</Text></Pressable>}
    {!!speechReview.error && <Text className="text-amber-200 py-3">Speech evidence unavailable: {speechReview.error}</Text>}
    <T1CleanupReview project={current} onChange={change} enabled={tier1Enabled('takeReview', __DEV__, enabled) && !speechReview.error} disabled={busy} onPreviewFootage={reviewFootage} />
    <T1CaptionEditor project={current} onChange={change} enabled={tier1Enabled('takeReview', __DEV__, enabled)} disabled={busy} />
    <T1WrapReport project={current} onChange={change} disabled={busy} enabled={tier1Enabled('wrapReport', __DEV__, enabled)} onReviewFootage={reviewFootage} onPickup={lineId => { void pickup(lineId); }} />
    {tier1Enabled('takeReview', __DEV__, enabled) && <Tier1TakeReview project={current} onChange={change} onPreview={reviewFootage} />}
    <TranscriptReview project={current} onChange={change} onSeek={() => setError('The original recording is unavailable.')} />
    {!!error && <Text accessibilityRole="alert" className="text-amber-200">{error}</Text>}
    <View style={{ height: 24 }} />
  </ScrollView>;
}

export default function Editor() {
  const { projectId, videoUri, timelineFixture } = useLocalSearchParams<{ projectId?: string; videoUri?: string; timelineFixture?: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(!!projectId);
  const [error, setError] = useState('');
  useFocusEffect(useCallback(() => {
    let active = true;
    if (!projectId) { setLoading(false); return; }
    setLoading(true); setError('');
    getProject(projectId).then(value => {
      if (!active) return;
      if (!value?.videoUri) setError('This project has no saved recording.');
      setProject(value);
    }).catch(e => { if (active) setError(`Could not open project: ${e.message}`); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]));
  if (timelineDevelopmentAccess(__DEV__, timelineFixture)) return <SafeAreaView className="flex-1 bg-black"><TimelineDevelopmentFixture /></SafeAreaView>;
  if (!loading && project && (!project.videoUri || project.mediaMissing)) return <SafeAreaView className="flex-1 bg-black px-6">
    <Pressable onPress={() => router.back()} className="py-4"><Text className="text-white">Back</Text></Pressable>
    <Text className="text-amber-200">{project.recoveryMessage ?? 'The original recording is unavailable. Your saved transcript is still here.'}</Text>
    <MissingMediaReview project={{ ...project, mediaMissing: true }} onChange={async next => { await saveProjectMetadata(next); setProject(next); }} />
  </SafeAreaView>;
  const uri = project?.videoUri ?? videoUri;
  if (loading || error || !uri) return <SafeAreaView className="flex-1 bg-black items-center justify-center px-6">
    {loading ? <ActivityIndicator color="white" /> : <Text className="text-white text-center">{error || 'No video selected.'}</Text>}
    <Pressable onPress={() => router.back()} className="p-4 mt-4"><Text className="text-white">Back</Text></Pressable>
  </SafeAreaView>;
  return <VideoEditor key={projectId ?? uri} project={project} uri={uri} />;
}

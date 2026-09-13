import { useEvent } from 'expo';
import { router, useNavigation, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ArrowLeft, Pause, Play } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import captionNative from '../../modules/one-take-captions';
import { AutomaticCutReview } from '@/components/review/automatic-cut-review';
import { applyAutomaticEdit, automaticEditCurrent, buildAutomaticEdit, editSources, type AudioEvidence } from '@/lib/automatic-edit';
import { completeSourceSemantics } from '@/lib/review-semantic-completion';
import { matchLocalSpeech, prepareLocalAi } from '@/features/local-ai/script-model';
import { enrichWordTiming, needsRefinedWords } from '@/lib/refined-word-timing';
import { recordedMediaDuration } from '@/lib/recorded-media';
import { transcriptForSource } from '@/lib/review-source';
import { reviewExportSelection } from '@/lib/review-export-selection';
import { sanitizeExportCaption } from '@/lib/export-plan';
import { cleanReview, pickupLineIds, selectedReviewCuts, selectedReviewSegments } from '@/lib/clean-review';
import type { Project } from '@/lib/session';
import { getProject, saveProject, saveProjectMetadata } from '@/lib/store';
import { nativeCaptionTimeline, partitionCaptionTimeline, activeCaptionAt } from '@/lib/caption-timeline';
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

function VideoEditor({ project: initialProject, uri }: { project: Project | null; uri: string }) {
  const [project, setProject] = useState(initialProject);
  const [failedMediaUris] = useState<string[]>([]);
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
  const sourceUriKey = JSON.stringify([...new Set([uri, ...(project?.recordings ?? []).map(recording => recording.mediaUri)])]);
  const sourceUris = useMemo<string[]>(() => JSON.parse(sourceUriKey), [sourceUriKey]);
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
  const [start] = useState(project?.trim?.start ?? 0);
  const [end] = useState(project?.trim?.end ?? 0);
  const [message, setMessage] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisAttempt, setAnalysisAttempt] = useState(0);
  const [tier1Test, setTier1Test] = useState(false);
  const [previewSource, setPreviewSource] = useState<PreviewSource>(
    Array.isArray(initialProject?.reviewSegments) || Array.isArray(initialProject?.cuts) ? 'clean' : 'trim',
  );
  const [peek, setPeek] = useState<Peek | null>(null);
  const cutIndex = useRef(0);
  const speechReview = useMemo(() => project ? projectWithSpeechEvidence(project, tier1Enabled('takeReview', __DEV__, tier1Test)) : null, [project, tier1Test]);
  const mediaProject = useMemo(() => speechReview ? projectForMediaReview(speechReview.project, status === 'error' ? [...failedMediaUris, uri] : failedMediaUris) : null, [speechReview, failedMediaUris, status, uri]);
  const review = useMemo(() => mediaProject ? cleanReview(mediaProject) : null, [mediaProject]);
  const clean = useMemo(() => review ? selectedReviewCuts(review, uri, duration > 0 ? duration : undefined) : null, [review, uri, duration]);
  const sequence = useMemo(() => project ? selectedReviewSegments({ ...mediaProject!, duration: duration > 0 ? duration : project.duration }, review!) : null, [project, mediaProject, review, duration]);
  const rawProposedSegments = useMemo<NonNullable<Project['reviewSegments']>>(() => {
    const sourceCaptions = (sourceUri: string, fallback: NonNullable<Project['reviewSegments']>[number]['captions'] = []) => {
      const transcript = project ? transcriptForSource(project, sourceUri) : [];
      return nativeCaptionTimeline(transcript.length ? transcript.filter(caption => caption.isFinal !== false).map(caption => ({
        t0: caption.t0, t1: caption.t1, text: sanitizeExportCaption(caption.manualCorrection ?? caption.correctedText ?? caption.text),
      })) : fallback ?? []);
    };
    return project?.reviewSegments?.map(segment => ({ ...segment, captions: sourceCaptions(segment.uri, segment.captions) }))
      ?? (project?.cuts?.length ? project.cuts.map(cut => ({ ...cut, uri, captions: sourceCaptions(uri) }))
        : project?.cuts ? [] : sequence?.segments.map(segment => ({ ...segment, captions: sourceCaptions(segment.uri, segment.captions) })) ?? []);
  }, [project?.reviewSegments, project?.cuts, project?.transcript, uri, sequence]);
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
    ? 'Preview could not play.'
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
  const nativeMode = !!NativeCutPreview && activeCleanReady && nativeSourcesAvailable && !peek && previewSource === 'clean' && playingSegments.length > 0;
  const peekNativeMode = !!NativeCutPreview && nativeSourcesAvailable && !!peek;
  const useNative = nativeMode || peekNativeMode;
  const playing = useNative ? nativePlaying : isPlaying;
  const nativeStarted = useRef(false);
  useEffect(() => {
    if (useNative && !nativeStarted.current && !isPlaying) { nativeStarted.current = true; setNativePlaying(true); }
  }, [useNative, isPlaying]);
  const valid = Number.isFinite(duration) && duration > 0;
  const nativeRequest = useMemo(() => JSON.stringify({ id: 'preview', sourceUri: playingSegments[0]?.uri ?? uri, cuts: [], captions: [], segments: playingSegments }), [playingSegments, uri]);
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
  const limit = end || duration;
  const reviewProject = mediaProject ? { ...mediaProject, duration: valid ? duration : mediaProject.duration } : null;
  const captionCues = useMemo(() => {
    try { return partitionCaptionTimeline((project ? transcriptForSource(project, uri) : []).map(s => ({ ...s, text: sanitizeExportCaption(s.manualCorrection ?? s.correctedText ?? s.text) }))); }
    catch { return []; }
  }, [project, uri]);
  const captionText = activeCaptionAt(captionCues, currentTime)?.text ?? '';

  function clearPeek() {
    setPeek(null); setNativePlaying(false); setNativeSeek(0);
  }

  const needsAnalysis = !!project && !automaticEditCurrent(project);
  useEffect(() => {
    if (!needsAnalysis || !project || sourceUris.some(source => !durationChecks[source])) { setAnalyzing(false); return; }
    let active = true;
    let refinementId: string | undefined;
    setAnalyzing(true);
    player.pause(); setNativePlaying(false);
    void (async () => {
      const audio: AudioEvidence = {};
      const checked: Project = { ...project, duration,
        recordings: project.recordings?.map(recording => ({ ...recording, duration: durationChecks[recording.mediaUri]?.duration ?? recording.duration })) };
      for (const source of editSources(checked)) {
        if (!active) return;
        try { audio[source.id] = await captionNative!.analyzeAudio(source.uri); }
        catch { if (active) setMessage('Some audio checks are unavailable. Existing cuts are preserved.'); }
        if (!active) return;
        const original = transcriptForSource(checked, source.uri);
        if (needsRefinedWords(original) && captionNative?.refine) {
          refinementId = `editor-words:${project.id}:${source.id}:${Date.now()}`;
          try {
            const refined = await captionNative.refine(refinementId, source.uri, 'small');
            if (!active) return;
            const enriched = enrichWordTiming(original, refined);
            const replacements = new Map(original.map((segment, index) => [segment, enriched[index]]));
            checked.transcript = checked.transcript.map(segment => replacements.get(segment) ?? segment);
          } catch { if (active) setMessage('Some filler cuts need a quick check.'); }
          finally { refinementId = undefined; }
        }
      }
      if (!active) return;
      if (checked.scriptLines?.length && captionNative?.aiStatus) {
        try {
          const state = await captionNative.aiStatus();
          if (active && state !== 'unavailable' && await prepareLocalAi() === 'available') {
            for (const source of editSources(checked)) {
              if (!active) return;
              checked.semanticMatches = await completeSourceSemantics(checked, source.uri, matchLocalSpeech, () => active);
            }
          }
        } catch { if (active) setMessage('Some script lines need a quick check.'); }
      }
      if (!active) return;
      setPreviewSource('clean'); clearPeek();
      await changeProject(applyAutomaticEdit(checked, buildAutomaticEdit(checked, audio)));
    })().catch(() => { if (active) setMessage('Could not prepare the edit. Tap Retry.'); })
      .finally(() => { if (active) setAnalyzing(false); });
    return () => {
      active = false;
      if (refinementId) void captionNative?.cancelRefinement(refinementId).catch(() => {});
    };
  }, [needsAnalysis, sourceUriKey, durationChecks, analysisAttempt]);

  const exportMode = previewSource === 'original' ? 'original' : previewSource === 'trim' ? 'trim' : 'cut';
  const exportBlockedReason = analyzing || needsAnalysis ? 'Preparing your edit…' : peek
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
      : activeSegments.reduce((sum, segment) => sum + (Number.isFinite(segment.t0) && Number.isFinite(segment.t1) ? Math.max(0, segment.t1 - segment.t0) : 0), 0);
  const statusLine = `${peek ? 'Preview' : previewSource === 'original' ? 'Original' : previewSource === 'trim' ? 'Trimmed' : 'Edited'} · ${time(outputDuration)}`;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') { player.pause(); setNativePlaying(false); } });
    return () => subscription.remove();
  }, [player]);

  useEffect(() => navigation.addListener('blur', () => { player.pause(); setNativePlaying(false); }), [navigation, player]);

  useEffect(() => {
    if (!isPlaying || useNative || peek) return;
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
  }, [player, isPlaying, currentTime, start, limit, duration, previewFullSource, previewCuts, useNative, peek]);

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
      {useNative && NativeCutPreview ? <NativeCutPreview style={{ flex: 1 }} request={nativeRequest} playing={nativePlaying} seek={nativeSeek} onState={event => {
        const state = event.nativeEvent;
        if (state.position !== undefined) setNativePosition(state.position);
        if (state.ended) setNativePlaying(false);
        if (state.error) {
          setNativeError(state.error); setNativePlaying(false); clearPeek(); setPreviewSource('clean');
        }
      }} /> : cleanPreviewEmpty ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text accessibilityRole="alert" className="text-neutral-300 text-center">{activeCleanIssue ?? 'Clean preview is unavailable.'}</Text>
        {!!nativeError && <Pressable accessibilityRole="button" onPress={() => { setNativeError(''); setNativeSeek(0); setNativePosition(0); setNativePlaying(true); }} className="mt-4 rounded-xl bg-neutral-800 px-5 py-3"><Text className="text-white">Retry preview</Text></Pressable>}
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
    {status === 'error' && <Text accessibilityRole="alert" className="text-red-300 px-6 py-2">{playbackError?.message ?? 'This video could not be opened. The file may no longer be available.'}</Text>}
    <View className="px-5 pt-2 w-full self-center" style={{ maxWidth: 600 }}>
      <View className="flex-row items-center justify-between mt-3 mb-2">
        <Text accessibilityLiveRegion="polite" className="text-neutral-300 text-xs flex-1 pr-3">{statusLine}</Text>
        <View className="flex-row items-center gap-1">
          <Pressable disabled={!valid || status === 'error' || (previewSource === 'clean' && !peek && !activeCleanReady)} accessibilityRole="button" accessibilityLabel={playing ? 'Pause' : 'Play'} className="p-3 bg-neutral-800 rounded-full disabled:opacity-40" onPress={() => {
            if (useNative) {
              if (!nativePlaying && nativePosition >= outputDuration - 0.05) setNativeSeek(0);
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

        </View>
      </View>
    </View>
    {project && <View className="px-5"><ImportantPointsReview project={reviewProject ?? project} compact /></View>}
    <View className="px-5 w-full self-center" style={{ maxWidth: 600 }}>
      {analyzing ? <View className="flex-row items-center gap-3 py-4"><ActivityIndicator color="#c4b5fd" /><Text className="text-neutral-300 text-sm">Preparing cuts…</Text></View>
        : project && <AutomaticCutReview project={project} busy={pendingWrites > 0} onChange={async next => {
          player.pause(); setNativePlaying(false); clearPeek(); setPreviewSource('clean'); await changeProject(next);
        }} onPreview={clip => {
          const source = editSources(project).find(item => item.id === clip.sourceId);
          if (!source || !NativeCutPreview) return;
          player.pause(); setPeek({ uri: source.uri, t0: clip.t0, t1: clip.t1, captions: [] }); setNativeSeek(0); setNativePlaying(true);
        }} />}
      {!analyzing && needsAnalysis && <Pressable accessibilityRole="button" onPress={() => setAnalysisAttempt(value => value + 1)} className="py-3"><Text className="text-white">Retry</Text></Pressable>}
    </View>
    <View className="px-5 pb-3 w-full self-center" style={{ maxWidth: 600 }}>
      {!!message && <Text accessibilityRole="alert" className="text-neutral-200 text-xs py-2">{message}</Text>}
      {!!persistenceError && <Text accessibilityRole="alert" className="text-red-300 py-2">{persistenceError}</Text>}
      {!!exportBlockedReason && !cleanPreviewEmpty && <Text className="text-amber-200 text-xs py-2">{exportBlockedReason}</Text>}
      {project && valid && !persistenceError && !exportBlockedReason && exportProject
        ? <ExportControls compact label={exportMode === 'original' ? 'Export original' : 'Export video'} framingEnabled={framingAllowed && exportMode === 'cut'} project={exportProject} start={exportMode === 'original' ? 0 : start} end={exportMode === 'original' ? duration : limit} />
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
  const [failed] = useState<string[]>([]);
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
        if (event.nativeEvent.error) { setError('Preview could not play. Select the footage to retry.'); setPreview(undefined); setPlaying(false); }
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

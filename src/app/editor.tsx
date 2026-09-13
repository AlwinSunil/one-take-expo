import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { router, useNavigation, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoThumbnail } from 'expo-video';
import { ArrowLeft, Pause, Play, RotateCcw, Scissors } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, PanResponder, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { recordedMediaDuration } from '@/lib/recorded-media';
import { transcriptForSource } from '@/lib/review-source';
import { reviewExportSelection } from '@/lib/review-export-selection';
import { sanitizeExportCaption } from '@/lib/export-plan';
import { cleanReview, selectedReviewCuts, selectedReviewSegments } from '@/lib/clean-review';
import type { Project } from '@/lib/session';
import { getProject, saveProject, saveProjectMetadata } from '@/lib/store';
import { partitionCaptionTimeline, activeCaptionAt } from '@/lib/caption-timeline';
import { LOCAL_VIDEO_BUFFER } from '@/lib/video-buffer';
import { ExportControls } from '@/components/review/export-controls';
import { NativeCutPreview } from '../../modules/one-take-media';
import { TranscriptReview } from '@/components/review/transcript-review';

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

type PreviewSource = 'clean' | 'trim' | 'original';
type Peek = NonNullable<Project['reviewSegments']>[number];

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
    { id: 'clean', label: 'Clean', disabled: cleanDisabled },
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
  const projectRef = useRef(project);
  projectRef.current = project;
  const persistence = useRef(Promise.resolve());
  const [pendingWrites, setPendingWrites] = useState(0);
  const [persistenceError, setPersistenceError] = useState('');
  async function changeProject(next: Project, preserveMedia = false) {
    setProject(next);
    setPendingWrites(count => count + 1);
    const pending = persistence.current.catch(() => {}).then(async () => {
      if (preserveMedia) await saveProject(next);
      else await saveProjectMetadata(next);
    });
    persistence.current = pending;
    try { await pending; setPersistenceError(''); }
    catch (error) { setPersistenceError('Edits are not saved. Reopen this screen before exporting.'); throw error; }
    finally { setPendingWrites(count => count - 1); }
  }
  const navigation = useNavigation();
  const player = useVideoPlayer(uri, p => { p.bufferOptions = LOCAL_VIDEO_BUFFER; p.timeUpdateEventInterval = 0.1; });
  const { status, error: playbackError } = useEvent(player, 'statusChange', { status: player.status });
  const source = useEvent(player, 'sourceLoad');
  const progress = useEvent(player, 'timeUpdate');
  const duration = source?.duration ?? player.duration;
  const currentTime = progress?.currentTime ?? 0;
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: false });
  const [start, setStart] = useState(project?.trim?.start ?? 0);
  const [end, setEnd] = useState(project?.trim?.end ?? 0);
  const [width, setWidth] = useState(0);
  const [thumbnails, setThumbnails] = useState<VideoThumbnail[]>([]);
  const [message, setMessage] = useState('');
  const [previewSource, setPreviewSource] = useState<PreviewSource>(
    initialProject?.reviewSegments?.length || initialProject?.cuts?.length ? 'clean' : 'trim',
  );
  const [peek, setPeek] = useState<Peek | null>(null);
  const cutIndex = useRef(0);
  const review = useMemo(() => project ? cleanReview(project) : null, [project]);
  const clean = useMemo(() => review ? selectedReviewCuts(review, uri, duration > 0 ? duration : undefined) : null, [review, uri, duration]);
  const sequence = useMemo(() => project ? selectedReviewSegments({ ...project, duration: duration > 0 ? duration : project.duration }, review!) : null, [project, review, duration]);
  const proposedSegments = useMemo<NonNullable<Project['reviewSegments']>>(() => project?.reviewSegments ?? (project?.cuts?.length ? project.cuts.map(cut => ({ ...cut, uri, captions: transcriptForSource(project, uri).filter(segment => segment.isFinal !== false).map(segment => ({ t0: segment.t0, t1: segment.t1, text: sanitizeExportCaption(segment.manualCorrection ?? segment.correctedText ?? segment.text) })).filter(caption => caption.text.trim()) })) : project?.cuts ? [] : sequence?.segments ?? []), [project?.reviewSegments, project?.cuts, project?.transcript, uri, sequence]);
  const [activeSegments, setActiveSegments] = useState(proposedSegments);
  const [nativePlaying, setNativePlaying] = useState(true);
  const [nativeSeek, setNativeSeek] = useState(0);
  const [nativePosition, setNativePosition] = useState(0);
  const [nativeError, setNativeError] = useState('');
  const playingSegments = peek ? [peek] : activeSegments;
  const hasClean = proposedSegments.length > 0;
  const nativeMode = !!NativeCutPreview && !peek && previewSource === 'clean' && playingSegments.length > 0;
  const peekNativeMode = !!NativeCutPreview && !!peek;
  const useNative = nativeMode || peekNativeMode;
  const playing = useNative ? nativePlaying : isPlaying;
  const nativeStarted = useRef(false);
  useEffect(() => {
    if (useNative && !nativeStarted.current && !isPlaying) { nativeStarted.current = true; setNativePlaying(true); }
  }, [useNative, isPlaying]);
  const nativeRequest = useMemo(() => JSON.stringify({ id: 'preview', sourceUri: playingSegments[0]?.uri ?? uri, cuts: [], captions: [], segments: playingSegments }), [playingSegments, uri]);
  useEffect(() => { if (useNative) player.pause(); else setNativePlaying(false); }, [useNative, player]);
  const proposedCuts = project?.cuts ?? (!sequence?.conflicts.length && clean?.cuts.length ? clean.cuts : undefined);
  const [activeCuts, setActiveCuts] = useState(proposedCuts);
  const previewCuts = !useNative && !peek && previewSource === 'clean' ? activeCuts : undefined;
  const updatesWaiting = JSON.stringify(proposedCuts) !== JSON.stringify(activeCuts) || JSON.stringify(proposedSegments) !== JSON.stringify(activeSegments);
  const autoStarted = useRef(false);
  useEffect(() => {
    if (playing || !updatesWaiting) return;
    setActiveCuts(proposedCuts); setActiveSegments(proposedSegments); cutIndex.current = 0;
  }, [playing, updatesWaiting, proposedCuts, proposedSegments]);
  useEffect(() => {
    if (useNative || peek || status !== 'readyToPlay' || isPlaying || previewSource !== 'clean' || !activeCuts?.length || autoStarted.current) return;
    autoStarted.current = true;
    player.currentTime = activeCuts[0].t0;
    player.play();
  }, [player, status, activeCuts, previewSource, peek, isPlaying, useNative]);
  const previewFullSource = !peek && (previewSource === 'original' || (previewSource === 'clean' && !previewCuts?.length && !nativeMode));
  const limit = end || duration;
  const valid = Number.isFinite(duration) && duration > 0;
  const captionCues = useMemo(() => {
    try { return partitionCaptionTimeline((project ? transcriptForSource(project, uri) : []).map(s => ({ ...s, text: sanitizeExportCaption(s.manualCorrection ?? s.correctedText ?? s.text) }))); }
    catch { return []; }
  }, [project, uri]);
  const captionText = activeCaptionAt(captionCues, currentTime)?.text ?? '';

  // Trim autosaves through the same queue as every other edit.
  const trimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (trimTimer.current) clearTimeout(trimTimer.current); }, []);
  function updateTrim(nextStart: number, nextEnd: number) {
    setStart(nextStart); setEnd(nextEnd); setMessage('');
    if (trimTimer.current) clearTimeout(trimTimer.current);
    trimTimer.current = setTimeout(() => {
      const current = projectRef.current;
      if (current) void changeProject({ ...current, trim: { start: nextStart, end: nextEnd } }, true).catch(() => {});
    }, 700);
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

  const exportMode = previewSource === 'original' ? 'original' : previewSource === 'trim' ? 'trim' : 'cut';
  const exportBlockedReason = peek
    ? 'Peeking at a take. Return to export.'
    : updatesWaiting && playing
      ? 'New edits apply when paused.'
      : null;
  const exportProject = project && !exportBlockedReason
    ? reviewExportSelection({ ...project, duration: valid ? duration : project.duration }, exportMode, !!sequence?.segments.length)
    : null;

  const covered = review?.lines.filter(line => line.spokenText.trim() && line.selectedTakeId).length ?? 0;
  const totalLines = review?.lines.filter(line => line.spokenText.trim()).length ?? 0;
  const outputDuration = previewSource === 'original'
    ? (valid ? duration : 0)
    : previewSource === 'trim'
      ? (valid ? Math.max(0, limit - start) : 0)
      : useNative
        ? playingSegments.reduce((sum, item) => sum + item.t1 - item.t0, 0)
        : previewCuts?.length
          ? previewCuts.reduce((sum, cut) => sum + cut.t1 - cut.t0, 0)
          : (valid ? duration : 0);
  const statusLine = project?.mode === 'script' && review
    ? `${covered}/${totalLines} lines · ${time(outputDuration)} output${updatesWaiting && playing ? ' · applies on pause' : ''}`
    : `${time(useNative ? nativePosition : currentTime)} · ${time(outputDuration)} output`;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') { player.pause(); setNativePlaying(false); } });
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
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} className="p-3">
        <ArrowLeft size={22} color="white" />
      </Pressable>
      <Text className="text-white text-base font-semibold">Review & export</Text>
      <Text accessibilityLiveRegion="polite" className="text-neutral-400 text-xs px-3">
        {pendingWrites > 0 ? 'Saving…' : persistenceError ? 'Unsaved' : 'Saved'}
      </Text>
    </View>
    <View className="flex-1 bg-neutral-950">
      {useNative && NativeCutPreview ? <NativeCutPreview style={{ flex: 1 }} request={nativeRequest} playing={nativePlaying} seek={nativeSeek} onState={event => {
        const state = event.nativeEvent;
        if (state.position !== undefined) setNativePosition(state.position);
        if (state.ended) setNativePlaying(false);
        if (state.error) {
          setNativeError(state.error); setNativePlaying(false); clearPeek(); setPreviewSource('original');
        }
      }} /> : <VideoView style={{ flex: 1 }} player={player} nativeControls={false} contentFit="contain" />}
      {!!captionText && previewSource !== 'original' && !useNative && <View pointerEvents="none" style={{ position: 'absolute', bottom: '17%', left: '10%', right: '10%', alignItems: 'center' }}>
        <Text style={{ color: 'white', backgroundColor: '#000b', textAlign: 'center', fontWeight: 'bold', fontSize: 18, padding: 6 }}>{captionText}</Text>
      </View>}
      {!useNative && status === 'loading' && <ActivityIndicator style={{ position: 'absolute', alignSelf: 'center', top: '50%' }} color="white" />}
      {!!peek && <Pressable accessibilityRole="button" accessibilityLabel="Return from take peek" onPress={clearPeek}
        className="absolute top-3 self-center rounded-full bg-black/80 px-4 py-2 active:opacity-70">
        <Text className="text-white text-xs">Peeking · tap to return</Text>
      </Pressable>}
    </View>
    {!!nativeError && <Text accessibilityRole="alert" className="text-amber-200 px-6 py-2">Clean preview failed: {nativeError}. Original kept.</Text>}
    {status === 'error' && <Text accessibilityRole="alert" className="text-red-300 px-6 py-2">{playbackError?.message ?? 'This video could not be opened. The file may no longer be available.'}</Text>}
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 48 }} className="px-5 pt-3 w-full self-center" style={{ maxWidth: 600, maxHeight: '55%' }}>
      {!NativeCutPreview && proposedSegments.some(segment => segment.uri !== uri) && <Text className="text-amber-200 text-xs mb-2">Multi-recording preview needs the Android development build. Original is available.</Text>}
      <SourceTabs value={previewSource} onChange={switchSource} cleanDisabled={!hasClean && !peek} />
      <View className="flex-row items-center justify-between mt-3 mb-2">
        <Text accessibilityLiveRegion="polite" className="text-neutral-300 text-xs flex-1 pr-3">{statusLine}</Text>
        <View className="flex-row items-center gap-1">
          <Pressable disabled={!valid || status === 'error'} accessibilityRole="button" accessibilityLabel={playing ? 'Pause' : 'Play'} className="p-3 bg-neutral-800 rounded-full disabled:opacity-40" onPress={() => {
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
          {previewSource === 'trim' && <Pressable accessibilityRole="button" accessibilityLabel="Reset trim" className="p-3" onPress={() => updateTrim(0, duration)}>
            <RotateCcw size={20} color="#a3a3a3" />
          </Pressable>}
        </View>
      </View>

      {previewSource === 'trim' && <>
        {valid && <View onLayout={e => setWidth(e.nativeEvent.layout.width)} style={{ height: 56, marginHorizontal: 12 }}>
          <View onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
            onResponderGrant={e => { if (width) seek(e.nativeEvent.locationX / width * duration); }}
            onResponderMove={e => { if (width) seek(e.nativeEvent.locationX / width * duration); }}
            style={{ flex: 1, backgroundColor: '#262626', overflow: 'hidden', borderRadius: 4 }}>
            <View pointerEvents="none" style={{ flex: 1, flexDirection: 'row' }}>
              {thumbnails.map((thumbnail, i) => <Image key={i} source={thumbnail} contentFit="cover" style={{ flex: 1, height: 56 }} />)}
            </View>
            <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${start / duration * 100}%`, backgroundColor: '#000b' }} />
            <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: `${(1 - limit / duration) * 100}%`, backgroundColor: '#000b' }} />
            <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: `${start / duration * 100}%`, width: `${(limit - start) / duration * 100}%`, borderTopWidth: 3, borderBottomWidth: 3, borderColor: '#e5e5e5' }} />
            <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: `${Math.min(100, currentTime / duration * 100)}%`, width: 2, backgroundColor: 'white' }} />
          </View>
          <TrimHandle value={start} duration={duration} width={width} onChange={v => {
            const next = Math.max(0, Math.min(limit - Math.min(0.25, duration), v));
            updateTrim(next, limit); player.pause(); player.currentTime = next;
          }} />
          <TrimHandle value={limit} duration={duration} width={width} onChange={v => {
            const next = Math.min(duration, Math.max(start + Math.min(0.25, duration), v));
            updateTrim(start, next); player.pause(); player.currentTime = next;
          }} />
        </View>}
        <View className="flex-row justify-between mt-3">
          <Text className="text-neutral-400 text-xs">{time(start)}</Text>
          <Text className="text-neutral-400 text-xs">{time(valid ? limit - start : 0)} selected</Text>
          <Text className="text-neutral-400 text-xs">{time(valid ? limit : 0)}</Text>
        </View>
        <View className="flex-row items-center gap-2 mt-3">
          <Scissors size={16} color="#a3a3a3" />
          <Text className="text-neutral-400 text-xs">Drag the ends to trim. Trims save automatically.</Text>
        </View>
      </>}

      {!!message && <Text accessibilityRole="alert" className="text-neutral-200 text-sm mt-3">{message}</Text>}
      {project && <TranscriptReview project={project} duration={valid ? duration : undefined} onChange={changeProject} onPreviewRecording={NativeCutPreview ? async (recordingUri) => {
        setNativePlaying(false); player.pause();
        try {
          const recordingDuration = await recordedMediaDuration(recordingUri);
          setPeek({ uri: recordingUri, t0: 0, t1: recordingDuration, captions: [] });
          setNativeError(''); setMessage('');
          setNativeSeek(v => v + 1); setNativePlaying(true);
        } catch (error) {
          setMessage(`Could not preview the saved original: ${error instanceof Error ? error.message : String(error)}`);
        }
      } : undefined} onPreviewTake={NativeCutPreview ? id => {
        const take = review?.takes.find(item => item.id === id);
        if (!take?.mediaUri || !take.playable) return;
        setPeek({ uri: take.mediaUri, t0: take.t0, t1: take.t1, takeId: id, captions: [] });
        setNativeSeek(v => v + 1); setNativePlaying(true);
      } : undefined} onSeek={value => {
        clearPeek(); setPreviewSource('original'); player.pause(); player.currentTime = Math.max(0, Math.min(duration, value));
      }} />}
      {!!persistenceError && <Text accessibilityRole="alert" className="text-red-300 py-3">{persistenceError}</Text>}
      {!!exportBlockedReason && <Text className="text-amber-200 text-xs mt-3">{exportBlockedReason}</Text>}
      {project && valid && !persistenceError && !exportBlockedReason && (exportProject ? <>
        <ExportControls project={exportProject} start={exportMode === 'original' ? 0 : start} end={exportMode === 'original' ? duration : limit} onMessage={setMessage} />
      </> : <Text className="text-amber-200 text-xs mt-3">Prepare selected takes below, then review every cut before exporting.</Text>)}
      <View style={{ height: 24 }} />
    </ScrollView>
  </SafeAreaView>;
}

export default function Editor() {
  const { projectId, videoUri } = useLocalSearchParams<{ projectId?: string; videoUri?: string }>();
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
  if (!loading && project && (!project.videoUri || project.mediaMissing)) return <SafeAreaView className="flex-1 bg-black px-6">
    <Pressable onPress={() => router.back()} className="py-4"><Text className="text-white">Back</Text></Pressable>
    <Text className="text-amber-200">{project.recoveryMessage ?? 'The original recording is unavailable. Your saved transcript is still here.'}</Text>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 48 }}>
      <TranscriptReview project={project} onChange={async next => { setProject(next); await saveProjectMetadata(next); }} onSeek={() => {}} />
      <View style={{ height: 24 }} />
    </ScrollView>
  </SafeAreaView>;
  const uri = project?.videoUri ?? videoUri;
  if (loading || error || !uri) return <SafeAreaView className="flex-1 bg-black items-center justify-center px-6">
    {loading ? <ActivityIndicator color="white" /> : <Text className="text-white text-center">{error || 'No video selected.'}</Text>}
    <Pressable onPress={() => router.back()} className="p-4 mt-4"><Text className="text-white">Back</Text></Pressable>
  </SafeAreaView>;
  return <VideoEditor key={projectId ?? uri} project={project} uri={uri} />;
}

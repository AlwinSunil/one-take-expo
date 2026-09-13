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
import { cleanReview, pickupLineIds, selectedReviewCuts, selectedReviewSegments } from '@/lib/clean-review';
import type { Project } from '@/lib/session';
import { getProject, saveProject, saveProjectMetadata } from '@/lib/store';
import { partitionCaptionTimeline, activeCaptionAt } from '@/lib/caption-timeline';
import { LOCAL_VIDEO_BUFFER } from '@/lib/video-buffer';
import { ExportControls } from '@/components/review/export-controls';
import media, { NativeCutPreview } from '../../modules/one-take-media';
import { TranscriptReview } from '@/components/review/transcript-review';
import { T1WrapReport } from '@/components/review/t1-wrap-report';
import { T1CaptionEditor } from '@/components/review/t1-caption-editor';
import { Tier1TakeReview } from '@/components/review/t1-take-review';
import { projectScriptLines } from '@/lib/project-workflow';
import { resolveReviewFootage } from '@/lib/t1-review';
import { applyProjectFraming } from '@/lib/t1-framing-selection';
import { tier1Enabled } from '@/lib/t1-gates';

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

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

function VideoEditor({ project: initialProject, uri }: { project: Project | null; uri: string }) {
  const [project, setProject] = useState(initialProject);
  const latestProject = useRef(project);
  latestProject.current = project;
  const persistence = useRef(Promise.resolve());
  const writeLock = useRef(false);
  const [pendingWrites, setPendingWrites] = useState(0);
  const [persistenceError, setPersistenceError] = useState('');
  async function changeProject(next: Project, preserveMedia = false) {
    if (writeLock.current) throw new Error('Wait for the current edit to save, then retry.');
    writeLock.current = true;
    latestProject.current = next;
    setProject(next);
    setPendingWrites(count => count + 1);
    const pending = persistence.current.catch(() => {}).then(async () => {
      if (preserveMedia) await saveProject(next);
      else await saveProjectMetadata(next);
    });
    persistence.current = pending;
    try { await pending; setPersistenceError(''); }
    catch (error) { setPersistenceError('Edits are not saved. Retry Save before exporting.'); throw error; }
    finally { writeLock.current = false; setPendingWrites(count => count - 1); }
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
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [previewOriginal, setPreviewOriginal] = useState(false);
  const [tier1Test, setTier1Test] = useState(false);
  const [previewTrim, setPreviewTrim] = useState(false);
  const cutIndex = useRef(0);
  const review = useMemo(() => project ? cleanReview(project) : null, [project]);
  const clean = useMemo(() => review ? selectedReviewCuts(review, uri, duration > 0 ? duration : undefined) : null, [review, uri, duration]);
  const sequence = useMemo(() => project ? selectedReviewSegments({ ...project, duration: duration > 0 ? duration : project.duration }, review!) : null, [project, review, duration]);
  const rawProposedSegments = useMemo<NonNullable<Project['reviewSegments']>>(() => project?.reviewSegments?.map(segment => ({ ...segment, captions: transcriptForSource(project, segment.uri).length ? transcriptForSource(project, segment.uri).filter(caption => caption.isFinal !== false).map(caption => ({ t0: caption.t0, t1: caption.t1, text: sanitizeExportCaption(caption.manualCorrection ?? caption.correctedText ?? caption.text) })).filter(caption => caption.text.trim()) : segment.captions })) ?? (project?.cuts?.length ? project.cuts.map(cut => ({ ...cut, uri, captions: transcriptForSource(project, uri).filter(segment => segment.isFinal !== false).map(segment => ({ t0: segment.t0, t1: segment.t1, text: sanitizeExportCaption(segment.manualCorrection ?? segment.correctedText ?? segment.text) })).filter(caption => caption.text.trim()) })) : project?.cuts ? [] : sequence?.segments ?? []), [project?.reviewSegments, project?.cuts, project?.transcript, uri, sequence]);
  const framingAllowed = tier1Enabled('reframing', __DEV__, tier1Test) && media?.supportsFraming === true;
  const proposedSegments = useMemo(() => project ? applyProjectFraming(project, rawProposedSegments, framingAllowed) : rawProposedSegments, [project, rawProposedSegments, framingAllowed]);
  const [activeSegments, setActiveSegments] = useState(proposedSegments);
  const [takePreview, setTakePreview] = useState<Project['reviewSegments']>();
  const [nativePlaying, setNativePlaying] = useState(true);
  const [nativeSeek, setNativeSeek] = useState(0);
  const [nativePosition, setNativePosition] = useState(0);
  const [nativeError, setNativeError] = useState('');
  const [failedMediaUris, setFailedMediaUris] = useState<string[]>([]);
  const playingSegments = takePreview ?? activeSegments;
  const nativeMode = !!NativeCutPreview && !previewOriginal && !previewTrim && playingSegments.length > 0;
  const playing = nativeMode ? nativePlaying : isPlaying;
  const nativeStarted = useRef(false);
  useEffect(() => {
    if (nativeMode && !nativeStarted.current && !isPlaying) { nativeStarted.current = true; setNativePlaying(true); }
  }, [nativeMode, isPlaying]);
  const nativeRequest = useMemo(() => JSON.stringify({ id: 'preview', sourceUri: playingSegments[0]?.uri ?? uri, cuts: [], captions: [], segments: playingSegments }), [playingSegments, uri]);
  useEffect(() => { if (nativeMode) player.pause(); else setNativePlaying(false); }, [nativeMode, player]);
  const proposedCuts = project?.cuts ?? (!sequence?.conflicts.length && clean?.cuts.length ? clean.cuts : undefined);
  const [activeCuts, setActiveCuts] = useState(proposedCuts);
  const previewCuts = !nativeMode && !previewOriginal && !previewTrim ? activeCuts : undefined;
  const updatesWaiting = JSON.stringify(proposedCuts) !== JSON.stringify(activeCuts) || JSON.stringify(proposedSegments) !== JSON.stringify(activeSegments);
  const autoStarted = useRef(false);
  useEffect(() => {
    if (playing || !updatesWaiting) return;
    setActiveCuts(proposedCuts); setActiveSegments(proposedSegments); cutIndex.current = 0;
  }, [playing, updatesWaiting, proposedCuts, proposedSegments]);
  useEffect(() => {
    if (nativeMode || status !== 'readyToPlay' || isPlaying || previewOriginal || previewTrim || !activeCuts?.length || autoStarted.current) return;
    autoStarted.current = true;
    player.currentTime = activeCuts[0].t0;
    player.play();
  }, [player, status, activeCuts, previewOriginal, previewTrim, isPlaying, nativeMode]);
  const previewFullSource = previewOriginal || (!previewTrim && project?.cuts?.length === 0);
  const limit = end || duration;
  const valid = Number.isFinite(duration) && duration > 0;
  const reviewProject = project ? { ...project, duration: valid ? duration : project.duration, mediaMissing: project.mediaMissing !== false || status === 'error' || failedMediaUris.includes(uri), availableMediaUris: (project.availableMediaUris ?? (project.mediaMissing === false ? [uri] : [])).filter(sourceUri => !failedMediaUris.includes(sourceUri) && !(sourceUri === uri && status === 'error')) } : null;
  const captionCues = useMemo(() => {
    try { return partitionCaptionTimeline((project ? transcriptForSource(project, uri) : []).map(s => ({ ...s, text: sanitizeExportCaption(s.manualCorrection ?? s.correctedText ?? s.text) }))); }
    catch { return []; }
  }, [project, uri]);
  const captionText = activeCaptionAt(captionCues, currentTime)?.text ?? '';
  const exportProject = project && !updatesWaiting && !takePreview ? reviewExportSelection({ ...reviewProject!, duration: valid ? duration : project.duration },
    previewOriginal ? 'original' : previewTrim ? 'trim' : 'cut', !!sequence?.segments.length) : null;


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
    if (!isPlaying) return;
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
  }, [player, isPlaying, currentTime, start, limit, duration, previewFullSource, previewCuts]);

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

  async function save() {
    if (!latestProject.current || saving || !valid || writeLock.current) return;
    setSaving(true); setMessage('');
    try {
      await changeProject({ ...latestProject.current!, trim: { start, end: limit } }, true);
      setMessage('Saved. Your original video is preserved.');
    } catch (e) {
      setMessage(`Could not save edits: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setSaving(false); }
  }

  return <SafeAreaView className="flex-1 bg-black">
    <View className="flex-row items-center justify-between px-4 py-2">
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} className="p-3">
        <ArrowLeft size={22} color="white" />
      </Pressable>
      <Text className="text-white text-base font-semibold">Edit video</Text>
      <Pressable disabled={!project || saving || !valid || pendingWrites > 0} onPress={save} className="px-5 py-3 bg-neutral-800 rounded-full disabled:opacity-40">
        <Text className="text-white font-semibold">{saving ? 'Saving…' : 'Save'}</Text>
      </Pressable>
    </View>
    <View className="flex-1 bg-neutral-950">
      {nativeMode && NativeCutPreview ? <NativeCutPreview style={{ flex: 1 }} request={nativeRequest} playing={nativePlaying} seek={nativeSeek} onState={event => {
        const state = event.nativeEvent;
        if (state.position !== undefined) setNativePosition(state.position);
        if (state.ended) setNativePlaying(false);
        if (state.error) {
          setNativeError(state.error); setNativePlaying(false); setPreviewOriginal(true);
          setFailedMediaUris(previous => [...new Set([...previous, ...playingSegments.map(segment => segment.uri)])]);

        }
      }} /> : <VideoView style={{ flex: 1 }} player={player} nativeControls={false} contentFit="contain" />}
      {!!captionText && !previewOriginal && !nativeMode && <View pointerEvents="none" style={{ position: 'absolute', bottom: '17%', left: '10%', right: '10%', alignItems: 'center' }}>
        <Text style={{ color: 'white', backgroundColor: '#000b', textAlign: 'center', fontWeight: 'bold', fontSize: 18, padding: 6 }}>{captionText}</Text>
      </View>}
      {!nativeMode && status === 'loading' && <ActivityIndicator style={{ position: 'absolute', alignSelf: 'center', top: '50%' }} color="white" />}
    </View>
    {!!nativeError && <Text accessibilityRole="alert" className="text-amber-200 px-6 py-3">Clean preview failed: {nativeError}. Preview the original recording or attach replacement footage. Coverage is not verified.</Text>}
    {status === 'error' && <Text accessibilityRole="alert" className="text-red-300 px-6 py-3">{playbackError?.message ?? 'This video could not be opened. The file may no longer be available.'}</Text>}
    <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }} className="px-6 pt-4 w-full self-center" style={{ maxWidth: 600, maxHeight: '55%' }}>
      {!NativeCutPreview && proposedSegments.some(segment => segment.uri !== uri) && <Text className="text-amber-200 text-xs mb-3">Multi-recording preview needs the Android development build with the media player. Your original recording remains available.</Text>}
      {takePreview && <Pressable accessibilityRole="button" className="py-3" onPress={() => { setTakePreview(undefined); setNativePlaying(false); setNativeSeek(0); }}><Text className="text-white text-xs">Return to clean cut</Text></Pressable>}
      {review && <Text accessibilityLiveRegion="polite" className="text-neutral-300 text-xs mb-3">
        {review.lines.filter(line => line.spokenText.trim() && line.selectedTakeId).length} / {review.lines.filter(line => line.spokenText.trim()).length} spoken lines {nativeError ? 'matched; playback verification failed' : 'covered'}.
        {review.lines.some(line => line.pendingReasons.length) || project?.refinement?.status === 'running' ? ' Verdicts updating.' : ''}
        {updatesWaiting ? ' Updated cuts will apply when playback pauses.' : ''}
        {!proposedSegments.length ? ' No clean sequence yet. Preview the original or recheck saved audio below.' : ' Selected takes play directly; review boundaries before export.'}
        {sequence?.conflicts.length ? ' Selected takes overlap spoken lines. Choose the same whole take for those lines below; preview the original meanwhile.' : sequence?.unavailableTakeIds.length ? ' Some selected media cannot play here. Coverage is incomplete; compare the original.' : ''}
      </Text>}
      <View className="flex-row items-center justify-between mb-5">
        <Text className="text-neutral-300 text-xs">{time(nativeMode ? nativePosition : currentTime)} / {time(nativeMode ? playingSegments.reduce((sum, item) => sum + item.t1 - item.t0, 0) : valid ? duration : 0)}</Text>
        <Pressable disabled={!nativeMode && (!valid || status === 'error')} accessibilityRole="button" accessibilityLabel={playing ? 'Pause' : 'Play'} className="p-3 bg-neutral-800 rounded-full" onPress={() => {
          if (nativeMode) { if (!nativePlaying && nativePosition >= playingSegments.reduce((sum, item) => sum + item.t1 - item.t0, 0) - 0.05) setNativeSeek(0); setNativePlaying(value => !value); return; }
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
        <Pressable accessibilityRole="button" accessibilityLabel="Reset trim" className="p-3" onPress={() => { setStart(0); setEnd(duration); player.pause(); player.currentTime = 0; setMessage(''); }}>
          <RotateCcw size={20} color="#a3a3a3" />
        </Pressable>
      </View>
      <Pressable className="py-3" onPress={() => { setTakePreview(undefined); setNativePlaying(false); player.pause(); setPreviewTrim(false); setPreviewOriginal(v => !v); }}>
        <Text className="text-white text-xs">{previewOriginal ? 'Preview clean cut' : 'Compare original video'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" className="py-3" onPress={() => {
        setTakePreview(undefined); setNativePlaying(false); player.pause(); setPreviewOriginal(false); setPreviewTrim(v => !v); player.currentTime = start;
      }}><Text className="text-white text-xs">{previewTrim ? 'Preview clean cut' : 'Preview manual trim'}</Text></Pressable>
      {valid && <View onLayout={e => setWidth(e.nativeEvent.layout.width)} style={{ height: 56, marginHorizontal: 12 }}>
        <View onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
          onResponderGrant={e => { if (width) { setTakePreview(undefined); setPreviewTrim(true); seek(e.nativeEvent.locationX / width * duration); } }}
          onResponderMove={e => { if (width) { setTakePreview(undefined); setPreviewTrim(true); seek(e.nativeEvent.locationX / width * duration); } }}
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
          setPreviewOriginal(false); setPreviewTrim(true); setStart(next); player.pause(); player.currentTime = next; setMessage('');
        }} />
        <TrimHandle value={limit} duration={duration} width={width} onChange={v => {
          const next = Math.min(duration, Math.max(start + Math.min(0.25, duration), v));
          setPreviewOriginal(false); setPreviewTrim(true); setEnd(next); player.pause(); player.currentTime = next; setMessage('');
        }} />
      </View>}
      <View className="flex-row justify-between mt-4">
        <Text className="text-neutral-400 text-xs">{time(start)}</Text>
        <Text className="text-neutral-400 text-xs">{time(valid ? limit - start : 0)} selected</Text>
        <Text className="text-neutral-400 text-xs">{time(valid ? limit : 0)}</Text>
      </View>
      <View className="items-center mt-6"><Scissors size={20} color="white" /><Text className="text-white text-xs mt-2">Trim</Text></View>
      <Text className="text-neutral-500 text-xs text-center mt-3">Drag the ends to trim. Slide across the filmstrip to preview.</Text>
      {!!message && <Text accessibilityRole="alert" className="text-neutral-200 text-sm mt-3 text-center">{message}</Text>}
      {__DEV__ && <Pressable accessibilityRole="button" className="py-3" onPress={() => setTier1Test(v => !v)}><Text className="text-amber-200">{tier1Test ? 'Disable Tier 1 development test' : 'Enable Tier 1 development test'}</Text></Pressable>}
      {project && tier1Enabled('reframing', __DEV__, tier1Test) && <View className="border-t border-neutral-800 py-3">
        <Text className="text-white font-semibold">Optional reframing</Text>
        <Text className="text-neutral-400 py-2">{!framingAllowed ? 'Reframing unavailable in this native build. Original frame retained.' : !(Array.isArray(project.framing?.suggestions) && project.framing.suggestions.length) ? 'No framing suggestions supplied. Original frame retained.' : project.framing.enabled ? 'Suggested static crops enabled. Unsafe or missing tracks use the original.' : 'Off · original frame'}</Text>
        <Pressable accessibilityRole="button" disabled={!framingAllowed || !(Array.isArray(project.framing?.suggestions) && project.framing.suggestions.length) || pendingWrites > 0} className="py-3 disabled:opacity-40" onPress={() => {
          setNativePlaying(false); player.pause(); setTakePreview(undefined);
          void changeProject({ ...project, framing: { ...project.framing!, enabled: !project.framing?.enabled } }).catch(() => setMessage('Framing choice could not be saved.'));
        }}><Text className="text-white">{project.framing?.enabled ? 'Off / reset original frame' : 'Apply suggested framing'}</Text></Pressable>
      </View>}
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
        if (!current) return;
        void changeProject({ ...current, scriptLines: projectScriptLines(current).map(line => ({ ...line, actionCues: line.actionCues.map(cue => cue.id === id ? { ...cue, resolved: confirmed } : cue) })) }).catch(() => setMessage('Action confirmation could not be saved.'));
      }} onReviewFootage={range => {
        const source = resolveReviewFootage(reviewProject!, range);
        if (!source || !NativeCutPreview) { setMessage('Supporting footage preview is unavailable in this build.'); return; }
        player.pause(); setPreviewOriginal(false); setPreviewTrim(false); setTakePreview([{ ...range, uri: source.uri }]); setNativeSeek(0); setNativePlaying(true);
      }} />}
      {project && reviewProject && tier1Enabled('takeReview', __DEV__, tier1Test) && <Tier1TakeReview project={reviewProject} onChange={changeProject} onPreview={range => {
        const source = resolveReviewFootage(reviewProject!, { ...range, recordingId: 'recordingId' in range ? String(range.recordingId) : project.id });
        if (!source || !NativeCutPreview) { setMessage('Take preview is unavailable in this build.'); return; }
        player.pause(); setPreviewOriginal(false); setPreviewTrim(false); setTakePreview([{ ...range, uri: source.uri }]); setNativeSeek(0); setNativePlaying(true);
      }} />}
      {project && reviewProject && <TranscriptReview project={reviewProject} duration={valid ? duration : undefined} onChange={changeProject} onPreviewRecording={NativeCutPreview ? async (recordingUri) => {
        setNativePlaying(false); player.pause();
        try {
          const recordingDuration = await recordedMediaDuration(recordingUri);
          setTakePreview([{ uri: recordingUri, t0: 0, t1: recordingDuration, captions: [] }]);
          setNativeError(''); setMessage('');
          setPreviewOriginal(false); setPreviewTrim(false); setNativeSeek(0); setNativePlaying(true);
        } catch (error) {
          setMessage(`Could not preview the saved original: ${error instanceof Error ? error.message : String(error)}`);
        }
      } : undefined} onPreviewTake={NativeCutPreview ? id => {
        const take = review?.takes.find(item => item.id === id);
        if (!take?.mediaUri || !take.playable) return;
        setTakePreview([{ uri: take.mediaUri, t0: take.t0, t1: take.t1, takeId: id, captions: [] }]);
        setPreviewOriginal(false); setPreviewTrim(false); setNativeSeek(0); setNativePlaying(true);
      } : undefined} onSeek={value => {
        setTakePreview(undefined); setPreviewOriginal(true); player.pause(); player.currentTime = Math.max(0, Math.min(duration, value));
      }} />}
      {!!persistenceError && <Text accessibilityRole="alert" className="text-red-300 py-3">{persistenceError}</Text>}
      {project && valid && !persistenceError && pendingWrites === 0 && (exportProject ? <>
        <Text className="text-neutral-300 text-xs mt-3">{previewOriginal ? 'Export original video without captions' : previewTrim ? 'Export the manual trim with captions' : project.cuts || project.reviewSegments?.length ? 'Export prepared cuts with captions' : 'Export the manual trim with captions'}</Text>
        <ExportControls framingEnabled={framingAllowed && !previewOriginal && !previewTrim} project={exportProject} start={previewOriginal ? 0 : start} end={previewOriginal ? duration : limit} onMessage={setMessage} />
      </> : <Text className="text-amber-200 text-xs mt-3">{takePreview ? 'Previewing a take. Return to the clean cut, original, or manual trim to export.' : updatesWaiting ? 'Pause playback to apply updated cuts before exporting.' : 'Prepare selected takes below and review every cut before exporting this clean preview. To export the original or manual trim, switch to that preview first.'}</Text>)}
    </ScrollView>
  </SafeAreaView>;
}

function MissingMediaReview({ project, onChange }: { project: Project; onChange: (next: Project) => Promise<void> }) {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [preview, setPreview] = useState<Project['reviewSegments']>();
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const current = { ...project, availableMediaUris: (project.availableMediaUris ?? []).filter(uri => !failed.includes(uri)) };
  function reviewFootage(range: { recordingId: string; t0: number; t1: number }) {
    const source = resolveReviewFootage(current, range);
    if (!source || !NativeCutPreview) { setError('Supporting footage is unavailable.'); return; }
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
    if (lock.current) throw new Error('Wait for the current edit to save.');
    lock.current = true; setBusy(true);
    try { await onChange(next); setError(''); }
    catch (e) { setError(String(e)); throw e; }
    finally { lock.current = false; setBusy(false); }
  }
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }}>
    {preview && NativeCutPreview && <View>
      <NativeCutPreview style={{ height: 240 }} request={JSON.stringify({ id: 'recovery-preview', sourceUri: preview[0].uri, cuts: [], captions: [], segments: preview })} playing={playing} seek={0} onState={event => {
        if (event.nativeEvent.ended) setPlaying(false);
        if (event.nativeEvent.error) { setError(event.nativeEvent.error); setFailed(previous => [...new Set([...previous, ...preview.map(segment => segment.uri)])]); setPreview(undefined); setPlaying(false); }
      }} />
      <Pressable accessibilityRole="button" onPress={() => { setPreview(undefined); setPlaying(false); }} className="py-3"><Text className="text-white">Close supporting footage</Text></Pressable>
    </View>}
    {__DEV__ && <Pressable accessibilityRole="button" className="py-3" onPress={() => setEnabled(v => !v)}><Text className="text-amber-200">{enabled ? 'Disable Tier 1 development test' : 'Enable Tier 1 development test'}</Text></Pressable>}
    <T1CaptionEditor project={current} onChange={change} enabled={tier1Enabled('takeReview', __DEV__, enabled)} disabled={busy} />
    <T1WrapReport project={current} onChange={change} disabled={busy} enabled={tier1Enabled('wrapReport', __DEV__, enabled)} onReviewFootage={reviewFootage} onPickup={lineId => { void pickup(lineId); }} />
    {tier1Enabled('takeReview', __DEV__, enabled) && <Tier1TakeReview project={current} onChange={change} onPreview={reviewFootage} />}
    <TranscriptReview project={current} onChange={change} onSeek={() => setError('The original recording is unavailable.')} />
    {!!error && <Text accessibilityRole="alert" className="text-amber-200">{error}</Text>}
  </ScrollView>;
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
    <MissingMediaReview project={{ ...project, mediaMissing: true }} onChange={async next => { await saveProjectMetadata(next); setProject(next); }} />
  </SafeAreaView>;
  const uri = project?.videoUri ?? videoUri;
  if (loading || error || !uri) return <SafeAreaView className="flex-1 bg-black items-center justify-center px-6">
    {loading ? <ActivityIndicator color="white" /> : <Text className="text-white text-center">{error || 'No video selected.'}</Text>}
    <Pressable onPress={() => router.back()} className="p-4 mt-4"><Text className="text-white">Back</Text></Pressable>
  </SafeAreaView>;
  return <VideoEditor key={projectId ?? uri} project={project} uri={uri} />;
}

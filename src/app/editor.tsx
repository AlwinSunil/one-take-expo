import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { router, useNavigation, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoThumbnail } from 'expo-video';
import { ArrowLeft, Pause, Play, RotateCcw, Scissors } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, PanResponder, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Project } from '@/lib/session';
import { getProject, saveProject, saveProjectMetadata } from '@/lib/store';
import { partitionCaptionTimeline, activeCaptionAt } from '@/lib/caption-timeline';
import { LOCAL_VIDEO_BUFFER } from '@/lib/video-buffer';
import { ExportControls } from '@/components/review/export-controls';
import { TranscriptReview } from '@/components/review/transcript-review';
import { T1WrapReport } from '@/components/review/t1-wrap-report';
import { T1CaptionEditor } from '@/components/review/t1-caption-editor';
import { Tier1TakeReview } from '@/components/review/t1-take-review';
import { projectScriptLines } from '@/lib/project-workflow';
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
  const [pendingWrites, setPendingWrites] = useState(0);
  const [persistenceError, setPersistenceError] = useState('');
  async function changeProject(next: Project, preserveMedia = false) {
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
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [previewOriginal, setPreviewOriginal] = useState(false);
  const [tier1Test, setTier1Test] = useState(false);
  const [takePreview, setTakePreview] = useState<{ t0: number; t1: number } | null>(null);
  const cutIndex = useRef(0);
  const previewCuts = takePreview ? [takePreview] : !previewOriginal ? project?.cuts : undefined;
  const previewFullSource = previewOriginal || project?.cuts?.length === 0;
  const limit = end || duration;
  const valid = Number.isFinite(duration) && duration > 0;
  const reviewProject = project ? { ...project, duration: valid ? duration : project.duration, mediaMissing: project.mediaMissing !== false || status !== 'readyToPlay' } : null;
  const captionCues = useMemo(() => {
    try { return partitionCaptionTimeline((project?.transcript ?? []).map(s => ({ ...s, text: s.manualCorrection ?? s.correctedText ?? s.text }))); }
    catch { return []; }
  }, [project?.transcript]);
  const captionText = activeCaptionAt(captionCues, currentTime)?.text ?? '';


  useEffect(() => navigation.addListener('blur', () => player.pause()), [navigation, player]);

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
    if (!project || saving || !valid) return;
    setSaving(true); setMessage('');
    try {
      await changeProject({ ...project, trim: { start, end: limit } }, true);
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
      <Pressable disabled={!project || saving || !valid} onPress={save} className="px-5 py-3 bg-neutral-800 rounded-full disabled:opacity-40">
        <Text className="text-white font-semibold">{saving ? 'Saving…' : 'Save'}</Text>
      </Pressable>
    </View>
    <View className="flex-1 bg-neutral-950">
      <VideoView style={{ flex: 1 }} player={player} nativeControls={false} contentFit="contain" />
      {!!captionText && !previewOriginal && <View pointerEvents="none" style={{ position: 'absolute', bottom: '17%', left: '10%', right: '10%', alignItems: 'center' }}>
        <Text style={{ color: 'white', backgroundColor: '#000b', textAlign: 'center', fontWeight: 'bold', fontSize: 18, padding: 6 }}>{captionText}</Text>
      </View>}
      {status === 'loading' && <ActivityIndicator style={{ position: 'absolute', alignSelf: 'center', top: '50%' }} color="white" />}
    </View>
    {status === 'error' && <Text accessibilityRole="alert" className="text-red-300 px-6 py-3">{playbackError?.message ?? 'This video could not be opened. The file may no longer be available.'}</Text>}
    <ScrollView className="px-6 pt-4 pb-6 w-full self-center" style={{ maxWidth: 600, maxHeight: '55%' }}>
      <View className="flex-row items-center justify-between mb-5">
        <Text className="text-neutral-300 text-xs">{time(currentTime)} / {time(valid ? duration : 0)}</Text>
        <Pressable disabled={!valid || status === 'error'} accessibilityRole="button" accessibilityLabel={isPlaying ? 'Pause' : 'Play'} className="p-3 bg-neutral-800 rounded-full" onPress={() => {
          if (isPlaying) player.pause();
          else {
            if (previewCuts?.length) { cutIndex.current = 0; player.currentTime = previewCuts[0].t0; }
            else if (player.currentTime < (previewFullSource ? 0 : start) || player.currentTime >= (previewFullSource ? duration : limit)) player.currentTime = previewFullSource ? 0 : start;
            player.play();
          }
        }}>
          {isPlaying ? <Pause size={22} color="white" /> : <Play size={22} color="white" />}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Reset trim" className="p-3" onPress={() => { setStart(0); setEnd(duration); player.pause(); player.currentTime = 0; setMessage(''); }}>
          <RotateCcw size={20} color="#a3a3a3" />
        </Pressable>
      </View>
      <Pressable className="py-3" onPress={() => { player.pause(); setTakePreview(null); setPreviewOriginal(v => !v); }}>
        <Text className="text-white text-xs">{previewOriginal ? 'Preview edits' : 'Compare original video'}</Text>
      </Pressable>
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
          setStart(next); player.pause(); player.currentTime = next; setMessage('');
        }} />
        <TrimHandle value={limit} duration={duration} width={width} onChange={v => {
          const next = Math.min(duration, Math.max(start + Math.min(0.25, duration), v));
          setEnd(next); player.pause(); player.currentTime = next; setMessage('');
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
      {project && reviewProject && <T1WrapReport project={reviewProject} onChange={next => changeProject({ ...next, mediaMissing: project.mediaMissing })} enabled={tier1Enabled('wrapReport', __DEV__, tier1Test)} onConfirmAction={(id, confirmed) => {
        const current = latestProject.current;
        if (!current) return;
        void changeProject({ ...current, scriptLines: projectScriptLines(current).map(line => ({ ...line, actionCues: line.actionCues.map(cue => cue.id === id ? { ...cue, resolved: confirmed } : cue) })) }).catch(() => setMessage('Action confirmation could not be saved.'));
      }} onReviewFootage={range => {
        player.pause(); setTakePreview(range); cutIndex.current = 0; player.currentTime = range.t0; setPreviewOriginal(false); player.play();
      }} />}
      {project && reviewProject && <T1CaptionEditor project={reviewProject} onChange={next => changeProject({ ...next, mediaMissing: project.mediaMissing })} enabled={tier1Enabled('takeReview', __DEV__, tier1Test)} disabled={pendingWrites > 0} />}
      {project && reviewProject && tier1Enabled('takeReview', __DEV__, tier1Test) && <Tier1TakeReview project={reviewProject} onChange={next => changeProject({ ...next, mediaMissing: project.mediaMissing })} onPreview={range => {
        player.pause(); setTakePreview(range); cutIndex.current = 0; player.currentTime = range.t0; setPreviewOriginal(false); player.play();
      }} />}
      {project && <TranscriptReview project={project} duration={valid ? duration : undefined} onChange={changeProject} onSeek={value => {
        setTakePreview(null); setPreviewOriginal(true); player.pause(); player.currentTime = Math.max(0, Math.min(duration, value));
      }} />}
      {!!persistenceError && <Text accessibilityRole="alert" className="text-red-300 py-3">{persistenceError}</Text>}
      {project && valid && !persistenceError && pendingWrites === 0 && <ExportControls project={project} start={start} end={limit} onMessage={setMessage} />}
    </ScrollView>
  </SafeAreaView>;
}

function MissingMediaReview({ project, onChange }: { project: Project; onChange: (next: Project) => Promise<void> }) {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function change(next: Project) {
    if (lock.current) throw new Error('Wait for the current edit to save.');
    lock.current = true; setBusy(true);
    try { await onChange(next); setError(''); }
    catch (e) { setError(String(e)); throw e; }
    finally { lock.current = false; setBusy(false); }
  }
  return <ScrollView>
    {__DEV__ && <Pressable accessibilityRole="button" className="py-3" onPress={() => setEnabled(v => !v)}><Text className="text-amber-200">{enabled ? 'Disable Tier 1 development test' : 'Enable Tier 1 development test'}</Text></Pressable>}
    <T1CaptionEditor project={project} onChange={change} enabled={tier1Enabled('takeReview', __DEV__, enabled)} disabled={busy} />
    <T1WrapReport project={project} onChange={change} enabled={tier1Enabled('wrapReport', __DEV__, enabled)} />
    {tier1Enabled('takeReview', __DEV__, enabled) && <Tier1TakeReview project={project} onChange={change} onPreview={() => {}} />}
    <TranscriptReview project={project} onChange={change} onSeek={() => {}} />
    {!!error && <Text accessibilityRole="alert" className="text-amber-200">{error}</Text>}
  </ScrollView>;
}

export default function Editor() {
  const { projectId, videoUri } = useLocalSearchParams<{ projectId?: string; videoUri?: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(!!projectId);
  const [error, setError] = useState('');
  useEffect(() => {
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
  }, [projectId]);
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

import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { router, useNavigation, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoThumbnail } from 'expo-video';
import { ArrowLeft, Pause, Play, RotateCcw, Scissors } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, PanResponder, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Project } from '@/lib/session';
import { getProject, saveProject } from '@/lib/store';

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

function VideoEditor({ project, uri }: { project: Project | null; uri: string }) {
  const navigation = useNavigation();
  const player = useVideoPlayer(uri, p => { p.timeUpdateEventInterval = 0.1; });
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
  const limit = end || duration;
  const valid = Number.isFinite(duration) && duration > 0;

  useEffect(() => navigation.addListener('blur', () => player.pause()), [navigation, player]);

  useEffect(() => {
    if (status !== 'readyToPlay' || !valid) return;
    let active = true;
    player.generateThumbnailsAsync(Array.from({ length: 8 }, (_, i) => duration * i / 8), { maxWidth: 120 })
      .then(frames => { if (active) setThumbnails(frames); }).catch(() => {});
    return () => { active = false; };
  }, [player, status, duration, valid]);

  useEffect(() => {
    if (isPlaying && (currentTime >= limit || currentTime < start)) {
      player.pause();
      player.currentTime = start;
    }
  }, [player, isPlaying, currentTime, start, limit]);

  function seek(value: number) {
    player.pause();
    player.currentTime = Math.max(start, Math.min(limit, value));
  }

  async function save() {
    if (!project || saving || !valid) return;
    setSaving(true); setMessage('');
    try {
      await saveProject({ ...project, trim: { start, end: limit } });
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
      {status === 'loading' && <ActivityIndicator style={{ position: 'absolute', alignSelf: 'center', top: '50%' }} color="white" />}
    </View>
    {status === 'error' && <Text accessibilityRole="alert" className="text-red-300 px-6 py-3">{playbackError?.message ?? 'This video could not be opened. The file may no longer be available.'}</Text>}
    <View className="px-6 pt-4 pb-6 w-full self-center" style={{ maxWidth: 600 }}>
      <View className="flex-row items-center justify-between mb-5">
        <Text className="text-neutral-300 text-xs">{time(currentTime)} / {time(valid ? duration : 0)}</Text>
        <Pressable disabled={!valid || status === 'error'} accessibilityRole="button" accessibilityLabel={isPlaying ? 'Pause' : 'Play'} className="p-3 bg-neutral-800 rounded-full" onPress={() => {
          if (isPlaying) player.pause();
          else { if (player.currentTime < start || player.currentTime >= limit) player.currentTime = start; player.play(); }
        }}>
          {isPlaying ? <Pause size={22} color="white" /> : <Play size={22} color="white" />}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Reset trim" className="p-3" onPress={() => { setStart(0); setEnd(duration); player.pause(); player.currentTime = 0; setMessage(''); }}>
          <RotateCcw size={20} color="#a3a3a3" />
        </Pressable>
      </View>
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
    </View>
  </SafeAreaView>;
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
  const uri = project?.videoUri ?? videoUri;
  if (loading || error || !uri) return <SafeAreaView className="flex-1 bg-black items-center justify-center px-6">
    {loading ? <ActivityIndicator color="white" /> : <Text className="text-white text-center">{error || 'No video selected.'}</Text>}
    <Pressable onPress={() => router.back()} className="p-4 mt-4"><Text className="text-white">Back</Text></Pressable>
  </SafeAreaView>;
  return <VideoEditor key={projectId ?? uri} project={project} uri={uri} />;
}

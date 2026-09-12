import { CameraType, CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { useEvent } from 'expo';
import { useKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoThumbnail } from 'expo-video';
import { Image } from 'expo-image';
import { ArrowLeft, Images, ChevronLeft, ChevronRight, Grid3X3, SlidersHorizontal, SwitchCamera, X, Sparkles } from 'lucide-react-native';
import { getSetting, saveProject, saveSetting } from '@/lib/store';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Animated, AppState, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  PinchGestureHandler,
  State,
  type PinchGestureHandlerGestureEvent,
  type PinchGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

const icons = {
  arrow_back: ArrowLeft,
  photo_library: Images,
  chevron_left: ChevronLeft,
  chevron_right: ChevronRight,
  grid_3x3: Grid3X3,
  tune: SlidersHorizontal,
  flip_camera_android: SwitchCamera,
  close: X,
};

function IconButton({ icon, label, onPress, disabled = false }: {
  icon: keyof typeof icons; label: string; onPress: () => void; disabled?: boolean;
}) {
  const Icon = icons[icon];
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    onPress={onPress} className="min-h-12 min-w-12 items-center justify-center active:opacity-60"
    style={{ opacity: disabled ? 0.35 : 1 }}>
    <Icon size={20} strokeWidth={1.75} color="white" />
  </Pressable>;
}

function PreviewPlayer({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, p => { p.loop = true; p.play(); });
  return <VideoView style={{ flex: 1 }} player={player} nativeControls contentFit="contain" />;
}

function LatestThumb({ uri, onPress }: { uri: string; onPress: () => void }) {
  const player = useVideoPlayer(uri);
  const [thumb, setThumb] = useState<VideoThumbnail | null>(null);
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  useEffect(() => {
    if (status !== 'readyToPlay') return;
    let live = true;
    player.generateThumbnailsAsync(0, { maxWidth: 128 })
      .then(t => { if (live) setThumb(t[0] ?? null); })
      .catch(() => {});
    return () => { live = false; };
  }, [player, status]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Open saved videos" onPress={onPress}
      className="min-h-12 min-w-12 items-center justify-center active:opacity-60">
      {thumb ? (
        <Image source={thumb} style={{ width: 36, height: 36, borderRadius: 6 }} contentFit="cover" />
      ) : (
        <Images size={20} strokeWidth={1.75} color="white" />
      )}
    </Pressable>
  );
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

const ZOOM_STOPS = [0, 0.25, 0.5];


export default function CameraScreen() {
  useKeepAwake();
  const { mode, script } = useLocalSearchParams<{ mode?: string; script?: string }>();
  const isScript = mode === 'script';
  const [cameraPermission, requestCamera] = useCameraPermissions();
  const [micPermission, requestMic] = useMicrophonePermissions();
  const camera = useRef<CameraView>(null);
  const busy = useRef(false);
  const startedAt = useRef(0);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [seconds, setSeconds] = useState(0);
  const [grid, setGrid] = useState(true);
  const [zoom, setZoom] = useState(0);
  const [sheet, setSheet] = useState<'settings' | 'suggestions' | null>(null);
  const [videoQuality, setVideoQuality] = useState<'2160p' | '1080p' | '720p' | '480p'>('2160p');
  const [error, setError] = useState('');
  const [chunk, setChunk] = useState(0);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [previewDuration, setPreviewDuration] = useState(0);
  const [lastUri, setLastUri] = useState<string | null>(null);
  const chunks = (script ?? '').match(/[^.!?\n]+[.!?]?/g)?.map(s => s.trim()).filter(Boolean) ?? [];

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' && busy.current) camera.current?.stopRecording();
    });
    return () => { subscription.remove(); camera.current?.stopRecording(); };
  }, []);

  const settingsLoaded = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const [q, g, z, last] = await Promise.all([
          getSetting('video_quality'),
          getSetting('grid', '1'),
          getSetting('zoom', '0'),
          getSetting('last_video_uri'),
        ]);
        if (q === '2160p' || q === '1080p' || q === '720p' || q === '480p') setVideoQuality(q);
        setGrid(g !== '0');
        const zf = parseFloat(z);
        if (Number.isFinite(zf)) setZoom(clamp01(zf));
        if (last) setLastUri(last);
      } catch {
        /* keep defaults */
      }
      settingsLoaded.current = true;
    })();
  }, []);

  useEffect(() => {
    if (settingsLoaded.current) saveSetting('video_quality', videoQuality).catch(() => {});
  }, [videoQuality]);

  useEffect(() => {
    if (settingsLoaded.current) saveSetting('grid', grid ? '1' : '0').catch(() => {});
  }, [grid]);

  useEffect(() => {
    if (!settingsLoaded.current) return;
    const id = setTimeout(() => saveSetting('zoom', String(zoom)).catch(() => {}), 600);
    return () => clearTimeout(id);
  }, [zoom]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 250);
    return () => clearInterval(id);
  }, [recording]);

  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);  const pinchBase = useRef(0);
  function onPinchState(e: PinchGestureHandlerStateChangeEvent) {
    if (e.nativeEvent.state === State.BEGAN) pinchBase.current = zoomRef.current;
  }
  function onPinch(e: PinchGestureHandlerGestureEvent) {
    setZoom(clamp01(pinchBase.current + (e.nativeEvent.scale - 1) * 0.5));
  }

  async function record() {
    if (busy.current) {
      setSaving(true);
      camera.current?.stopRecording();
      return;
    }
    if (!ready || !camera.current) return;
    busy.current = true;
    startedAt.current = Date.now();
    setSeconds(0); setError(''); setRecording(true);
    try {
      const result = await camera.current.recordAsync();
      if (!result) throw new Error('No video was returned. Please try again.');
      setPreviewDuration(Math.floor((Date.now() - startedAt.current) / 1000));
      setPreviewUri(result.uri);
      setLastUri(result.uri);
      saveSetting('last_video_uri', result.uri).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recording failed. Please try again.');
    } finally {
      busy.current = false; setRecording(false); setSaving(false);
    }
  }

  async function continueToEditor() {
    if (!previewUri) return;
    const uri = previewUri;
    const duration = previewDuration;
    try {
      await saveProject({
        id: `${Date.now()}`,
        mode: isScript ? 'script' : 'assisted',
        script: isScript && typeof script === 'string' ? script : undefined,
        videoUri: uri,
        clips: [],
        transcript: [],
        createdAt: Date.now(),
      });
    } catch {
      setError('Could not save project. Please try again.');
      return;
    }
    setPreviewUri(null);
    router.push({ pathname: '/editor', params: {
      mode: isScript ? 'script' : 'assisted', videoUri: uri,
      duration: String(duration),
      quality: videoQuality,
    } });
  }

  const camBlocked = !!cameraPermission && !cameraPermission.granted && !cameraPermission.canAskAgain;
  const micBlocked = !!micPermission && !micPermission.granted && !micPermission.canAskAgain;
  const settingsBlocked = camBlocked || micBlocked;

  if (!cameraPermission?.granted || !micPermission?.granted) return (
    <SafeAreaView className="flex-1 bg-black items-center justify-center px-6">
      <StatusBar style="light" />
      <Text className="text-white text-base text-center">Camera and microphone access</Text>
      <Text className="text-neutral-400 text-sm text-center mt-2 leading-6">
        One Take needs the camera for video and the microphone for audio. Recording is impossible without both.
      </Text>
      {settingsBlocked ? (
        <Pressable className="bg-white rounded-full px-6 py-4 mt-5" onPress={() => Linking.openSettings()}>
          <Text className="text-black font-semibold">Open Settings</Text>
        </Pressable>
      ) : (
        <Pressable className="bg-white rounded-full px-6 py-4 mt-5" onPress={async () => {
          await requestCamera(); await requestMic();
        }}><Text className="text-black font-semibold">Allow access</Text></Pressable>
      )}
      <Pressable onPress={() => router.push('/projects')} className="p-4"><Text className="text-neutral-400">View projects</Text></Pressable>
      <Pressable onPress={() => router.back()} className="p-4"><Text className="text-neutral-400">Back</Text></Pressable>
    </SafeAreaView>
  );

  return <SafeAreaView className="flex-1 bg-black">
    <StatusBar style="light" />
    <View className="flex-1 overflow-hidden bg-neutral-950">
        <CameraView ref={camera} style={StyleSheet.absoluteFill} facing={facing} mode="video"
          videoQuality={videoQuality} zoom={zoom}
          onCameraReady={() => setReady(true)} onMountError={event => { setReady(false); setError(event.message); }} />
    <View className="flex-row items-center justify-between px-4 h-16 bg-black/40">
      <IconButton icon="arrow_back" label="Back" disabled={recording || saving} onPress={() => router.back()} />
      <Text className="text-white text-xs tracking-widest">{isScript ? 'SCRIPT' : 'ASSISTED'}</Text>
      {lastUri && !recording && !saving
        ? <LatestThumb uri={lastUri} onPress={() => router.push('/projects')} />
        : <IconButton icon="photo_library" label="Projects" disabled={recording || saving} onPress={() => router.push('/projects')} />}
    </View>

    <View className="flex-1">
      <PinchGestureHandler onGestureEvent={onPinch} onHandlerStateChange={onPinchState}>
        <Animated.View style={{ flex: 1 }}>
        {grid && <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {[1, 2].map(n => <View key={`v${n}`} style={{ position: 'absolute', left: `${n * 100 / 3}%`, top: 0, bottom: 0, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: '#ffffff55' }} />)}
          {[1, 2].map(n => <View key={`h${n}`} style={{ position: 'absolute', top: `${n * 100 / 3}%`, left: 0, right: 0, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#ffffff55' }} />)}
        </View>}
        <View className="self-center mt-4 bg-white rounded px-3 py-1.5">
          <Text className="text-black text-xs font-bold">{recording ? `${saving ? 'SAVING' : 'REC'}  ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : `VIDEO · ${videoQuality}`}</Text>
        </View>
        {isScript && <View className="absolute bottom-3 left-3 right-3 bg-black/70 rounded-xl px-3 py-2">
          <Text numberOfLines={2} className="text-white text-base leading-6">{chunks[chunk] ?? 'No script'}</Text>
          <View className="flex-row justify-between items-center">
            <IconButton icon="chevron_left" label="Previous script section" disabled={chunk === 0} onPress={() => setChunk(i => i - 1)} />
            <Text className="text-neutral-400 text-xs">Manual · {chunks.length ? chunk + 1 : 0}/{chunks.length}</Text>
            <IconButton icon="chevron_right" label="Next script section" disabled={chunk >= chunks.length - 1} onPress={() => setChunk(i => i + 1)} />
          </View>
        </View>}
        </Animated.View>
      </PinchGestureHandler>
      </View>
    </View>

    <View className="w-full self-center px-4" style={{ maxWidth: 520 }}>
      {!!error && <Text accessibilityRole="alert" numberOfLines={3} className="text-red-300 text-xs text-center py-2">{error}</Text>}
      <View className="flex-row items-center border-b border-neutral-800 py-2">
        <View className="flex-1 items-center"><IconButton icon="grid_3x3" label={grid ? 'Hide grid' : 'Show grid'} onPress={() => setGrid(v => !v)} /></View>
        <View className="flex-1 items-center border-l border-neutral-800"><Pressable accessibilityRole="button" accessibilityLabel="Change zoom" onPress={() => setZoom(v => {
            let best = 0;
            for (let i = 1; i < ZOOM_STOPS.length; i++) {
              if (Math.abs(ZOOM_STOPS[i]! - v) < Math.abs(ZOOM_STOPS[best]! - v)) best = i;
            }
            return ZOOM_STOPS[(best + 1) % ZOOM_STOPS.length] ?? 0;
          })} className="h-12 min-w-12 items-center justify-center"><Text className="text-white text-lg font-medium">{zoom === 0 ? 'WIDE' : `${Math.round(zoom * 100)}%`}</Text></Pressable></View>
        <View className="flex-1 items-center border-l border-neutral-800"><IconButton icon="tune" label="Camera settings" disabled={recording || saving} onPress={() => setSheet('settings')} /></View>
      </View>
      <View className="flex-row items-center py-5">
        <Pressable accessibilityRole="button" accessibilityLabel="Visual Suggestions" onPress={() => setSheet('suggestions')} className="flex-1 items-center py-2 active:opacity-60">
          <View className="bg-amber-400 rounded-full px-5 py-2"><Sparkles size={20} strokeWidth={1.75} color="black" /></View>
          <Text className="text-neutral-400 text-[10px] mt-2 tracking-widest">SUGGESTIONS</Text>
        </Pressable>
        <View className="flex-1 items-center">
          <Pressable accessibilityRole="button" accessibilityLabel={recording ? 'Stop recording' : 'Start recording'} disabled={!ready || saving} onPress={record}
            style={{ width: 84, height: 64, borderRadius: 40, borderWidth: 3, borderColor: 'white', padding: 5, opacity: !ready || saving ? 0.4 : 1 }}>
            <View style={{ flex: 1, borderRadius: recording ? 10 : 32, backgroundColor: recording ? '#ef4444' : 'white', margin: recording ? 7 : 0 }} />
          </Pressable>
        </View>
        <View className="flex-1 items-center">
          <IconButton icon="flip_camera_android" label="Switch front or rear camera" disabled={recording || saving} onPress={() => { setReady(false); setZoom(0); setFacing(v => v === 'back' ? 'front' : 'back'); }} />
          <Text className="text-neutral-400 text-[10px] mt-2 tracking-widest">FLIP</Text>
        </View>
      </View>
    </View>
    <Modal visible={sheet !== null} transparent animationType="slide" onRequestClose={() => setSheet(null)}>
      <View className="flex-1 justify-end bg-black/60">
        <Pressable className="flex-1" accessibilityLabel="Dismiss panel" onPress={() => setSheet(null)} />
        <SafeAreaView edges={['bottom']} className="bg-neutral-950" style={{ maxHeight: '70%' }}>
          <ScrollView contentContainerStyle={{ padding: 24 }}>
            <View className="flex-row items-center justify-between"><Text className="text-white text-lg font-semibold">{sheet === 'settings' ? 'Camera settings' : 'Visual Suggestions'}</Text><IconButton icon="close" label="Close panel" onPress={() => setSheet(null)} /></View>
            {sheet === 'settings' ? <>
              <Text className="text-neutral-300 text-sm mt-3">Maximum recording quality</Text>
              <Text className="text-neutral-500 text-xs mt-2 leading-5">Applies to the recorded file, not the live preview. Unsupported qualities fall back to the highest available.</Text>
              <View className="flex-row flex-wrap gap-2 mt-4">{(['2160p', '1080p', '720p', '480p'] as const).map(value => <Pressable key={value} onPress={() => { setVideoQuality(value); setSheet(null); }} className={`rounded-lg px-3 py-2 ${videoQuality === value ? 'bg-white' : 'bg-neutral-900'}`}><Text className={`text-xs ${videoQuality === value ? 'text-black' : 'text-white'}`}>{value}</Text></Pressable>)}</View>
            </> : <Text className="text-neutral-400 text-sm leading-6 mt-3">Visual analysis is not connected yet. Suggestions will appear here once the on-device vision engine is available.</Text>}
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
    <Modal visible={previewUri !== null} animationType="slide" onRequestClose={() => setPreviewUri(null)}>
      <SafeAreaView className="flex-1 bg-black">
        <StatusBar style="light" />
        <View className="flex-row items-center justify-between px-4 h-16">
          <Text className="text-white text-xs tracking-widest">PREVIEW · {videoQuality}</Text>
          <IconButton icon="close" label="Discard recording" onPress={() => setPreviewUri(null)} />
        </View>
        <View className="flex-1 px-4">
          {previewUri && <PreviewPlayer key={previewUri} uri={previewUri} />}
        </View>
        <View className="flex-row gap-2 px-4 py-5" style={{ maxWidth: 520, width: '100%', alignSelf: 'center' }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Retake video" onPress={() => setPreviewUri(null)} className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl py-3.5 active:opacity-70">
            <Text className="text-neutral-200 text-xs font-semibold text-center">Retake</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Continue to editor" onPress={continueToEditor} className="flex-1 bg-white rounded-xl py-3.5 active:opacity-80">
            <Text className="text-black text-xs font-bold text-center">Continue</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  </SafeAreaView>;
}

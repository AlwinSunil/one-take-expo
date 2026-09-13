import { CameraType, CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { useEvent } from 'expo';
import { uuid } from 'expo-modules-core';
import { Paths } from 'expo-file-system';
import { useKeepAwake } from 'expo-keep-awake';
import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoThumbnail } from 'expo-video';
import { Image } from 'expo-image';
import { ArrowLeft, Images, ChevronLeft, ChevronRight, Grid3X3, SlidersHorizontal, SwitchCamera, X, Sparkles } from 'lucide-react-native';
import {
  beginProjectPickup,
  cancelProjectPickup,
  checkpointProjectPickup,
  beginRecording,
  completeProjectPickup,
  getProject,
  getSetting,
  saveProject,
  saveProjectMetadata,
  saveSetting,
} from '@/lib/store';
import type { Project } from '@/lib/session';
import { recordedMediaDuration } from '@/lib/recorded-media';
import { buildCaptureStopHandoff, captureEvent, checkpointCaptureOriginal, type CaptureEvent, type CaptureScope } from '@/features/capture/stop-handoff';
import { projectCaptureDocument, requestedPickupLineIds, recordingTranscript } from '@/features/capture/project-handoff';
import { projectScriptLines } from '@/lib/project-workflow';
import { useLiveCaptions } from '@/hooks/use-live-captions';
import { LOCAL_VIDEO_BUFFER } from '@/lib/video-buffer';
import { LiveCaptions } from '@/components/captions/live-captions';
import { CoverageStrip } from '@/components/prompter/coverage-strip';
import { PrompterLines } from '@/components/prompter/prompter-lines';
import { RetakePrompt } from '@/components/prompter/retake-prompt';
import { CaptureControls } from '@/components/capture/capture-controls';
import { decideRetakePrompt } from '@/lib/retake-prompts';
import {
  captureScriptLines,
  captureTranscriptSegments,
  deriveCaptureCoverage,
  deriveProjectCaptureCoverage,
  pendingCaptureCoverage,
  type CaptureCoverageSnapshot,
} from '@/features/capture/coverage';
import {
  createCaptureCommandGate,
  type CaptureCommand,
} from '@/features/capture/capture-controls';
import { setCaptureInputActive, subscribeCaptureInput } from '@/features/capture/input';
import { loadAcceptedScriptDocument } from '@/lib/script-draft';
import { parseScript, setCueStatus, type ScriptDocument } from '@/lib/script-lines';
import { basicVisualCheck, type BasicVisualCheck } from '@/features/vision/basic-check';
import { createGazeCollector } from '@/features/vision/gaze';
import { useVision } from '@/features/vision/use-vision';
import { createSuggestionJobController } from '@/features/coach/suggestion-job';
import { CaptureSuggestions } from '@/features/coach/capture-suggestions';
import type { CoachIntent, CoachVisionEvidence } from '@/features/coach/policy';
import {
  captureFailureMessage,
  classifyCaptureFailure,
  createStopLatch,
  describeCapturePermissions,
  inspectCaptureStorage,
  type CaptureFailureKind,
  type CaptureStorageCheck,
  type CaptureStopReason,
} from '@/features/capture/reliability';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const player = useVideoPlayer(uri, p => { p.bufferOptions = LOCAL_VIDEO_BUFFER; p.loop = true; p.play(); });
  return <VideoView style={{ flex: 1 }} player={player} nativeControls contentFit="contain" />;
}

function LatestThumb({ uri, onPress }: { uri: string; onPress: () => void }) {
  const player = useVideoPlayer(uri, p => { p.bufferOptions = LOCAL_VIDEO_BUFFER; });
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

type CapturePhase = 'idle' | 'preparing' | 'recording' | 'saving';

function readCaptureStorage(): CaptureStorageCheck {
  try {
    return inspectCaptureStorage(Paths.availableDiskSpace);
  } catch {
    return inspectCaptureStorage(undefined);
  }
}


export default function CameraScreen() {
  useKeepAwake();
  const { mode, script, coachingDevelopment, pickupProjectId: requestedPickupProjectId } = useLocalSearchParams<{
    mode?: string;
    script?: string;
    pickupProjectId?: string;
    coachingDevelopment?: string;
  }>();
  // Explicit development preview only; Session 3 owns the common release gate.
  const showDevelopmentCoaching = __DEV__ && coachingDevelopment === '1';
  const isScript = mode === 'script' || !!requestedPickupProjectId;
  const routeScript = typeof script === 'string' ? script : '';
  const isFocused = useIsFocused();
  const [cameraPermission, requestCamera, getCameraPermission] = useCameraPermissions();
  const [micPermission, requestMic, getMicPermission] = useMicrophonePermissions();
  const camera = useRef<CameraView>(null);
  const captions = useLiveCaptions();
  const activeScreen = useRef(AppState.currentState === 'active' && isFocused);
  const recordingGeneration = useRef(0);
  const busy = useRef(false);
  const capturePhase = useRef<CapturePhase>('idle');
  const stopLatch = useRef(createStopLatch());
  const startedAt = useRef(0);
  const sourceZeroMonotonicMs = useRef(0);
  const captureScope = useRef<CaptureScope | null>(null);
  const captureEvents = useRef<CaptureEvent[]>([]);
  const gazeCollector = useRef<ReturnType<typeof createGazeCollector> | null>(null);
  const gazeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const captureHandoff = useRef<ReturnType<typeof buildCaptureStopHandoff> | null>(null);
  const [recording, setRecording] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [seconds, setSeconds] = useState(0);
  const [grid, setGrid] = useState(true);
  const [zoom, setZoom] = useState(0);
  const [sheet, setSheet] = useState<'settings' | null>(null);
  const [videoQuality, setVideoQuality] = useState<'2160p' | '1080p' | '720p' | '480p'>('2160p');
  const [error, setError] = useState('');
  const [chunk, setChunk] = useState(0);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [previewDuration, setPreviewDuration] = useState(0);
  const [lastUri, setLastUri] = useState<string | null>(null);
  const pendingSave = useRef<(() => Promise<Project>) | null>(null);
  const [recordedProject, setRecordedProject] = useState<Project | null>(null);
  const [scriptDocument, setScriptDocument] = useState<ScriptDocument>(() => parseScript(routeScript));
  const scriptDocumentRef = useRef(scriptDocument);
  scriptDocumentRef.current = scriptDocument;
  const [scriptDocumentLoaded, setScriptDocumentLoaded] = useState(!isScript);
  const [captureCoverage, setCaptureCoverage] = useState<CaptureCoverageSnapshot>(() => pendingCaptureCoverage(parseScript(routeScript)));
  const [requestedLines, setRequestedLines] = useState<string[] | null>(null);
  const [pickupProject, setPickupProject] = useState<Project | null>(null);
  const [pickupTargetId, setPickupTargetId] = useState<string | null>(null);
  const [captureFeedback, setCaptureFeedback] = useState('');
  const [promptNow, setPromptNow] = useState(Date.now());
  const [captureMode, setCaptureMode] = useState<'pending' | 'live' | 'record-only'>('pending');
  const [storageCheck, setStorageCheck] = useState<CaptureStorageCheck>(() => readCaptureStorage());
  const [cameraMountFailure, setCameraMountFailure] = useState<CaptureFailureKind | null>(null);
  const [cameraRetry, setCameraRetry] = useState(0);
  const [requestingPermission, setRequestingPermission] = useState(false);
  const [appInForeground, setAppInForeground] = useState(AppState.currentState === 'active');
  const [suggestionsVisible, setSuggestionsVisible] = useState(false);
  const [basicCheck, setBasicCheck] = useState<BasicVisualCheck | null>(null);
  const [suggestionJobs] = useState(createSuggestionJobController);
  const [suggestionSnapshot, setSuggestionSnapshot] = useState(suggestionJobs.getSnapshot);
  const [cameraSessionId] = useState(() => `camera:${uuid.v4()}`);
  const [shotIntent, setShotIntent] = useState<CoachIntent>('talking-head');
  const vision = useVision({
    enabled: isFocused && appInForeground && previewUri === null
      && !!cameraPermission?.granted && !!micPermission?.granted,
    ready,
    lensFacing: facing,
    recording: preparing || recording || saving,
  });
  const latestVisionEvidence = useRef(vision.evidence);
  latestVisionEvidence.current = vision.evidence;
  // Face presence alone cannot certify lighting, background, or visible crop.
  const coachEvidence: CoachVisionEvidence = vision.evidence.status === 'pending'
    ? { status: 'pending', reason: 'model-loading' }
    : vision.evidence.status === 'ready'
      ? { status: 'ready', frameCapturedAtMs: vision.evidence.frameCapturedAtMs, observations: {} }
      : { status: 'unavailable', reason: 'unknown' };
  const suggestionIdentity = useMemo(() => ({
    sessionId: captureScope.current?.captureSessionId ?? cameraSessionId,
    lensGeneration: `${vision.evidence.sessionId ?? 'unavailable'}:${facing}:${cameraRetry}:${zoom}`,
    intent: shotIntent,
  }), [cameraSessionId, recording, preparing, facing, cameraRetry, zoom, shotIntent, vision.evidence.sessionId]);
  useEffect(() => suggestionJobs.subscribe(setSuggestionSnapshot), [suggestionJobs]);
  useEffect(() => { suggestionJobs.bind(suggestionIdentity); setBasicCheck(null); }, [suggestionIdentity, suggestionJobs]);
  useEffect(() => {
    if (!isFocused || !appInForeground || !ready || previewUri) {
      suggestionJobs.cancel(!appInForeground ? 'background' : 'navigation');
      setSuggestionsVisible(false);
    }
    return () => { suggestionJobs.cancel('route-exit'); };
  }, [isFocused, appInForeground, ready, previewUri, suggestionJobs]);
  const dismissSuggestions = useCallback(() => {
    setBasicCheck(null);
    suggestionJobs.cancel('dismissed');
    setSuggestionsVisible(false);
  }, [suggestionJobs]);
  function requestSuggestions() {
    setSuggestionsVisible(true);
    if (!showDevelopmentCoaching) {
      if (__DEV__) setBasicCheck(basicVisualCheck(latestVisionEvidence.current, performance.now()));
      return;
    }
    suggestionJobs.bind(suggestionIdentity);
    suggestionJobs.start({ ...suggestionIdentity, requestedAtMs: performance.now(), evidence: coachEvidence });
  }
  const permissionRequesting = useRef(false);
  const commandGate = useRef(createCaptureCommandGate());
  const scratchRequested = useRef(false);
  const activeCaptureTakeId = useRef<string | null>(null);
  const lastTranscript = useRef<ReturnType<typeof captureTranscriptSegments>>([]);
  const lastCoverageTakeId = useRef('');
  const lastCoverageUri = useRef<string | null>(null);
  const captionStatus = useRef(captions.status);
  const captionMessage = useRef(captions.message);
  captionStatus.current = captions.status;
  captionMessage.current = captions.message;
  const interrupted = useRef(false);
  const promptLines = requestedLines ? captureCoverage.lines.filter(line => requestedLines.includes(line.id)) : captureCoverage.lines;
  const chunks = promptLines.map(line => line.spokenText);

  const refreshDeviceState = useCallback(() => {
    setStorageCheck(readCaptureStorage());
    void Promise.all([getCameraPermission(), getMicPermission()]).catch(() => {});
  }, [getCameraPermission, getMicPermission]);

  const endCaptureSignals = useCallback((kind: 'stop-requested' | 'recording-ended' = 'recording-ended') => {
    if (gazeTimer.current !== null) clearInterval(gazeTimer.current);
    gazeTimer.current = null;
    const nowMs = performance.now();
    gazeCollector.current?.stop(nowMs);
    if (captureScope.current && !captureEvents.current.some(event => event.kind === 'stop-requested' || event.kind === 'recording-ended')) {
      captureEvents.current.push(captureEvent(captureScope.current, kind, sourceZeroMonotonicMs.current, nowMs));
    }
  }, []);

  const stopActiveCapture = useCallback((reason: CaptureStopReason) => {
    endCaptureSignals('stop-requested');
    suggestionJobs.cancel('stop');
    setSuggestionsVisible(false);
    const phase = capturePhase.current;
    if (phase !== 'preparing' && phase !== 'recording') return;
    if (reason !== 'user') interrupted.current = true;
    if (!stopLatch.current.request(reason)) return;
    if (phase === 'preparing') recordingGeneration.current++;
    if (reason === 'storage') setError(captureFailureMessage('storage'));
    if (reason !== 'user' && reason !== 'storage') setError(captureFailureMessage('interrupted'));
    commandGate.current.end();
    activeCaptureTakeId.current = null;
    setCaptureInputActive(false);
    setSaving(true);
    camera.current?.stopRecording();
    void captions.stop().catch(() => {});
  }, [captions.stop, endCaptureSignals, suggestionJobs]);

  useFocusEffect(useCallback(() => {
    activeScreen.current = AppState.currentState === 'active';
    refreshDeviceState();
    return () => {
      activeScreen.current = false;
      setReady(false);
      stopActiveCapture('screen-blur');
    };
  }, [refreshDeviceState, stopActiveCapture]));

  useEffect(() => {
    activeScreen.current = AppState.currentState === 'active' && isFocused;
    const subscription = AppState.addEventListener('change', state => {
      setAppInForeground(state === 'active');
      activeScreen.current = state === 'active' && isFocused;
      if (state !== 'active') {
        stopActiveCapture('interruption');
      } else {
        refreshDeviceState();
      }
    });
    return () => {
      activeScreen.current = false;
      recordingGeneration.current++;
      subscription.remove();
    };
  }, [isFocused, refreshDeviceState, stopActiveCapture]);

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

  useEffect(() => {
    if (captions.status === 'unavailable' || captions.status === 'interrupted') setCaptureMode('record-only');
  }, [captions.status]);

  useEffect(() => {
    if (!recording) return;
    const checkStorage = () => {
      const next = readCaptureStorage();
      setStorageCheck(next);
      if (next.state === 'blocked' && !stopLatch.current.requested) {
        stopActiveCapture('storage');
        setError(next.message);
      }
    };
    checkStorage();
    const id = setInterval(checkStorage, 1000);
    return () => clearInterval(id);
  }, [recording, stopActiveCapture]);

  const applyCaptureCommand = useCallback((command: CaptureCommand) => {
    if (command === 'scratch') {
      scratchRequested.current = true;
      setCaptureFeedback('Current take marked for scratch. It will not count toward coverage.');
      return;
    }
    if (!isScript || chunks.length === 0) {
      setCaptureFeedback('There are no script lines to advance.');
      return;
    }
    const next = Math.min(chunks.length - 1, chunk + 1);
    setChunk(next);
    setCaptureFeedback(next === chunk ? 'Already at the last script line.' : 'Advanced to the next script line.');
  }, [chunk, chunks.length, isScript]);

  const receiveCaptureCommand = useCallback((command: CaptureCommand) => {
    const result = commandGate.current.receive({ command, source: 'tap' });
    if (result.accepted) applyCaptureCommand(result.command);
  }, [applyCaptureCommand]);

  useEffect(() => {
    const unsubscribe = subscribeCaptureInput(event => {
      const result = commandGate.current.receive(event);
      if (result.accepted) applyCaptureCommand(result.command);
    });
    return unsubscribe;
  }, [applyCaptureCommand]);

  useEffect(() => {
    if (requestedPickupProjectId) return;
    if (!isScript) {
      setScriptDocumentLoaded(true);
      return;
    }
    let cancelled = false;
    setScriptDocumentLoaded(false);
    loadAcceptedScriptDocument(routeScript || undefined)
      .then(document => {
        if (cancelled) return;
        setScriptDocument(document);
        setCaptureCoverage(pendingCaptureCoverage(document));
        setScriptDocumentLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        const document = parseScript(routeScript);
        setScriptDocument(document);
        setCaptureCoverage(pendingCaptureCoverage(document));
        setScriptDocumentLoaded(true);
      });
    return () => { cancelled = true; };
  }, [isScript, routeScript, requestedPickupProjectId]);

  useEffect(() => {
    if (!requestedPickupProjectId) return;
    let cancelled = false;
    getProject(requestedPickupProjectId)
      .then(async project => {
        if (cancelled) return;
        if (!project) {
          setError('That project is no longer available for another take.');
          return;
        }
        const document = projectCaptureDocument(project);
        if (cancelled) return;
        setPickupTargetId(project.id);
        setPickupProject(project);
        setRequestedLines(requestedPickupLineIds(project));
        setScriptDocument(document);
        setScriptDocumentLoaded(true);
        setCaptureCoverage(deriveProjectCaptureCoverage(document, project));
      })
      .catch(() => {
        if (!cancelled) setError('Could not open the project for another take.');
      });
    return () => { cancelled = true; };
  }, [requestedPickupProjectId, routeScript]);

  useEffect(() => {
    if (!scriptDocumentLoaded || !isScript) return;
    if (recordedProject) {
      setCaptureCoverage(deriveProjectCaptureCoverage(scriptDocument, recordedProject));
    } else if (pickupProject) {
      setCaptureCoverage(deriveProjectCaptureCoverage(scriptDocument, pickupProject));
    } else if (!previewUri) {
      setCaptureCoverage(pendingCaptureCoverage(scriptDocument));
    }
  }, [isScript, previewUri, recordedProject, scriptDocument, scriptDocumentLoaded, pickupProject]);

  useEffect(() => {
    setChunk(current => Math.min(Math.max(current, 0), Math.max(0, chunks.length - 1)));
  }, [chunks.length]);

  useEffect(() => {
    if (!recording && !previewUri) return;
    const id = setInterval(() => setPromptNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [previewUri, recording]);

  const markCueDone = useCallback((cueId: string) => {
    setScriptDocument(document => setCueStatus(document, cueId, 'done'));
  }, []);

  const promptDecision = useMemo(() => {
    if (!isScript) return null;
    const engineState = captions.status === 'delayed'
      ? 'delayed' as const
      : captions.status === 'unavailable' || captions.status === 'interrupted'
        ? 'unavailable' as const
        : 'ready' as const;
    return decideRetakePrompt({
      lines: captureCoverage.spokenLines,
      lineEnds: captureCoverage.lineEnds,
      verdicts: captureCoverage.verdicts,
      now: promptNow,
      midLine: recording && !captions.isFinal,
      takeEnded: !!previewUri,
      engineState,
    });
  }, [captions.isFinal, captions.status, captureCoverage, isScript, previewUri, promptNow, recording]);

  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);  const pinchBase = useRef(0);
  function onPinchState(e: PinchGestureHandlerStateChangeEvent) {
    if (e.nativeEvent.state === State.BEGAN) pinchBase.current = zoomRef.current;
  }
  function onPinch(e: PinchGestureHandlerGestureEvent) {
    setZoom(clamp01(pinchBase.current + (e.nativeEvent.scale - 1) * 0.5));
  }

  async function record() {
    if (capturePhase.current === 'preparing' || capturePhase.current === 'recording') {
      stopActiveCapture('user');
      return;
    }
    if (pendingSave.current) { setError('This recording still needs saving. Retry Save before recording another take.'); return; }
    if (busy.current || !ready || !camera.current || !activeScreen.current) return;
    dismissSuggestions();
    busy.current = true;
    interrupted.current = false;
    capturePhase.current = 'preparing';
    captureScope.current = null;
    captureEvents.current = [];
    gazeCollector.current = null;
    captureHandoff.current = null;
    stopLatch.current.reset();
    const generation = ++recordingGeneration.current;
    let captureDocument = scriptDocumentLoaded ? scriptDocument : parseScript(routeScript);
    let project: Project | null = null;
    let targetProject: Project | null = null;
    let pickupRecordingId = '';
    let pickupStarted = false;
    let pickupReturned = false;
    let returnedUri: string | null = null;
    let pickupLineIds: string[] = [];
    let captionFailure: string | undefined;
    setSeconds(0); setError(''); setPreparing(true);
    setCaptureFeedback('');
    setCaptureMode('pending');
    scratchRequested.current = false;
    try {
      const [latestCamera, latestMic] = await Promise.all([getCameraPermission(), getMicPermission()]);
      const permissions = describeCapturePermissions(latestCamera, latestMic);
      if (stopLatch.current.requested || !activeScreen.current || generation !== recordingGeneration.current) return;
      if (permissions.state !== 'ready') {
        setError(permissions.message);
        return;
      }

      const storage = readCaptureStorage();
      setStorageCheck(storage);
      if (!storage.canRecord) {
        setError(storage.message);
        return;
      }

      if (pickupTargetId) {
        targetProject = await getProject(pickupTargetId);
        if (!targetProject) throw new Error('That project is no longer available for another take.');
        captureDocument = projectCaptureDocument(targetProject);
        pickupLineIds = requestedPickupLineIds(targetProject);
        setScriptDocument(captureDocument); setRequestedLines(pickupLineIds);
        if (pickupLineIds.length === 0) throw new Error('Every spoken line is already covered. You can wrap this project.');
        pickupRecordingId = `${targetProject.id}:pickup:${uuid.v4()}`;
      } else {
        project = {
          id: `recording-${uuid.v4()}`,
          mode: isScript ? 'script' : 'assisted',
          script: isScript ? captureDocument.text : undefined,
          videoUri: null,
          transcript: [],
          clips: [],
          createdAt: Date.now(),
          schemaVersion: 2,
          scriptLines: isScript ? captureScriptLines(captureDocument) : undefined,
        };
        await beginRecording(project);
      }
      if (stopLatch.current.requested || !activeScreen.current || generation !== recordingGeneration.current) return;

      const startResult = await captions.start();
      if (!startResult.ok) {
        captionFailure = startResult.message;
        setCaptureMode('record-only');
      } else {
        setCaptureMode('live');
      }
      if (stopLatch.current.requested || !activeScreen.current || generation !== recordingGeneration.current || !camera.current) return;

      if (targetProject) {
        await beginProjectPickup(targetProject.id, pickupRecordingId, pickupLineIds);
        pickupStarted = true;
        if (stopLatch.current.requested || !activeScreen.current || generation !== recordingGeneration.current) return;
      }
      const captureTakeId = pickupRecordingId || project?.id || `recording-${uuid.v4()}`;
      activeCaptureTakeId.current = captureTakeId;
      commandGate.current.begin(captureTakeId);
      setCaptureInputActive(true);
      capturePhase.current = 'recording';
      setPreparing(false);
      startedAt.current = Date.now();
      sourceZeroMonotonicMs.current = performance.now();
      const recordingPromise = camera.current.recordAsync();
      captureScope.current = { projectId: targetProject?.id ?? project!.id, sourceId: captureTakeId,
        takeId: captureTakeId, captureSessionId: `${captureTakeId}:capture:${generation}`,
        generation: latestVisionEvidence.current.sessionId ?? `unavailable:${generation}` };
      captureEvents.current = [captureEvent(captureScope.current, 'record-requested', sourceZeroMonotonicMs.current, sourceZeroMonotonicMs.current)];
      if (showDevelopmentCoaching) {
        gazeCollector.current = createGazeCollector({ ...captureScope.current,
          visionSessionId: latestVisionEvidence.current.sessionId ?? `unavailable:${generation}`,
          lensFacing: facing, previewMirrored: facing === 'front',
        }, sourceZeroMonotonicMs.current);
        gazeCollector.current.sample(performance.now(), latestVisionEvidence.current);
        gazeTimer.current = setInterval(() => {
          gazeCollector.current?.sample(performance.now(), latestVisionEvidence.current);
        }, 1000);
      }
      setRecording(true);
      const result = await recordingPromise;
      endCaptureSignals();
      suggestionJobs.cancel('stop');
      setSuggestionsVisible(false);
      if (!result) throw new Error('No video was returned. Please try again.');
      pickupReturned = true;
      returnedUri = result.uri;
      commandGate.current.end();
      activeCaptureTakeId.current = null;
      setCaptureInputActive(false);
      capturePhase.current = 'saving';
      setSaving(true);
      // A returned file must remain retryable even when metadata loading fails.
      pendingSave.current = async () => {
        const duration = await recordedMediaDuration(result.uri);
        return targetProject
          ? checkpointProjectPickup(targetProject.id, pickupRecordingId, { videoUri: result.uri, duration })
          : saveProject({ ...project!, videoUri: result.uri, duration, transcript: [],
            recordingStatus: 'interrupted', recoveryMessage: 'The original was saved after metadata recovery. Recheck its saved audio before reviewing coverage.' });
      };
      const duration = await recordedMediaDuration(result.uri);
      if (targetProject) {
        const targetId = targetProject.id;
        pendingSave.current = () => checkpointProjectPickup(targetId, pickupRecordingId, { videoUri: result.uri, duration });
        setRecordedProject(await checkpointCaptureOriginal(pendingSave.current, () => {
          if (captureScope.current) {
            captureEvents.current.push(captureEvent(captureScope.current, 'original-saved', sourceZeroMonotonicMs.current, performance.now()));
            captureHandoff.current = buildCaptureStopHandoff(captureScope.current, duration, captureEvents.current, gazeCollector.current?.snapshot() ?? null);
          }
        }));
      }
      // Make the returned original discoverable before waiting for analysis.
      // If the process stops during caption cleanup, Projects can recover it.
      if (project) {
        const recoverable: Project = { ...project, videoUri: result.uri, duration,
          recordingStatus: 'interrupted',
          recoveryMessage: 'The original is available. Saving or analysis did not finish; review this take in Projects.',
          transcript: recordingTranscript(captions.transcript.current, captions.sourceStartedAt.current, startedAt.current, duration),
        };
        setRecordedProject(recoverable);
        pendingSave.current = () => saveProject(recoverable);
        // Retain the cache URI for reopen/retry if low space prevents the copy.
        await saveProjectMetadata(recoverable);
        setRecordedProject(await checkpointCaptureOriginal(pendingSave.current, () => {
          if (captureScope.current) {
            captureEvents.current.push(captureEvent(captureScope.current, 'original-saved', sourceZeroMonotonicMs.current, performance.now()));
            captureHandoff.current = buildCaptureStopHandoff(captureScope.current, duration, captureEvents.current, gazeCollector.current?.snapshot() ?? null);
          }
        }));
       }
      let transcript = captions.transcript.current;
      try {
        transcript = await captions.stop();
      } catch (e) {
        // Keep the video and any segments already observed, but mark the
        // project for saved-audio caption recovery instead of claiming a
        // complete transcript.
        captionFailure = e instanceof Error && e.message ? e.message : 'Could not finish captions.';
        transcript = captions.transcript.current;
      }
      if (captionStatus.current === 'unavailable' || captionStatus.current === 'interrupted') {
        captionFailure ??= captionMessage.current || 'Live captions became unavailable.';
        setCaptureMode('record-only');
      }
      const alignedTranscript = recordingTranscript(transcript, captions.sourceStartedAt.current, startedAt.current, duration);
      const transcriptSegments = captureTranscriptSegments(alignedTranscript.map((segment, index) => ({ ...segment, id: segment.id ?? `${captureTakeId}:${index}`, isFinal: segment.isFinal ?? true })));
      lastTranscript.current = transcriptSegments;
      const coverage = deriveCaptureCoverage({
        document: captureDocument,
        takeId: captureTakeId,
        videoUri: result.uri,
        transcript: transcriptSegments,
        scratched: scratchRequested.current,
      });
      const stopReason = stopLatch.current.reason;
      const wasInterrupted = interrupted.current || stopReason === 'interruption' || stopReason === 'storage'
        || stopReason === 'screen-blur' || stopReason === 'cleanup';
      const recoveryMessages = [
        wasInterrupted
          ? stopReason === 'storage'
            ? captureFailureMessage('storage')
            : captureFailureMessage('interrupted')
          : undefined,
        captionFailure ? `Live captions need recovery: ${captionFailure} ${targetProject ? 'Review the saved pickup original and record those lines again if needed.' : 'Recheck the saved audio in the editor.'}` : undefined,
      ].filter((value): value is string => !!value);

      let saved: Project;
      if (project) {
        const captured: Project = { ...project, videoUri: result.uri, duration,
          recordingStatus: wasInterrupted ? 'interrupted' : 'complete',
          recoveryMessage: recoveryMessages.length ? recoveryMessages.join(' ') : undefined,
          scriptLines: isScript ? captureScriptLines(scriptDocumentRef.current) : undefined,
          takes: coverage.review.takes,
          transcript: alignedTranscript.map(segment => ({ ...segment, rawText: segment.text, timingSource: 'live-estimate' as const })),
        };
        await saveProjectMetadata({ ...captured, recoveryMessage: [
          'Recording is available in temporary storage. Open and save it to preserve it.',
          ...recoveryMessages,
        ].join(' ') });
        pendingSave.current = () => saveProject(captured);
        saved = await pendingSave.current();
        setCaptureCoverage(deriveCaptureCoverage({
          document: captureDocument,
          takeId: captureTakeId,
          videoUri: saved.videoUri,
          transcript: transcriptSegments,
          scratched: scratchRequested.current,
        }));
      } else {
        const targetId = targetProject!.id;
        const latestTarget = await getProject(targetId);
        if (!latestTarget) throw new Error('The pickup project was deleted.');
        await saveProjectMetadata({ ...latestTarget, scriptLines: captureScriptLines(scriptDocumentRef.current) });
        const input = { videoUri: result.uri, duration,
          transcript: alignedTranscript.map(segment => ({ ...segment, rawText: segment.text, timingSource: 'live-estimate' as const })), takes: coverage.review.takes };
        pendingSave.current = () => completeProjectPickup(targetId, pickupRecordingId, input);
        saved = await pendingSave.current();
        setCaptureCoverage(deriveProjectCaptureCoverage(captureDocument, saved));
      }
      pendingSave.current = null;
      lastCoverageTakeId.current = captureTakeId;
      lastCoverageUri.current = result.uri;
      setRecordedProject(saved);
      setPreviewDuration(Math.floor(duration));
      setPreviewUri(project ? saved.videoUri : result.uri);
      setLastUri(saved.videoUri);
      if (saved.videoUri) saveSetting('last_video_uri', saved.videoUri).catch(() => {});
      if (activeScreen.current) { setPreviewUri(null); router.replace({ pathname: '/editor', params: { projectId: saved.id } }); }
    } catch (e) {
      if (returnedUri) setPreviewUri(returnedUri);
      const classified = classifyCaptureFailure(e);
      const kind: CaptureFailureKind = classified === 'storage'
        ? 'storage'
        : interrupted.current || stopLatch.current.reason === 'interruption' || stopLatch.current.reason === 'screen-blur'
          ? 'interrupted'
          : classified;
      if (kind === 'camera-busy') setCameraMountFailure(kind);
      setError(returnedUri && e instanceof Error ? e.message : captureFailureMessage(kind));
    } finally {
      endCaptureSignals();
      suggestionJobs.cancel('stop');
      setSuggestionsVisible(false);
      if (pickupStarted && !pickupReturned && targetProject) await cancelProjectPickup(targetProject.id, pickupRecordingId).catch(error => setError(String(error)));
      commandGate.current.end();
      activeCaptureTakeId.current = null;
      setCaptureInputActive(false);
      setSaving(true);
      await captions.stop().catch(() => {});
      capturePhase.current = 'idle';
      stopLatch.current.reset();
      busy.current = false; setRecording(false); setSaving(false); setPreparing(false);
    }
  }

  function retake() {
    if (saving) return;
    if (pendingSave.current) { setError('Save this returned recording before starting a retake.'); return; }
    setPreviewUri(null);
    setRecordedProject(null);
    setPickupTargetId(requestedPickupProjectId ?? pickupTargetId);
    setCaptureCoverage(pendingCaptureCoverage(scriptDocument));
    setCaptureFeedback('');
  }

  function continueRecording() {
    if (saving || !recordedProject || !isScript || captureCoverage.safeToWrap) return;
    setPickupTargetId(recordedProject.id);
    setPreviewUri(null);
    setCaptureFeedback('Record the lines still needed.');
  }

  async function continueToEditor() {
    if (!previewUri || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    const uri = previewUri;
    const duration = previewDuration;
    try {
      const project = pendingSave.current ? await pendingSave.current() : recordedProject ?? await saveProject({
        id: uri.split('/').pop() ?? `${Date.now()}`,
        mode: isScript ? 'script' : 'assisted',
        script: isScript && typeof script === 'string' ? script : undefined,
        videoUri: uri,
        clips: [],
        transcript: captions.transcript.current,
        createdAt: Date.now(),
      });
    pendingSave.current = null;
    setLastUri(project.videoUri);
    saveSetting('last_video_uri', project.videoUri!).catch(() => {});
    setPreviewUri(null);
    router.replace({ pathname: '/editor', params: {
      projectId: project.id,
      mode: isScript ? 'script' : 'assisted', videoUri: project.videoUri!,
      duration: String(duration),
      quality: videoQuality,
    } });
    } catch (e) {
      setError(`Could not save project: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  const permissionDescription = describeCapturePermissions(cameraPermission, micPermission);
  const currentPrompterLine = promptLines[chunk] ?? null;
  const nextPrompterLine = promptLines[chunk + 1] ?? null;

  async function requestAccess() {
    if (permissionRequesting.current || permissionDescription.state !== 'requestable') return;
    permissionRequesting.current = true;
    setRequestingPermission(true);
    setError('');
    try {
      await requestCamera();
      await requestMic();
      await Promise.all([getCameraPermission(), getMicPermission()]);
    } catch {
      setError('Could not update camera permissions. Open Settings and try again.');
    } finally {
      permissionRequesting.current = false;
      setRequestingPermission(false);
    }
  }

  if (permissionDescription.state !== 'ready') return (
    <SafeAreaView className="flex-1 bg-black items-center justify-center px-6">
      <StatusBar style="light" />
      <Text className="text-white text-base text-center">{permissionDescription.title}</Text>
      <Text className="text-neutral-400 text-sm text-center mt-2 leading-6">
        {permissionDescription.message}
      </Text>
      {permissionDescription.action === 'settings' ? (
        <Pressable className="bg-white rounded-full px-6 py-4 mt-5" onPress={() => Linking.openSettings()}>
          <Text className="text-black font-semibold">Open Settings</Text>
        </Pressable>
      ) : permissionDescription.action === 'request' ? (
        <Pressable disabled={requestingPermission} className="bg-white rounded-full px-6 py-4 mt-5" onPress={requestAccess}>
          <Text className="text-black font-semibold">{requestingPermission ? 'Checking access…' : 'Allow access'}</Text>
        </Pressable>
      ) : null}
      {!!error && <Text accessibilityRole="alert" className="text-red-300 text-xs text-center mt-4">{error}</Text>}
      {permissionDescription.state === 'loading' && <Text className="text-neutral-500 text-xs text-center mt-4">Please wait a moment.</Text>}
      <Pressable onPress={() => router.push('/projects')} className="p-4"><Text className="text-neutral-400">View projects</Text></Pressable>
      <Pressable onPress={() => router.back()} className="p-4"><Text className="text-neutral-400">Back</Text></Pressable>
    </SafeAreaView>
  );

  const storageBlocked = storageCheck.state === 'blocked';

  return <SafeAreaView className="flex-1 bg-black">
    <StatusBar style="light" />
    <View className="flex-1 overflow-hidden bg-neutral-950">
        {isFocused ? <CameraView key={cameraRetry} ref={camera} style={StyleSheet.absoluteFill} facing={facing} mode="video"
          videoQuality={videoQuality} zoom={zoom}
          onCameraReady={() => { setReady(true); if (cameraMountFailure) { setCameraMountFailure(null); setError(''); } }}
          onMountError={event => {
            const kind = classifyCaptureFailure(event.message);
            setReady(false);
            setCameraMountFailure(kind);
            setError(captureFailureMessage(kind));
          }} /> : <View style={StyleSheet.absoluteFill} />}
    <View className="flex-row items-center justify-between px-4 h-16 bg-black/40">
      <IconButton icon="arrow_back" label="Back" disabled={preparing || recording || saving} onPress={() => router.back()} />
      <Text className="text-white text-xs tracking-widest">{isScript ? 'SCRIPT' : 'ASSISTED'}</Text>
      {lastUri && !preparing && !recording && !saving
        ? <LatestThumb uri={lastUri} onPress={() => router.push('/projects')} />
        : <IconButton icon="photo_library" label="Projects" disabled={preparing || recording || saving} onPress={() => router.push('/projects')} />}
    </View>

    <View className="flex-1">
      <PinchGestureHandler onGestureEvent={onPinch} onHandlerStateChange={onPinchState}>
        <Animated.View style={{ flex: 1 }}>
        {grid && <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {[1, 2].map(n => <View key={`v${n}`} style={{ position: 'absolute', left: `${n * 100 / 3}%`, top: 0, bottom: 0, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: '#ffffff55' }} />)}
          {[1, 2].map(n => <View key={`h${n}`} style={{ position: 'absolute', top: `${n * 100 / 3}%`, left: 0, right: 0, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#ffffff55' }} />)}
        </View>}
        <View className="self-center mt-4 bg-white rounded px-3 py-1.5">
          <Text className="text-black text-xs font-bold">{preparing ? 'PREPARING CAPTIONS' : recording ? `${captureMode === 'record-only' ? 'RECORD-ONLY · ' : ''}${saving ? 'SAVING' : 'REC'}  ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : `VIDEO · UP TO ${videoQuality}`}</Text>
        </View>
        {(preparing || recording) && <LiveCaptions text={captions.text} isFinal={captions.isFinal} status={captions.status} />}
        {(preparing || recording) && captureMode === 'record-only' && <Text accessibilityRole="alert" className="self-center mt-2 rounded bg-amber-950/90 px-3 py-1.5 text-center text-amber-200 text-xs">RECORD-ONLY · Live analysis unavailable. Video and camera audio will still be saved.</Text>}
        <View pointerEvents="none" className="absolute bottom-3 self-center mx-3 rounded-lg bg-black/70 px-3 py-2">
          <Text className="text-neutral-200 text-xs text-center">
            {vision.status === 'ready' && vision.faceStable
              ? vision.facePresence === 'present' ? 'Face detected' : 'No face detected'
              : vision.status === 'pending' ? 'Checking framing' : 'Framing unavailable'}
            {vision.device?.batteryPercent != null ? ` · Battery ${vision.device.batteryPercent}%` : ''}
            {vision.device && vision.device.thermalStatus !== 'none' && vision.device.thermalStatus !== 'unknown'
              ? ` · Phone ${['light', 'moderate'].includes(vision.device.thermalStatus) ? 'warm' : 'hot'}` : ''}
          </Text>
        </View>
        {isScript && scriptDocumentLoaded && <View className="absolute top-3 left-3 right-3 gap-2">
          <CoverageStrip
            lines={captureCoverage.spokenLines}
            currentLineId={currentPrompterLine?.id}
            nextLineId={nextPrompterLine?.id}
          />
          <PrompterLines
            current={currentPrompterLine}
            next={nextPrompterLine}
            onCueDone={markCueDone}
          />
          {recording && <RetakePrompt decision={promptDecision} />}
          {!!captureFeedback && <Text accessibilityRole="alert" className="rounded-lg bg-black/80 px-3 py-2 text-center text-neutral-200 text-xs">{captureFeedback}</Text>}
          <View className="flex-row justify-between items-center rounded-xl bg-black/70 px-2">
            <IconButton icon="chevron_left" label="Previous script section" disabled={chunk === 0 || recording === false && preparing} onPress={() => setChunk(i => Math.max(0, i - 1))} />
            <Text className="text-neutral-400 text-xs">{chunks.length ? chunk + 1 : 0}/{chunks.length}</Text>
            <IconButton icon="chevron_right" label="Next script section" disabled={chunk >= chunks.length - 1 || recording === false && preparing} onPress={() => setChunk(i => Math.min(chunks.length - 1, i + 1))} />
          </View>
        </View>}
        </Animated.View>
      </PinchGestureHandler>
      </View>
    </View>

    {suggestionsVisible && <View className="bg-neutral-950 border-t border-neutral-800 px-4" style={{ maxHeight: 190 }}>
      <ScrollView contentContainerStyle={{ paddingVertical: 12 }}>
        {showDevelopmentCoaching ? <CaptureSuggestions snapshot={suggestionSnapshot}
          onRetry={requestSuggestions} onDismiss={dismissSuggestions}
          intent={shotIntent} onIntentChange={setShotIntent}
          diagnostics={__DEV__ ? suggestionJobs.getDiagnostics() : undefined} /> : <View>
          {__DEV__ ? <View>
            <Text accessibilityRole="header" className="text-white text-sm font-semibold">Basic face check · Preview</Text>
            <Text accessibilityLiveRegion="polite" className="text-neutral-200 text-sm mt-2">{basicCheck?.message ?? 'The camera changed. Tap Check again for a fresh result.'}</Text>
            <Text className="text-neutral-400 text-xs mt-2">Snapshot from your last tap. Face detection only; lighting, background and eye contact are not assessed.</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Check face framing again" onPress={requestSuggestions} className="min-h-12 justify-center"><Text className="text-amber-200">Check again</Text></Pressable>
          </View> : <Text className="text-neutral-300 text-sm">Visual analysis is not enabled in this build.</Text>}
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss Visual Suggestions" onPress={dismissSuggestions} className="min-h-12 justify-center"><Text className="text-white">Dismiss</Text></Pressable>
        </View>}
        {__DEV__ && <Text selectable className="text-neutral-500 text-xs mt-3">
          {`Debug · Engine ${vision.diagnostics?.engine ?? 'unknown'} · Processor ${vision.diagnostics?.processor ?? 'unknown'}\nGaze samples ${gazeCollector.current?.snapshot().acceptedSampleCount ?? 0} · Gaps ${gazeCollector.current?.snapshot().samplingGapCount ?? 0} · Metadata persistence pending`}
        </Text>}
      </ScrollView>
    </View>}
    <View className="w-full self-center px-4" style={{ maxWidth: 520 }}>
      {!!error && <Text accessibilityRole="alert" numberOfLines={3} className="text-red-300 text-xs text-center py-2">{error}</Text>}
      {(storageCheck.state === 'warning' || storageCheck.state === 'blocked') && <Text accessibilityRole="alert" numberOfLines={3} className="text-amber-200 text-xs text-center pb-2">{storageCheck.message}</Text>}
      {!!cameraMountFailure && <Pressable accessibilityRole="button" accessibilityLabel="Retry camera" onPress={() => { setCameraMountFailure(null); setReady(false); setError(''); setCameraRetry(value => value + 1); }} className="self-center rounded-lg bg-neutral-900 border border-neutral-800 px-4 py-2 mb-2 active:opacity-70"><Text className="text-neutral-200 text-xs font-semibold">Retry camera</Text></Pressable>}
      {isScript && recording && <View className="pb-2"><CaptureControls active={recording} onCommand={receiveCaptureCommand} /></View>}
      <View className="flex-row items-center border-b border-neutral-800 py-2">
        <View className="flex-1 items-center"><IconButton icon="grid_3x3" label={grid ? 'Hide grid' : 'Show grid'} onPress={() => setGrid(v => !v)} /></View>
        <View className="flex-1 items-center border-l border-neutral-800"><Pressable accessibilityRole="button" accessibilityLabel="Change zoom" onPress={() => setZoom(v => {
            let best = 0;
            for (let i = 1; i < ZOOM_STOPS.length; i++) {
              if (Math.abs(ZOOM_STOPS[i]! - v) < Math.abs(ZOOM_STOPS[best]! - v)) best = i;
            }
            return ZOOM_STOPS[(best + 1) % ZOOM_STOPS.length] ?? 0;
          })} className="h-12 min-w-12 items-center justify-center"><Text className="text-white text-lg font-medium">{zoom === 0 ? 'WIDE' : `${Math.round(zoom * 100)}%`}</Text></Pressable></View>
        <View className="flex-1 items-center border-l border-neutral-800"><IconButton icon="tune" label="Camera settings" disabled={preparing || recording || saving} onPress={() => { dismissSuggestions(); setSheet('settings'); }} /></View>
      </View>
      <View className="flex-row items-center py-5">
        <Pressable accessibilityRole="button" accessibilityLabel="Visual Suggestions" disabled={preparing || saving} accessibilityState={{ disabled: preparing || saving }} onPress={requestSuggestions} className="flex-1 items-center py-2 active:opacity-60" style={{ opacity: preparing || saving ? 0.4 : 1 }}>
          <View className="bg-amber-400 rounded-full px-5 py-2"><Sparkles size={20} strokeWidth={1.75} color="black" /></View>
          <Text className="text-neutral-500 text-[11px] mt-2 tracking-widest font-semibold">SUGGESTIONS</Text>
        </Pressable>
        <View className="flex-1 items-center">
          <Pressable accessibilityRole="button" accessibilityLabel={preparing ? 'Cancel recording preparation' : recording ? 'Stop recording' : 'Start recording'} disabled={!ready || saving || storageBlocked || !scriptDocumentLoaded || (!!requestedPickupProjectId && !pickupProject)} onPress={record}
            style={{ width: 84, height: 64, borderRadius: 40, borderWidth: 3, borderColor: 'white', padding: 5, opacity: !ready || saving || storageBlocked ? 0.4 : 1 }}>
            <View style={{ flex: 1, borderRadius: recording ? 10 : 32, backgroundColor: recording ? '#ef4444' : 'white', margin: recording ? 7 : 0 }} />
          </Pressable>
        </View>
        <View className="flex-1 items-center">
          <IconButton icon="flip_camera_android" label="Switch front or rear camera" disabled={preparing || recording || saving} onPress={() => { setReady(false); setZoom(0); setFacing(v => v === 'back' ? 'front' : 'back'); }} />
          <Text className="text-neutral-500 text-[11px] mt-2 tracking-widest font-semibold">FLIP</Text>
        </View>
      </View>
    </View>
    <Modal visible={sheet !== null} transparent animationType="slide" onRequestClose={() => setSheet(null)}>
      <View className="flex-1 justify-end bg-black/60">
        <Pressable className="flex-1" accessibilityLabel="Dismiss panel" onPress={() => setSheet(null)} />
        <SafeAreaView edges={['bottom']} className="bg-neutral-950" style={{ maxHeight: '70%' }}>
          <ScrollView contentContainerStyle={{ padding: 24 }}>
            <View className="flex-row items-center justify-between"><Text className="text-white text-base font-semibold">{sheet === 'settings' ? 'Camera settings' : 'Visual Suggestions'}</Text><IconButton icon="close" label="Close panel" onPress={() => setSheet(null)} /></View>
            {sheet === 'settings' ? <>
              <Text className="text-neutral-300 text-sm mt-3">Maximum recording quality</Text>
              <Text className="text-neutral-500 text-xs mt-2 leading-5">Applies to the recorded file, not the live preview. Unsupported qualities fall back to the highest available.</Text>
              <View className="flex-row flex-wrap gap-2 mt-4">{(['2160p', '1080p', '720p', '480p'] as const).map(value => <Pressable key={value} onPress={() => { setVideoQuality(value); setSheet(null); }} className={`rounded-xl px-4 py-3 active:opacity-70 ${videoQuality === value ? 'bg-white' : 'bg-neutral-900'}`}><Text className={`text-xs font-semibold ${videoQuality === value ? 'text-black' : 'text-white'}`}>{value}</Text></Pressable>)}</View>
            </> : null}
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
    <Modal visible={previewUri !== null} animationType="slide" onRequestClose={() => { if (!saving && !pendingSave.current) setPreviewUri(null); }}>
      <SafeAreaView className="flex-1 bg-black">
        <StatusBar style="light" />
        <View className="flex-row items-center justify-between px-4 h-16">
          <Text className="text-white text-xs tracking-widest">{recordedProject?.recordingStatus === 'interrupted' ? 'REVIEW INTERRUPTED TAKE' : 'PREVIEW'}</Text>
          <IconButton icon="close" label="Close saved preview" disabled={saving || !!pendingSave.current} onPress={() => setPreviewUri(null)} />
        </View>
        <View className="flex-1 px-4">
          {previewUri && <PreviewPlayer key={previewUri} uri={previewUri} />}
        </View>
        {!!recordedProject?.recoveryMessage && <Text accessibilityRole="alert" className="text-amber-200 text-sm px-4 pt-3">{recordedProject.recoveryMessage}</Text>}
        {!!error && <Text accessibilityRole="alert" className="text-red-300 text-sm px-4 pt-3">{error}</Text>}
        {isScript && !captureCoverage.safeToWrap && <View className="px-4 pt-3">
          <Text accessibilityRole="alert" className="text-amber-200 text-xs leading-5">
            {promptDecision?.text ?? 'Some lines still need a clean, playable take.'}
          </Text>
        </View>}
        <View className="flex-row gap-2 px-4 py-5" style={{ maxWidth: 520, width: '100%', alignSelf: 'center' }}>
          <Pressable disabled={saving} accessibilityRole="button" accessibilityLabel="Retake video" onPress={retake} className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl py-3.5 active:opacity-70">
            <Text className="text-neutral-200 text-xs font-semibold text-center">Retake</Text>
          </Pressable>
          {isScript && !captureCoverage.safeToWrap && <Pressable disabled={saving} accessibilityRole="button" accessibilityLabel="Continue recording" onPress={continueRecording} className="flex-1 bg-neutral-900 border border-amber-700 rounded-xl py-3.5 active:opacity-70">
            <Text className="text-amber-100 text-xs font-semibold text-center">Continue recording</Text>
          </Pressable>}
          <Pressable disabled={saving} accessibilityRole="button" accessibilityLabel="Continue to editor" onPress={continueToEditor} className="flex-1 bg-white rounded-xl py-3.5 active:opacity-80">
            <Text className="text-black text-xs font-bold text-center">{saving ? 'Saving…' : isScript && !captureCoverage.safeToWrap ? 'Wrap anyway' : 'Continue'}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  </SafeAreaView>;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Directory, File, Paths } from 'expo-file-system';
import { NativeCutView, getExportJobs, nativeMedia, type ExportJob, type MediaSegment } from '@/features/media/native';

const folder = () => new Directory(Paths.document, 'research');
const source = () => new File(folder(), 'media-sample.mp4');
const suppliedCut = (): MediaSegment[] => [
  { uri: source().uri, start: 0, end: 4, caption: 'This is the first clean take.' },
  { uri: source().uri, start: 8, end: 12, caption: 'This is the final clean take.' },
];
function Button({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} className="active:opacity-65" style={[styles.button, disabled && { opacity: 0.4 }]}><Text style={styles.buttonText}>{title}</Text></Pressable>;
}

export default function MediaResearch() {
  const scroll = useRef<ScrollView>(null);
  const [activeJobId, setActiveJobId] = useState('');
  const [visible, setVisible] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [segments, setSegments] = useState<MediaSegment[]>([]);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [seek, setSeek] = useState(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [firstFrame, setFirstFrame] = useState<number | null>(null);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const serialized = useMemo(() => JSON.stringify(segments), [segments]);
  const latest = jobs.find(job => job.id === activeJobId) ?? jobs[jobs.length - 1];
  const completed = jobs.find(job => job.id === activeJobId && job.state === 'completed');
  const active = jobs.find(job => job.state === 'queued' || job.state === 'running');
  const record = (text: string) => setLog(previous => [...previous.slice(-79), `${new Date().toISOString()} ${text}`]);

  useEffect(() => {
    folder().create({ intermediates: true, idempotent: true });
    const file = new File(folder(), 'active-project.txt');
    const id = file.exists ? file.textSync() : `media-research-${Date.now()}`;
    if (!file.exists) file.write(id);
    setProjectId(id);
    const lastJob = new File(folder(), 'active-job.txt');
    if (lastJob.exists) setActiveJobId(lastJob.textSync());
  }, []);
  useEffect(() => {
    if (!log.length) return;
    new File(folder(), 'media-report.json').write(JSON.stringify({ projectId, source: source().uri, firstFrame, log, jobs }, null, 2));
  }, [log, projectId, jobs, firstFrame]);
  useEffect(() => {
    if (!visible || !projectId || !nativeMedia) return;
    let live = true;
    const refresh = () => getExportJobs(projectId).then(value => { if (live) setJobs(value); }).catch(error => { if (live) setMessage(String(error)); });
    refresh(); const timer = setInterval(refresh, 500);
    return () => { live = false; clearInterval(timer); };
  }, [visible, projectId]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') setPlaying(false); if (visible) record(`App state: ${state}`); });
    return () => subscription.remove();
  }, [visible]);
  useEffect(() => { if (latest) record(`Export ${latest.id}: ${latest.state} ${latest.progress}%`); }, [latest?.id, latest?.state]);

  useEffect(() => { if (visible) requestAnimationFrame(() => scroll.current?.scrollTo({ y: 0, animated: false })); }, [visible]);

  async function action(run: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await run(); } catch (error) { const text = error instanceof Error ? error.message : String(error); setMessage(text); record(text); }
    finally { setBusy(false); }
  }
  function preview(value: MediaSegment[]) {
    setPreviewRevision(value => value + 1);
    setPlaying(false); setFirstFrame(null); setPosition(0); setDuration(0); setSeek(0); setMessage(''); setSegments(value);
    scroll.current?.scrollTo({ y: 0, animated: false });
    record(`Load preview: ${value.length} segments`);
  }
  async function exportVideo(repetitions: number, cancel = false) {
    if (!nativeMedia) return;
    const cut = Array.from({ length: repetitions }, suppliedCut).flat();
    record(`Start export: ${repetitions * 8}s supplied cut`);
    const id = await nativeMedia.startExport(projectId, JSON.stringify(cut));
    setActiveJobId(id); new File(folder(), 'active-job.txt').write(id);
    record(`Export queued: ${id}`);
    if (cancel) { await new Promise(resolve => setTimeout(resolve, 200)); await nativeMedia.cancelExport(id); record(`Cancel requested: ${id}`); }
    setJobs(await getExportJobs(projectId));
  }
  function close() { setPlaying(false); setSegments([]); setVisible(false); }
  return <>
    <Pressable accessibilityRole="button" onPress={() => setVisible(true)} style={styles.entry} className="active:opacity-65"><Text style={styles.entryText}>Playback & export research · Dev</Text></Pressable>
    <Modal visible={visible} onRequestClose={close} animationType="none">
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}><Button title="Close research" onPress={close} /><Text style={styles.headerText}>Media research</Text></View>
        <ScrollView ref={scroll} style={{ flex: 1 }} contentInsetAdjustmentBehavior="never" contentContainerStyle={styles.content}>
          <Text style={styles.tag}>DEVELOPMENT · SYNTHETIC FIXTURE</Text>
          <Text style={styles.title}>Play now. Export separately.</Text>
          <Text style={styles.body}>Two non-adjacent takes from a 12-second local fixture. The red middle take is excluded. This experiment does not change Projects.</Text>
          {!nativeMedia && <Text style={styles.notice}>Install the research Android build to enable native playback and export.</Text>}
          {!source().exists && <Text style={styles.notice}>Stage media-sample.mp4 in the app’s files/research folder using the research setup instructions.</Text>}
          {segments.length > 0 && NativeCutView && <View style={styles.preview}>
            <NativeCutView key={previewRevision} style={{ flex: 1 }} segments={serialized} playing={playing} seek={seek} onState={({ nativeEvent: event }) => {
              if (event.position != null) setPosition(event.position);
              if (event.duration != null) setDuration(event.duration);
              if (event.firstFrameMs != null) { setFirstFrame(event.firstFrameMs); record(`First frame: ${event.firstFrameMs} ms`); }
              if (event.ended) { setPlaying(false); record('Preview reached end'); }
              if (event.error) { setMessage(event.error); record(`Preview error: ${event.error}`); }
            }} />
          </View>}
          {segments.length > 0 && <>
            <Text style={styles.body}>{position.toFixed(1)} / {duration.toFixed(1)} seconds{firstFrame != null ? ` · First frame ${firstFrame} ms` : ''}</Text>
            <View style={styles.buttons}><Button title={playing ? 'Pause preview' : 'Play preview'} onPress={() => setPlaying(!playing)} /><Button title="Restart preview" onPress={() => { setSeek(previous => previous === 0 ? 0.001 : 0); setPlaying(true); }} /></View>
          </>}
          <View style={styles.buttons}>
            <Button title="Load clean cut" disabled={!nativeMedia || !source().exists} onPress={() => preview(suppliedCut())} />
            <Button title="Load original" disabled={!nativeMedia || !source().exists} onPress={() => preview([{ uri: source().uri, start: 0, end: 12 }])} />
          </View>
          <Text style={styles.section}>Real MP4 export</Text>
          <Text style={styles.body}>720 × 1280, SDR, H.264 + AAC. Captions use the same composition as preview. Synthetic voice; no measured human-speech splice or lip-sync claim.</Text>
          <Button title="Export 8-second cut" disabled={busy || !!active || !nativeMedia} onPress={() => action(() => exportVideo(1))} />
          <Button title="Export 2-minute stress cut" disabled={busy || !!active || !nativeMedia} onPress={() => action(() => exportVideo(15))} />
          <Button title="Test cancellation" disabled={busy || !!active || !nativeMedia} onPress={() => action(() => exportVideo(15, true))} />
          {active && <Button title="Cancel export" disabled={busy} onPress={() => action(async () => { await nativeMedia!.cancelExport(active.id); record('Manual cancellation requested'); })} />}
          {latest && <Text accessibilityLiveRegion="polite" style={styles.notice}>Export: {latest.state} · {latest.progress}%{latest.error ? `\n${latest.error}` : ''}</Text>}
          {completed && <>
            <Button title="Preview exported file" onPress={() => preview([{ uri: completed.uri!, start: 0, end: completed.segments.reduce((sum, item) => sum + item.end - item.start, 0) }])} />
            <Button title="Save research export to gallery" disabled={busy} onPress={() => action(async () => { await nativeMedia!.saveToGallery(completed.id); record('Gallery save completed'); setMessage('Research export saved to gallery.'); })} />
            <Button title="Open share sheet" disabled={busy} onPress={() => action(async () => { await nativeMedia!.shareExport(completed.id); record('Share sheet opened; no destination selected by automation'); })} />
          </>}
          <Text style={styles.section}>On-device container inspection</Text>
          <Button title="Inspect source and export" disabled={busy || !completed || !nativeMedia?.inspectExport} onPress={() => action(async () => {
            const original = JSON.parse(await nativeMedia!.inspectSource!(source().uri));
            const output = JSON.parse(await nativeMedia!.inspectExport!(completed!.id));
            new File(folder(), 'container-report.json').write(JSON.stringify({ original, output }, null, 2));
            record(`Container inspection: ${JSON.stringify(output)}`);
            setMessage('Source and export inspected on device. Results saved in container-report.json.');
          })} />
          <Text style={styles.section}>Failure & recovery checks</Text>
          <Button title="Check missing source" disabled={busy || !nativeMedia} onPress={() => action(async () => {
            try { await nativeMedia!.startExport(`${projectId}-missing`, JSON.stringify([{ uri: new File(folder(), 'absent.mp4').uri, start: 0, end: 4 }])); throw new Error('FAIL: missing source accepted'); }
            catch (error) { if (String(error).includes('FAIL:') || !String(error).toLowerCase().includes('missing')) throw error; record(`Missing source rejected: ${String(error)}`); setMessage('Missing source rejected; original fixture unchanged.'); }
          })} />
          <Text style={styles.body}>For interruption: start the stress cut, force-stop this app, reopen research. The job must say interrupted, never completed. Use a new export to retry.</Text>
          {!!message && <Text accessibilityRole="alert" style={styles.notice}>{message}</Text>}
          <Text style={styles.section}>Device log</Text>
          <Text selectable style={styles.log}>{log.slice(-12).join('\n') || 'No operations yet.'}</Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#080808' }, entry: { minHeight: 48, alignItems: 'center', justifyContent: 'center' }, entryText: { color: '#a3a3a3', fontSize: 12 },
  header: { paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }, headerText: { color: '#fff', fontSize: 15, flex: 1 },
  content: { padding: 20, paddingBottom: 40, gap: 12, maxWidth: 600, width: '100%', alignSelf: 'center' },
  tag: { color: '#a3a3a3', fontSize: 10, letterSpacing: 1 }, title: { color: '#fff', fontSize: 28, fontFamily: 'Inter_700Bold' },
  body: { color: '#b5b5b5', fontSize: 13, lineHeight: 21 }, notice: { padding: 16, borderRadius: 12, backgroundColor: '#242016', color: '#fde68a', fontSize: 13, lineHeight: 20 },
  preview: { height: 360, backgroundColor: '#000', overflow: 'hidden', borderRadius: 12 }, buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 48, padding: 14, borderRadius: 12, backgroundColor: '#262626', justifyContent: 'center' }, buttonText: { color: '#fff', textAlign: 'center', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  section: { color: '#fff', fontSize: 17, fontFamily: 'Inter_600SemiBold', marginTop: 12 }, log: { color: '#b5b5b5', fontSize: 11, lineHeight: 18 },
});

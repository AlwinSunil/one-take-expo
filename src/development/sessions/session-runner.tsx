import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Check, ChevronRight, FlaskConical, RotateCcw, X } from 'lucide-react-native';

import { summarizeSession } from './contracts';
import { createSample, sampleIds, type SampleId } from './samples';
import { runSampleChecks } from './checks';
import { runStorageChecks } from './storage-checks';
import { runCoachingChecks } from '../../../docs/research/capture-vision/f4/cue-policy';

function Button({ label, onPress, secondary = false }: { label: string; onPress: () => void; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" onPress={onPress} className="active:opacity-65" style={[styles.button, secondary && styles.secondaryButton]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
  </Pressable>;
}

export default function SessionRunner() {
  const [resultMode, setResultMode] = useState<'handoff' | 'storage' | 'coaching'>('handoff');
  const [checkingStorage, setCheckingStorage] = useState(false);
  const [visible, setVisible] = useState(false);
  const [session, setSession] = useState<ReturnType<typeof createSample> | null>(null);
  const [results, setResults] = useState<ReturnType<typeof runSampleChecks> | null>(null);
  const scroll = useRef<ScrollView>(null);
  const summary = session ? summarizeSession(session) : null;
  if (!__DEV__) return null;

  function select(id: SampleId) {
    setSession(createSample(id));
    setResults(null);
    scroll.current?.scrollTo({ y: 0, animated: false });
  }
  function back() {
    setSession(null); setResults(null);
    scroll.current?.scrollTo({ y: 0, animated: false });
  }
  function close() { setVisible(false); back(); }
  async function checkStorage() {
    if (checkingStorage) return;
    setResultMode('storage');
    setCheckingStorage(true);
    try { setResults(await runStorageChecks()); scroll.current?.scrollTo({ y: 0, animated: false }); }
    catch (error) { setResults([{ name: 'Storage checks', passed: false, error: String(error) }]); }
    finally { setCheckingStorage(false); }
  }
  function checkCoaching() {
    setResultMode('coaching');
    setResults(runCoachingChecks());
    scroll.current?.scrollTo({ y: 0, animated: false });
  }
  function checkHandoffs() {
    setResultMode('handoff');
    setResults(runSampleChecks());
    scroll.current?.scrollTo({ y: 0, animated: false });
  }

  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="Open development sample sessions" onPress={() => setVisible(true)}
      className="active:opacity-65" style={styles.entry}>
      <FlaskConical size={16} color="#a3a3a3" />
      <Text style={styles.entryText}>Sample sessions · Dev</Text>
    </Pressable>
    <Modal visible={visible} onRequestClose={session || results ? back : close} animationType="none" presentationStyle="fullScreen">
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel={session || results ? 'Back to samples' : 'Close samples'} onPress={session || results ? back : close} className="active:opacity-65" style={styles.iconButton}>
            {session || results ? <ArrowLeft color="#fff" size={22} /> : <X color="#fff" size={22} />}
          </Pressable>
          <Text style={styles.headerTitle}>Sample sessions</Text>
          {session ? <Pressable accessibilityRole="button" accessibilityLabel="Reset sample" onPress={() => select(session.id as SampleId)} className="active:opacity-65" style={styles.iconButton}>
            <RotateCcw color="#d4d4d4" size={20} />
          </Pressable> : <View style={styles.iconButton} />}
        </View>
        <ScrollView ref={scroll} contentContainerStyle={styles.content}>
          <Text style={styles.eyebrow}>DEVELOPMENT ONLY</Text>
          {!session && !results && <>
            <Text style={styles.title}>Every state, on demand.</Text>
            <Text style={styles.subtitle}>Replay the shared examples without a camera or speech engine. These samples stay in memory and never enter Projects.</Text>
            <View style={styles.list}>
              {sampleIds.map((id, index) => {
                const sample = createSample(id);
                return <Pressable key={id} accessibilityRole="button" onPress={() => select(id)} className="active:opacity-65" style={[styles.row, index > 0 && styles.divider]}>
                  <Text style={styles.index}>{String(index + 1).padStart(2, '0')}</Text>
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{sample.title}</Text>
                    <Text style={styles.rowDescription}>{sample.description}</Text>
                  </View>
                  <ChevronRight size={18} color="#737373" />
                </Pressable>;
              })}
            </View>
            <Button label="Run handoff checks" onPress={checkHandoffs} secondary />
            <View style={{ marginTop: 12 }}><Button label={checkingStorage ? 'Checking storage…' : 'Run on-device storage checks'} onPress={checkStorage} secondary /></View>
            <View style={{ marginTop: 12 }}><Button label="Run coaching policy checks" onPress={checkCoaching} secondary /></View>
            <Text style={styles.footnote}>Storage checks briefly create and remove dedicated fixture projects. Other checks stay in memory. No recognition, video playback or export is simulated as a real result.</Text>
          </>}
          {results && <>
            <Text accessibilityLiveRegion="polite" style={styles.title}>{results.filter(result => result.passed).length} / {results.length} checks passed</Text>
            <Text style={styles.subtitle}>Shared-data behavior checks executed by the app’s JavaScript runtime. These do not verify camera, audio sync, NPU or rendered media.</Text>
            <View style={styles.list}>{results.map((result, index) => <View key={result.name} style={[styles.row, index > 0 && styles.divider]}>
              {result.passed ? <Check size={18} color="#a7f3d0" /> : <X size={18} color="#fca5a5" />}
              <Text style={[styles.rowTitle, styles.rowText]}>{result.passed ? 'Pass' : 'Fail'} · {result.name}{result.error ? `: ${result.error}` : ''}</Text>
            </View>)}</View>
            <Button label="Run again" onPress={resultMode === 'storage' ? checkStorage : resultMode === 'coaching' ? checkCoaching : checkHandoffs} secondary />
          </>}
          {session && summary && <>
            <Text style={styles.title}>{session.title}</Text>
            <Text style={styles.subtitle}>{session.description}</Text>
            <View style={styles.card}>
              <Text style={[styles.status, { color: summary.safeToWrap ? '#a7f3d0' : '#fde68a' }]}>
                {summary.pending ? 'Still checking' : summary.outstandingActions ? 'Action needs confirmation' : summary.safeToWrap ? 'All spoken lines covered' : 'Pickups needed'}
              </Text>
              <Text style={styles.metric}>{summary.covered} of {summary.total} lines</Text>
              <Text style={styles.detail}>{summary.safeToWrap ? 'Coverage complete in this sample.' : summary.pending ? 'Wait for the remaining verdict before deciding to wrap.' : `${summary.outstandingActions} required action not yet confirmed.`}</Text>
            </View>
            {session.media.status === 'missing' && <View style={styles.notice}>
              <Text style={styles.noticeTitle}>Recording unavailable</Text>
              <Text style={styles.detail}>The script and take decisions are still here. Restore the original recording before previewing or exporting.</Text>
            </View>}
            {session.export.status === 'failed' && <View style={styles.notice}>
              <Text style={styles.noticeTitle}>Export didn’t finish</Text>
              <Text style={styles.detail}>{session.export.reason} Free up space, then retry. Your original and cut decisions are unchanged.</Text>
              <Button label="Replay export-ready state" secondary onPress={() => setSession({ ...session, export: { status: 'not-started' } })} />
            </View>}
            {session.camera.vision === 'off-frame' && <View style={styles.notice}>
              <Text style={styles.noticeTitle}>Check the framing</Text>
              <Text style={styles.detail}>The sample vision signal places the subject outside the frame. Keep intentional framing; spoken coverage is unchanged.</Text>
            </View>}
            <Text style={styles.sectionTitle}>Lined script</Text>
            <View style={styles.list}>{session.script.map((item, index) => {
              const coverage = session.coverage.find(entry => entry.lineId === item.id);
              const label = item.kind === 'action' ? item.confirmed ? 'Manually confirmed' : item.required ? 'Required action' : 'Optional cue' : coverage?.status === 'covered' ? 'Covered' : coverage?.status === 'pending' ? 'Checking…' : 'Needs pickup';
              return <View key={item.id} style={[styles.scriptRow, index > 0 && styles.divider]}>
                <Text style={[styles.lineLabel, { color: label === 'Covered' || item.kind === 'action' && item.confirmed ? '#a7f3d0' : '#d4d4d4' }]}>{label}</Text>
                <Text style={styles.lineText}>{item.text}</Text>
                {item.kind === 'action' && item.required && <Button secondary label={item.confirmed ? 'Undo confirmation' : 'Confirm action in sample'} onPress={() => setSession({ ...session, script: session.script.map(line => line.id === item.id ? { ...item, confirmed: !item.confirmed } : line) })} />}
              </View>;
            })}</View>
            {summary.pending && <Button label="Replay completed analysis" onPress={() => select('clean')} secondary />}
            <Text style={styles.sectionTitle}>Take ledger</Text>
            <View style={styles.list}>{session.takes.map((take, index) => <View key={take.id} style={[styles.scriptRow, index > 0 && styles.divider]}>
              <Text style={styles.rowTitle}>Take {index + 1} · {take.verdict}</Text>
              <Text style={styles.detail}>{take.start.toFixed(1)}–{take.end.toFixed(1)} s · {take.lineIds.length} spoken {take.lineIds.length === 1 ? 'line' : 'lines'}</Text>
              {!!take.reason && <Text style={styles.detail}>{take.reason}</Text>}
            </View>)}</View>
            <Text style={styles.sectionTitle}>Supplied cut</Text>
            <View style={styles.card}>
              {session.cut.map((segment, index) => <Text key={index} style={styles.lineText}>{index + 1}. {segment.start.toFixed(1)}–{segment.end.toFixed(1)} s · {segment.takeId}</Text>)}
              <Text style={styles.detail}>Data preview only. No video is attached; no playback or export has run.</Text>
            </View>
            <Text style={styles.footnote}>Engine: fixture · No model or hardware processor involved. Reset restores this example without changing your saved recordings.</Text>
          </>}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#080808' },
  entry: { minHeight: 48, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  entryText: { color: '#a3a3a3', fontSize: 12, fontFamily: 'Inter_500Medium' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 4 },
  headerTitle: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  iconButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 24, paddingTop: 20, paddingBottom: 40, width: '100%', maxWidth: 600, alignSelf: 'center' },
  eyebrow: { color: '#a3a3a3', fontSize: 10, letterSpacing: 1.8, fontFamily: 'Inter_600SemiBold', marginBottom: 12 },
  title: { color: '#fafafa', fontSize: 30, fontFamily: 'Inter_700Bold', letterSpacing: -0.8 },
  subtitle: { color: '#a3a3a3', fontSize: 14, lineHeight: 22, marginTop: 10, marginBottom: 24, fontFamily: 'Inter_400Regular' },
  list: { backgroundColor: '#161616', borderWidth: 1, borderColor: '#2b2b2b', borderRadius: 16, overflow: 'hidden', marginBottom: 20 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center', padding: 18, minHeight: 64 },
  divider: { borderTopWidth: 1, borderTopColor: '#2b2b2b' },
  index: { fontSize: 11, color: '#a3a3a3', fontFamily: 'Inter_500Medium' },
  rowText: { flex: 1 },
  rowTitle: { color: '#fafafa', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  rowDescription: { color: '#a3a3a3', fontSize: 12, lineHeight: 18, marginTop: 5, fontFamily: 'Inter_400Regular' },
  button: { backgroundColor: '#fafafa', borderRadius: 12, minHeight: 48, justifyContent: 'center', paddingVertical: 13, paddingHorizontal: 16 },
  secondaryButton: { backgroundColor: '#262626', borderWidth: 1, borderColor: '#404040' },
  buttonText: { color: '#171717', textAlign: 'center', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  secondaryButtonText: { color: '#fafafa' },
  footnote: { color: '#a3a3a3', fontSize: 12, lineHeight: 19, marginTop: 16, fontFamily: 'Inter_400Regular' },
  card: { backgroundColor: '#161616', padding: 20, borderWidth: 1, borderColor: '#2b2b2b', borderRadius: 16, marginBottom: 16, gap: 8 },
  status: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  metric: { color: '#fafafa', fontSize: 28, fontFamily: 'Inter_600SemiBold' },
  detail: { color: '#b5b5b5', fontSize: 13, lineHeight: 21, fontFamily: 'Inter_400Regular' },
  notice: { borderWidth: 1, borderColor: '#51452b', backgroundColor: '#1c1912', borderRadius: 16, padding: 18, gap: 10, marginBottom: 16 },
  noticeTitle: { color: '#fde68a', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  sectionTitle: { color: '#fafafa', fontSize: 16, fontFamily: 'Inter_600SemiBold', marginTop: 12, marginBottom: 12 },
  scriptRow: { padding: 18, gap: 8 },
  lineLabel: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  lineText: { color: '#f5f5f5', fontSize: 16, lineHeight: 25, fontFamily: 'Inter_400Regular' },
});

import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Directory, File, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import { beginProjectPickup, completeProjectPickup, saveProject } from '@/lib/store';
import media, { NativeCutPreview, type MediaExportRequest } from '../../../modules/one-take-media';

const folder = () => new Directory(Paths.document, 'research');
const source = () => new File(folder(), 'media-sample.mp4');
const reportFile = () => new File(folder(), 'tier0-media-report.json');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export default function Tier0MediaChecks() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [request, setRequest] = useState<MediaExportRequest | null>(null);
  const [playing, setPlaying] = useState(false);
  function log(text: string) {
    setLines(previous => {
      const next = [...previous, text];
      reportFile().write(JSON.stringify({ at: new Date().toISOString(), lines: next }, null, 2));
      return next;
    });
  }
  async function plan(id: string, repeats = 1): Promise<MediaExportRequest> {
    const second = new File(folder(), 'tier0-second-source.mp4');
    if (!second.exists) await source().copy(second);
    const pair = [
      { uri: source().uri, t0: 0, t1: 4, captions: [{ t0: 0, t1: 4, text: 'This is the first clean take.' }] },
      { uri: second.uri, t0: 8, t1: 12, captions: [{ t0: 8, t1: 12, text: 'This is the final clean take.' }] },
    ];
    return { id, sourceUri: source().uri, cuts: [], captions: [], segments: Array.from({ length: repeats }, () => pair).flat() };
  }
  async function waitFor(id: string) {
    for (let i = 0; i < 600; i++) {
      const job = await media!.getExport(id);
      if (!['queued', 'running'].includes(job.status)) return job;
      await delay(500);
    }
    throw new Error('Export timed out after five minutes.');
  }
  async function run(stress = false) {
    if (!media || busy) return;
    setBusy(true); setLines([]);
    const id = `tier0-${Date.now()}`;
    try {
      if (!source().exists) throw new Error('Stage the dedicated 12-second media fixture.');
      const prepared = await plan(id, stress ? 15 : 1);
      log(`Start production ${stress ? 120 : 8}-second two-source export ${id}`);
      const started = Date.now();
      new File(folder(), 'tier0-active-id.txt').write(id);
      await media.startExport(prepared);
      const result = await waitFor(id);
      if (result.status !== 'completed' || !result.uri || !new File(result.uri).exists) throw new Error(JSON.stringify(result));
      log(`PASS completed in ${Date.now() - started} ms: ${result.uri}`);
      new File(folder(), 'tier0-output.json').write(JSON.stringify(result));
      if (stress) return;
      const cancelId = `${id}-cancel`;
      await media.startExport(await plan(cancelId, 15));
      await delay(250);
      const beforeDeletion = await media.getExport(cancelId);
      if (beforeDeletion.status !== 'running') throw new Error(`Cancellation fixture was ${beforeDeletion.status}, not running`);
      await media.deleteExport(cancelId, false);
      log('PASS active export deletion settled');
      let rejected = false;
      try {
        await media.startExport({ ...prepared, id: `${id}-missing`, segments: [{ uri: new File(folder(), 'tier0-absent.mp4').uri, t0: 0, t1: 4 }] });
        const failed = await waitFor(`${id}-missing`);
        rejected = failed.status === 'failed' && !failed.uri;
      }
      catch { rejected = true; }
      if (!rejected) throw new Error('Missing source was accepted');
      log('PASS missing source rejected');
      const gallery = await media.saveToGallery(id);
      log(`PASS gallery save ${gallery}`);
      await media.deleteExport(id, true);
      if (new File(result.uri).exists) throw new Error('Deleted export still exists');
      log('PASS native output and app-created gallery copy deletion');
      if (!source().exists) throw new Error('Original fixture lost');
      log('PASS original preserved');
    } catch (error) { log(`FAIL ${String(error)}`); }
    finally { setBusy(false); }
  }
  async function openReviewFixture() {
    if (busy) return;
    setBusy(true);
    try {
      const id = `tier0-review-${Date.now()}`;
      const saved = await saveProject({ id, mode: 'script', createdAt: Date.now(), duration: 12,
        script: 'This is the first clean take. This is the final clean take.', videoUri: source().uri, clips: [],
        scriptLines: [{ id: 'first', spokenText: 'This is the first clean take.', actionCues: [] },
          { id: 'last', spokenText: 'This is the final clean take.', actionCues: [{ id: 'show', text: 'Show the product', required: true, resolved: false }] }],
        transcript: [{ id: 'first-caption', t0: 0, t1: 4, text: 'This is the first clean take.', isFinal: true, timingSource: 'saved-audio' }],
        takes: [{ id: 'first-take', t0: 0, t1: 4, mediaUri: source().uri, playable: true, quality: 'clean', inFrame: true, transcriptSegmentIds: ['first-caption'] }],
      });
      await beginProjectPickup(saved.id, 'pickup', ['last']);
      await completeProjectPickup(saved.id, 'pickup', { videoUri: source().uri, duration: 12,
        transcript: [{ id: 'last-caption', t0: 8, t1: 12, text: 'This is the final clean take.', isFinal: true, timingSource: 'saved-audio' }],
        takes: [{ id: 'last-take', t0: 8, t1: 12, mediaUri: source().uri, playable: true, quality: 'clean', inFrame: true, transcriptSegmentIds: ['last-caption'] }],
      });
      new File(folder(), 'tier0-review-id.txt').write(saved.id);
      setPlaying(false); setVisible(false);
      router.push({ pathname: '/editor', params: { projectId: saved.id } });
    } catch (error) { log(`FAIL review fixture ${String(error)}`); }
    finally { setBusy(false); }
  }
  const button = (title: string, action: () => void) => <Pressable accessibilityRole="button" disabled={busy} onPress={action} style={{ minHeight: 48, padding: 14, backgroundColor: '#262626', borderRadius: 10 }}><Text style={{ color: 'white' }}>{title}</Text></Pressable>;
  return <>
    <Pressable accessibilityRole="button" onPress={() => setVisible(true)} style={{ minHeight: 48, justifyContent: 'center' }}><Text style={{ color: '#a3a3a3', textAlign: 'center' }}>Tier 0 media checks · Dev</Text></Pressable>
    <Modal visible={visible} onRequestClose={() => { setPlaying(false); setVisible(false); }}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#080808' }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
          {button('Close Tier 0 checks', () => { setPlaying(false); setVisible(false); })}
          <Text style={{ color: 'white', fontSize: 22 }}>Production media validation</Text>
          <Text style={{ color: '#aaa' }}>Dedicated synthetic media only. This checks production native playback/export; it does not establish human speech or lip sync accuracy.</Text>
          {!media && <Text style={{ color: '#fbbf24' }}>Rebuild the Android app to run these checks.</Text>}
          {button('Preview production cut', () => { void plan('preview').then(value => { setRequest(value); setPlaying(true); }).catch(error => log(String(error))); })}
          {request && NativeCutPreview && <View style={{ height: 330 }}><NativeCutPreview style={{ flex: 1 }} request={JSON.stringify(request)} playing={playing} seek={0} onState={({ nativeEvent: event }) => {
            if (event.firstFrameMs != null) log(`PREVIEW first frame ${event.firstFrameMs} ms`);
            if (event.ended) { setPlaying(false); log('PREVIEW ended'); }
            if (event.error) log(`PREVIEW error ${event.error}`);
          }} /></View>}
          {button('Run production export checks', () => { void run(); })}
          {button('Run 120-second export', () => { void run(true); })}
          {button('Open synthetic pickup in editor', () => { void openReviewFixture(); })}
          {button('Recover last test export', () => { void (async () => {
            try {
              const id = new File(folder(), 'tier0-active-id.txt').textSync();
              const result = await media!.getExport(id);
              log(`RECOVERY ${JSON.stringify(result)}`);
              if (result.status === 'completed') new File(folder(), 'tier0-output.json').write(JSON.stringify(result));
            } catch (error) { log(`FAIL recovery ${String(error)}`); }
          })(); })}
          <Text selectable style={{ color: '#ddd' }}>{lines.join('\n') || 'No results yet.'}</Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </>;
}

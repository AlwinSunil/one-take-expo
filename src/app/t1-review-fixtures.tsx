import { Asset } from 'expo-asset';
import { router } from 'expo-router';
import { saveProject } from '@/lib/store';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createTier1ReviewFixture } from '@/lib/t1-fixtures';
import { normalizeProject } from '@/lib/project-data';
import { getSetting, saveSetting } from '@/lib/store';
import { tier1Enabled } from '@/lib/t1-gates';
import { T1FramingFixture } from '@/components/review/t1-framing-fixture';
import { T1WrapReport } from '@/components/review/t1-wrap-report';
import { T1CaptionEditor } from '@/components/review/t1-caption-editor';
import { Tier1TakeReview } from '@/components/review/t1-take-review';

export default function Tier1ReviewFixtures() {
  const [storageMessage, setStorageMessage] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [project, setProject] = useState(createTier1ReviewFixture);
  const [saved, setSaved] = useState(() => JSON.stringify(project));
  if (!__DEV__) return <SafeAreaView><Text>Development fixtures unavailable.</Text></SafeAreaView>;
  return <SafeAreaView className="flex-1 bg-black"><ScrollView contentContainerStyle={{ padding: 20 }}>
    <Text className="text-white text-xl">Tier 1 review fixtures</Text>
    <Text className="text-amber-200 py-3">Invented provider results. No recorded media, human accuracy or hardware evidence. Only the dedicated test fixture is saved by the test controls.</Text>
    <Pressable accessibilityRole="button" className="py-3" onPress={() => setEnabled(v => !v)}><Text className="text-white">{enabled ? 'Disable Tier 1 test' : 'Enable Tier 1 test'}</Text></Pressable>
    {tier1Enabled('takeReview', __DEV__, enabled) && <View>
      <Pressable accessibilityRole="button" className="py-3" onPress={() => setProject(normalizeProject(JSON.parse(saved)))}><Text className="text-white">Reopen serialized fixture</Text></Pressable>
      {Platform.OS !== 'web' && <Pressable accessibilityRole="button" className="py-3" onPress={async () => {
        try {
          const asset = await Asset.fromModule(require('../../tools/fixtures/t1-portrait.mp4')).downloadAsync();
          if (!asset.localUri) throw new Error('Synthetic media download unavailable');
          const base = createTier1ReviewFixture();
          const id = `t1-video-fixture-${Date.now()}`;
          const next = { ...base, id, duration: 12, videoUri: asset.localUri, mediaMissing: false,
            tier1Evidence: { ...base.tier1Evidence!, projectId: id } };
          await saveProject(next);
          router.push({ pathname: '/editor', params: { projectId: id } });
        } catch (e) { setStorageMessage(`Video fixture failed: ${String(e)}`); }
      }}><Text className="text-white">Create synthetic video project</Text></Pressable>}
      {Platform.OS !== 'web' && <View>
        <Pressable accessibilityRole="button" className="py-3" onPress={async () => {
          try { await saveSetting('t1-session-3-fixture', JSON.stringify(project)); setStorageMessage('Fixture saved to SQLite.'); }
          catch (e) { setStorageMessage(`Save failed: ${String(e)}`); }
        }}><Text className="text-white">Save fixture to SQLite</Text></Pressable>
        <Pressable accessibilityRole="button" className="py-3" onPress={async () => {
          try { const value = await getSetting('t1-session-3-fixture'); if (!value) throw new Error('No saved fixture'); setProject(normalizeProject(JSON.parse(value))); setStorageMessage('Fixture reopened from SQLite.'); }
          catch (e) { setStorageMessage(`Reopen failed: ${String(e)}`); }
        }}><Text className="text-white">Reopen SQLite fixture</Text></Pressable>
        <Text className="text-neutral-300">{storageMessage}</Text>
      </View>}
      <T1CaptionEditor project={project} enabled onChange={async next => { setProject(next); setSaved(JSON.stringify(next)); }} />
      <T1WrapReport project={project} enabled onConfirmAction={(id, confirmed) => {
        const next = { ...project, scriptLines: project.scriptLines?.map(line => ({ ...line, actionCues: line.actionCues.map(cue => cue.id === id ? { ...cue, resolved: confirmed } : cue) })) };
        setProject(next); setSaved(JSON.stringify(next));
      }} onChange={async next => { setProject(next); setSaved(JSON.stringify(next)); }} />
      <T1FramingFixture />
      <Tier1TakeReview project={project} onChange={async next => { setProject(next); setSaved(JSON.stringify(next)); }} onPreview={() => {}} />
    </View>}
  </ScrollView></SafeAreaView>;
}

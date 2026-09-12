import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { acceptDraft, getDraft, saveDraft } from '@/lib/store';

export default function ScriptInput() {
  const [script, setScript] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const words = useMemo(
    () => script.trim().split(/\s+/).filter(Boolean).length,
    [script]
  );

  useEffect(() => {
    let cancelled = false;
    getDraft()
      .then(draft => { if (!cancelled && draft) setScript(draft); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveDraft(script).catch(() => setSaveError('Could not save draft.'));
    }, 400);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [script, loaded]);

  async function paste() {
    const s = await Clipboard.getStringAsync();
    if (s) setScript((prev) => (prev ? `${prev}\n${s}` : s));
  }

  async function cont() {
    if (!script.trim() || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const accepted = await acceptDraft(script);
      router.push({ pathname: '/camera', params: { mode: 'script', script: accepted } });
    } catch {
      setSaveError('Could not save script. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-black">
      <View className="flex-1 px-5 pt-4 pb-5 max-w-[480px] w-full self-center">
        <Text className="text-white text-lg font-bold">Script</Text>
        <Text className="text-neutral-500 text-[11px] mt-0.5">{words} words</Text>

        <TextInput
          value={script}
          onChangeText={setScript}
          multiline
          placeholder="Enter or paste your script…"
          placeholderTextColor="#525252"
          textAlignVertical="top"
          className="flex-1 bg-neutral-900 border border-neutral-800 text-white text-sm p-4 mt-3 min-h-[180px]"
        />

        {!!saveError && <Text className="text-red-300 text-xs mt-2">{saveError}</Text>}

        <View className="flex-row gap-3 mt-3">
          <Pressable onPress={paste} className="flex-1 bg-neutral-900 border border-neutral-800 py-4 active:opacity-70">
            <Text className="text-neutral-200 text-sm font-semibold text-center">
              Paste from Clipboard
            </Text>
          </Pressable>
          <Pressable
            disabled={!script.trim() || saving}
            onPress={cont}
            className="flex-1 bg-white py-4 active:opacity-80 disabled:opacity-30">
            <Text className="text-black text-sm font-bold text-center">Continue</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ScriptInput() {
  const [script, setScript] = useState('');
  const words = useMemo(
    () => script.trim().split(/\s+/).filter(Boolean).length,
    [script]
  );

  async function paste() {
    const s = await Clipboard.getStringAsync();
    if (s) setScript((prev) => (prev ? `${prev}\n${s}` : s));
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
          className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl text-white text-sm p-3 mt-3 min-h-[180px]"
        />

        <View className="flex-row gap-2 mt-3">
          <Pressable onPress={paste} className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl py-3 active:opacity-70">
            <Text className="text-neutral-200 text-xs font-semibold text-center">
              Paste from Clipboard
            </Text>
          </Pressable>
          <Pressable
            disabled={!script.trim()}
            onPress={() =>
              router.push({ pathname: '/camera', params: { mode: 'script', script } })
            }
            className="flex-1 bg-white rounded-xl py-3 active:opacity-80 disabled:opacity-30">
            <Text className="text-black text-xs font-bold text-center">Continue</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

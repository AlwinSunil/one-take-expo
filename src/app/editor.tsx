import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface ClipRow {
  id: string;
  label: string;
  keep: boolean;
}

const seed: ClipRow[] = [
  { id: '1', label: 'Intro · 0:00–0:08', keep: true },
  { id: '2', label: 'Retake · 0:08–0:14', keep: false },
  { id: '3', label: 'Main · 0:14–0:42', keep: true },
];

export default function Editor() {
  const { duration, quality } = useLocalSearchParams<{ duration?: string; quality?: string }>();
  const [clips, setClips] = useState(seed);
  const [past, setPast] = useState<ClipRow[][]>([]);
  const [future, setFuture] = useState<ClipRow[][]>([]);

  function commit(next: ClipRow[]) {
    setPast((p) => [...p, clips]);
    setClips(next);
    setFuture([]);
  }

  return (
    <SafeAreaView className="flex-1 bg-black">
      <View className="flex-1 px-5 pt-4 pb-5 max-w-[480px] w-full self-center">
        <Text className="text-white text-lg font-bold">Editor</Text>
        <Text className="text-neutral-500 text-[11px] mt-0.5">
          {duration ? `${duration}s recorded · ` : ''}{quality ? `${quality} · ` : ''}grey = suggested removal
        </Text>

        <ScrollView className="mt-3 gap-2">
          {clips.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => commit(clips.map((x) => (x.id === c.id ? { ...x, keep: !x.keep } : x)))}
              className={`rounded-xl px-3 py-2.5 border ${c.keep ? 'bg-neutral-900 border-neutral-800' : 'bg-neutral-950 border-neutral-900 opacity-50'}`}>
              <Text className={`text-xs font-semibold ${c.keep ? 'text-white' : 'text-neutral-500 line-through'}`}>
                {c.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        <View className="flex-row gap-2 mt-3">
          {['Trim', 'Split', 'Delete'].map((a) => (
            <Pressable key={a} className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl py-2.5">
              <Text className="text-neutral-200 text-[11px] font-semibold text-center">{a}</Text>
            </Pressable>
          ))}
        </View>
        <View className="flex-row gap-2 mt-2">
          <Pressable
            disabled={!past.length}
            onPress={() => {
              const p = [...past];
              const prev = p.pop()!;
              setFuture((f) => [clips, ...f]);
              setClips(prev);
              setPast(p);
            }}
            className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl py-2.5 disabled:opacity-30">
            <Text className="text-neutral-200 text-[11px] font-semibold text-center">Undo</Text>
          </Pressable>
          <Pressable
            disabled={!future.length}
            onPress={() => {
              const [next, ...rest] = future;
              setPast((p) => [...p, clips]);
              setClips(next);
              setFuture(rest);
            }}
            className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl py-2.5 disabled:opacity-30">
            <Text className="text-neutral-200 text-[11px] font-semibold text-center">Redo</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/projects')}
            className="flex-1 bg-white rounded-xl py-2.5">
            <Text className="text-black text-[11px] font-bold text-center">Export</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

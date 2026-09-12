import { useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { listProjects } from '@/lib/store';
import type { Project } from '@/lib/session';

export default function Projects() {
  const [items, setItems] = useState<Project[]>([]);

  useEffect(() => {
    listProjects().then(setItems).catch(() => setItems([]));
  }, []);

  return (
    <SafeAreaView className="flex-1 bg-black">
      <View className="flex-1 px-5 pt-4 pb-5 max-w-[480px] w-full self-center">
        <Text className="text-white text-lg font-bold">Projects</Text>
        <Text className="text-neutral-500 text-[11px] mt-0.5">Originals always preserved</Text>
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ gap: 8, marginTop: 12 }}
          ListEmptyComponent={
            <Text className="text-neutral-600 text-xs mt-6 text-center">No projects yet</Text>
          }
          renderItem={({ item }) => (
            <View className="bg-neutral-900 border border-neutral-800 px-4 py-3.5">
              <Text className="text-white text-sm font-semibold">
                {item.mode === 'script' ? 'Script' : 'Assisted'} · {item.clips.length} clips
              </Text>
              <Text className="text-neutral-500 text-xs mt-0.5">
                {new Date(item.createdAt).toLocaleString()}
              </Text>
            </View>
          )}
        />
      </View>
    </SafeAreaView>
  );
}

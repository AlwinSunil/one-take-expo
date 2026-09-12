import { useCallback, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { listProjects } from '@/lib/store';
import type { Project } from '@/lib/session';

export default function Projects() {
  const [items, setItems] = useState<Project[]>([]);
  const [error, setError] = useState('');

  useFocusEffect(useCallback(() => {
    let active = true;
    setError('');
    listProjects().then(rows => { if (active) setItems(rows); })
      .catch(e => { if (active) setError(`Could not load projects: ${e.message}`); });
    return () => { active = false; };
  }, []));

  return (
    <SafeAreaView className="flex-1 bg-black">
      <View className="flex-1 px-5 pt-4 pb-5 max-w-[480px] w-full self-center">
        <Text className="text-white text-lg font-bold">Projects</Text>
        <Text className="text-neutral-500 text-[11px] mt-0.5">Originals always preserved</Text>
        {!!error && <Text accessibilityRole="alert" className="text-red-300 mt-3">{error}</Text>}
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ gap: 8, marginTop: 12 }}
          ListEmptyComponent={
            <Text className="text-neutral-600 text-xs mt-6 text-center">No projects yet</Text>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/editor', params: { projectId: item.id } })}
              className="bg-neutral-900 border border-neutral-800 px-4 py-3.5 active:opacity-70">
              <Text className="text-white text-sm font-semibold">
                {item.mode === 'script' ? 'Script' : 'Assisted'} · {item.transcript.length} caption segments
              </Text>
              {!!item.recoveryMessage && <Text className="text-amber-200 text-xs mt-2">{item.recoveryMessage}</Text>}
              <Text className="text-neutral-300 text-xs mt-2">{item.mediaMissing ? 'Review saved text' : 'Review recording'}</Text>
              <Text className="text-neutral-500 text-xs mt-0.5">
                {new Date(item.createdAt).toLocaleString()}
              </Text>
            </Pressable>
          )}
        />
      </View>
    </SafeAreaView>
  );
}

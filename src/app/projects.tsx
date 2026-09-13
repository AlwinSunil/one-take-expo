import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { deleteProject, listProjects } from '@/lib/store';
import type { Project } from '@/lib/session';
import { cleanReview } from '@/lib/clean-review';
import { ProjectThumbnail } from '@/components/ui/project-thumbnail';

export default function Projects() {
  const [items, setItems] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const performDelete = async (item: Project, deleteGallery: boolean) => {
    setDeleting(item.id);
    try { await deleteProject(item.id, { deleteGallery }); setItems(rows => rows.filter(row => row.id !== item.id)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Deletion could not finish. Please retry.'); }
    finally { setDeleting(null); }
  };
  const confirmDelete = (item: Project) => Alert.alert('Delete this project?',
    'Remove its recordings, saved text, edits and app exports. You can also remove gallery copies made by One Take. Copies shared elsewhere remain.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Keep gallery copies', style: 'destructive', onPress: () => { void performDelete(item, false); } },
      { text: 'Delete gallery copies too', style: 'destructive', onPress: () => { void performDelete(item, true); } },
    ]);


  useFocusEffect(useCallback(() => {
    let active = true;
    setError('');
    setLoading(true);
    listProjects().then(rows => { if (active) setItems(rows); })
      .catch(() => { if (active) setError('Your projects could not be loaded. Retry to open your saved recordings.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]));

  return (
    <SafeAreaView className="flex-1 bg-black">
      <View className="flex-1 px-5 pt-4 pb-5 max-w-[600px] w-full self-center">
        <Text accessibilityRole="header" className="text-white text-3xl font-bold">Projects</Text>
        <Text className="text-neutral-400 text-sm mt-1">Recordings, coverage and saved edits</Text>
        {!!error && <Text accessibilityRole="alert" className="text-red-300 mt-3">{error}</Text>}
        {!!error && <Pressable accessibilityRole="button" onPress={() => setRefresh(value => value + 1)}><Text className="text-white py-3">Retry loading</Text></Pressable>}
        <FlatList
          data={items}
          numColumns={2}
          keyExtractor={(i) => i.id}
          columnWrapperStyle={{ gap: 12 }}
          contentContainerStyle={{ gap: 12, marginTop: 12, paddingBottom: 24 }}
          ListEmptyComponent={
            <Text className="text-neutral-600 text-xs mt-6 text-center">{loading ? 'Loading your projects…' : error ? 'Your saved projects have not been changed.' : 'No projects yet. Record your first take to get started.'}</Text>
          }
          renderItem={({ item }) => {
            const review = item.mode === 'script' ? cleanReview(item) : undefined;
            const counts = review?.lines.reduce((result, line) => {
              result[line.status] += 1;
              return result;
            }, { covered: 0, needed: 0, pending: 0 });
            const title = item.script?.trim().split('\n').find(line => line.trim())
              || (item.mode === 'script' ? 'Script project' : 'Free recording');
            const subtitle = review && counts
              ? `${counts.covered} covered · ${counts.needed} needed`
              : `${item.transcript.length} captions`;

            return <View style={{ flex: 1 }} className="bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open project from ${new Date(item.createdAt).toLocaleDateString()}`}
                onPress={() => router.push({ pathname: '/editor', params: { projectId: item.id } })}
                className="active:opacity-70">
                <ProjectThumbnail uri={item.mediaMissing ? null : item.videoUri} />
                <View className="px-3 pt-2.5 pb-1">
                  <Text numberOfLines={1} className="text-white text-sm font-semibold">{title}</Text>
                  <Text numberOfLines={1} className="text-neutral-400 text-xs mt-1">{subtitle}</Text>
                  <Text className="text-neutral-500 text-[11px] mt-1">
                    {new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </Text>
                </View>
              </Pressable>
              <View className="flex-row items-center justify-between px-3 pb-2">
                <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/editor', params: { projectId: item.id } })}>
                  <Text className="text-neutral-200 text-xs py-2">{item.mediaMissing ? 'Review text' : 'Review'}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Delete project" disabled={deleting !== null} onPress={() => confirmDelete(item)}>
                  <Text className="text-red-300 text-xs py-2 px-1">{deleting === item.id ? 'Deleting…' : 'Delete'}</Text>
                </Pressable>
              </View>
            </View>;
          }}
        />
      </View>
    </SafeAreaView>
  );
}

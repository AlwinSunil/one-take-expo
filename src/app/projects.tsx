import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { deleteProject, listProjects } from '@/lib/store';
import type { Project } from '@/lib/session';
import { cleanReview } from '@/lib/clean-review';

export default function Projects() {
  const [items, setItems] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const confirmDelete = (item: Project) => Alert.alert('Delete this project?', 'Remove this recording, saved text, edits and app-owned exports. Copies saved to your gallery or shared elsewhere remain.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete project', style: 'destructive', onPress: async () => {
      setDeleting(item.id);
      try { await deleteProject(item.id); setItems(rows => rows.filter(row => row.id !== item.id)); }
      catch (e) { setError(e instanceof Error ? e.message : 'Deletion could not finish. Please retry.'); }
      finally { setDeleting(null); }
    } },
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
      <View className="flex-1 px-5 pt-4 pb-5 max-w-[480px] w-full self-center">
        <Text className="text-white text-lg font-bold">Projects</Text>
        <Text className="text-neutral-500 text-[11px] mt-0.5">Recordings, coverage and saved edits</Text>
        {!!error && <Text accessibilityRole="alert" className="text-red-300 mt-3">{error}</Text>}
        {!!error && <Pressable accessibilityRole="button" onPress={() => setRefresh(value => value + 1)}><Text className="text-white py-3">Retry loading</Text></Pressable>}
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ gap: 8, marginTop: 12 }}
          ListEmptyComponent={
            <Text className="text-neutral-600 text-xs mt-6 text-center">{loading ? 'Loading your projects…' : error ? 'Your saved projects have not been changed.' : 'No projects yet. Record your first take to get started.'}</Text>
          }
          renderItem={({ item }) => {
            const review = item.mode === 'script' ? cleanReview(item) : undefined;
            const counts = review?.lines.reduce((result, line) => {
              result[line.status] += 1;
              return result;
            }, { covered: 0, needed: 0, pending: 0 });
            const nextAction = review
              ? review.lines.length === 0
                ? 'Next: add a script to track coverage.'
                : counts?.needed
                  ? `Next: review ${counts.needed} needed ${counts.needed === 1 ? 'line' : 'lines'}.`
                  : counts?.pending
                    ? `Next: resolve ${counts.pending} pending ${counts.pending === 1 ? 'line' : 'lines'} before export.`
                    : review.unresolvedRequiredActionCueIds.length
                      ? `Next: confirm ${review.unresolvedRequiredActionCueIds.length} required ${review.unresolvedRequiredActionCueIds.length === 1 ? 'action' : 'actions'} before export.`
                      : 'Next: review every covered line and take before export.'
              : undefined;

            return <Pressable
              onPress={() => router.push({ pathname: '/editor', params: { projectId: item.id } })}
              className="bg-neutral-900 border border-neutral-800 px-4 py-3.5 active:opacity-70">
              <Text className="text-white text-sm font-semibold">
                {review && counts
                  ? `Script · ${counts.covered} covered · ${counts.needed} needed · ${counts.pending} pending`
                  : `Assisted · ${item.transcript.length} caption segments`}
              </Text>
              {!!item.recoveryMessage && <Text className="text-amber-200 text-xs mt-2">{item.recoveryMessage}</Text>}
              {!!nextAction && <Text className="text-neutral-300 text-xs mt-2">{nextAction}</Text>}
              <Text className="text-neutral-300 text-xs mt-2">{item.mediaMissing ? 'Review saved text' : 'Review recording'}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Delete project" disabled={deleting !== null} onPress={event => { event.stopPropagation(); confirmDelete(item); }}>
                <Text className="text-red-300 text-xs py-3">{deleting === item.id ? 'Deleting…' : 'Delete project'}</Text>
              </Pressable>
              <Text className="text-neutral-500 text-xs mt-0.5">
                {new Date(item.createdAt).toLocaleString()}
              </Text>
            </Pressable>;
          }}
        />
      </View>
    </SafeAreaView>
  );
}

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { Project } from '@/lib/session';
import { projectPointChecks } from '@/features/capture/script-point-checks';

export function ImportantPointsReview({ project, compact = false }: { project: Project; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const checks = useMemo(() => projectPointChecks(project), [project]);
  if (project.mode !== 'script' || !checks.length) return null;
  const remaining = checks.filter(point => point.status !== 'covered');
  if (compact) {
    if (!remaining.length) return null;
    return <View className="mb-2">
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} className="py-3 flex-row items-center justify-between">
        <Text accessibilityLiveRegion="polite" className="text-amber-200 text-xs">{remaining.length} important {remaining.length === 1 ? 'point to check' : 'points to check'}</Text>
        <Text className="text-neutral-400 text-xs">{expanded ? 'Hide' : 'Review'}</Text>
      </Pressable>
      {expanded && <ScrollView style={{ maxHeight: 120 }} nestedScrollEnabled>
        {remaining.map(point => <Text key={point.id} className="text-neutral-300 text-sm pb-2">{point.text}</Text>)}
        <Text className="text-neutral-500 text-xs pb-2">Not confirmed in kept footage. Recognition can miss paraphrases.</Text>
      </ScrollView>}
    </View>;
  }
  return <View className="rounded-xl bg-neutral-900 p-4 mb-4">
    <Text accessibilityLiveRegion="polite" className={remaining.length ? 'text-amber-200 text-sm font-semibold' : 'text-neutral-200 text-sm font-semibold'}>
      {remaining.length ? `${remaining.length} important ${remaining.length === 1 ? 'point needs' : 'points need'} checking` : 'All important points heard'}
    </Text>
    {remaining.map(point => <View key={point.id} className="mt-3">
      <Text className="text-neutral-200 text-sm">{point.text}</Text>
      <Text className="text-neutral-500 text-xs mt-1">{point.status === 'unavailable' ? 'Speech analysis unavailable' : point.status === 'partial' ? 'Not fully confirmed in the kept footage' : 'Not confirmed in the kept footage'}</Text>
    </View>)}
    <Text className="text-neutral-500 text-xs mt-3">On-device script checks. Review paraphrases and recognition errors.</Text>
  </View>;
}

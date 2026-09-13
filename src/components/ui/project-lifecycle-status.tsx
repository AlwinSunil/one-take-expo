import { Pressable, Text, View } from 'react-native';
import type { ProjectLifecycle } from '@/lib/t15-lifecycle';

const labels = { saving: 'Saving', analyzing: 'Analyzing', ready: 'Ready', partial: 'Partially ready', failed: 'Analysis failed', cancelled: 'Analysis cancelled' };

/** Controlled by the capture/editor owner. Does not start models, navigate, or delete sources. */
export function ProjectLifecycleStatus({ state, onOpenEditor, onRetry, retrying = false }: {
  state: ProjectLifecycle;
  onOpenEditor: () => void;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return <View className="rounded-xl border border-neutral-700 bg-neutral-900 p-3" accessibilityLiveRegion="polite">
    <Text className="text-white text-sm font-semibold">{labels[state.phase]}</Text>
    <Text className="mt-1 text-neutral-300 text-sm">{state.message}</Text>
    <View className="mt-2 flex-row flex-wrap gap-2">
      {state.canOpenEditor && <Pressable accessibilityRole="button" onPress={onOpenEditor} className="min-h-12 justify-center px-3 rounded-lg bg-neutral-800">
        <Text className="text-white text-sm">Open editor</Text>
      </Pressable>}
      {state.retryJob && onRetry && <Pressable accessibilityRole="button" accessibilityState={{ disabled: retrying }} disabled={retrying} onPress={onRetry} className="min-h-12 justify-center px-3 rounded-lg bg-neutral-800">
        <Text className="text-white text-sm">{retrying ? 'Queuing retry…' : 'Retry'}</Text>
      </Pressable>}
    </View>
  </View>;
}

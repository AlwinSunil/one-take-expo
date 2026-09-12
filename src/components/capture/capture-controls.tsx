import { Pressable, Text, View } from 'react-native';

import type { CaptureCommand } from '@/features/capture/capture-controls';

/**
 * The same two commands are available to a creator holding the phone. The
 * native key adapter calls these callbacks too, so the route has one command
 * path and one boundary/deduplication policy.
 */
export function CaptureControls({
  active,
  onCommand,
}: {
  active: boolean;
  onCommand: (command: CaptureCommand) => void;
}) {
  return <View className="flex-row gap-2 justify-center">
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Advance capture line"
      accessibilityState={{ disabled: !active }}
      disabled={!active}
      onPress={() => onCommand('advance')}
      className="min-h-12 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 active:opacity-70 disabled:opacity-35">
      <Text className="text-neutral-100 text-xs font-semibold">Advance</Text>
    </Pressable>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Scratch current take"
      accessibilityState={{ disabled: !active }}
      disabled={!active}
      onPress={() => onCommand('scratch')}
      className="min-h-12 rounded-lg border border-amber-700 bg-amber-950/60 px-4 py-3 active:opacity-70 disabled:opacity-35">
      <Text className="text-amber-100 text-xs font-semibold">Scratch take</Text>
    </Pressable>
  </View>;
}

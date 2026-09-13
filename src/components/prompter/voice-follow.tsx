import { Pressable, Text, View } from 'react-native';

import type { AlignmentStatus } from '@/features/speech-analysis/alignment';

export interface VoiceFollowToggleProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  status?: AlignmentStatus;
  disabled?: boolean;
  /** The shared release gate keeps this capability development-only until T1.5 passes. */
  featureEnabled?: boolean;
}

function statusLabel(enabled: boolean, status: AlignmentStatus | undefined): string {
  if (!enabled) return 'Voice follow off';
  if (status === 'unavailable') return 'Voice follow unavailable';
  if (status === 'pending' || status === 'partial') return 'Voice follow listening';
  if (status === 'paused') return 'Voice follow paused';
  if (status === 'stopped') return 'Voice follow stopped';
  if (status === 'unknown') return 'Waiting for speech';
  return 'Voice follow on';
}

function statusHint(enabled: boolean, status: AlignmentStatus | undefined): string {
  if (!enabled) return 'Use Previous or Next to move through the script.';
  if (status === 'unavailable') return 'Recognition is unavailable. Manual navigation remains available.';
  if (status === 'pending' || status === 'partial') return 'Waiting for a final supported line match.';
  if (status === 'paused') return 'The last speech was ambiguous. Use manual navigation to continue.';
  if (status === 'stopped') return 'Following is stopped for this recording.';
  if (status === 'unknown') return 'No supported speech yet; manual navigation remains available.';
  return 'Final supported speech advances the current line. It does not mark coverage.';
}

/**
 * Props-only voice-follow control for the camera owner.
 *
 * The component does not own recognition, cursor state, coverage or actions.
 * The default gate keeps the new control out of release builds until the
 * integrated T1.5 acceptance gate passes. Session 2 passes the shared gate.
 */
export function VoiceFollowToggle({
  enabled,
  onEnabledChange,
  status,
  disabled = false,
  featureEnabled = false,
}: VoiceFollowToggleProps) {
  if (!featureEnabled) return null;
  const label = statusLabel(enabled, status);
  return <View className="rounded-xl border border-neutral-700 bg-black/80 px-3 py-2">
    <View className="flex-row items-center justify-between">
      <View className="flex-1 mr-3">
        <Text accessibilityRole="text" className="text-white text-sm font-semibold">{label}</Text>
        <Text className="text-neutral-400 text-xs mt-0.5">{statusHint(enabled, status)}</Text>
      </View>
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel="Voice follow"
        accessibilityHint="Automatically advance the script after final supported speech"
        accessibilityState={{ checked: enabled, disabled }}
        disabled={disabled}
        onPress={() => onEnabledChange(!enabled)}
        className={`min-h-[44px] min-w-[72px] items-center justify-center rounded-lg px-3 ${enabled ? 'bg-white' : 'border border-neutral-500 bg-neutral-900'} ${disabled ? 'opacity-50' : 'active:opacity-75'}`}>
        <Text className={enabled ? 'text-black text-sm font-semibold' : 'text-white text-sm font-semibold'}>
          {enabled ? 'On' : 'Off'}
        </Text>
      </Pressable>
    </View>
  </View>;
}

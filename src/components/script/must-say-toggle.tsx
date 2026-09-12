import { Pressable, Text, View } from 'react-native';

import {
  mustSayToggleLabel,
  type MustSayStatus,
} from '@/features/speech-control/must-say';

export type MustSayToggleProps = {
  /** Stable script-line id, used by the parent when applying the toggle. */
  lineId: string;
  /** Tier 1 gate.  The control is absent until the owning lane enables it. */
  featureEnabled?: boolean;
  enabled: boolean;
  /** Optional derived review state; the toggle itself remains controlled. */
  status?: MustSayStatus;
  disabled?: boolean;
  onChange?: (lineId: string, enabled: boolean) => void;
};

/**
 * Props-only must-say control for the script editor and capture/review rows.
 * It does not read or write draft/project storage and it never infers speech
 * coverage from a press, a caption edit, or a completed recording.
 */
export function MustSayToggle({
  lineId,
  featureEnabled = false,
  enabled,
  status = enabled ? 'needed' : 'off',
  disabled = false,
  onChange,
}: MustSayToggleProps) {
  if (!featureEnabled) return null;
  const label = mustSayToggleLabel(enabled, status);
  const actionLabel = enabled ? 'Turn off must-say' : 'Require exact wording';
  return (
    <View className="mt-2">
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={`${actionLabel} for script line`}
        accessibilityState={{ checked: enabled, disabled }}
        disabled={disabled}
        onPress={() => onChange?.(lineId, !enabled)}
        style={{ minHeight: 44 }}
        className="self-start flex-row items-center rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 active:opacity-70 disabled:opacity-40">
        <Text className={enabled ? 'text-amber-200 text-xs font-semibold' : 'text-neutral-300 text-xs'}>
          {enabled ? 'Must-say' : 'Exact wording off'}
        </Text>
        <Text className="text-neutral-500 text-[11px] ml-2">
          {enabled ? 'Required' : 'Tap to require exact wording'}
        </Text>
      </Pressable>
      {enabled && (
        <Text accessibilityLiveRegion="polite" className={`text-[11px] mt-1 ${status === 'covered' ? 'text-emerald-300' : status === 'unavailable' ? 'text-red-300' : 'text-amber-200'}`}>
          {label}
        </Text>
      )}
    </View>
  );
}

export default MustSayToggle;

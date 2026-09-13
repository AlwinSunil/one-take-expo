import { Switch, Text, View } from 'react-native';

export interface CaptionSettingsProps {
  showInEditor: boolean;
  burnIntoExport: boolean;
  onShowInEditorChange: (show: boolean) => void;
  onBurnIntoExportChange: (burn: boolean) => void;
  disabled?: boolean;
}

/**
 * Props-only caption display choices for the editor and export controls.
 *
 * The two switches intentionally have separate values and callbacks. This
 * component does not read or write project preferences or caption content.
 */
export function CaptionSettings({
  showInEditor,
  burnIntoExport,
  onShowInEditorChange,
  onBurnIntoExportChange,
  disabled = false,
}: CaptionSettingsProps) {
  return (
    <View className="border-t border-neutral-800 mt-3 pt-3">
      <Text className="text-white text-base font-semibold">Caption settings</Text>
      <Text className="text-neutral-400 text-xs leading-5 mt-1 mb-2">
        These choices are independent. Hiding captions in the editor keeps the transcript and corrections; burn-in only changes the exported copy.
      </Text>
      <CaptionSettingRow
        label="Show captions in editor"
        value={showInEditor}
        onValueChange={onShowInEditorChange}
        disabled={disabled}
      />
      <CaptionSettingRow
        label="Burn captions into export"
        value={burnIntoExport}
        onValueChange={onBurnIntoExportChange}
        disabled={disabled}
      />
    </View>
  );
}

function CaptionSettingRow({
  label,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <View className="flex-row items-center gap-3 py-2">
      <Text className="flex-1 text-neutral-100 text-sm leading-6">{label}</Text>
      <Switch
        accessibilityLabel={label}
        accessibilityRole="switch"
        accessibilityState={{ checked: value, disabled }}
        disabled={disabled}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: '#404040', true: '#fcd34d' }}
        thumbColor="#ffffff"
      />
    </View>
  );
}

export default CaptionSettings;

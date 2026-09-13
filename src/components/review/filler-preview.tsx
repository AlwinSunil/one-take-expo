import { Pressable, Text, View, Modal } from 'react-native';

export type FillerPreviewStatus = 'ready' | 'playing' | 'completed' | 'error';

export interface FillerPreviewProps {
  visible: boolean;
  label: string;
  start: number;
  end: number;
  min: number;
  max: number;
  status: FillerPreviewStatus;
  error?: string;
  onPreview: () => void;
  onAdjustStart: (delta: number) => void;
  onAdjustEnd: (delta: number) => void;
  onDelete: () => void;
  onClose: () => void;
}

const seconds = (value: number) => `${Math.max(0, value).toFixed(2)}s`;

function BoundaryControl({
  label,
  value,
  canDecrease,
  canIncrease,
  onDecrease,
  onIncrease,
}: {
  label: string;
  value: number;
  canDecrease: boolean;
  canIncrease: boolean;
  onDecrease: () => void;
  onIncrease: () => void;
}) {
  return <View style={{ marginTop: 10 }}>
    <Text style={{ color: '#a3a3a3', fontSize: 12 }}>{label} · {seconds(value)}</Text>
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 5 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Move filler ${label.toLowerCase()} earlier`} disabled={!canDecrease}
        onPress={onDecrease} style={{ minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#262626', opacity: canDecrease ? 1 : 0.4 }}>
        <Text style={{ color: 'white', fontSize: 20 }}>−</Text>
      </Pressable>
      <Text accessibilityLabel={`${label} ${seconds(value)}`} style={{ color: 'white', fontSize: 14, flex: 1, textAlign: 'center' }}>{seconds(value)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Move filler ${label.toLowerCase()} later`} disabled={!canIncrease}
        onPress={onIncrease} style={{ minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#262626', opacity: canIncrease ? 1 : 0.4 }}>
        <Text style={{ color: 'white', fontSize: 20 }}>+</Text>
      </Pressable>
    </View>
  </View>;
}

export function FillerPreview({
  visible,
  label,
  start,
  end,
  min,
  max,
  status,
  error,
  onPreview,
  onAdjustStart,
  onAdjustEnd,
  onDelete,
  onClose,
}: FillerPreviewProps) {
  if (!visible) return null;
  const step = 0.1;
  const canMoveStartEarlier = start - step >= min;
  const canMoveStartLater = start + step < end;
  const canMoveEndEarlier = end - step > start;
  const canMoveEndLater = end + step <= max;
  const statusText = status === 'playing'
    ? 'Playing this filler range…'
    : status === 'completed'
      ? 'Preview complete. You can remove this range.'
      : status === 'error'
        ? error ?? 'Preview failed. Try again.'
        : 'Listen to the range before removing it.';

  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: '#0005', justifyContent: 'flex-end' }}>
      <View style={{ backgroundColor: '#171717', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, paddingBottom: 28 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={{ color: 'white', fontSize: 18, fontWeight: '600' }}>Filler: “{label}”</Text>
            <Text style={{ color: '#a3a3a3', fontSize: 12, marginTop: 4 }}>Adjust the estimated range if needed.</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close filler preview" onPress={onClose} style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#d4d4d4', fontSize: 24 }}>×</Text>
          </Pressable>
        </View>
        <Text accessibilityLiveRegion="polite" style={{ color: status === 'error' ? '#fca5a5' : '#d4d4d4', fontSize: 13, marginTop: 14 }}>{statusText}</Text>
        <BoundaryControl label="Start" value={start} canDecrease={canMoveStartEarlier} canIncrease={canMoveStartLater}
          onDecrease={() => onAdjustStart(-step)} onIncrease={() => onAdjustStart(step)} />
        <BoundaryControl label="End" value={end} canDecrease={canMoveEndEarlier} canIncrease={canMoveEndLater}
          onDecrease={() => onAdjustEnd(-step)} onIncrease={() => onAdjustEnd(step)} />
        <Pressable accessibilityRole="button" accessibilityLabel={status === 'completed' ? 'Preview filler again' : 'Preview filler'} disabled={status === 'playing'} onPress={onPreview}
          style={{ alignItems: 'center', justifyContent: 'center', minHeight: 50, marginTop: 16, borderRadius: 10, backgroundColor: '#262626', opacity: status === 'playing' ? 0.45 : 1 }}>
          <Text style={{ color: 'white', fontWeight: '600' }}>{status === 'playing' ? 'Playing…' : status === 'completed' ? 'Preview again' : 'Preview filler'}</Text>
        </Pressable>
        {status === 'completed' && <Pressable accessibilityRole="button" accessibilityLabel={`Delete filler ${label}`} onPress={onDelete}
          style={{ alignItems: 'center', justifyContent: 'center', minHeight: 50, marginTop: 10, borderRadius: 10, backgroundColor: '#b91c1c' }}>
          <Text style={{ color: 'white', fontWeight: '700' }}>Delete filler</Text>
        </Pressable>}
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel filler preview" onPress={onClose} style={{ alignItems: 'center', justifyContent: 'center', minHeight: 44, marginTop: 6 }}>
          <Text style={{ color: '#a3a3a3' }}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  </Modal>;
}

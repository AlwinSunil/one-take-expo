import { Pressable, ScrollView, Text, View } from 'react-native';
import type { TranscriptTimelineMark } from '@/lib/transcript-filler-timeline';

export function FillerBands({ marks, duration }: { marks: readonly TranscriptTimelineMark[]; duration: number }) {
  if (!(duration > 0)) return null;
  return <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>
    {marks.map(mark => <View key={mark.id} style={{ position: 'absolute', top: 0, bottom: 0,
      left: `${Math.min(100, mark.t0 / duration * 100)}%`, width: `${Math.max(0.4, (mark.t1 - mark.t0) / duration * 100)}%`,
      minWidth: 3, backgroundColor: '#ef4444b3', borderLeftWidth: 2, borderColor: '#f87171' }} />)}
  </View>;
}

export function TranscriptFillerMarkers({ marks, duration, showTrack, onSelect }: {
  marks: readonly TranscriptTimelineMark[];
  duration: number;
  showTrack: boolean;
  onSelect: (mark: TranscriptTimelineMark) => void;
}) {
  if (!marks.length) return null;
  return <View style={{ marginTop: 12 }}>
    <Text style={{ color: '#f87171', fontSize: 12 }}>Fillers in transcript · {marks.length}</Text>
    {showTrack && <View accessibilityLabel="Filler timeline" style={{ height: 20, marginTop: 8, borderRadius: 4, backgroundColor: '#262626', overflow: 'hidden' }}>
      <FillerBands marks={marks} duration={duration} />
    </View>}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
      {marks.map(mark => <Pressable key={mark.id} accessibilityRole="button"
        accessibilityLabel={`Filler ${mark.label}, approximately ${mark.t0.toFixed(1)} seconds. Preview source.`}
        onPress={() => onSelect(mark)} style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 12, marginRight: 8,
          justifyContent: 'center', borderRadius: 8, backgroundColor: '#450a0a' }}>
        <Text style={{ color: '#fca5a5', fontSize: 13 }}>{mark.label} · ~{mark.t0.toFixed(1)}s</Text>
      </Pressable>)}
    </ScrollView>
    <Text style={{ color: '#a3a3a3', fontSize: 11, marginTop: 4 }}>Tap a filler to review. Positions are estimated from transcript timing.</Text>
  </View>;
}

import { useMemo, useRef } from 'react';
import { Text, View } from 'react-native';
import { NativeCutPreview } from '../../../modules/one-take-media';
import { previewFromPosition, type PreviewSegment } from './playback';

/** Receives a frozen sequence and an explicit seek request. It never edits clips. */
export function TimelinePreview({ revision, segments, playing, seekPosition, seekToken, label, onPosition, onPause, onError }: {
  revision: number; segments: readonly PreviewSegment[]; playing: boolean; seekPosition: number; seekToken: number; label: string;
  onPosition: (position: number) => void; onPause: () => void; onError: (message: string, uris: string[]) => void;
}) {
  const active = useRef({ revision, segments, label });
  if (!playing) active.current = { revision, segments, label };
  const frozen = active.current;
  const waiting = frozen.revision !== revision || frozen.segments !== segments;
  const selected = useMemo(() => previewFromPosition(frozen.segments, seekPosition), [frozen.segments, seekPosition, seekToken]);
  const request = useMemo(() => JSON.stringify({ id: `timeline-preview:${frozen.revision}:${seekToken}`, sourceUri: selected.segments[0]?.uri,
    cuts: [], captions: [], segments: selected.segments.map(({ uri, t0, t1, captions, crop }) => ({ uri, t0, t1, captions: captions ?? [], crop })) }), [frozen.revision, seekToken, selected]);
  return <View style={{ minHeight: 200, height: 260, backgroundColor: '#0a0a0a', borderRadius: 16, overflow: 'hidden' }}>
    {selected.segments.length === 0 ? <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}><Text accessibilityLiveRegion="polite" style={{ color: '#d4d4d4', textAlign: 'center' }}>Empty preview · 0 seconds. Restore a clip to continue.</Text></View>
      : !NativeCutPreview ? <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}><Text style={{ color: '#d4d4d4' }}>Timeline preview needs the Android development build. Saved originals remain available in source review.</Text></View>
        : <NativeCutPreview key={`${frozen.revision}:${seekToken}`} style={{ flex: 1 }} request={request} playing={playing} seek={0} onState={event => {
          const state = event.nativeEvent;
          if (typeof state.position === 'number') onPosition(selected.offset + state.position);
          if (state.ended) onPause();
          if (state.error) { onPause(); onError(state.error, selected.segments.map(segment => segment.uri)); }
        }} />}
    <Text accessibilityLiveRegion="polite" style={{ color: '#fafafa', padding: 8, backgroundColor: '#171717' }}>{frozen.label}{waiting ? ' · updated sequence waits for pause' : ''}</Text>
  </View>;
}

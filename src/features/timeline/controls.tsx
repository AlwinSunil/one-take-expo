import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, Text, TextInput, View } from 'react-native';
import { ArrowDown, ArrowUp, Eye, RotateCcw, Scissors, Trash2 } from 'lucide-react-native';
import type { TimelineClip, TimelineReason, TimelineSnapshot } from './engine';

export type ClipAction =
  | { kind: 'trim'; clipId: string; t0: number; t1: number }
  | { kind: 'split'; clipId: string; at: number }
  | { kind: 'exclude' | 'restore'; clipId: string }
  | { kind: 'reorder'; clipId: string; index: number };

export function TimelineButton({ label, onPress, disabled = false, children }: {
  label: string; onPress: () => void; disabled?: boolean; children?: React.ReactNode;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={{ minHeight: 48, minWidth: 48, padding: 12, borderRadius: 12, backgroundColor: '#262626', flexDirection: 'row', alignItems: 'center', gap: 8, opacity: disabled ? 0.4 : 1 }}>
    {children}<Text style={{ color: '#fafafa', flexShrink: 1, fontSize: 14 }}>{label}</Text>
  </Pressable>;
}

/** A drag commits once on release. Screen readers can adjust by 0.1 source seconds. */
function BoundaryHandle({ label, value, min, max, width, onCommit, disabled }: {
  label: string; value: number; min: number; max: number; width: number; onCommit: (value: number) => void; disabled: boolean;
}) {
  const current = useRef({ value, min, max, width, onCommit, disabled });
  current.current = { value, min, max, width, onCommit, disabled };
  const origin = useRef(value);
  const [draft, setDraft] = useState<number | null>(null);
  const nextValue = (dx: number) => {
    const p = current.current;
    return Math.round(Math.max(p.min, Math.min(p.max, origin.current + dx / Math.max(1, p.width) * (p.max - p.min))) * 1000) / 1000;
  };
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !current.current.disabled,
    onMoveShouldSetPanResponder: () => !current.current.disabled,
    onPanResponderGrant: () => { origin.current = current.current.value; },
    onPanResponderMove: (_, gesture) => setDraft(nextValue(gesture.dx)),
    onPanResponderRelease: (_, gesture) => { setDraft(null); if (!current.current.disabled) current.current.onCommit(nextValue(gesture.dx)); },
    onPanResponderTerminate: () => setDraft(null),
  }), []);
  return <View {...responder.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel={label}
    accessibilityValue={{ min, max, now: value, text: `${value.toFixed(2)} seconds` }} accessibilityState={{ disabled }}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value.toFixed(2)} seconds`}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={event => { if (!disabled) onCommit(Math.round((value + (event.nativeEvent.actionName === 'increment' ? 0.1 : -0.1)) * 1000) / 1000); }}
    style={{ minHeight: 48, minWidth: 48, flex: 1, borderWidth: 1, borderColor: '#737373', borderRadius: 10, padding: 12 }}>
    <Text style={{ color: '#fafafa' }}>↔ {label} {(draft ?? value).toFixed(2)}s</Text>
  </View>;
}

function ClipRow({ clip, index, total, reasons, sourceDuration, unavailable, playhead, disabled, onAction, onPreview, onSeek }: {
  clip: TimelineClip; index: number; total: number; reasons: TimelineReason[]; sourceDuration: number | null;
  unavailable: boolean; playhead: { clipId: string; sourceTime: number } | null; disabled: boolean;
  onAction: (action: ClipAction) => void; onPreview: (clip: TimelineClip) => void; onSeek: (clip: TimelineClip, sourceTime: number) => void;
}) {
  const [start, setStart] = useState(String(clip.t0));
  const [end, setEnd] = useState(String(clip.t1));
  const [width, setWidth] = useState(240);
  useEffect(() => { setStart(String(clip.t0)); setEnd(String(clip.t1)); }, [clip.t0, clip.t1]);
  const splitAt = playhead?.clipId === clip.id ? playhead.sourceTime : null;
  const knownReasons = clip.reasonIds.map(id => reasons.find(reason => reason.id === id) ?? { id, text: `Reason ${id}`, actor: 'analysis' });
  return <View style={{ padding: 14, gap: 12, borderRadius: 14, backgroundColor: clip.included ? '#171717' : '#303030', borderWidth: 1, borderColor: playhead?.clipId === clip.id ? '#e5e5e5' : '#404040' }}>
    <Text style={{ color: clip.included ? '#fafafa' : '#d4d4d4', fontSize: 16, fontWeight: '600' }}>{index + 1}. {unavailable ? '⚠ Unavailable media' : clip.included ? 'Included clip' : '⊘ Excluded clip'}</Text>
    <Text selectable style={{ color: '#a3a3a3' }}>{clip.sourceId} · {clip.t0.toFixed(2)}–{clip.t1.toFixed(2)}s</Text>
    {!clip.included && <Text style={{ color: '#d4d4d4' }}>Source context only · no output time</Text>}
    {knownReasons.map(reason => <Text key={reason.id} style={{ color: '#d4d4d4' }}>{reason.actor === 'creator' ? 'Creator' : 'Suggestion'}: {reason.text}</Text>)}
    {unavailable && <Text accessibilityRole="alert" style={{ color: '#fcd34d' }}>Reopen to refresh media, choose another take, or exclude this row. Restore requires an available valid range.</Text>}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <TimelineButton label="Preview source" disabled={unavailable || disabled} onPress={() => onPreview(clip)}><Eye size={18} color="#d4d4d4" /></TimelineButton>
      <TimelineButton label={clip.included ? 'Delete / exclude' : 'Restore'} disabled={disabled || (!clip.included && unavailable)} onPress={() => onAction({ kind: clip.included ? 'exclude' : 'restore', clipId: clip.id })}>
        {clip.included ? <Trash2 size={18} color="#d4d4d4" /> : <RotateCcw size={18} color="#d4d4d4" />}
      </TimelineButton>
      <TimelineButton label="Move earlier" disabled={disabled || index === 0} onPress={() => onAction({ kind: 'reorder', clipId: clip.id, index: index - 1 })}><ArrowUp size={18} color="#d4d4d4" /></TimelineButton>
      <TimelineButton label="Move later" disabled={disabled || index === total - 1} onPress={() => onAction({ kind: 'reorder', clipId: clip.id, index: index + 1 })}><ArrowDown size={18} color="#d4d4d4" /></TimelineButton>
    </View>
    {clip.included && !unavailable && <>
      <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} pointerEvents={disabled ? 'none' : 'auto'}>
        <BoundaryHandle disabled={disabled} label="Trim start" value={clip.t0} min={0} max={sourceDuration ?? clip.t1} width={width} onCommit={t0 => onAction({ kind: 'trim', clipId: clip.id, t0, t1: clip.t1 })} />
        <BoundaryHandle disabled={disabled} label="Trim end" value={clip.t1} min={0} max={sourceDuration ?? clip.t1} width={width} onCommit={t1 => onAction({ kind: 'trim', clipId: clip.id, t0: clip.t0, t1 })} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <TextInput accessibilityLabel={`Clip ${index + 1} start seconds`} keyboardType="decimal-pad" value={start} onChangeText={setStart} editable={!disabled}
          style={{ color: '#fafafa', backgroundColor: '#262626', padding: 12, minHeight: 48, minWidth: 80, flex: 1 }} />
        <TextInput accessibilityLabel={`Clip ${index + 1} end seconds`} keyboardType="decimal-pad" value={end} onChangeText={setEnd} editable={!disabled}
          style={{ color: '#fafafa', backgroundColor: '#262626', padding: 12, minHeight: 48, minWidth: 80, flex: 1 }} />
        <TimelineButton label="Apply trim" disabled={disabled} onPress={() => onAction({ kind: 'trim', clipId: clip.id, t0: start.trim() ? Number(start) : NaN, t1: end.trim() ? Number(end) : NaN })} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <TimelineButton label="Seek to clip" disabled={disabled} onPress={() => onSeek(clip, clip.t0)} />
        <TimelineButton label="Split at playhead" disabled={disabled || splitAt === null || splitAt <= clip.t0 || splitAt >= clip.t1} onPress={() => { if (splitAt !== null) onAction({ kind: 'split', clipId: clip.id, at: splitAt }); }}><Scissors size={18} color="#d4d4d4" /></TimelineButton>
      </View>
    </>}
  </View>;
}

export function TimelineControls({ snapshot, reasons, sources, playhead, canUndo, canRedo, disabled = false, onUndo, onRedo, onAction, onPreview, onSeek }: {
  snapshot: TimelineSnapshot; reasons: TimelineReason[];
  sources: Readonly<Record<string, { duration: number | null; available: boolean }>>;
  playhead: { clipId: string; sourceTime: number } | null; canUndo: boolean; canRedo: boolean; disabled?: boolean;
  onUndo: () => void; onRedo: () => void; onAction: (action: ClipAction) => void;
  onPreview: (clip: TimelineClip) => void; onSeek: (clip: TimelineClip, sourceTime: number) => void;
}) {
  return <View style={{ gap: 12 }}>
    <Text style={{ color: '#fafafa', fontSize: 20, fontWeight: '600' }}>Timeline</Text>
    <Text style={{ color: '#a3a3a3' }}>Edits pause playback. Your source position stays when possible; removed footage moves to the next available output position.</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <TimelineButton label="Undo" disabled={disabled || !canUndo} onPress={onUndo} />
      <TimelineButton label="Redo" disabled={disabled || !canRedo} onPress={onRedo} />
    </View>
    {snapshot.clips.length === 0 && <Text style={{ color: '#d4d4d4' }}>No clips. Review an available original or recommendation to add footage.</Text>}
    {snapshot.clips.map((clip, index) => <ClipRow key={clip.id} clip={clip} index={index} total={snapshot.clips.length} reasons={reasons}
      sourceDuration={sources[clip.sourceId]?.duration ?? null} unavailable={!sources[clip.sourceId]?.available} playhead={playhead} disabled={disabled}
      onAction={onAction} onPreview={onPreview} onSeek={onSeek} />)}
  </View>;
}

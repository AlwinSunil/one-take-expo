import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { Project } from '@/lib/session';
import { applyAutomaticEdit, automaticMissingLines, type AutoClip } from '@/lib/automatic-edit';

const cutLabel = (clip: AutoClip) => clip.reason === 'filler' ? `Filler · ${clip.label}` : clip.reason === 'silence' ? 'Gap' : clip.reason === 'repeat' ? 'Repeat' : clip.reason === 'retake' ? 'Retake' : clip.label === 'Pause' ? 'Audio' : clip.label;
const rangeLabel = (clip: AutoClip) => `${clip.t0.toFixed(2)}–${clip.t1.toFixed(2)}s`;

export function AutomaticCutReview({ project, busy, onChange, onPreview }: {
  project: Project; busy: boolean; onChange: (project: Project) => Promise<void>; onPreview: (clip: AutoClip) => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const clips = project.automaticEdit?.clips ?? [];
  const clip = clips.find(item => item.id === selected);
  const missing = automaticMissingLines(project);
  async function toggle(item: AutoClip) {
    if (!project.automaticEdit || busy) return;
    try {
      await onChange(applyAutomaticEdit(project, { ...project.automaticEdit, clips: clips.map(c => c.id === item.id ? { ...c, included: !c.included, suggested: false, manual: true } : c) }));
      setError('');
    } catch { setError('Could not save this cut. Try again.'); }
  }
  async function pickup(lineId: string) {
    try {
      await onChange({ ...project, pickupRequest: { lineIds: [lineId], requestedAt: Date.now() } });
      router.push({ pathname: '/camera', params: { mode: 'script', script: project.script ?? '', pickupProjectId: project.id } });
    } catch { setError('Could not start the retake. Try again.'); }
  }
  return <View className="py-3">
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
      {clips.map(item => <Pressable key={item.id} accessibilityRole="button"
        accessibilityLabel={`${cutLabel(item)}, ${rangeLabel(item)}, ${(item.t1 - item.t0).toFixed(2)} seconds, ${item.included ? item.suggested ? 'suggested cut' : 'kept' : 'removed'}`}
        accessibilityState={{ selected: item.id === selected }} onPress={() => { setSelected(item.id); onPreview(item); }}
        style={{ width: Math.max(64, Math.min(180, (item.t1 - item.t0) * 35)), minHeight: 76, borderRadius: 10, padding: 10,
          backgroundColor: item.included && !item.suggested ? '#c4b5fd' : '#262626', opacity: item.included ? 1 : 0.5,
          borderColor: selected === item.id ? '#fff' : 'transparent', borderWidth: 2 }}>
        <Text numberOfLines={2} style={{ color: item.included && !item.suggested ? '#171321' : '#d4d4d4', fontSize: 12 }}>{cutLabel(item)}</Text>
        <Text style={{ color: item.included && !item.suggested ? '#514365' : '#a3a3a3', fontSize: 10, marginTop: 4 }}>{rangeLabel(item)}</Text>
      </Pressable>)}
    </ScrollView>
    {clip && <View className="flex-row items-center gap-2 mt-2">
      <Text className="text-neutral-400 text-xs flex-1" numberOfLines={1}>{clip.suggested ? 'Suggested · check the boundary' : clip.included ? 'Kept' : 'Removed'}{` · ${(clip.t1 - clip.t0).toFixed(2)}s`}</Text>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void toggle(clip); }} className="px-4 py-3 rounded-xl bg-neutral-800 disabled:opacity-40"><Text className="text-white text-sm">{clip.included ? 'Remove' : 'Restore'}</Text></Pressable>
      {!!clip.lineId && <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void pickup(clip.lineId!); }} className="px-4 py-3 rounded-xl bg-neutral-800 disabled:opacity-40"><Text className="text-white text-sm">Retake</Text></Pressable>}
    </View>}
    {!!missing.length && <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mt-2">
      {missing.map(line => <Pressable key={line.id} accessibilityRole="button" disabled={busy} onPress={() => { void pickup(line.id); }} className="mr-2 rounded-xl bg-neutral-900 px-4 py-3 disabled:opacity-40" style={{ maxWidth: 230 }}>
        <Text className="text-amber-200 text-xs">Record missing line</Text><Text numberOfLines={2} className="text-neutral-300 text-xs mt-1">{line.spokenText}</Text>
      </Pressable>)}
    </ScrollView>}
    {!clips.length && !busy && <Text className="text-neutral-400 text-xs">No cuts yet.</Text>}
    {!!error && <Text accessibilityRole="alert" className="text-amber-200 text-xs mt-2">{error}</Text>}
  </View>;
}

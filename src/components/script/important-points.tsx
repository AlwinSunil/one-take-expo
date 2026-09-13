import { Pressable, Text, TextInput, View } from 'react-native';
import type { ImportantPoint, ScriptSpan, PointMatch } from '../../features/speech-analysis/contracts';

/** Controlled surface: the schema owner persists every change before recording. */
export function ImportantPoints({ points, featureEnabled = false, unavailable = false, onEdit, onAdd, onReanalyze, onReviewSpan }: {
  points: readonly ImportantPoint[];
  featureEnabled?: boolean;
  unavailable?: boolean;
  onEdit: (id: string, patch: Partial<Pick<ImportantPoint, 'text' | 'importance' | 'removed'>>) => void;
  onAdd: () => void;
  onReanalyze: () => void;
  onReviewSpan: (id: string) => void;
}) {
  if (!featureEnabled) return null;
  return <View className="mt-4 gap-3">
    <Text className="text-white text-base font-semibold">Important points</Text>
    <Text className="text-neutral-400 text-sm">{unavailable ? 'Suggestions unavailable. Select points from your script manually.' : 'Suggested from your script. Choose what matters and correct these ideas.'}</Text>
    {points.filter(point => !point.removed).map(point => <View key={point.id} className="bg-neutral-900 border border-neutral-800 p-3 gap-2">
      <Text className="text-neutral-400 text-xs">Script: {point.span.text}</Text>
      <TextInput multiline accessibilityLabel={`Important point ${point.text}`} value={point.text} onChangeText={text => onEdit(point.id, { text })} className="text-white text-sm min-h-[44px]" />
      <Text className="text-neutral-400 text-xs">{point.reason}</Text>
      {!point.text.trim() && <Text className="text-amber-200 text-sm">Enter the idea or remove this point before recording a pickup.</Text>}
      {(point.state === 'pending' || point.state === 'unavailable') && <Pressable accessibilityRole="button" onPress={() => onReviewSpan(point.id)} className="min-h-[44px] justify-center"><Text className="text-amber-200 text-sm">Script changed. Review point attachment</Text></Pressable>}
      <View className="flex-row flex-wrap gap-2">
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: point.importance === 'important' }} accessibilityLabel="Mark point important" onPress={() => onEdit(point.id, { importance: point.importance === 'important' ? 'optional' : 'important' })} className="min-h-[44px] justify-center px-3 bg-neutral-800"><Text className="text-white">{point.importance === 'important' ? 'Important' : 'Optional'}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove point ${point.text}`} onPress={() => onEdit(point.id, { removed: true })} className="min-h-[44px] justify-center px-3"><Text className="text-neutral-300">Remove</Text></Pressable>
      </View>
    </View>)}
    <View className="flex-row flex-wrap gap-2">
      <Pressable accessibilityRole="button" onPress={onAdd} className="min-h-[44px] justify-center px-3 bg-neutral-800"><Text className="text-white">Select from script</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={onReanalyze} className="min-h-[44px] justify-center px-3"><Text className="text-neutral-300">Re-analyze points</Text></Pressable>
    </View>
    <Text className="text-neutral-500 text-xs">Importance does not require exact wording or complete physical actions.</Text>
  </View>;
}

/** Used for manual addition or reattachment when suggestions are unavailable/stale. */
export function ScriptPointSelector({ spans, onSelect, onCancel }: {
  spans: readonly ScriptSpan[];
  onSelect: (span: ScriptSpan) => void;
  onCancel: () => void;
}) {
  return <View className="bg-neutral-900 p-3 gap-2">
    <Text className="text-white text-base font-semibold">Select a script point</Text>
    <Text className="text-neutral-400 text-sm">Choose the spoken line this idea belongs to.</Text>
    {spans.filter(span => span.text.trim()).map(span => <Pressable key={span.id} accessibilityRole="button" accessibilityLabel={`Select ${span.text}`} onPress={() => onSelect(span)} className="min-h-[44px] justify-center py-3 border-b border-neutral-800"><Text className="text-white text-sm">{span.text}</Text></Pressable>)}
    {spans.length === 0 && <Text className="text-neutral-400 text-sm">Add spoken text to your script first.</Text>}
    <Pressable accessibilityRole="button" onPress={onCancel} className="min-h-[44px] justify-center"><Text className="text-neutral-300">Cancel</Text></Pressable>
  </View>;
}

export function MissingPointReview({ points, matches, selectedIds, onSelectionChange, onRecord, onReviewOriginal, onContinue }: {
  points: readonly ImportantPoint[];
  matches: readonly PointMatch[];
  selectedIds: readonly string[];
  onSelectionChange: (ids: string[]) => void;
  onRecord: () => void;
  onReviewOriginal: () => void;
  onContinue: () => void;
}) {
  const unresolved = points.filter(point => !point.removed && point.importance === 'important' && !matches.some(match => match.pointId === point.id && match.pointRevision === point.revision && match.scriptRevision === point.span.scriptRevision && match.state === 'available' && match.verdict === 'covered'));
  const selected = new Set(selectedIds);
  const canRecord = unresolved.some(point => selected.has(point.id)) && unresolved.filter(point => selected.has(point.id)).every(point => point.text.trim() && point.state !== 'pending' && point.state !== 'unavailable');
  return <View className="p-3 gap-2 bg-neutral-900">
    <Text className="text-white text-base font-semibold">Missed important points</Text>
    {unresolved.length === 0 && <Text className="text-neutral-300">No unresolved important points in this analysis.</Text>}
    {unresolved.map(point => <Pressable key={point.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected.has(point.id) }} onPress={() => onSelectionChange(selected.has(point.id) ? selectedIds.filter(id => id !== point.id) : [...selectedIds, point.id])} className="min-h-[44px] py-3">
      <Text className="text-white">{selected.has(point.id) ? '✓ ' : ''}{point.text}</Text>
      <Text className="text-neutral-400 text-xs">{matches.find(match => match.pointId === point.id)?.reason ?? 'No speech evidence available.'}</Text>
    </Pressable>)}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canRecord }} disabled={!canRecord} onPress={onRecord} className="min-h-[44px] justify-center disabled:opacity-40"><Text className="text-white font-semibold">Record missed points</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={onReviewOriginal} className="min-h-[44px] justify-center"><Text className="text-white">Review original</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={onContinue} className="min-h-[44px] justify-center"><Text className="text-neutral-300">Continue editing</Text></Pressable>
  </View>;
}

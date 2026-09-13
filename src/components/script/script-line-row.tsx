import { Pressable, Text, View } from 'react-native';

import { ActionCueRow } from './action-cue-row';

import type { ActionCueStatus, ScriptDocumentLine } from '@/lib/script-lines';

type ScriptLineRowProps = {
  line: ScriptDocumentLine;
  /** Position shown to the creator; the id is what other lanes key off. */
  position: number;
  onCueRequiredChange?: (cueId: string, required: boolean) => void;
  onCueStatusChange?: (cueId: string, status: ActionCueStatus) => void;
  onCorrectAmbiguousCue?: (cueId: string, as: 'action' | 'spoken') => void;
  onMove?: (lineId: string, offset: number) => void;
  onDelete?: (lineId: string) => void;
};

/**
 * One script line: what to say, and the directions attached to it. Props only, so the
 * capture lane can render the same rows without reaching into the draft store.
 */
export function ScriptLineRow({
  line,
  position,
  onCueRequiredChange,
  onCueStatusChange,
  onCorrectAmbiguousCue,
  onMove,
  onDelete,
}: ScriptLineRowProps) {
  return (
    <View className="border-t border-neutral-800 py-4">
      <View className="flex-row items-start">
        <Text className="text-neutral-500 text-[11px] w-6 leading-5">{position}</Text>
        <View className="flex-1">
          {line.kind === 'action-only' ? (
            <Text className="text-neutral-500 text-xs italic">Action only · nothing to say here</Text>
          ) : (
            <Text className="text-white text-sm leading-5">{line.spokenText}</Text>
          )}
          {line.kind === 'spoken' && (
            <Text className="text-neutral-500 text-[11px] mt-1">
              {line.wordCount} {line.wordCount === 1 ? 'spoken word' : 'spoken words'}
            </Text>
          )}
        </View>
        {!!onMove && (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Move line ${position} up`}
              onPress={() => onMove(line.id, -1)}
              className="min-h-12 justify-center px-3 active:opacity-70">
              <Text className="text-neutral-400 text-xs">Up</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Move line ${position} down`}
              onPress={() => onMove(line.id, 1)}
              className="min-h-12 justify-center px-3 active:opacity-70">
              <Text className="text-neutral-400 text-xs">Down</Text>
            </Pressable>
          </>
        )}
        {!!onDelete && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete line ${position}`}
            onPress={() => onDelete(line.id)}
            className="min-h-12 justify-center px-3 active:opacity-70">
            <Text className="text-neutral-400 text-xs">Delete</Text>
          </Pressable>
        )}
      </View>

      {line.actionCues.map((cue) => (
        <ActionCueRow
          key={cue.id}
          cue={cue}
          onRequiredChange={onCueRequiredChange}
          onStatusChange={onCueStatusChange}
        />
      ))}

      {line.ambiguousCues.map((cue) => (
        <View key={cue.id} className="bg-neutral-900 border-l-2 border-neutral-500 px-3 py-2.5 mt-2">
          <Text className="text-neutral-300 text-xs">
            “{cue.raw}” has no closing bracket, so it is still counted as spoken.
          </Text>
          <View className="flex-row flex-wrap items-center mt-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Make an action cue from ${cue.text}`}
              onPress={() => onCorrectAmbiguousCue?.(cue.id, 'action')}
              className="pr-4 py-2 active:opacity-70">
              <Text className="text-amber-200 text-[11px]">This is an action</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Keep ${cue.text} as spoken text`}
              onPress={() => onCorrectAmbiguousCue?.(cue.id, 'spoken')}
              className="pr-4 py-2 active:opacity-70">
              <Text className="text-white text-[11px]">This is actually spoken</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

import { Pressable, Text, View } from 'react-native';

import type { ActionCueStatus, ScriptActionCue } from '@/lib/script-lines';

type ActionCueRowProps = {
  cue: ScriptActionCue;
  onRequiredChange?: (cueId: string, required: boolean) => void;
  onStatusChange?: (cueId: string, status: ActionCueStatus) => void;
};

const STATUS_LABEL: Record<ActionCueStatus, string> = {
  pending: 'Not done yet',
  done: 'Marked done',
  skipped: 'Skipped · still unresolved',
};

/**
 * One bracketed direction. Status is only ever what the creator said it is; this row
 * never presents an action as automatically verified.
 */
export function ActionCueRow({ cue, onRequiredChange, onStatusChange }: ActionCueRowProps) {
  return (
    <View className="bg-neutral-900 border-l-2 border-amber-300 px-3 py-2 mt-1">
      <Text className="text-amber-200 text-xs font-semibold">Action · {cue.text}</Text>
      <View className="flex-row flex-wrap items-center mt-1">
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: cue.required }}
          accessibilityLabel={`${cue.required ? 'Required' : 'Optional'} action: ${cue.text}`}
          onPress={() => onRequiredChange?.(cue.id, !cue.required)}
          className="pr-4 py-1 active:opacity-70">
          <Text className="text-neutral-300 text-[11px]">
            {cue.required ? 'Required · tap to make optional' : 'Optional · tap to require'}
          </Text>
        </Pressable>
        {cue.required && (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Mark action done: ${cue.text}`}
              onPress={() => onStatusChange?.(cue.id, cue.status === 'done' ? 'pending' : 'done')}
              className="pr-4 py-1 active:opacity-70">
              <Text className="text-white text-[11px]">{cue.status === 'done' ? 'Undo done' : 'I did this'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Skip action: ${cue.text}`}
              onPress={() => onStatusChange?.(cue.id, cue.status === 'skipped' ? 'pending' : 'skipped')}
              className="pr-4 py-1 active:opacity-70">
              <Text className="text-neutral-300 text-[11px]">{cue.status === 'skipped' ? 'Unskip' : 'Skip it'}</Text>
            </Pressable>
          </>
        )}
      </View>
      {cue.required && (
        <Text className={`text-[11px] ${cue.status === 'done' ? 'text-neutral-400' : 'text-amber-200'}`}>
          {STATUS_LABEL[cue.status]}
        </Text>
      )}
    </View>
  );
}

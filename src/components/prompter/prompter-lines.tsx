import { useEffect, useState } from 'react';
import { PixelRatio, Pressable, Text, View, useWindowDimensions, type TextLayoutEventData, type NativeSyntheticEvent } from 'react-native';

import {
  COVERAGE_MARKS,
  actionCueLabel,
  lineClamp,
  readableFontSize,
  type PrompterActionCue,
  type PrompterLine,
} from '@/lib/retake-prompts';

/**
 * The current line large, the next line small, and action cues on their own
 * "Do:" row.  Cue text is never shown as dialogue and a required cue is only
 * ever completed by pressing its Done control: advancing a line does nothing
 * to it.  Props-only; the caller owns every piece of state.
 */
export function PrompterLines({ current, next, onCueDone, showStatus = true }: {
  current: PrompterLine | null;
  next?: PrompterLine | null;
  onCueDone: (cueId: string) => void;
  /** Pass `false` before a coverage engine is connected, so no status is implied. */
  showStatus?: boolean;
}) {
  const window = useWindowDimensions();
  const fontScale = window.fontScale || PixelRatio.getFontScale();
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const clamp = lineClamp({ fontScale, expanded });
  const currentSize = readableFontSize(24, { width: window.width, fontScale });
  const nextSize = readableFontSize(17, { width: window.width, fontScale });

  // A new line must never inherit the previous line's expansion, or it would
  // cover the camera preview with text the creator never asked to unfold.
  useEffect(() => {
    setExpanded(false);
    setTruncated(false);
  }, [current?.id]);

  function onTextLayout(event: NativeSyntheticEvent<TextLayoutEventData>) {
    if (clamp > 0) setTruncated(event.nativeEvent.lines.length >= clamp);
  }

  if (!current) {
    return <View className="rounded-xl bg-black/80 px-4 py-3">
      <Text className="text-neutral-300" style={{ fontSize: nextSize }}>No script line to read.</Text>
    </View>;
  }

  return <View className="rounded-xl bg-black/80 px-4 py-3">
    <View className="flex-row items-center justify-between">
      <Text className="text-neutral-300 text-xs">Line {current.number}</Text>
      {showStatus && <Text className="text-neutral-300 text-xs">
        {COVERAGE_MARKS[current.status].symbol} {COVERAGE_MARKS[current.status].short}
      </Text>}
    </View>
    <Text accessibilityLabel={`Line ${current.number}. ${current.spokenText}`} onTextLayout={onTextLayout}
      numberOfLines={clamp || undefined} className="text-white mt-1"
      style={{ fontSize: currentSize, lineHeight: Math.round(currentSize * 1.35) }}>
      {current.spokenText}
    </Text>
    {(truncated || expanded) && <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
      accessibilityLabel={expanded ? 'Show less of this line' : 'Show the rest of this line'}
      onPress={() => setExpanded(value => !value)} className="active:opacity-65 justify-center" style={{ minHeight: 44 }}>
      <Text className="text-white text-sm underline">{expanded ? 'Less' : 'More'}</Text>
    </Pressable>}

    {current.actionCues.map(cue => <CueRow key={cue.id} cue={cue} lineNumber={current.number} onDone={onCueDone} fontSize={nextSize} />)}

    {next && <View className="mt-3 border-t border-neutral-700 pt-2">
      <Text className="text-neutral-400 text-xs">Next · line {next.number}</Text>
      <Text accessibilityLabel={`Next, line ${next.number}. ${next.spokenText}`}
        numberOfLines={lineClamp({ fontScale, compact: true })} className="text-neutral-200 mt-0.5"
        style={{ fontSize: nextSize, lineHeight: Math.round(nextSize * 1.35) }}>
        {next.spokenText}
      </Text>
      {next.actionCues.map(cue => <CueRow key={cue.id} cue={cue} lineNumber={next.number} onDone={onCueDone} fontSize={nextSize} />)}
    </View>}
  </View>;
}

function CueRow({ cue, lineNumber, onDone, fontSize }: {
  cue: PrompterActionCue; lineNumber: number; onDone: (cueId: string) => void; fontSize: number;
}) {
  return <View className="flex-row items-center mt-2 rounded-lg border border-amber-300/60 bg-amber-300/10 px-2 py-1.5">
    <Text className="text-amber-200 text-xs mr-2">Do:</Text>
    <Text accessibilityLabel={actionCueLabel(cue, lineNumber)} className="text-amber-100 flex-1"
      style={{ fontSize, lineHeight: Math.round(fontSize * 1.3) }}>
      {cue.text}{cue.required ? ' · required' : ' · optional'}
    </Text>
    {cue.required && (cue.resolved
      ? <Text className="text-emerald-200 text-xs ml-2">● Done</Text>
      : <Pressable accessibilityRole="button" accessibilityLabel={`Mark done: ${cue.text}`} onPress={() => onDone(cue.id)}
        className="ml-2 rounded-lg bg-white px-3 justify-center active:opacity-80" style={{ minHeight: 44 }}>
        <Text className="text-black text-xs font-semibold">Done</Text>
      </Pressable>)}
  </View>;
}

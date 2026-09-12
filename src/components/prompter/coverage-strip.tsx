import { PixelRatio, Text, View, useWindowDimensions } from 'react-native';

import {
  COVERAGE_MARKS,
  coverageCellLabel,
  coverageSummaryText,
  stripCapacity,
  stripWindow,
  type PrompterLine,
} from '@/lib/retake-prompts';

/**
 * One cell per spoken line.  Status is a glyph and a word first and a colour
 * second, so the strip stays readable without colour perception.  The component
 * is props-only: it reads no store, no hook state and no coverage engine.
 *
 * A missing `currentLineId` keeps the window at the start of the script and
 * emphasises no cell, which is what a take that has not started looks like.
 */
export function CoverageStrip({ lines, currentLineId, nextLineId }: {
  lines: readonly PrompterLine[];
  currentLineId?: string | null;
  nextLineId?: string | null;
}) {
  const window = useWindowDimensions();
  const fontScale = window.fontScale || PixelRatio.getFontScale();
  const currentIndex = Math.max(0, lines.findIndex(line => line.id === currentLineId));  // -1 (no current line) anchors the window at the start
  const slice = stripWindow(lines.length, currentIndex, stripCapacity(window.width, fontScale));
  const visible = lines.slice(slice.start, slice.end);

  return <View className="rounded-xl bg-black/80 px-3 py-2">
    <Text accessibilityLabel={`Coverage: ${coverageSummaryText(lines)}`} className="text-neutral-200 text-xs">
      {coverageSummaryText(lines)}
    </Text>
    <View className="flex-row items-stretch mt-2">
      {slice.hiddenBefore > 0 && <Edge label={`${slice.hiddenBefore} earlier lines`} text={`+${slice.hiddenBefore}`} />}
      {visible.map(line => {
        const position = line.id === currentLineId ? 'current' : line.id === nextLineId ? 'next' : null;
        const mark = COVERAGE_MARKS[line.status];
        return <View key={line.id} accessible accessibilityLabel={coverageCellLabel({ number: line.number, status: line.status, position })}
          className={`flex-1 items-center rounded-lg px-1 py-1.5 mr-1 border ${position === 'current' ? 'border-white bg-white/15'
            : position === 'next' ? 'border-neutral-300' : 'border-neutral-700'}`}
          style={{ minWidth: 40 }}>
          <Text className={line.status === 'covered' ? 'text-emerald-200 text-sm'
            : line.status === 'pending' ? 'text-amber-200 text-sm' : 'text-orange-200 text-sm'}>{mark.symbol}</Text>
          <Text className="text-white text-xs mt-0.5">{line.number}</Text>
          {position && <Text numberOfLines={1} className="text-neutral-200 text-[10px] mt-0.5">{mark.short}</Text>}
        </View>;
      })}
      {slice.hiddenAfter > 0 && <Edge label={`${slice.hiddenAfter} later lines`} text={`+${slice.hiddenAfter}`} />}
    </View>
  </View>;
}

function Edge({ label, text }: { label: string; text: string }) {
  return <View accessible accessibilityLabel={label} className="items-center justify-center px-1.5 mr-1">
    <Text className="text-neutral-400 text-xs">{text}</Text>
  </View>;
}

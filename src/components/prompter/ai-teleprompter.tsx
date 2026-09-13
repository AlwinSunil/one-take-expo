import { useMemo, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import type { PrompterLine } from '@/lib/retake-prompts';
import { followScript, prompterWords } from '@/lib/prompter-progress';

type ReadRow = { words: string[]; offset: number };
const typeStyle = { fontSize: 26, lineHeight: 40, fontWeight: '500' as const, color: '#fff' };

export function AITeleprompter({ lines, transcript, recording, unavailable, onCueDone, completedLineIds = [] }: {
  lines: readonly PrompterLine[];
  completedLineIds?: readonly string[];
  transcript: string;
  recording: boolean;
  unavailable: boolean;
  onCueDone: (id: string) => void;
}) {
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const [measured, setMeasured] = useState<{ key: string; rows: ReadRow[] }>({ key: '', rows: [] });
  const [manual, setManual] = useState({ key: '', index: 0 });
  const text = lines.map(line => line.spokenText).filter(Boolean).join('\n');
  const measurementKey = `${width}:${fontScale}:${text}`;
  const words = useMemo(() => prompterWords(text), [text]);
  const progress = useMemo(() => {
    const result = followScript(words, recording ? transcript : '');
    if (!recording) return result;
    let offset = 0;
    for (const line of lines) {
      const length = prompterWords(line.spokenText).length;
      if (completedLineIds.includes(line.id)) {
        result.cursor = Math.max(result.cursor, offset + length);
        for (let i = offset; i < offset + length; i++) result.matched.add(i);
      }
      offset += length;
    }
    return result;
  }, [words, transcript, recording, lines, completedLineIds]);
  const rows = measured.key === measurementKey ? measured.rows : [];
  const following = rows.findIndex(row => progress.cursor < row.offset + row.words.length);
  const index = unavailable && manual.key === measurementKey
    ? Math.min(manual.index, Math.max(0, rows.length - 1))
    : following < 0 ? Math.max(0, rows.length - 1) : following;
  let end = 0;
  const active = lines.find(line => { end += prompterWords(line.spokenText).length; return end > (rows[index]?.offset ?? 0); });
  const cues = active?.actionCues ?? [];

  return <View className="rounded-2xl bg-black/80 px-5 py-4">
    <Pressable onLayout={event => setWidth(event.nativeEvent.layout.width)}
      disabled={!unavailable} onPress={() => setManual({ key: measurementKey, index: (index + 1) % Math.max(1, rows.length) })}
      accessibilityRole={unavailable ? 'button' : undefined}
      accessibilityLabel={unavailable ? rows.slice(index, index + 2).map(row => row.words.join(' ')).join('. ') : undefined}
      accessibilityHint={unavailable ? 'Voice follow is unavailable. Tap to advance the script.' : undefined}>
      {/* Measure with the same native text layout so long sentences remain readable two visual rows at a time. */}
      {width > 0 && <Text key={measurementKey} accessible={false} importantForAccessibility="no-hide-descendants"
        textBreakStrategy="simple" android_hyphenationFrequency="none"
        style={[typeStyle, { position: 'absolute', width, opacity: 0 }]}
        onTextLayout={event => {
          let offset = 0;
          const next = event.nativeEvent.lines.flatMap(line => {
            const lineWords = prompterWords(line.text);
            if (!lineWords.length) return [];
            const row = { words: lineWords, offset };
            offset += lineWords.length;
            return [row];
          });
          setMeasured(previous => previous.key === measurementKey ? previous : { key: measurementKey, rows: next });
        }}>{text}</Text>}
      {rows.length ? rows.slice(index, index + 2).map((row, position) => <Text key={row.offset}
        numberOfLines={1} textBreakStrategy="simple" android_hyphenationFrequency="none"
        style={[typeStyle, { opacity: position === 0 ? 1 : 0.4 }]}>
        {row.words.map((word, wordIndex) => <Text key={wordIndex} style={{
          color: position === 0 && progress.matched.has(row.offset + wordIndex) ? '#c4b5fd' : '#fff',
        }}>{word}{wordIndex < row.words.length - 1 ? ' ' : ''}</Text>)}
      </Text>) : <Text numberOfLines={2} style={typeStyle}>{text || 'Add a script to start reading.'}</Text>}
    </Pressable>
    {cues.map(cue => <Pressable key={cue.id} disabled={!cue.required || cue.resolved}
      accessibilityRole={cue.required ? 'button' : 'text'} onPress={() => onCueDone(cue.id)}
      accessibilityLabel={`${cue.text}${cue.resolved ? ', done' : cue.required ? ', tap to mark done' : ''}`}
      className="min-h-11 justify-center">
      <Text className="text-neutral-400 text-sm italic">{cue.resolved ? '✓ ' : ''}{cue.text}{cue.required && !cue.resolved ? ' · Done' : ''}</Text>
    </Pressable>)}
  </View>;
}

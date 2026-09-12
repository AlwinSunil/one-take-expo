import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { CoverageStrip } from '@/components/prompter/coverage-strip';
import { PrompterLines } from '@/components/prompter/prompter-lines';
import { RetakePrompt } from '@/components/prompter/retake-prompt';
import { decideRetakePrompt, evaluatePromptTiming } from '@/lib/retake-prompts';

import { createPrompterSession, prompterSessionIds, type PrompterSessionId } from './prompter-sessions';

/**
 * A camera-free prompter harness.
 *
 * It replays the fixture logs in `prompter-sessions.ts` against the real
 * scheduler and the real components, so the capture lane can be reviewed
 * without a camera, a recognizer or a recording.  Nothing here is device
 * evidence: the clock is a slider, not a read.
 */
export function PrompterHarness() {
  const [sessionId, setSessionId] = useState<PrompterSessionId>('flub');
  const [session, setSession] = useState(() => createPrompterSession('flub'));
  const [offsetMs, setOffsetMs] = useState(0);
  const [midLine, setMidLine] = useState(false);
  const [forceDelayed, setForceDelayed] = useState(false);
  const [takeEnded, setTakeEnded] = useState(false);
  const [currentLineId, setCurrentLineId] = useState<string>(() => createPrompterSession('flub').currentLineId);
  const titles = useMemo(() => prompterSessionIds.map(id => createPrompterSession(id).title), []);
  if (!__DEV__) return null;

  const engineState = forceDelayed ? 'delayed' : session.engineState;
  const now = session.now + offsetMs;
  const decision = decideRetakePrompt({
    lines: session.lines,
    lineEnds: session.lineEnds,
    verdicts: session.verdicts,
    now,
    midLine: midLine || session.midLine,
    takeEnded,
    engineState,
  });
  const report = evaluatePromptTiming({
    lines: session.lines,
    lineEnds: session.lineEnds,
    verdicts: session.verdicts,
    engineState,
  });
  const currentIndex = Math.max(0, session.lines.findIndex(line => line.id === currentLineId));
  const current = session.lines[currentIndex] ?? null;
  const next = session.lines[currentIndex + 1] ?? null;

  function select(id: PrompterSessionId) {
    setSessionId(id);
    setSession(createPrompterSession(id));
    setOffsetMs(0);
    setMidLine(false);
    setForceDelayed(false);
    setTakeEnded(false);
    setCurrentLineId(createPrompterSession(id).currentLineId);
  }

  function markCueDone(cueId: string) {
    setSession(value => ({
      ...value,
      lines: value.lines.map(line => ({
        ...line,
        actionCues: line.actionCues.map(cue => (cue.id === cueId ? { ...cue, resolved: true } : cue)),
      })),
    }));
  }

  return <ScrollView className="flex-1 bg-neutral-950" contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
    <Text className="text-neutral-400 text-[10px] tracking-[2px] mb-3">DEVELOPMENT ONLY · NO CAMERA</Text>
    <Text className="text-neutral-50 text-2xl font-semibold">Prompter harness</Text>
    <Text className="text-neutral-400 text-sm mt-2 leading-5">{session.description}</Text>

    <View className="flex-row flex-wrap gap-2 mt-4">
      {prompterSessionIds.map((id, index) => <Chip key={id} label={titles[index]}
        selected={id === sessionId} onPress={() => select(id)} />)}
    </View>

    <View className="mt-5"><CoverageStrip lines={session.lines} currentLineId={current?.id} nextLineId={next?.id} /></View>
    <View className="mt-3"><PrompterLines current={current} next={next} onCueDone={markCueDone} /></View>
    <View className="mt-3"><RetakePrompt decision={decision} /></View>

    <View className="flex-row flex-wrap gap-2 mt-5">
      <Chip label="−500 ms" onPress={() => setOffsetMs(value => value - 500)} />
      <Chip label="+500 ms" onPress={() => setOffsetMs(value => value + 500)} />
      <Chip label="Reset clock" onPress={() => setOffsetMs(0)} />
      <Chip label="Creator speaking" selected={midLine} onPress={() => setMidLine(value => !value)} />
      <Chip label="Engine delayed" selected={forceDelayed} onPress={() => setForceDelayed(value => !value)} />
      <Chip label="Take ended" selected={takeEnded} onPress={() => setTakeEnded(value => !value)} />
      <Chip label="Previous line" onPress={() => setCurrentLineId(session.lines[Math.max(0, currentIndex - 1)].id)} />
      <Chip label="Next line" onPress={() => setCurrentLineId(session.lines[Math.min(session.lines.length - 1, currentIndex + 1)].id)} />
    </View>

    <View className="mt-5 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <Text className="text-neutral-50 text-sm font-semibold">Replayed timing</Text>
      <Text className="text-neutral-300 text-xs mt-2 leading-5">
        Clock {(now / 1000).toFixed(1)} s · engine {engineState} · take {takeEnded ? 'ended' : 'running'} · decision {decision ? decision.kind : 'none'}
      </Text>
      <Text className="text-neutral-300 text-xs mt-1 leading-5">
        {report.promptedBeforeNextLine} of {report.eligible} line ends needing a prompt got one before the next line
        ({report.resolvedWithoutPrompt} resolved without a prompt, mode {report.mode}).
      </Text>
      <Text className="text-neutral-300 text-xs mt-1 leading-5">
        {report.missed.length === 0 ? 'No missed line ends in this fixture.'
          : `Missed: ${report.missed.map(miss => `line ${miss.lineNumber} (${miss.reason})`).join(', ')}.`}
      </Text>
      <Text className="text-amber-200 text-xs mt-2 leading-5">
        {report.sampleComplete ? 'Sample size reached 20 promptable line ends.'
          : 'Fixture sample is below 20 promptable line ends, so the 18/20 acceptance target stays open.'}
      </Text>
    </View>

    <Text className="text-neutral-400 text-xs mt-4 leading-5">
      Manual checks this harness is for: press More on a long line, then switch the current line and confirm the next line
      comes back clamped; raise the system text size and confirm the strip, the lines and the prompt stay readable.
    </Text>
    <Text className="text-neutral-500 text-xs mt-4 leading-5">
      Fixture timings only. This harness runs no camera, recognizer or recording, so it cannot establish device latency,
      speech accuracy or the recorded quiet and noisy 18/20 measurement.
    </Text>
  </ScrollView>;
}

function Chip({ label, onPress, selected = false }: { label: string; onPress: () => void; selected?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
    className={`rounded-lg px-3 justify-center active:opacity-70 ${selected ? 'bg-white' : 'bg-neutral-800 border border-neutral-700'}`}
    style={{ minHeight: 44 }}>
    <Text className={`text-xs font-semibold ${selected ? 'text-black' : 'text-neutral-100'}`}>{label}</Text>
  </Pressable>;
}

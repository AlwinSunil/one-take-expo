# Handoff: prompter and coverage strip (#19)

Owner: Sabari (script and coverage lane). Reviewer and integrator: Alwin (capture lane).

This lane cannot edit `src/app/camera.tsx`, so this document carries the exact JSX to paste there.
Everything below is an owner-authored proposal; nothing has been applied to the capture route.

## What ships in this branch

| File | Purpose |
| --- | --- |
| `src/lib/retake-prompts.ts` | Pure scheduler: decides between an in-pause `Again, line N` prompt and a batched after-the-take list, plus the readability and label rules used by the components. |
| `src/components/prompter/coverage-strip.tsx` | One cell per spoken line, status by glyph and word first. |
| `src/components/prompter/prompter-lines.tsx` | Current line large, next line small, action cues on a separate `Do:` row. |
| `src/components/prompter/retake-prompt.tsx` | Renders one `PromptDecision` inside a polite live region. |
| `src/development/prompter/prompter-sessions.ts` | Five camera-free fixture logs: `clean`, `flub`, `long-line`, `delayed-verdict`, `action`. |
| `src/development/prompter/prompter-harness.tsx` | Route-less dev harness that replays those logs against the real components. |
| `tests/retake-prompts.test.mjs` | 24 behavior tests, including the 18/20 timing evaluator. |

All three components are props-only: they read no store, no SQLite, no hook state and no engine.
Every piece of logic lives in `src/lib/retake-prompts.ts` so it can be tested without rendering.

## Props

### `CoverageStrip`

| Prop | Type | Notes |
| --- | --- | --- |
| `lines` | `readonly PrompterLine[]` | Script order. `number` is what the creator sees and must match the prompt text. |
| `currentLineId` | `string \| null` | Emphasised cell; also the cell the visible window keeps in view. |
| `nextLineId` | `string \| null` | Secondary emphasis. |

The strip hides earlier cells first when they do not fit, and shows `+N` chips with an accessibility label for what it hid.
Capacity comes from `useWindowDimensions().width` and the font scale, so large system text shows fewer, bigger cells instead of clipping.

### `PrompterLines`

| Prop | Type | Notes |
| --- | --- | --- |
| `current` | `PrompterLine \| null` | `null` renders "No script line to read." |
| `next` | `PrompterLine \| null` | Optional. |
| `onCueDone` | `(cueId: string) => void` | Called only by an explicit press on a required cue's Done control. |
| `showStatus` | `boolean` (default `true`) | Pass `false` until a coverage engine is connected, so no status is implied. |

### `RetakePrompt`

| Prop | Type | Notes |
| --- | --- | --- |
| `decision` | `PromptDecision \| null` | The result of `decideRetakePrompt`. `null` renders an empty live region. |

### `PrompterLine` and `PrompterActionCue`

```ts
interface PrompterLine {
  id: string;
  number: number;                    // 1-based, shown to the creator
  status: 'needed' | 'pending' | 'covered';
  spokenText: string;                // never contains cue text
  actionCues: PrompterActionCue[];
}

interface PrompterActionCue {
  id: string;
  text: string;
  required: boolean;
  resolved: boolean;                 // only ever set by an explicit creator press
}
```

## Stage 1: the JSX to paste today, with no coverage engine

Replace the current manual script overlay in `src/app/camera.tsx` (the `{isScript && <View className="absolute bottom-3 left-3 right-3 …">` block, lines 337-344 at commit `3f2eeca`) with:

```tsx
        {isScript && <View className="absolute bottom-3 left-3 right-3">
          <PrompterLines showStatus={false} current={prompterLines[chunk] ?? null}
            next={prompterLines[chunk + 1] ?? null} onCueDone={() => {}} />
          <View className="flex-row justify-between items-center">
            <IconButton icon="chevron_left" label="Previous script section" disabled={chunk === 0} onPress={() => setChunk(i => i - 1)} />
            <Text className="text-neutral-400 text-xs">Manual · {chunks.length ? chunk + 1 : 0}/{chunks.length}</Text>
            <IconButton icon="chevron_right" label="Next script section" disabled={chunk >= chunks.length - 1} onPress={() => setChunk(i => i + 1)} />
          </View>
        </View>}
```

Add one import beside the existing `LiveCaptions` import:

```tsx
import { PrompterLines } from '@/components/prompter/prompter-lines';
```

Add one derived value directly after the existing `chunks` line (line 112 at commit `3f2eeca`):

```tsx
  const prompterLines = chunks.map((text, index) => ({
    id: `chunk-${index}`, number: index + 1, status: 'needed' as const, spokenText: text, actionCues: [],
  }));
```

Stage 1 deliberately renders no coverage strip and no retake prompt.
Without a coverage engine there is no honest status to draw, which is why `showStatus={false}` is passed and every line carries the neutral `needed` value.

## Stage 2: the JSX once the coverage lane (#16) feeds the route

When the capture route can supply `PrompterLine[]` with real statuses, line-end timestamps and verdict arrivals, add these imports:

```tsx
import { CoverageStrip } from '@/components/prompter/coverage-strip';
import { RetakePrompt } from '@/components/prompter/retake-prompt';
import { decideRetakePrompt } from '@/lib/retake-prompts';
```

Add this state and tick beside the existing recording timer effect:

```tsx
  const [promptNow, setPromptNow] = useState(Date.now());
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setPromptNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [recording]);

  const promptDecision = recording ? decideRetakePrompt({
    lines: coverage.lines,           // PrompterLine[] from the coverage lane
    lineEnds: coverage.lineEnds,     // { lineId, endedAt, nextStartsAt? }[] in ms
    verdicts: coverage.verdicts,     // { lineId, status, arrivedAt }[] in ms
    now: promptNow,
    midLine: coverage.isSpeaking,
    engineState: captions.status === 'delayed' ? 'delayed'
      : captions.status === 'error' ? 'unavailable' : 'ready',
  }) : null;
```

Then render the overlay block as:

```tsx
        {isScript && <View className="absolute bottom-3 left-3 right-3">
          <CoverageStrip lines={coverage.lines} currentLineId={coverage.currentLineId} nextLineId={coverage.nextLineId} />
          <View className="mt-2">
            <PrompterLines current={coverage.current} next={coverage.next} onCueDone={coverage.markCueDone} />
          </View>
          <View className="mt-2"><RetakePrompt decision={promptDecision} /></View>
        </View>}
```

`promptNow` must use the same clock as `endedAt`, `nextStartsAt` and `arrivedAt`.
`Date.now()` milliseconds throughout is the simplest choice; seconds-since-recording-start also works as long as every value uses it.

## What these components do not do

- No vision, no framing judgement and no automatic take selection.
- No coverage decision. A status arrives as a prop; the components never derive one from speech.
- No auto-completion of action cues. Advancing a line, finishing a take or stopping the recording never resolves a required cue; only `onCueDone` does.
- No motion. There is no animation to suppress, so reduced-motion settings need nothing here.
- No speech, camera or storage access, so mounting them cannot affect the existing recording, draft, project or trim behavior.
- No device evidence. The fixtures and the harness replay hand-written timings.

## Reviewing without a camera

```bash
npm test                 # 64 tests, 24 of them for the prompter
npm run typecheck
```

Mount `PrompterHarness` from `src/development/prompter/prompter-harness.tsx` in any dev screen to step the clock, toggle "creator speaking" and force the delayed engine against all five fixtures.
It is guarded by `__DEV__` and renders nothing in a release build.

## Open acceptance checks

- The recorded quiet and noisy 18/20 measurement needs real sessions; `evaluatePromptTiming` replays such a log but does not produce one.
- A large-system-text pass on a physical phone has not been run.
- Alwin's reproduction and the camera integration itself remain open.

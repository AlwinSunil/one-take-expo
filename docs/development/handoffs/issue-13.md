# Handoff for #13: caption status for the capture lane

Owner of this change: Sabari (script and coverage lane).
Consumer: Alwin (capture lane, `src/app/camera.tsx`).

`src/app/camera.tsx` belongs to the capture lane, so nothing in it was edited.
This document describes the seam that was added instead, and the exact change the capture lane can apply when it wants it.

## What is available now

`src/hooks/use-live-captions.ts` exports a second, read-only hook:

```ts
import { useCaptionStatusForCapture } from '@/hooks/use-live-captions';

const { status, reason, message, retryable, retry, timing } = useCaptionStatusForCapture();
```

It takes no arguments and starts nothing.
It reads a module-level snapshot published by whichever `useLiveCaptions()` is currently mounted, through `useSyncExternalStore`, so calling it does not create a second recognition session or a second microphone stream.
When no caption session is mounted it reports `status: 'idle'` and a `retry` that resolves to `{ ok: false }`.

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `idle`, `preparing`, `listening`, `delayed`, `stopping`, `stopped`, `unavailable`, `interrupted` | The current recognition state. `delayed` is reported either by the native lag hysteresis or by measured stage timing. |
| `reason` | `CaptionFailureReason \| null` | Why recognition is unavailable or interrupted: `model-missing`, `model-corrupt`, `initialization-failed`, `unsupported-device`, `permission-denied`, `unknown`, `audio-focus-lost`, `audio-route-changed`, `lifecycle-interrupted`. |
| `message` | `string` | The native message behind the reason. Useful for a log or a details row; the reason is what the UI should key on. |
| `retryable` | `boolean` | `false` only for `unsupported-device`. |
| `retry` | `() => Promise<{ ok: true } \| { ok: false; message: string }>` | Prepares recognition again as a fresh caption session. The video recording is untouched. |
| `timing` | `CaptionTimingReport` | Per-utterance pause detection, recognition finalization and coverage processing in milliseconds, plus `delayed`. |

`status` is the presentation vocabulary, not the wire vocabulary.
The Kotlin module sends `error` or `interrupted`; the native status decides which of `unavailable` and `interrupted` is reported, and `classifyCaptionFailure` in `src/lib/live-caption-state.ts` only refines the reason.
The reason union itself is owned by `modules/one-take-captions/index.ts`, because it is the wire contract with `CaptionFailureReason.kt`; `src/lib/live-caption-state.ts` re-exports it for app consumers.

An interruption needs no action from the capture lane: the next `start()` creates a new session, which clears the reason.
`retry()` exists for the unavailable cases, where nothing will change without another preparation attempt.

### Retry resumes the take

`retry()` is not a fresh take.
It starts a new native caption session, but the utterances already recognized are kept and the new session's segment ids are namespaced `r<attempt>:<id>`, because the recognizer restarts its own ids from the beginning.
So a failure two utterances into a recording, followed by a retry, still saves those two utterances when the capture lane stops and persists the transcript.
`start()` with no arguments is unchanged and still begins a clean take.

### Timing clock contract

**Every timestamp passed to `noteCaptionTiming(utteranceId, stage, at)` is milliseconds on the audio-stream clock**, whose origin is the moment the native module reported `listening`.
That is the clock a segment's `t0`/`t1` already use.
Omit `at` to use now, which the hook converts for you.
Do not pass a wall-clock instant or a value anchored at `start()`: preparation happens before `listening`, so that would inflate pause detection by the whole preparation interval.
`streamElapsedMs(nowWallMs, streamStartWallMs)` in `src/lib/caption-timing.ts` is the conversion, and returns `null` before the stream exists.

The coverage lane (#16, #19) owns `pause-detected` and `coverage-verdict`.
Until it supplies them, `pauseDetectionMs` and `finalizationMs` are `null`, no timing-driven `delayed` can fire, and the `delayed` state on device comes only from the existing native lag hysteresis.

## Behavior change already merged into this lane's files

`<LiveCaptions>` now accepts three optional props: `reason`, `retryable` and `onRetry`.
Existing call sites keep working unchanged, because all three are optional.
Without them the overlay still names the failure from `status` alone, but it cannot offer the retry button.

`useLiveCaptions()` now returns `reason`, `retryable`, `timing`, `retry` and `noteCaptionTiming` in addition to its previous fields, and its `status` reports `unavailable` or `interrupted` where it previously reported `error`.

## Proposed camera.tsx change, for the capture lane to apply

```diff
-  const captions = useLiveCaptions();
+  const captions = useLiveCaptions();
@@
-        {(preparing || recording) && <LiveCaptions text={captions.text} isFinal={captions.isFinal} status={captions.status} />}
+        {(preparing || recording) && <LiveCaptions
+          text={captions.text}
+          isFinal={captions.isFinal}
+          status={captions.status}
+          reason={captions.reason}
+          retryable={captions.retryable}
+          onRetry={() => { void captions.retry(); }}
+        />}
```

A route that does not own the caption session, such as a future capture status bar or a multicam control, should use `useCaptionStatusForCapture()` instead of threading props.

## What this does not establish

Nothing here is device evidence.
The reason classification is covered by `tests/live-caption-state.test.mjs` and by `CaptionFailureReasonTest.kt`, and the recorded sessions in `tools/speech-fixtures/recordings/` are synthetic.
A real missing or corrupt model, a real audio-route change and a real audio-focus loss still need a phone run before the matching acceptance checks in [issue-acceptance.md](../../issue-acceptance.md) can be ticked.

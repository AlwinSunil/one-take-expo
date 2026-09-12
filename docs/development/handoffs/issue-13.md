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
The Kotlin module still sends `error`; `classifyCaptionFailure` in `src/lib/live-caption-state.ts` turns that plus its `reason` into `unavailable` or `interrupted`.

An interruption needs no action from the capture lane: the next `start()` creates a new session, which clears the reason.
`retry()` exists for the unavailable cases, where nothing will change without another preparation attempt.

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

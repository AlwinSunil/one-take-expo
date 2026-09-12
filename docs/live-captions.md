# Moonshine live captions

The React Native camera screen displays live English captions from a local Kotlin Expo module.
`expo-camera` owns CameraX video recording, including the saved video's audio.
The caption module owns a separate 16 kHz mono microphone stream and a serial Moonshine recognizer.
Caption text, utterance timing, finality and session status cross into JavaScript.
Recordings retain the live transcript with estimated timing.
The editor can recheck saved audio offline, correct captions, review coverage and cuts, and export a separate captioned video through the Kotlin Media3 module.
Saved-audio timing is tied to the decoded media clock; live timing remains explicitly approximate.

## Runtime provenance

Use Moonshine Tiny Streaming English from the `quantized_26_08_21` catalog.
The verified runtime is Moonshine `v0.1.5`, source commit `234f60faa0eb388b01cdf7e60aca232af37aefda`, rebuilt against Android ONNX Runtime `1.28.0`.
Inference uses the CPU.
The three rebuilt arm64 libraries and eight model files are pinned by SHA-256 in `tools/moonshine-artifacts.json`.
The stock Moonshine Android 0.1.5 runtime is unsuitable for this iQOO 15: its ORT 1.23.2 build crashed with SIGILL during Silero VAD in the prior benchmark.
Replacing ORT alone is insufficient because Moonshine itself links against versioned ORT symbols.

The original local benchmark and reproduction notes are in the Kotlin worktree at `/Users/sabari/.t3/worktrees/OneTake/t3code-4e41e1d3/docs/moonshine-streaming-benchmark.md`.
The verified native libraries are committed in `tools/vendor/onetake-moonshine-0.1.5-ort-1.28.0-arm64-v8a.tar.gz`.
The archive contains `libmoonshine.so`, `libmoonshine-jni.so`, `libonnxruntime.so`, and `SHA256SUMS`.
A fresh clone can extract this archive without rebuilding the native runtime.
See [runtime reproduction](research/moonshine-runtime.md) and `tools/rebuild_moonshine.py` for the pinned source build.
The optional `--with-small` flag stages the larger streaming comparison model; live captions still use Tiny.

From the repository root, extract and stage the verified artifacts before Gradle sync or building.
Python 3, `tar`, and internet access are required; the setup script downloads model files and the Java AAR and checks their pinned hashes:

```sh
mkdir -p tools/.cache/moonshine-runtime
tar -xzf tools/vendor/onetake-moonshine-0.1.5-ort-1.28.0-arm64-v8a.tar.gz \
  -C tools/.cache/moonshine-runtime
python3 tools/prepare_moonshine.py \
  --native-dir tools/.cache/moonshine-runtime/arm64-v8a --with-small
```

The script downloads the pinned model files, verifies every hash, and generates a Java-only Moonshine AAR with the incompatible stock native libraries removed.
Downloaded models, generated AARs, and extracted native binaries stay ignored by Git.
The compressed native runtime archive is tracked in Git.
The setup script verifies every extracted library against `tools/moonshine-artifacts.json` before staging it.

## Behavior

Starting a recording prepares captions first, then starts the video recorder.
Caption preparation failures are shown in the overlay and do not prevent video recording.
Partial text can change as additional speech arrives.
The native and Java transcription intervals are both 200 ms; this is an update setting, not a guaranteed speech-to-screen latency.
Each recording has a unique caption session ID and monotonically increasing caption sequence numbers.
The UI ignores events from old sessions and out-of-order caption revisions.
Stopping or backgrounding the recording stops the caption microphone and drains the stream.
Unmounting the screen removes JavaScript listeners and requests native cleanup.

## Recognition states and failure reasons

`src/lib/live-caption-state.ts` turns native status events into one of `idle`, `preparing`, `listening`, `delayed`, `stopping`, `stopped`, `unavailable` and `interrupted`.
An `unavailable` or `interrupted` state always carries a named reason: `model-missing`, `model-corrupt`, `initialization-failed`, `unsupported-device`, `permission-denied`, `unknown`, `audio-focus-lost`, `audio-route-changed` or `lifecycle-interrupted`.
`CaptionFailureReason.kt` names the same reasons on the Kotlin side and sends them with the status event; the JavaScript classifier falls back to matching the native message so an older installed build is still classified rather than shown as a generic error.
An unrecognized failure stays `initialization-failed` and a failure with no information stays `unknown`; no cause is inferred.

A missing or corrupt model, and an initialization failure, are recoverable through `retry()`, which prepares recognition again as a new caption session without touching the video recording.
A retry resumes the same take: the utterances recognized before the failure are kept, and the retried session's segment ids are namespaced `r<attempt>:<id>` so the recognizer restarting its ids cannot overwrite them.
`unsupported-device` is the only reason that reports `retryable: false`, and it is matched only against the exact device-support sentences the module emits, so an unsupported PCM encoding or channel count stays a retryable `initialization-failed`.
The native status owns the interrupted-versus-unavailable split; message matching only refines the reason.

`CaptionFailureReason.kt` also defines `audio-focus-lost` and `audio-route-changed` so the wire contract is complete, but no `AudioManager` focus listener raises them yet.
Today only a lifecycle stop emits `interrupted` from native. Adding the listener is an open device item.
An interruption needs no retry: backgrounding, an audio-focus loss or a route change reports `interrupted`, keeps the utterances already recognized, and the next start clears it.

The capture lane reads this through `useCaptionStatusForCapture()` without owning the session; see [the #13 handoff](development/handoffs/issue-13.md).

## Separate stage timing

`src/lib/caption-timing.ts` measures three durations per utterance and never merges them:

| Duration | Interval | Delayed above |
| --- | --- | --- |
| Pause detection | speech end to pause detected | not a delay signal on its own |
| Recognition finalization | pause detected to the final segment | 1500 ms |
| Coverage processing | final segment to the coverage verdict | 500 ms |

A line prefixed `caption-timing:` is logged as soon as recognition finalizes an utterance, with any stage that was never reported shown as `n/a`, and a second line once the coverage verdict completes it.
Each distinct line is logged exactly once; selection is by line identity, not by position, because utterances reach their coverage verdict in a different order from the one they were first observed in.
The line also carries `recognized_ms`, the speech end to final segment span, which is the only interval whose two endpoints both have a native source today.

When the most recently measured utterance is over either threshold, a `listening` session is reported as `delayed`; every other status already describes something more specific and is left alone.
`delayed` follows the latest measured utterance only, not the whole session, so one slow utterance does not pin the take to `delayed` after a later utterance has been measured as fast again.

**All stage timestamps are milliseconds on the audio-stream clock**, whose origin is the moment the native module reports `listening`.
A segment's end time is already on that clock.
Anything supplied by a caller must use the same clock; a wall clock anchored at `start()` would add the whole preparation interval to pause detection.
`streamElapsedMs(Date.now(), streamStartWallMs)` converts a wall-clock instant and returns `null` before the stream exists, so an observation that cannot be placed is dropped rather than recorded wrongly.

Only the final segment and the speech end have a native source today: the arrival of the revision that finalizes a segment, and that segment's own end time.
Pause detection and the coverage verdict are reported by this lane through `noteCaptionTiming()`; the module never estimates a stage it was not told about.
**`pauseDetectionMs` and `finalizationMs` therefore remain `null` on device until a pause source exists**, and the native lag hysteresis in `RecognitionLag.kt` is what actually drives the `delayed` state on a phone today.

## Replaying a recorded session

`tools/speech-fixtures/recordings/*.json` hold synthetic recordings of the events the bridge sends to JavaScript: a quiet read, a noisy read, an empty sub-second take, a missing-model failure and an audio-route interruption.
The format is documented in [the recordings README](../tools/speech-fixtures/recordings/README.md).
`replayCaptionSession` is the function the hook itself uses, so replaying a recording offline cannot drift from what the camera screen showed.

```sh
npm run samples
node --experimental-strip-types tools/replay-captions.mjs tools/speech-fixtures/recordings/noisy-read.json
```

`tests/caption-replay.test.mjs` replays every recording twice and asserts byte-identical merged output, and asserts that stale events - a revision that is not newer and an event from another session - change nothing when they are delivered late, redelivered or reordered among themselves.

The packaged native runtime targets arm64 Android API 26 or later.
Other platforms must remain able to record without this caption feature.
No microphone samples or recognized text are sent to a server by this module.
The app still has Internet permission for its existing development and other Expo capabilities.

## Verification

Run `node --experimental-strip-types --test tests/live-caption-state.test.mjs tests/caption-replay.test.mjs tests/caption-timing.test.mjs tests/caption-status-store.test.mjs` to check stale-session handling, revision handling, replay identity, failure reasons and the separated stage timing.
Run `npx tsc --noEmit` for the TypeScript integration.
After staging artifacts, build and install the Android app, then check the packaged native-library hashes against the manifest.

```sh
python3 tools/verify_moonshine_apk.py android/app/build/outputs/apk/debug/app-debug.apk
```

On the iQOO 15, select Assisted Mode, choose 1080p for a repeatable baseline, and record a known spoken passage for 30 seconds.
Verify caption text changes before Stop, save the recording, and play it back to confirm video and audio are present.
Repeat recording to exercise cleanup and ensure the previous transcript does not return.
Also check silence, backgrounding during preparation and recording, and a caption initialization failure.
The named recognition states still need their own phone checks: a quiet read, a noisy read, a sub-second empty take, a deleted model asset, a corrupted model file, an audio-route change and an audio-focus loss, each confirming the reported reason, the retry and the recovery on the next start.
The synthetic recordings under `tools/speech-fixtures/recordings/` exercise those code paths only; they are not evidence of the device behavior.
Compare sustained performance separately before claiming the earlier file-fed benchmark latency also applies to camera capture.
Human-speech accuracy, long-session thermal behavior, saved-caption alignment, and captioned export still require device validation.
The user performs recording tests personally.

## Workflow checks

Run `npm test`, `npm run typecheck`, `npm run samples`, and `python3 tests/speech-evaluation.test.py`.
Run the two native module unit-test tasks with the Android app build.
The app-level `android.packagingOptions.doNotStrip` setting preserves the exact native bytes; library-level packaging options alone do not.
The generated Java-only AAR retains the original `ai.moonshine.voice` manifest package required by Android's resource transform.
See [media export](media-export.md), [transcript workflow](transcript-workflow.md), and [speech evaluation](research/speech-evaluation.md) for contracts and remaining validation.
No live camera accuracy or latency result is claimed by build checks.

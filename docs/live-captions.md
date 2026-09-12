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
The verified native artifacts currently exist at `/tmp/moonshine-benchmark/android-harness/app/src/main/jniLibs/arm64-v8a`.
Those are machine-local build outputs, not remotely published dependencies.
A fresh machine needs the matching rebuilt runtime before it can reproduce this build.
See [runtime reproduction](research/moonshine-runtime.md) and `tools/rebuild_moonshine.py` for the pinned source build.
The optional `--with-small` flag stages the larger streaming comparison model; live captions still use Tiny.

Stage the verified artifacts before building:

```sh
python3 tools/prepare_moonshine.py \
  --native-dir /tmp/moonshine-benchmark/android-harness/app/src/main/jniLibs/arm64-v8a --with-small
```

The script downloads the pinned model files, verifies every hash, and generates a Java-only Moonshine AAR with the incompatible stock native libraries removed.
Downloaded models, generated AARs, and native binaries stay ignored by Git.

## Behavior

Starting a recording prepares captions first, then starts the video recorder.
Caption preparation failures are shown in the overlay and do not prevent video recording.
Partial text can change as additional speech arrives.
The native and Java transcription intervals are both 200 ms; this is an update setting, not a guaranteed speech-to-screen latency.
Each recording has a unique caption session ID and monotonically increasing caption sequence numbers.
The UI ignores events from old sessions and out-of-order caption revisions.
Stopping or backgrounding the recording stops the caption microphone and drains the stream.
Unmounting the screen removes JavaScript listeners and requests native cleanup.

The packaged native runtime targets arm64 Android API 26 or later.
Other platforms must remain able to record without this caption feature.
No microphone samples or recognized text are sent to a server by this module.
The app still has Internet permission for its existing development and other Expo capabilities.

## Verification

Run `node --test tests/live-caption-state.test.mjs` to check stale-session and revision handling.
Run `npx tsc --noEmit` for the TypeScript integration.
After staging artifacts, build and install the Android app, then check the packaged native-library hashes against the manifest.

```sh
python3 tools/verify_moonshine_apk.py android/app/build/outputs/apk/debug/app-debug.apk
```

On the iQOO 15, select Assisted Mode, choose 1080p for a repeatable baseline, and record a known spoken passage for 30 seconds.
Verify caption text changes before Stop, save the recording, and play it back to confirm video and audio are present.
Repeat recording to exercise cleanup and ensure the previous transcript does not return.
Also check silence, backgrounding during preparation and recording, and a caption initialization failure.
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

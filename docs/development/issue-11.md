# Recording reliability handoff

Issue: [#11](https://github.com/AlwinSunil/one-take-expo/issues/11).
Owner: NarayanaSabari.
Reviewer: Melvin0070.

## Behavior

Capture checks current camera/microphone permission and free storage before creating a recording.
Denied access offers a request action; blocked access offers Settings and refreshes on return.
The recorder has explicit preparation, recording, and saving phases, and repeated stop requests share one stop decision.
Backgrounding or leaving capture preserves interruption state rather than presenting a complete take.
The preview displays recovery text so a recoverable original cannot be mistaken for a successful full recording.
Optional caption failure labels record-only mode and preserves video/audio.
Low-space checks during recording request a recoverable stop before storage is exhausted.
The byte thresholds are conservative guardrails, not a promised recording duration or quality-dependent estimate.

## Native build integration

The baseline Android build failed because production and research export both declared `androidx.core.content.FileProvider` with distinct authorities and XML roots.
A dedicated `ResearchFileProvider` subclass keeps both providers and their original path allowlists separate in the merged manifest.
No path was broadened, no manifest override discarded an export provider, and no generated app source was edited.
This research-module integration change requires Melvin's review.

## Verification recorded so far

- Baseline JavaScript: 40 tests passed.
- Baseline TypeScript: passed after `npm ci --ignore-scripts`.
- Shared sample runner: 19/19 passed.
- Android debug build after the provider fix: passed for arm64-v8a.
- Native JVM tests: 9 caption tests and 5 media tests passed.
- Packaged Moonshine verification: 3 native library and 8 Tiny model SHA-256 hashes matched.
- I2501 / Android 16 / 1080p: baseline record, Home interruption, reopen preview/editor reproduced the missing interruption warning.
- I2501 with updated camera JavaScript: denied camera access showed Allow access; a blocked permission request showed Open Settings; permission restoration and return reopened capture.
- I2501 with updated camera JavaScript: Home interruption reopened preview with explicit recovery text and retained a 44,223,486-byte original.

The device checks used the rebuilt native baseline with working-tree JavaScript from Metro.
They must be repeated against the final PR revision before issue closure.
Private camera files and screenshots remain local.
Camera/microphone permissions and flags were restored after testing.

## Reproduction

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:samples
```

Stage verified Moonshine artifacts using `tools/prepare_moonshine.py`, set `JAVA_HOME` and `ANDROID_HOME`, then:

```sh
cd android
EXPO_NO_DOTENV=1 ./gradlew :app:assembleDebug :one-take-captions:testDebugUnitTest :one-take-media:testDebugUnitTest -PreactNativeArchitectures=arm64-v8a
cd ..
python3 tools/verify_moonshine_apk.py android/app/build/outputs/apk/debug/app-debug.apk
```

## Acceptance still open

Real camera-busy and nearly-full-storage recovery, actual calls and audio-route transitions, force-close during save, and named peer reproduction remain open.
A shared microphone source is not established by this change; the existing recognizer and recorder are separate consumers.
The required two-minute clock-based A/V sync report remains open.
No fixture, matching track duration, or successful build is claimed as proof of sync or microphone sharing.

Additional I2501 check: rapid preparation cancellation returned to ready; an immediate start/stop failure showed a recoverable error, and the next recording started successfully.
Two stop taps during that subsequent recording produced one normal preview.
This is a bounded UI check rather than a complete rapid-input stress matrix.

Review fixes reset camera readiness on blur and persist the returned cache URI before caption cleanup.
Native stop now rejects a terminal caption failure directly, including repeated stop calls, independently of React status rendering.
The caption JVM suite now passes 11 tests, including two terminal-result regressions; four focused capture checks pass.

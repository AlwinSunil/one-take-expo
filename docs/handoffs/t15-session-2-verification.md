# T1.5 Session 2 verification

Branch: `feat/t15-capture-signals`.
Draft PR: https://github.com/AlwinSunil/one-take-expo/pull/71.
Base: merged main `15d80d6`; PR #58 remains open and is not incorporated.
This report covers independent development implementation, not completed V1.

## Acceptance matrix

| Issue/check | Implemented evidence | Outstanding |
| --- | --- | --- |
| #64 source identity, seconds, unknown and gap states | Pure collector plus recording timer, fresh native binding identity, stop/background/route cleanup, bounded diagnostic ring and optional observation sink | Durable #65 sink/checkpoint integration; actual gaze directions unsupported by face-only engine |
| #64 stale/no-face/multiple-face/unsupported handling | Deterministic source/session/lens, pre-record/stale-frame, jitter, gap, overflow and sink-failure tests | Actual occlusion/glasses/low-light inference cannot distinguish these cases; all remain unknown |
| #64 five-session measurements | Five synthetic sessions retain unknown labels with explicit fixture provenance and no false jitter gaps | iQOO staged label confusion, measured cadence/drops, battery/thermal/recording impact, actual processor evidence |
| #69 tap-only bounded work | Inert controller, one recent-snapshot evaluation per tap, timeout, duplicate suppression, retry, cancellation and stale-session/lens rejection | Integrated physical camera/UI reproduction and named human review |
| #69 honest advice and intentional shots | Existing coach calibration/target/confidence/stability policy reused; fixtures cover actionable/all-good; current camera returns unavailable; intentional framing is explicitly off | Calibrated real scene cues, useful real-camera advice, large text and TalkBack acceptance |
| #61 camera seam | Existing prompter/manual/remote and required-action controls preserved | Session 1 merged follower/toggle/status/manual-reanchor implementation |
| #63 pickup seam | Existing requested line IDs and original/pickup source IDs preserved; durable pickup save retained | Point IDs/revision schema and owner-authored pickup/analysis integration |
| #66 Stop handoff | Root durable original copy now precedes awaited caption cleanup; pickup checkpoint preserved; full transcript save and direct editor route retained | Durable capture metadata, visible final analysis, retry/cancel job UI and producer integration |
| #62 baseline | Source tests, sample checks, Android build/JVM tests, pinned artifact verification and Android JS export | Complete both-mode device flows, A/V, recovery matrix and named human acceptance |

## Environment and commands

Host: Darwin arm64, Apple M5, Node v26.7.0.
All Expo/Gradle commands used `EXPO_NO_DOTENV=1`; no `.env` was read.
No package, lock, config, shared schema, editor or speech implementation file was changed.

- `npm ci --ignore-scripts`: passed; package/lock unchanged.
- Baseline `npm test`: 327 passed, zero failed.
- `npm run test:samples`: 19/19 passed.
- `npm run samples`: passed deterministic caption replay.
- `node --experimental-strip-types tests/t15-session2-replay.mjs docs/handoffs/evidence/t15-session-2/replay.json`: passed five synthetic sessions, zero jobs before taps, one evaluation per requested job, no automatic restart, unknown gaze and 1.001-second simulated cadence.
- `python3 tools/prepare_moonshine.py --native-dir /tmp/t15-moonshine/arm64-v8a`: staged and verified the repository's pinned Tiny runtime/model artifacts.
- From `android`, with Android Studio JBR and the local Android SDK: `EXPO_NO_DOTENV=1 ./gradlew :one-take-vision:compileDebugKotlin -PreactNativeArchitectures=arm64-v8a`: passed.
- With the same environment: `EXPO_NO_DOTENV=1 ./gradlew :app:assembleDebug :one-take-captions:testDebugUnitTest :one-take-media:testDebugUnitTest -PreactNativeArchitectures=arm64-v8a`: passed; 15 caption and 10 media JVM tests, zero failures/errors/skips.
- `python3 tools/verify_moonshine_apk.py android/app/build/outputs/apk/debug/app-debug.apk`: 3 native and 8 Tiny model SHA-256 hashes matched.

The native debug APK requires Metro and is not a self-contained final JavaScript acceptance build.
Its SHA-256 and test totals are in `evidence/t15-session-2/build.json`.
No app was installed, restarted or recorded during this session.
Read-only adb discovery found a connected I2501; that alone establishes no exclusive device testing window or acceptance.

## App-flow blocker and evidence limits

Used the chrome-devtools-axi skill with isolated browser session `t15-capture`.
Command: `EXPO_NO_DOTENV=1 npx expo start --web --port 8096`.
Opened `http://localhost:8096/camera?coachingDevelopment=1`.
The route fails before rendering because Metro cannot resolve Expo SQLite's `wa-sqlite.wasm`.
Evidence: `evidence/t15-session-2/web-baseline-blocker.png`.
Session 3 owns the Metro configuration fix; this lane did not alter it.
No rendered camera, large-text or screen-reader pass is claimed.

The gaze engine remains bundled ML Kit face detection 16.1.7, reporting `cpu-fallback` through the existing bridge.
It supplies no calibrated eye direction, gaze confidence, scene cue or sensor/PTS clock mapping.
No NPU execution or eye-contact accuracy is claimed.
Replay timestamps are synthetic, not measured camera cadence or recording impact.
Original audio/video correctness, ten-clap/long-recording acceptance, low-storage/process-death recovery and named human review remain pending.
Review by a Luna agent is a separate code pass, not cross-family or named human acceptance.

## Final source verification

Implementation reference: `8709a7f` on `feat/t15-capture-signals`.
`npm test`: 365 passed, zero failed/cancelled/skipped after final review.
`npm run typecheck`: passed.
Focused new coverage includes 13 gaze tests, 17 suggestion-job tests, 4 durable Stop tests and 4 delayed-binding tests.
`git diff --check`: passed.
The combined replay output is `evidence/t15-session-2/replay.json`.

Exact native environment prefixes were `EXPO_NO_DOTENV=1 JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ANDROID_HOME='/Users/sabari/Library/Android/sdk'`.
The vendored archive was extracted with `tar -xzf tools/vendor/onetake-moonshine-0.1.5-ort-1.28.0-arm64-v8a.tar.gz -C /tmp/t15-moonshine` before staging.
The native build ran before final JS integration; native source was unchanged, and final JS bundling is verified separately.

## Handoffs and review state

Initial proposal: `aa8ec85`.
Binding/Stop contract: `1fd8882`.
Gaze producer: `1d7c8d6`.
Camera/request-job integration: `8709a7f`.
Session 1 remote handoff inspected at `f097b0f`, PR #70.
Session 3 remote handoff inspected at `ccce524`, PR #72.
No unmerged implementation was copied, cherry-picked or merged.

Separate code review identified missing durable metadata integration, source clock placement, wall-clock source-ID collision and delayed native-start cleanup.
The latter three were fixed with a request-boundary anchor, Expo UUIDs and the compensating-stop helper/replays.
Durable metadata remains explicitly pending because the owner-authored #65 API does not exist yet.
The camera's temporary handoff must not be described as persisted gaze or complete Stop-to-analysis V1.

`EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/t15-capture-final-export`: passed after integration; generated a 6.7 MB Hermes bundle.
That dependency refresh found main at `15d80d6` and PR #58 open.
A later refresh found Session 1 implementation at `5947706` (PR #70), including the follower and toggle APIs; Session 3 remains at `ccce524` (PR #72).
Both remain unmerged; see the handoff latest producer refresh for exact APIs.
CI for `7bbbcc7` passed: https://github.com/AlwinSunil/one-take-expo/actions/runs/34729254239.
No merged dependency was available to incorporate or recheck.

GitHub checks for implementation `8709a7f` passed in runs `34728799750` and `34728801852`.
These are repository CI checks, not device or named human acceptance.

Initial hardening reference: `d291de7`.
Malformed evaluator payloads become unavailable; rejected partial native starts receive cleanup; the original cache-URI checkpoint remains before the durable copy for low-space recovery.
`EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/t15-capture-reviewed-export`: passed after final hardening.
The final Hermes bundle SHA-256 is recorded in `evidence/t15-session-2/build.json`.

Final reviewed implementation: `3bd5a01`.
The exported retry API requires a fresh evidence snapshot and never replays the old frame; stale results retain Dismiss.
The final separate signal review found no additional material gaze defects; both reported suggestion issues were fixed.
Known durable-metadata and real-device/human acceptance gaps remain open.

`EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/t15-capture-delivery-export`: passed for final reviewed source `3bd5a01`; final hash recorded in `build.json`.

# Melvin's Milestone 1 implementation

Branch: `feat/melvin-milestone-1`; draft PR #49. Issues #14, #17, #20, #21 and #27 in **01 · Tier 0** remain open for integration, device acceptance and named review. Alwin's capture work is separate from the receiving functionality implemented here.

## Implemented in this lane

- **#14 — persistence:** Optional take/recording ledgers retain legacy JSON. Source-relative take boundaries and namespaced pickup captions survive reopening. SQLite journals distinguish copying from validated, ready media and recover interrupted saves. Restored files regain availability. Concurrent stale editor saves cannot discard a newly attached recording.
- **#17 — immediate review:** Production native `CompositionPlayer` uses the same multi-source composition as export, without rendering first. Latest suitable takes play in script order, indivisible multi-line takes are deduplicated and conflicting selections are flagged. Playback requests remain stable while playing. Original/manual-trim access and corrupt-media fallback remain available.
- **#20 — coverage and pickups:** Review shows selected/alternative/scratched takes and separate action status. It saves needed-line requests and can attach an explicitly selected saved pickup recording to the same project, preserving both originals and putting takes in script order. Storage exposes begin/complete/cancel pickup APIs for the capture owner; editor refreshes on return. Single-source audio rechecks are gated after multi-source attachment to prevent erasing pickup captions.
- **#21 — export:** Reviewed source segments and their source-local captions feed the shared native composition. Output is 720×1280 SDR H.264/AAC with aspect-ratio fitting and readable captions. Raw/manual/cut export matches the selected review mode. Progress, cancellation, interrupted-job recovery, missing-output retry, open, gallery and share paths are implemented. All Media3 requests now use the existing Expo video/research 1.9.0 version.
- **#27 — deletion:** Confirmation offers app-only deletion or deletion including app-created gallery copies. The choice survives interruption. Tombstones reject late work; cancellation waits for file writers. Private originals, pickup media, registered attachments, cache-source files, export history, drafts and journals are removed while other projects' referenced files are protected. Native gallery copy/delete operations preserve associations on failure for retry. Externally shared copies remain outside app control.

## Capture and review handoffs

- [Storage/pickup receiving API](handoffs/melvin-tier0-storage.md): exact lifecycle calls, cancellation barrier, durable saves, namespace rules and deletion semantics.
- [Review return and native preview](handoffs/melvin-tier0-review.md): project fields, navigation and review behavior.

Alwin still owns camera permissions, interruptions, recorder cancellation and calling these receiving APIs with real take evidence. No camera/script route was edited or duplicate recorder introduced. Sabari's available script/coverage handoff shapes were inspected; his unmerged branch changes were not silently merged into this PR.

## Actual validation

| Command/check | Result |
| --- | --- |
| `npm test` | 69 passed |
| `npm run typecheck` | Passed |
| `npm run test:samples` | 19 passed |
| `EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/one-take-tier0-bundle` | Passed |
| `JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ANDROID_HOME='/Users/melvin/Library/Android/sdk' ./android/gradlew -p android :one-take-media:testDebugUnitTest --console=plain` | Native production code compiled; 6 JVM tests passed |
| Home → Sample sessions · Dev → Run on-device storage checks | 17/17 passed on iQOO I2501, Android 16, serial `10BFAT1U1Q000XP` |

The 17 storage checks use dedicated fixture projects with real SQLite/filesystem operations: legacy reopen, missing-source failure, coverage invalidation, independent pickup copy, idempotent completion, failed-cancellation retry, concurrent save/deletion, replay of an interrupted copy journal and preservation of another project/source. They use the existing installed debug APK with current Metro JavaScript. [Summary screenshot](evidence/milestone-1/storage.png), [detail screenshot](evidence/milestone-1/storage-detail.png), [captured results](evidence/milestone-1/storage-results.json).

The new development-only **Tier 0 media checks** panel exercises production multi-source native preview, eight-second export, cancellation, missing-source rejection, gallery copy/deletion and a 120-second export. It writes `files/research/tier0-media-report.json`. Its code is bundled/typechecked, but it has **not** run against the new native module in a rebuilt APK.

## Native build prerequisite

All eight Tiny Streaming English `quantized_26_08_21` model files are downloaded to the ignored staging cache and match the pinned manifest. Models are not native libraries.

`tools/rebuild_moonshine.py --execute --strict-output` successfully compiled the pinned Moonshine source against ORT 1.28.0 with the specified NDK/CMake, but failed output hash verification. ORT matches; the two Moonshine binaries do not:

| File | Rebuilt SHA-256 |
| --- | --- |
| `libmoonshine.so` | `0da3046c46f7792c35e7f92860eb11a5f951fcad7a2571ae67c2e32af280fdb4` |
| `libmoonshine-jni.so` | `34516cb474e76da98370e64c8d1ca7a80463c588133490627dd7cb2ec37a3bc0` |

`prepare_moonshine.py` consequently refuses staging. No pinned hashes or guards were changed. The recorded verified libraries are machine-local to Sabari at `/tmp/moonshine-benchmark/android-harness/app/src/main/jniLibs/arm64-v8a`, per `docs/live-captions.md`. Those binaries, or a speech-owner-reviewed reproducible artifact update, are needed for the integrated APK build.

## Remaining acceptance

A fresh APK must exercise native multi-source playback/export, first-frame timing, two-minute A/V sync, background/foreground, force-stop recovery, permission denial, low storage and native active-export/gallery deletion. Current JVM and storage results do not prove these behaviors. The new composition has not yet been visually verified on device.

Alwin's direct record → pickup → same-project return, Sabari's named reproduction, both peers' shared-handoff/deletion review and the five-session #34 gate remain separate requirements. This implementation must not be described as closing all acceptance boxes or completing the milestone.

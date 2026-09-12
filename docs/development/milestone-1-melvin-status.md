# Melvin's Milestone 1 implementation

Branch: `feat/melvin-milestone-1`. Issues: #14, #17, #20, #21 and #27 in **01 · Tier 0**. These issues remain open; this is implementation progress, not integrated milestone acceptance.

## Implemented

- **#14:** Optional persisted take evidence and pickup requests preserve legacy project JSON. Original audio boundaries survive reopening. Missing take files cannot establish coverage, and restoring a file restores its availability. Saved take URIs follow the durable original. Project rows show coverage and recovery actions.
- **#17:** The review screen derives latest suitable single-recording takes in script order and starts playback without rendering. Whole takes are deduplicated; conflicting multi-line selections and multiple source recordings produce an explicit fallback. Cut updates wait for a playback pause. Original and manual trim preview remain available.
- **#20:** Review shows selected, alternative and scratched attempts, separate action confirmation, pending coverage and a durable needed-line pickup list. The UI explicitly states that recording into the same project still needs the capture handoff.
- **#21:** Export can open its output, recover interrupted queued jobs and detect missing completed files. Preview mode determines the export request; automatic cuts require explicit preparation and acceptance. Action cues and standalone scratch commands are filtered consistently from preview/export captions. Export history is associated with its project.
- **#27:** Projects offers confirmation and retryable deletion. Durable tombstones prevent late saves; deletion waits for in-flight saves/exports before removing app-private files. Other projects' referenced files are protected. Gallery and externally shared copies explicitly remain.

## Actual validation

Run from the repository root:

| Command/check | Result |
| --- | --- |
| `npm test` | 53 passed |
| `npm run typecheck` | Passed |
| `npm run test:samples` | 19 passed |
| `EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/one-take-m1-bundle` | Passed |
| `JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ANDROID_HOME='/Users/melvin/Library/Android/sdk' ./android/gradlew -p android :one-take-media:testDebugUnitTest --console=plain` | Media Kotlin compiled; 5 JVM tests passed |
| Home → Sample sessions · Dev → Run on-device storage checks | 14/14 passed on iQOO I2501, Android 16, serial `10BFAT1U1Q000XP` |

The storage checks use dedicated fixture projects and real SQLite/filesystem operations. They cover legacy reopen, missing-source failure, missing-media coverage, cancellation failure/retry, registered file removal, late-save rejection, concurrent save/deletion and preservation of another project. The first device pass caught missing `await` on SDK 57's asynchronous file copy/move; the fix and cancellation barrier passed the rerun. [Screenshot](evidence/milestone-1/storage.png) and [visible device results](evidence/milestone-1/storage-results.json).

The device used its existing installed debug APK with updated JavaScript from Metro. It did **not** run the new native export bridge. Full `:app:assembleDebug` failed because the speech lane's pinned Moonshine AAR/model/native files are not staged (`modules/one-take-captions/android/build.gradle`). No build guard was bypassed and no speech runtime was substituted.

## Remaining acceptance and handoffs

- Alwin/Sabari integration: route stop-to-review with final take evidence, consume `pickupRequest`, merge pickups into the same project without replacing existing media, and register active capture work for deletion. Optional `Project.takes` reuses the existing `TakeEvidence` type; `unavailableTakeIds` is derived availability, not a take verdict.
- Multi-source pickup playback/export needs its production composition handoff. Single-source JSX seek playback has no new stop-to-first-frame or seamless A/V device measurement.
- Stage the verified speech artifacts, rebuild the integrated APK and validate new native export open/delete methods. Existing Media3 requests differ between production export (1.11.0) and Expo video/research (1.9.0); integrated runtime compatibility remains unverified.
- Two-minute A/V sync, background/foreground, permission denial, low storage, force-stop recovery and native active-export deletion need the rebuilt phone app. Gallery-copy deletion is not implemented; the confirmation accurately says those copies remain.
- Sabari's named review, both peers' shared-handoff/deletion review and the five-session #34 acceptance gate remain required. No issue was closed or external message sent.

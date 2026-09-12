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

## Fresh native runtime and device checks

The verified Moonshine runtime update from PR #51 is now merged into this branch. The integrated Android build succeeds, and all **19 pinned APK runtime/model files** were verified. The earlier local rebuild hash mismatch is no longer the build prerequisite; the speech-owner-provided verified runtime is used. This validates packaging, not recognizer performance or NPU execution.

The fresh debug APK was exercised on the physical **iQOO I2501, Android 16, serial `10BFAT1U1Q000XP`**. The development media panel calls the production native module with synthetic local media; it does not substitute for Alwin's real recording integration.

| Fresh APK check | Observed result |
| --- | --- |
| Native multi-source preview | Native preview rendered on the phone; editor fixture with pickup media loaded a two-line, eight-second sequence |
| Eight-second, two-source export | Completed in **1,051 ms**; this is export completion time, not stop-to-first-frame latency |
| Active-export deletion | Job was checked in `running` state before deletion; cancellation/deletion settled |
| Missing source | Rejected with a missing-file error |
| Gallery lifecycle | Saved app-created MediaStore row `165`; native output/gallery deletion completed and a subsequent MediaStore query returned no result |
| 120-second background export | Completed while the app was backgrounded |
| Force-stop recovery | The same job changed from `running` before force-stop to `interrupted` after reopening; retry subsequently completed |

Evidence: [short export and deletion report](evidence/milestone-1-native/short-export.json), [background jobs](evidence/milestone-1-native/background-jobs.json), [before force-stop](evidence/milestone-1-native/interrupted-before.json), and [after reopening](evidence/milestone-1-native/interrupted-after.json). The gallery-query check and pre-deletion running-state check supplement the panel report. These are fixture device checks, not a complete real-creator acceptance run.

## Render inspection and known cadence limitation

The phone's unmodified 120-second export was pulled for host FFmpeg decoding and comparison with its synthetic source. [Render validation](evidence/milestone-1-native/render-validation.json) records the input hashes, streams, frame observations, 60 audio comparison windows across 15 cycles, and frame timestamps. The output displays at **720×1280** through rotation metadata; the encoded video is 1280×720 H.264, with AAC audio. Inspected [first-source frame](evidence/milestone-1-native/frame-001.png) and [second-source frame](evidence/milestone-1-native/frame-005.png) contain the expected scene and readable caption.

The first/last voiced windows in each retained phrase correlate with the expected source at **0.87609 or higher**, with **20.5–34.0 ms** measured audio lag. This supports preservation of the synthetic speech sequence through the two-minute output. The exploratory audio-to-audio measurement is not a human lip-sync test or a direct audio-to-video landmark comparison.

A separate cadence problem remains: the 120-second output contains **3,570 decoded frames**, with a **100 ms inter-frame gap at each of the 15 first-source → second-source cuts**. The source itself has regular approximately 33.33 ms spacing. Two nominal frames are absent at each such boundary, holding the previous image for 100 ms. Source packet ordering and Media3 1.9.0 clipping code strongly indicate B-frame termination at the clip endpoint; this is a source-code/packet-order diagnosis, not an instrumented decoder trace. No verified app-only correction has been applied. Padding clips would change the selected audio/video interval and is not an accepted fix. This limitation prevents claiming frame-continuous cut acceptance despite the small measured audio lag.

## Remaining acceptance

Alwin's direct record → review → targeted pickup → same-project return still needs integration with real take evidence. Actual recording-stop-to-first-frame latency, human on-device playback/lip-sync review, denied-permission behavior and low-storage recovery remain unverified. The B-frame cut-boundary cadence problem needs a validated fix or an explicit product/reviewer decision; it is not hidden by the passing export lifecycle checks.

Sabari's named reproduction, both peers' shared-handoff/deletion review and the five-session #34 gate remain separate requirements. The native build and fixture device evidence have advanced; they do not close all acceptance boxes. Issues and the milestone remain open.

### Final editor validation

On the fresh Android build, the synthetic original-plus-pickup fixture loaded 2/2 spoken lines and played an eight-second native cut. Fixed the nested Android review scroller that hid lower controls; preparation, acceptance, actual editor export and the system share chooser now work. No share was sent. Output and chooser evidence are in `evidence/milestone-1-native/`. The remaining B-frame cadence defect is tracked in [#53](https://github.com/AlwinSunil/one-take-expo/issues/53). This is still Melvin-owned follow-up work, not an Alwin dependency.

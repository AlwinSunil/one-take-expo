# F3: instant review and captioned export research (#9)

This is an isolated Android experiment, not a production editor or export pipeline. The existing camera, projects, preview and filmstrip remain the product path. Native bridge: `modules/one-take-media-research`; JavaScript contract: `src/features/media/native.ts`. Actual [iQOO evidence](device-evidence.md) is recorded separately; build success alone does not establish playback, A/V sync or acceptance.

## Recommendation to A/B

Keep review separate from rendering. On Android, pass a saved local recording and a cut list to a native `CompositionPlayer`; use the same `Composition` with `Transformer` only when the user requests an exported file. This keeps captions and cut geometry consistent without making review wait for encoding. Media3 1.9.0 is pinned to the **installed** expo-video 57.0.4 dependency (`node_modules/expo-video/android/build.gradle`), not copied from newer online examples. Google requires all Media3 modules to use the same version. CompositionPlayer is experimental: retain the working Expo preview/filmstrip and treat this as a candidate until device and reviewer evidence is complete. [Transformer setup](https://developer.android.com/media/media3/transformer/getting-started), [CompositionPlayer](https://developer.android.com/media/media3/transformer/compositionplayer), [1.9.0 source](https://github.com/androidx/media/blob/1.9.0/libraries/transformer/src/main/java/androidx/media3/transformer/CompositionPlayer.java).

The handoff is a JSON array of `{ uri, start, end, caption? }`. Times are seconds on the original recording; end is exclusive. Two non-adjacent source intervals become adjacent output intervals. Native code reads original media duration (required by CompositionPlayer), rejects absent files and invalid/out-of-range intervals, then applies the same clipping and caption bitmap to review and export. The experimental canvas is 720 × 1280 SDR with preserved aspect ratio; H.264/AAC MP4 export retains source audio. Long captions are rejected instead of silently cut off. No speech transcription, word-boundary correction, multicam, or production edit persistence is introduced.

## Options and limits

| Option | Platforms / license | Appropriate role and limits | Local setup |
| --- | --- | --- | --- |
| Expo SDK 57 `expo-video` | Android, iOS, tvOS, web; Expo MIT | Existing playback UI. Its documented player API has playback/seek controls, not a caption-burning multi-cut export API. A JS sequence of seeks must be measured for transition gaps. | Already installed; `npx expo install expo-video` for a fresh app. |
| Expo FileSystem, MediaLibrary, Sharing | FileSystem: Android/iOS/tvOS; MediaLibrary: Android/iOS/tvOS; Sharing: Android/iOS/web; Expo MIT | File ownership, gallery and OS share handoff, not video composition/encoding. Web sharing cannot share a local file URI in the same way as native. | `npx expo install expo-file-system expo-media-library expo-sharing` only if adopting those adapters; this experiment uses existing filesystem support and native gallery/share adapters. |
| Media3 CompositionPlayer + Transformer 1.9.0 | Android; Apache-2.0 | Shared composition for immediate preview and exported MP4. Native codec/device constraints and experimental preview API require real-phone checks. | Local Expo module and Android rebuild below. Not available in Expo Go. |
| Apple AVFoundation composition/export | Apple platforms; Apple SDK terms | Candidate equivalent for iOS; separate native module and device validation needed. This experiment does not provide an iOS implementation. | Apple toolchain and local iOS module; no iOS package added. |

Primary sources: [SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/), [Video](https://docs.expo.dev/versions/v57.0.0/sdk/video/), [FileSystem](https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/), [MediaLibrary](https://docs.expo.dev/versions/v57.0.0/sdk/media-library/), [Sharing](https://docs.expo.dev/versions/v57.0.0/sdk/sharing/), [Expo license](https://github.com/expo/expo/blob/main/LICENSE), [Media3 license](https://github.com/androidx/media/blob/1.9.0/LICENSE), [AVMutableComposition](https://developer.apple.com/documentation/avfoundation/avmutablecomposition), [AVAssetExportSession](https://developer.apple.com/documentation/avfoundation/avassetexportsession). Sources read September 13, 2026. Apple documentation establishes an alternative to investigate, not tested parity.

## Background and recovery contract

Export runs in an Android foreground service, with a persistent notification while active. API 35+ uses `mediaProcessing`; older versions use `dataSync`. Foreground service does not mean unlimited or guaranteed execution: Android limits media processing time (normally six hours per 24-hour window), restricts background starts, and may stop the process. The app starts export from foreground interaction. No boot receiver or automatic resumption is installed. [Android foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types#media-processing).

| Condition | Experiment behavior | Evidence needed |
| --- | --- | --- |
| Cancel | Cancel Transformer, remove partial output, persist `cancelled`; source unchanged. | Cancel a long fixture before completion; inspect state/files on iQOO. |
| Process death or force-stop | On next job read, prior-process `queued`/`running` work becomes `interrupted`; partial output is removed. Retry creates a new job from the source, not a byte-level resume. | Force-stop during export, relaunch, inspect state and retry. |
| Missing input | Reject before creating a job; display recoverable missing-recording error. | Rename only the dedicated research fixture, invoke export, restore it. |
| Low storage | Refuse startup below 64 MiB available; mid-export errors remove partial output and report failure. This fixed reserve is a research guard, not a sufficient size estimate for arbitrary videos. | Low-space execution remains unverified unless explicitly recorded; do not fill the user's phone. |
| Completed output missing | Job becomes failed with re-export guidance. | Remove only a dedicated research output, refresh jobs. |
| Gallery copy fails / deletion during copy | Remove pending MediaStore entry; never publish an incomplete video. Project deletion prevents late publication. | Dedicated fixture only; deletion needs owner review before production adoption. |

`saveToGallery` requires Android 10+, writes a pending MediaStore item, then publishes on successful copy. `shareExport` opens the system chooser using a granted FileProvider URI. A chooser appearing is evidence of handoff readiness, not evidence another app received the video. The deletion bridge remains experimental and must not be connected to production project deletion without the shared ownership review. Concurrent repeated gallery saves are not a supported harness action; disable its button while saving.

## Build and reproduce on the connected iQOO

The user approved Media3 and its native rebuild. From repository root, after dependencies are installed and Android is generated:

```sh
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' \
ANDROID_HOME='/Users/melvin/Library/Android/sdk' \
./android/gradlew -p android :app:assembleDebug --console=plain
adb -s 10BFAT1U1Q000XP install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s 10BFAT1U1Q000XP reverse tcp:8081 tcp:8081
npm start -- --localhost
```

The module is autolinked through `expo-module.config.json`. Its Gradle dependencies are `media3-transformer`, `media3-effect`, and `media3-ui`, all 1.9.0. The manifest adds the export foreground service and a private FileProvider. No host/emulator behavior tests substitute for iQOO tests. Native compilation succeeded after fixing the overlay list generic and adding original duration metadata; device findings belong in the evidence document.

The dedicated fixture is `Paths.document/research/media-sample.mp4`: 12 seconds with speech/video, supplied by the research harness. Use source cuts `[0,4)` and `[8,12)`, with one caption per segment. Expected output is approximately eight seconds, with the middle four seconds absent. A/B may substitute another local file URI while retaining the same shape; reselect speech-safe boundaries for other recordings.

1. Open the development research harness. Play without exporting; capture `firstFrameMs` separately from export elapsed time. Listen for both selected segments and a clean transition.
2. Export; wait for completed state. Play the resulting MP4 on iQOO, checking readable captions, first/last spoken words, transition and end sync. Record codec/output duration and attach the actual output sample or a UX recording. Synthetic fixture checks alone do not prove arbitrary recorded speech boundaries.
3. Run missing source, cancellation and interruption/retry paths above. Preserve the source and ordinary projects throughout.
4. Check the original camera/draft/project/trim paths after integration. Record phone model, OS, actual processor, app version/build and fixture configuration.
5. Named reviewer @NarayanaSabari must reproduce behavior, edge cases and accessibility; both other owners review shared handoffs/deletion paths. Agent review does not replace this requirement.

Device preview/export, background, cancellation, interruption/retry, gallery/share, container results and a passing on-device decoded PCM comparison of retained synthetic phrase boundaries are now recorded in [device evidence](device-evidence.md), with the actual captioned MP4 attached. Perceptual human-speech/A/V verification, low-storage fault injection and named human review remain unverified. Do not infer later-feature production acceptance from this research experiment.

### On-device container inspection

The optional research methods `inspectSource(fileUri)` and `inspectExport(completedJobId)` return JSON from Android `MediaMetadataRetriever` and `MediaExtractor`. Reports include file size, duration, dimensions, rotation and each track's MIME, declared duration, sample count, and minimum/maximum presentation timestamps in microseconds. Run these through the connected app and record their returned values with device evidence. They do not use host media tools. Sample timestamps describe compressed packets; the last timestamp is a packet's start, not its end. AAC priming/padding and video frame duration can make track spans differ. This probe confirms container streams and timing structure only; it does not decode speech, prove lip sync or establish that no syllable was clipped.

### Coexistence with the production module

During integration, the isolated experiment was renamed to `modules/one-take-media-research` / `OneTakeMediaResearch` so it can coexist with the independently shipped production `modules/one-take-media` module. Its Kotlin namespace, Expo registration, FileProvider authority and XML resource name are distinct. Research output/job directories retain their original names, preserving the recorded fixtures; production uses its own `exports` directory. Device evidence above predates this registration-only rename; the integrated APK requires a rebuild and smoke check.

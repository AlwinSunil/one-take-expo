# Production native media evidence

Physical iQOO I2501 / SM8850, Android 16, serial `10BFAT1U1Q000XP`; fresh One Take debug APK 1.0.0 (1), with the PR #51 runtime update and all 19 pinned runtime/model files verified. Local date: 2026-09-13; report timestamps use UTC. Media3 1.9.0 uses Android codecs and graphics; codec hardware utilization was not profiled, and these checks establish no NPU inference result.

The production module now shares one 720×1280 SDR composition between immediate `CompositionPlayer` preview and background `Transformer` export. Integration fixes include separate production/research FileProvider classes, version-matched Media3 artifacts, foreground-service types for API 35+ and older versions, replay after end, cancellation waiting for file writers, missing-output/interrupted-job recovery, and persisted gallery-copy ownership with serialized save/delete operations. Older Android fallbacks were compiled but not exercised on this phone.

## Fixture and observed lifecycle

The dedicated 12-second synthetic source has a timecode, three colored scenes and padded synthetic speech. Two local source paths supply `[0,4)` followed by `[8,12)`. Repeating that pair 15 times produces the 120-second test. No user project media was used.

| Check | Evidence/result |
| --- | --- |
| Immediate preview | Parent observed a 206 ms first frame, end and replay; this is fixture load-to-first-frame, not recording-stop latency. |
| Eight-second export | [Short report](short-export.json): completed in 1,051 ms; original retained. |
| Active cancellation/deletion | Parent checked the job was running before deletion; cancellation settled and the private output was absent. |
| Missing source | Failed with a missing-file error; no completed output claimed. |
| Gallery | Short report records app-created row `165`; parent separately queried MediaStore after deletion and found no row. |
| Background | [Job records](background-jobs.json): 120-second export completed while the app was Home/backgrounded. |
| Process death | Same job is running [before force-stop](interrupted-before.json), interrupted [after reopening](interrupted-after.json); subsequent retry completed. |

## Render inspection and validated cadence correction

[Render validation](render-validation.json) records hashes and host FFmpeg inspection of the unmodified device-produced MP4. Video duration is 120.000 seconds; AAC mono audio is 120.067483 seconds at 22,050 Hz. H.264 is encoded 1280×720 with rotation metadata, displaying at 720×1280. Inspected frames show the expected [first scene/caption](frame-001.png) and [second scene/caption](frame-005.png), with readable lower-third text.

Exploratory audio-to-audio correlation checked first/last voiced windows of both retained phrases across all 15 cycles: 60 windows, minimum correlation 0.87609, measured lag 20.5–34.0 ms. This supports preservation of synthetic phrase timing, not human lip sync or direct audio/video landmark synchronization. Decoding occurred on the host, not the phone.

The pre-fix output had 3,570 decoded frames and fifteen **100 ms inter-frame gaps**, one at each first-source → second-source boundary. The source has regular approximately 33.33 ms spacing and includes the two missing B-frames. Its compressed packet order encounters the 4.0-second reference frame before the retained 3.933333/3.966667-second B-frames. [Media3 1.9.0 clipping code](https://github.com/androidx/media/blob/1.9.0/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/source/ClippingMediaPeriod.java#L364-L373) terminates reading at the first compressed timestamp reaching the cut endpoint. This source-code/packet-order diagnosis motivated the scoped correction below; it is not an instrumented decoder trace.

The production preview and export now use `DecodeAheadMediaSourceFactory` for H.264/HEVC video. Retained frame timestamps and audio clipping remain unchanged. Post-cut reference packets receive a pre-start decode-only timestamp, letting trailing retained B-frames reach the decoder without displaying the reference packets. Reading stops after 32 consecutive outside-cut packets (beyond the codecs’ maximum 16-picture reordering depth); other codecs retain the original path. This does not pad the selected cut or transcode the source into an intermediary.

A fresh physical-phone export with the correction produced **3,600 decoded frames**, **zero gaps over 50 ms**, and a maximum interval of **33.334 ms** across all 15 splices. The formerly absent [3.933-second source frame](decode-ahead-restored-frame.png) is present with the correct caption. [Validation JSON](decode-ahead-validation.json) records the new output hash and unchanged 120.000-second video/120.067483-second audio durations. Decoded 2 kHz mono PCM was byte-identical to the pre-fix output; the 60-window correlation/lag results above are unchanged.

With the same fresh APK, [native preview](decode-ahead-preview.json) rendered its first frame in 129 ms, ended at eight seconds and replayed. [Lifecycle checks](decode-ahead-lifecycle.json) covered a 1,078 ms short export, running-job cancellation, missing source, missing completed output with same-ID retry, and gallery row `168` save/delete. Ten JVM tests passed, including retained B-frame timestamps, bounded read-ahead, peeking, reset, partial-buffer loading positions and synthetic end-of-stream readiness. Device cadence evidence is specifically H.264 on this phone; HEVC breadth and other decoder implementations are not established by it.

The final buffering/EOS safeguards were then exercised with a separate **44,707,521-byte (~43 MiB), 12-second H.264 B-frame source**. Its 120-second device export again contains **3,600 frames**, zero intervals over 50 ms and a maximum interval of 33.334 ms. Audio comparisons against this source retained the same 0.87609 minimum correlation and 20.5–34.0 ms lag across all 60 windows; video/audio durations remain 120.000/120.067483 seconds. [Large-source validation](large-decode-ahead-validation.json) records the distinct source/output hashes and stream details. This exercises progressive local input beyond the small original fixture, without changing user footage.

Human on-device lip-sync acceptance, actual recording-stop latency, low-storage/ENOSPC recovery, denied gallery permission, real capture/pickup integration remain separate acceptance gates. Peer review is deferred at the user’s request for development velocity. Successful fixture lifecycle tests do not close those gates.

### Editor handoff check

The development panel's synthetic pickup fixture loaded both recordings as an eight-second native review sequence (2/2 spoken lines covered). Android exposed an unreachable-controls bug in the nested review scroller; review now uses the editor's single scroll surface, with a scrolling wrapper for missing-media recovery. Preparing and accepting the synthetic cuts, exporting through the actual editor, and opening Android's share chooser succeeded. `editor-export.mp4` is that output; `editor-share.png` shows the chooser (nothing was sent). Open video reached the system app chooser; external playback was not established because the selected third-party player requested library access.

`preview-screen-recording.mp4` records native synthetic preview. The earlier cadence defect is tracked in [#53](https://github.com/AlwinSunil/one-take-expo/issues/53); the newer decode-ahead evidence above supersedes the historical defective export for this regression.

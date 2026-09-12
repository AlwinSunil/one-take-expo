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

## Render inspection and cadence defect

[Render validation](render-validation.json) records hashes and host FFmpeg inspection of the unmodified device-produced MP4. Video duration is 120.000 seconds; AAC mono audio is 120.067483 seconds at 22,050 Hz. H.264 is encoded 1280×720 with rotation metadata, displaying at 720×1280. Inspected frames show the expected [first scene/caption](frame-001.png) and [second scene/caption](frame-005.png), with readable lower-third text.

Exploratory audio-to-audio correlation checked first/last voiced windows of both retained phrases across all 15 cycles: 60 windows, minimum correlation 0.87609, measured lag 20.5–34.0 ms. This supports preservation of synthetic phrase timing, not human lip sync or direct audio/video landmark synchronization. Decoding occurred on the host, not the phone.

The output has 3,570 decoded frames and fifteen **100 ms inter-frame gaps**, one at each first-source → second-source boundary. The source has regular approximately 33.33 ms spacing and includes the two missing B-frames. Its compressed packet order encounters the 4.0-second reference frame before the retained 3.933333/3.966667-second B-frames. [Media3 1.9.0 clipping code](https://github.com/androidx/media/blob/1.9.0/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/source/ClippingMediaPeriod.java#L364-L373) terminates reading at the first compressed timestamp reaching the cut endpoint. This strongly explains the missing frames, but is not an instrumented decoder trace. No verified fix is applied; padding the cut would change the reviewed audio/video interval. Do not claim frame-continuous cuts.

Human on-device lip-sync acceptance, actual recording-stop latency, low-storage/ENOSPC recovery, denied gallery permission, real capture/pickup integration and named peer review remain outstanding. Successful fixture lifecycle tests do not close those gates.

### Editor handoff check

The development panel's synthetic pickup fixture loaded both recordings as an eight-second native review sequence (2/2 spoken lines covered). Android exposed an unreachable-controls bug in the nested review scroller; review now uses the editor's single scroll surface, with a scrolling wrapper for missing-media recovery. Preparing and accepting the synthetic cuts, exporting through the actual editor, and opening Android's share chooser succeeded. `editor-export.mp4` is that output; `editor-share.png` shows the chooser (nothing was sent). Open video reached the system app chooser; external playback was not established because the selected third-party player requested library access.

`preview-screen-recording.mp4` records native synthetic preview. The cadence defect is tracked in [#53](https://github.com/AlwinSunil/one-take-expo/issues/53), assigned to Melvin; it remains open.

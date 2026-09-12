# Captioned media export

`modules/one-take-media` provides production native preview and export for the editor.
It runs a local Kotlin Media3 Transformer job in an Android `mediaProcessing`
foreground service, persists the job record under the app's private files, and
publishes a completed MP4 only after the Transformer reports success.

The JavaScript contract is:

```ts
startExport({
  id,
  sourceUri,
  cuts: [{ t0, t1 }],
  captions: [{ t0, t1, text }],
  // Optional reviewed sequence, overriding the legacy source/cuts/captions.
  segments: [{ uri, t0, t1, captions: [{ t0, t1, text }], takeId? }],
}) -> Promise<{ id }>
getExport(id) -> Promise<{
  id,
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted',
  progress,
  uri?,
  galleryUri?,
  error?,
}>
cancelExport(id) -> Promise<void>
deleteExport(id, deleteGallery: boolean) -> Promise<void>
openExport(id) -> Promise<void>
saveToGallery(id) -> Promise<string>
shareExport(id) -> Promise<void>
```

All `t0` and `t1` values are seconds relative to their source recording.
For `segments`, every entry has its own local URI and caption timeline; array
order is presentation order. Equal timestamps across different recordings do
not overlap in the output. The persisted `Project.reviewSegments` snapshot
feeds both native preview and export. Legacy raw/manual export filters the
project transcript by recording ID or source-linked take, so pickup captions
cannot appear over the original recording.

Without `segments`, the legacy source/cuts/captions contract applies.
An empty `cuts` array means the complete source.
When cuts are supplied, their array order is the output order, including when
the source ranges are nonchronological.
Cuts may touch at an endpoint but may not overlap.
Invalid or overlapping ranges are rejected before the service starts.
ASR timestamps are never treated as safe cuts automatically; the editor must
turn a reviewed decision into the explicit `cuts` array.

Captions are mapped to the concatenated output timeline by intersecting each
caption with each selected source range.
A caption crossing a removed gap becomes one segment per selected range, so
the output text follows the retained audio and video.
Before native export, the editor partitions overlapping recognizer intervals at every start and end boundary.
Each resulting visual cue contains the active text in stable source order, separated by newlines.
Preview uses the same partitioning, so normal recognizer padding does not block export or silently discard a caption.
The native module receives sorted, non-overlapping visual cues and still rejects overlapping intervals supplied directly to its API.

Media3 `1.9.0` is used for `media3-transformer`, `media3-effect`,
`media3-common`, and `media3-ui`, matching Expo Video and the existing research
module to avoid incompatible runtime artifacts.
`MediaComposition` builds the same 720 × 1280 SDR composition for
`CompositionPlayer` preview and `Transformer` export. Each source fits inside
the portrait canvas without stretching; HDR sources are tone mapped to SDR.
Metadata inspection runs off the main thread and validates cut endpoints
against the source duration before playback or encoding.

For fixed local H.264/HEVC recordings, preview and export use
`DecodeAheadMediaSourceFactory` before Media3's normal clipping source. This
preserves post-cut compressed reference pictures needed to decode retained
B-frames. Outside-cut references receive a pre-start timestamp that the
renderer discards after decoding; retained timestamps, audio and timeline
boundaries are unchanged. Read-ahead is bounded to 32 consecutive outside-cut
packets, beyond H.264/HEVC's maximum 16-picture reorder depth. Other codecs use
the unchanged baseline path. No source normalization, cut padding or dependency
upgrade is introduced.

The [physical-phone regression evidence](development/evidence/milestone-1-native/decode-ahead-validation.json)
contains 3,600 frames over 120 seconds, maximum frame interval 33.334 ms and no
100 ms splice gaps. The decoded audio comparison is byte-identical to the
pre-fix export at 2 kHz mono, with unchanged 20.5–34.0 ms synthetic phrase lag.
The final adapter also passed the same 120-second cadence/audio checks with a
[44.7 MB local B-frame source](development/evidence/milestone-1-native/large-decode-ahead-validation.json).
The period keeps requesting data while reference frames remain pending, and a
synthetic end-of-stream remains readable even if the child stream is not ready.
These checks validate the H.264 fixtures on the tested phone, not every
codec/device or human lip synchronization.
The composition contains one audio-and-video sequence with one clipped
`EditedMediaItem` per cut.
The composition-wide `OverlayEffect` uses a timed `BitmapOverlay`, so caption
timestamps refer to the final concatenated timeline while audio is retained.
The overlay uses a single readable white bold lower-third style with a dark
background, width-aware line wrapping, and height-aware text scaling.
Captions that cannot fit at a readable minimum size fail with a request to
split or shorten the text instead of shrinking it to an unreadable size.

`NativeCutPreview` is a nullable named export (available on the Android build).
Its `request` prop is a JSON-serialized export request, including an ID such as
`preview`; `playing` controls playback and `seek` is output-relative seconds.
`onState` delivers `event.nativeEvent` with readiness, playback position,
duration, end/error state, and `firstFrameMs` measured from composition loading
through the first rendered frame. It does not render an output file. Detaching
cancels pending loading and releases the player. The UI keeps its request
snapshot stable during playback and pauses when backgrounded.

The service declares the Android `mediaProcessing` foreground-service type and
updates a low-priority notification with progress.
On Android 15 and later it starts with
`FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING`; older Android versions use the
two-argument `startForeground` API.
The service is deliberately `START_NOT_STICKY`.
If the process dies, the next native module instance changes persisted
`queued` and `running` records to `interrupted`, removes no source media, and lets the
editor offer retry with the same request.
Cancellation is idempotent for queued and running jobs.
The process-local cancellation bridge calls `Transformer.cancel()` on the
main looper, while the persistent record becomes `cancelled` before the
service observes the cancellation. The promise waits for the worker to stop
writing, with a bounded timeout that keeps failed deletion retryable.

Exports are written to `files/exports/<id>.mp4` and remain app-private.
`saveToGallery` is an explicit copy through `MediaStore` into `Movies/One Take`.
`shareExport` is a separate explicit action using a scoped `FileProvider` URI.
`openExport` opens a player through the same scoped URI. Missing or empty
completed outputs become failed jobs with retry guidance.
`deleteExport` cancels active work, waits for it to settle, and removes the
app-private output and job record. The required `deleteGallery` flag selects
whether to also remove the associated app-created MediaStore copy. The
project deletion confirmation persists this choice for retries. Permission
failure retains the job record and explains which gallery copy remains;
externally shared copies remain outside app control.

Gallery saving and deletion share a native mutex. A pending gallery URI is
persisted before copying bytes, then marked complete after publishing. Retry
removes a pending item left by process death; a gallery copy manually removed
outside One Take can be saved again. Active-work cancellation preserves this
association until project deletion applies the chosen gallery policy.
The source file is never modified.
No network source URI is accepted and no caption data leaves the device.

The module manifest provides the service, foreground-service permissions,
legacy storage permission for Android 8 and earlier, and the scoped
`FileProvider` path.
The editor calls this module and persists the latest job under `export:<projectId>`
and the job history under `exports:<projectId>`. Project deletion cancels and
removes the associated native jobs. New native methods require an APK rebuild;
see [Milestone 1 validation and remaining gates](development/milestone-1-melvin-status.md).

Run the pure timeline checks with:

```sh
node --test tests/media-export-timeline.test.mjs
```

Ten Android module JVM tests cover timeline mapping, cancellation state,
retained B-frame timestamps, read-ahead bounds, peeking, reset, partial-buffer
loading positions and synthetic end-of-stream readiness:

```sh
cd android
./gradlew :one-take-media:testDebugUnitTest
```

Device acceptance must cover a two-minute source with nonadjacent cuts,
readable burned-in captions, retained audio, backgrounding and foregrounding,
cancellation, retry after an injected failure or process interruption,
MediaStore permission failure, and explicit share/gallery actions.
Those checks are separate from timeline unit tests and must name the Android
device, source fixture, output duration, and observed status transitions.

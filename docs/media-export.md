# Captioned media export

`modules/one-take-media` exposes the first native export seam for the editor.
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
}) -> Promise<{ id }>
getExport(id) -> Promise<{
  id,
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted',
  progress,
  uri?,
  error?,
}>
cancelExport(id) -> Promise<void>
deleteExport(id) -> Promise<void>
openExport(id) -> Promise<void>
saveToGallery(id) -> Promise<string>
shareExport(id) -> Promise<void>
```

All `t0` and `t1` values are seconds relative to the original source file.
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

Media3 `1.11.0` is used for `media3-transformer`, `media3-effect`, and
`media3-common`, matching the current Android documentation and release.
The composition contains one audio-and-video sequence with one clipped
`EditedMediaItem` per cut.
The composition-wide `OverlayEffect` uses a timed `BitmapOverlay`, so caption
timestamps refer to the final concatenated timeline while audio is retained.
The overlay uses a single readable white bold lower-third style with a dark
background, width-aware line wrapping, and height-aware text scaling.

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
service observes the cancellation.

Exports are written to `files/exports/<id>.mp4` and remain app-private.
`saveToGallery` is an explicit copy through `MediaStore` into `Movies/One Take`.
`shareExport` is a separate explicit action using a scoped `FileProvider` URI.
`openExport` opens a player through the same scoped URI. Missing or empty
completed outputs become failed jobs with retry guidance.
`deleteExport` cancels active work, waits for it to settle, and removes the
app-private output and job record. Explicit gallery copies remain.
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

The Android module tests cover the same mapping and cancellation state rules:

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

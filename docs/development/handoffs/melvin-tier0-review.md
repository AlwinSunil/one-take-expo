# Melvin Tier 0 review and pickup handoff

This documents implemented review/storage interfaces and the remaining capture-owner integration. It is not evidence of device playback, stop-to-first-frame latency, audio/video synchronization, or recognition accuracy. The Expo SDK 57 reference was read before implementation.

## Review entry and return

The implemented route is `/editor` with `projectId: string`. Review loads the durable project again on focus, so a camera-owned pickup flow can return to the same project after its save has completed:

```ts
router.replace({ pathname: '/editor', params: { projectId } });
```

Use the existing editor entry if it is already beneath capture in the navigation stack; returning with `router.back()` also triggers its focus reload. Do not create a second project or replace its primary `videoUri` to save a pickup. Do not navigate before the durable completion promise resolves.

The editor also accepts `videoUri` for existing direct/raw preview. A `projectId` is required for durable review and pickup attachment.

## Camera launch contract

The combined integration includes the capture PRs and exposes **Record requested pickups**, **Save pickup list**, and **Attach a saved pickup recording**. The direct action saves the current needed-line request before opening `/camera` with `mode: script`, `script`, and `pickupProjectId`. A failed save prevents navigation. The existing capture route is reused; there is no second recorder.

Saving the list persists:

```ts
project.pickupRequest = {
  lineIds: string[],       // Existing projectScriptLines(project) identities
  requestedAt: number,    // Epoch milliseconds
};
```

The list contains spoken lines with no selected take, including pending/unavailable lines. Actions remain separate confirmations. The camera accepts `/camera` parameter `pickupProjectId: string`, fetches that project, reads its current `pickupRequest`, and shows only those requested spoken lines while preserving original IDs. It restores the full script and action ledger from the target project rather than the global accepted draft. Recording preparation revalidates the requested subset against current coverage.

Use the following implemented store APIs:

```ts
await beginProjectPickup(projectId, recordingId, lineIds);
const updatedProject = await completeProjectPickup(projectId, recordingId, {
  videoUri,              // Local recording source, retained until save succeeds
  duration,              // Finite positive seconds
  transcript,            // TranscriptSeg[] with stable IDs and source-local times
  takes,                 // TakeEvidence[] referencing those transcript IDs
});
await cancelProjectPickup(projectId, recordingId);
```

Choose a new, stable `recordingId` before starting; reuse it when retrying completion. `beginProjectPickup` verifies the project and requested IDs and saves a pickup journal. `completeProjectPickup` validates the payload, copies media into project-owned storage, appends the recording and namespaced transcript/takes, and returns a `Project`. Completion is idempotent for a recording already present. Cancel removes an uncommitted request, but refuses to discard an operation with saved media pending recovery.

Every take's `mediaUri` must reference the submitted recording, and its finite `[t0,t1]` interval must be inside `duration`. Its `transcriptSegmentIds` must exist, and each referenced caption interval must be inside that take. Preserve one-breath multi-line takes as one interval. Send real `quality`, `playable`, `inFrame`, and final/pending transcript evidence; action completion does not establish spoken coverage.

The merge assigns `TranscriptSeg.recordingId`, namespaces transcript/take IDs, retains `recordedAt`, and appends:

```ts
project.recordings: {
  id: string;
  mediaUri: string;
  duration: number;
  createdAt: number;
}[];
```

Source-local timestamps are never shifted onto the primary video's timeline. Existing raw media and take history are preserved. The pickup request and prepared segment sequence are cleared, and `cutsReviewed` becomes false.

Request `lineIds` target capture and are persisted as `takes[].eligibleLineIds` during completion. The review adapter limits pickup candidate selection to those requested lines, including explicit take choices. Capture must still show only those lines. Full transcript matching separately checks whole-take audio: if a scoped pickup also speaks an unrequested line already selected elsewhere, sequence preparation blocks the conflicting whole take rather than repeating or splitting its audio.

## Available saved-pickup workflow

1. Open the target project and save its pickup list.
2. Record and save a separate, ordinary pickup project through the existing recording flow.
3. Return to the target editor, choose **Attach a saved pickup recording**, select it, and confirm.
4. Review the resulting takes in script order, then prepare and accept the sequence for export.

The UI calls `mergePickupProject(targetId, pickupId, lineIds): Promise<Project>`. It first flushes pending review edits and prevents further panel interaction during import. Storage copies the source recording into target-owned storage; it does not delete or mutate the source project. Reattaching the same source project to the same target is idempotent. A source with multiple recordings, missing video, invalid timing, or foreign take-media references is rejected with an error; the existing target footage remains.

## Native preview and export

`NativeCutPreview` is a nullable export from `modules/one-take-media`. When available, the editor uses the native composition player for clean sequences and individual take previews. Raw and manual-trim preview retain `expo-video`.

```ts
<NativeCutPreview
  request={JSON.stringify({
    id: 'preview',
    sourceUri: segments[0].uri,
    cuts: [],
    captions: [],
    segments,
  })}
  playing={playing}
  seek={timelineSeconds}
  onState={event => { /* event.nativeEvent */ }}
/>
```

Each segment is `{ uri, t0, t1, takeId?, captions?: { t0, t1, text }[] }`; caption and cut times are relative to that segment's source file. Seek/position are composition timeline seconds. Native state can include `ready`, `ended`, `playing`, `position`, `duration`, `firstFrameMs`, and `error`.

The editor freezes the active sequence while playback continues; updates apply after pause. Backgrounding or leaving the route pauses playback. Native errors show an unverified-coverage warning and offer the raw recording; runtime errors do not permanently mark files unavailable. Multi-source preview is unavailable without the Android native player, and the UI says so.

Automatic selection uses suitable clean, final takes, preserves explicit choices, and compares recording creation times before source-local offsets. Whole takes appear once in script order. Incompatible selections that would repeat a spoken line are blocked for explicit review rather than splitting their audio.

Prepared segments are stored in `Project.reviewSegments`. Automatic preview requires preparation and explicit cut acceptance before export. Manual-trim export excludes prepared segments; raw export uses the complete primary source without captions. Preview and export filter primary-source captions so overlapping timestamps from pickup recordings cannot leak into the primary video. Multi-source saved-audio recheck and transcript rollback are disabled until safe per-source refinement exists.

## Remaining acceptance evidence

Direct pickup targeting/launch and stop-to-review navigation are implemented in the combined branch. User-authorized development integration does not wait for peer signoff. Target-device validation must measure stop-to-first-frame separately from native preview `firstFrameMs`, and verify A/V synchronization, continuous multi-line audio, corrupt-media fallback, background/resume, and record → review → pickup → review. No device result is claimed by this handoff.

Local behavior checks: `node --experimental-strip-types --test tests/clean-review.test.mjs tests/review-export-selection.test.mjs tests/review-source.test.mjs`. These cover deterministic selection, indivisible conflicts, cross-source timing/recency, and caption-source isolation; they do not establish native-device correctness.

## Combined integration changes

The isolated `integration/milestone-1-review` worktree combines current #49 with #57 (which contains #46/#47/#48/#50/#54), #55 (which contains #56), and verified runtime/checkpoint updates. The camera merge preserves coverage controls, hardware input, recording reliability, optional vision readiness and composition coaching. Vision readiness sits separately from the prompter; it is not treated as proof of clean speech.

The previously documented receiving gaps are now addressed:

- `projectCaptureDocument` restores target line/cue IDs and statuses. `requestedPickupLineIds` keeps the saved subset and current needed-line eligibility.
- Persisted-project capture coverage uses `cleanReview`, including explicit take choices, recording recency and pickup scope.
- A begun pickup without returned media is cancelled. Returned media is checkpointed before waiting for caption finalization; pending raw footage is reachable from review without claiming coverage.
- Failed saves retain a retry closure for the same project/recording identity. Starting another recording or closing the unsaved preview is blocked until save is retried. A retake retains the target project.
- Successful capture navigates directly to the editor after durable save. Raw preview remains a recovery path. Caption timestamps subtract the measured audio-listening-to-video-start offset; a caption truncated by the video boundary is provisional. Retry recognition offsets include the gap between microphone sessions.
- Action confirmations made during capture are preserved in saved project lines. The editor exposes direct targeted pickup navigation only in this combined consumer implementation; no environment flag is required.

`checkpointProjectPickup(projectId, recordingId, { videoUri, duration })` returns the project with a durable `recordings[]` entry marked `evidenceStatus: pending`. Final `completeProjectPickup` upgrades that same entry with namespaced evidence. A checkpoint is not cancelled or silently overwritten after a source is returned.

At the integration check, **248 behavior tests, 19 sample checks and TypeScript checking passed**. Four new capture-handoff checks cover persisted identity/action restoration, scoped coverage, audio/video start-offset conversion and failed-save/no-navigation behavior. Actual camera timing still uses JS-observed start clocks and remains `live-estimate`; these checks do not establish frame accuracy or replace physical device recording validation. Native build/device work is tracked separately by the root agent.

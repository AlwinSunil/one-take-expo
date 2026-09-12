# Melvin Tier 0 review and pickup handoff

This documents implemented review/storage interfaces and the remaining capture-owner integration. It is not evidence of device playback, stop-to-first-frame latency, audio/video synchronization, or recognition accuracy. The Expo SDK 57 reference was read before implementation.

## Review entry and return

The implemented route is `/editor` with `projectId: string`. Review loads the durable project again on focus, so a camera-owned pickup flow can return to the same project after its save has completed:

```ts
router.replace({ pathname: '/editor', params: { projectId } });
```

Use the existing editor entry if it is already beneath capture in the navigation stack; returning with `router.back()` also triggers its focus reload. Do not create a second project or replace its primary `videoUri` to save a pickup. Do not navigate before the durable completion promise resolves.

The editor also accepts `videoUri` for existing direct/raw preview. A `projectId` is required for durable review and pickup attachment.

## Proposed camera launch contract — not wired

There is no production camera capability handshake or direct pickup launch button yet. Alwin owns `src/app/camera.tsx`; this change does not modify or duplicate capture. The review UI truthfully exposes **Save pickup list** and **Attach a saved pickup recording**.

Saving the list persists:

```ts
project.pickupRequest = {
  lineIds: string[],       // Existing projectScriptLines(project) identities
  requestedAt: number,    // Epoch milliseconds
};
```

The list contains spoken lines with no selected take, including pending/unavailable lines. Actions remain separate confirmations. The camera owner should accept a proposed `/camera` parameter `pickupProjectId: string`, fetch that project, read its current `pickupRequest`, and show only those requested spoken lines while preserving their original IDs. This parameter is a handoff proposal, not a currently supported camera route contract. The editor must not launch it until capture implements and advertises support.

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

Camera-owned direct pickup targeting/launch and stop-to-review navigation still require Alwin's integration. Sabari must review the production coverage evidence handoff. Target-device validation must measure stop-to-first-frame separately from native preview `firstFrameMs`, and verify A/V synchronization, continuous multi-line audio, corrupt-media fallback, background/resume, and record → review → pickup → review. No device result is claimed by this handoff.

Local behavior checks: `node --experimental-strip-types --test tests/clean-review.test.mjs tests/review-export-selection.test.mjs tests/review-source.test.mjs`. These cover deterministic selection, indivisible conflicts, cross-source timing/recency, and caption-source isolation; they do not establish native-device correctness.

## PR stack audit and combined integration requirement

Audited remote heads: #46 `5ba3e81`, #47 `1009593`, #48 `12bed10`, #50 `911e81f`, #54 `e28608a`, #56 `68d1589`, #55 `4d302dd`, and #57 `378a36c`. PRs #54–57 are authored by Sabari and supply the capture-side work discussed here.

- PR #57 already contains the current heads of #46, #47, #48, #50 and #54, plus the earlier #49 receiving implementation at `b1c0f55`. Its base is `feat/t0-capture-dependencies` (`68d9fdb`), not `main`.
- PR #56 is based on #54; PR #55 is based on #56 and contains both current heads. Neither #55 nor #56 is contained in #57.
- Read-only `git merge-tree` found the audited #49 HEAD + #57 combination clean. Combining #57 and #55 reports a content conflict in `src/app/camera.tsx`. A clean merge is not behavioral acceptance, and the result does not include later uncommitted edits.

Prepare an isolated worktree from a committed current #49 snapshot. Merge #57 there to include its dependency stack once, then merge #55 and have the capture owner resolve `camera.tsx` semantically, preserving recording durability, permission/interruption handling, input controls, coverage and optional vision setup. Do not resolve by taking the entire camera file from either side. Keep the working review/native-fix checkout unchanged. The direct pickup action below must not land into a build whose camera ignores its parameters.

The root agent has created `/tmp/one-take-milestone1-integration` on `integration/milestone-1-review` with current #49 + #57. That combination passes 218 behavior tests, 19 sample checks and TypeScript checking. These results do not include #55/#56 conflict resolution or prove the direct pickup scenarios below.

### Capture-owner corrections before direct launch

References below are pinned to PR #57's audited commit `378a36c5cf51665640d6b2bc6b8a450cfe7bba24`.

1. **Restore the target project's script identity.** The [pickup loader](https://github.com/AlwinSunil/one-take-expo/blob/378a36c5cf51665640d6b2bc6b8a450cfe7bba24/src/app/camera.tsx#L355) calls `loadAcceptedScriptDocument(routeScript || project.script)`, whose [implementation](https://github.com/AlwinSunil/one-take-expo/blob/378a36c5cf51665640d6b2bc6b8a450cfe7bba24/src/lib/script-draft.ts#L43) reads global `script_accepted_lines`. Another accepted script can change line IDs/cue state. Build the pickup document from `projectScriptLines(project)`, preserving IDs and action state; never substitute the latest global accepted document for an existing project's ledger.
2. **Honor the saved requested subset.** The [record preparation](https://github.com/AlwinSunil/one-take-expo/blob/378a36c5cf51665640d6b2bc6b8a450cfe7bba24/src/app/camera.tsx#L465) recomputes every uncovered line and does not read `project.pickupRequest.lineIds`. Validate and use that saved subset, intersecting existing spoken IDs and retaining original IDs in the prompter. Recheck the current request at record start. The list of all script lines must remain available for whole-utterance matching and separate action status.
3. **Use the same scoped coverage and explicit choices as review.** [deriveProjectCaptureCoverage](https://github.com/AlwinSunil/one-take-expo/blob/378a36c5cf51665640d6b2bc6b8a450cfe7bba24/src/features/capture/coverage.ts#L110) calls unscoped `deriveReviewState` without `project.reviewDecisions`. It therefore bypasses `eligibleLineIds` and creator choices and can disagree with the editor. Consume the receiving review adapter (`cleanReview`/scoped `projectReview`) for persisted-project coverage; retain pending/live capture state separately. Do not silently replace the editor's latest-recording ranking with source-relative earliest-take ranking.
4. **Close the pickup lifecycle.** [Record preparation](https://github.com/AlwinSunil/one-take-expo/blob/378a36c5cf51665640d6b2bc6b8a450cfe7bba24/src/app/camera.tsx#L503) calls `beginProjectPickup`, and [successful completion](https://github.com/AlwinSunil/one-take-expo/blob/378a36c5cf51665640d6b2bc6b8a450cfe7bba24/src/app/camera.tsx#L588) calls `completeProjectPickup`; the route has no `cancelProjectPickup` call. Cancel a started-but-uncommitted request on abandoned capture/no returned media, preserving operations that have media waiting for recovery. Keep the same recording identity on save retry. Do not let **Retake** silently clear the target and create a separate project; its [current implementation](https://github.com/AlwinSunil/one-take-expo/blob/378a36c5cf51665640d6b2bc6b8a450cfe7bba24/src/app/camera.tsx#L624) resets `pickupTargetId`.
5. **Checkpoint pickup media before final analysis.** The [early returned-media save](https://github.com/AlwinSunil/one-take-expo/blob/378a36c5cf51665640d6b2bc6b8a450cfe7bba24/src/app/camera.tsx#L522) runs only for a new primary project. A pickup waits through `captions.stop()` before its media URI reaches durable completion. Coordinate a receiving-store checkpoint if necessary so a process death in that interval does not leave a request journal without its returned recording URI. Final pending/failed recognition must not overwrite recoverable video.
6. **Return and immediate-review behavior.** The [continue handler](https://github.com/AlwinSunil/one-take-expo/blob/378a36c5cf51665640d6b2bc6b8a450cfe7bba24/src/app/camera.tsx#L640) returns the saved `project.id`, which is compatible with editor reload. It currently pushes another editor only after a raw-preview modal and a user **Continue** action. This does not establish recording-stop → first clean frame. Preserve raw access but explicitly wire the desired immediate clean-review transition and measure it on device. Recognition starts before `recordAsync`; verify that supplied source timestamps account for that start offset before claiming cut/frame alignment.

### Review launch patch for the combined worktree

This patch is intentionally **not applied to the current source**. Current #49 camera code can ignore `pickupProjectId` and create a new recording project, so presenting this action before the consumer is integrated would be unsafe for the expected workflow. Apply it only after #57 plus the corrections above are present in the combined worktree. No environment feature flag is used.

In `src/components/review/transcript-review.tsx`, add:

```ts
import { router } from 'expo-router';
```

Inside the existing `pickupLineIds(review).length > 0` section, add this action alongside the saved-list/attachment actions:

```tsx
<Pressable
  accessibilityRole="button"
  disabled={importing || progress !== null}
  className="p-3 bg-white rounded-lg"
  onPress={async () => {
    setImporting(true);
    try {
      const current = latest.current;
      const lineIds = pickupLineIds(cleanReview(current));
      if (!lineIds.length) {
        setMessage('No spoken lines need a pickup now.');
        return;
      }
      if (!await change({
        ...current,
        pickupRequest: { lineIds, requestedAt: Date.now() },
      })) return;
      router.push({
        pathname: '/camera',
        params: {
          mode: 'script',
          script: current.script ?? '',
          pickupProjectId: current.id,
        },
      });
    } finally {
      setImporting(false);
    }
  }}
>
  <Text className="text-black text-sm">Record requested pickups</Text>
</Pressable>
```

After integrating the consumer, replace the unavailable-capture copy with a truthful description of recording the saved requested lines. The existing `change` function awaits the editor's serialized metadata save and returns false on failure, so this action cannot navigate before its request is durable. The existing `importing` guard blocks concurrent panel edits while saving. It intentionally does not call `beginProjectPickup`: the camera owns the stable recording ID and starts that journal immediately before capture.

Combined-worktree checks should include a failing-save/no-navigation test, one requested line among several missing lines, a changed global accepted script, an explicit older-take choice, a scoped pickup containing extra words, cancelled preparation, interrupted returned-media save, and pickup retake. Run combined TypeScript/behavior tests, build the native capture/vision/input dependencies, then reproduce editor → record requested pickup → same editor with original media intact. Record actual stop-to-first-frame and A/V behavior separately. No combined-stack device result is claimed here.

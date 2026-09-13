# Tier 1.5 timeline owner handoff

Status: implementation in progress, development access only.
Branch: `feat/t15-editable-timeline`, fresh worktree based on merged main `3da03c4`.
A owns persisted schemas/store/jobs and lifecycle UI; C owns caption mapping/settings/export.
These are requested runtime interfaces, not a competing persisted schema or evidence of agreement.

## Required A contract

Please publish owner-authored structural types and store APIs matching these fields, or an exact adapter contract before integration.

```ts
type TimelineClip = {
  id: string; sourceId: string; t0: number; t1: number;
  included: boolean; reasonIds: string[];
  spanIds: string[]; pointIds: string[]; utteranceIds: string[];
  takeId?: string; parentClipId?: string;
};
type TimelineSnapshot = { revision: number; clips: TimelineClip[] };
type TimelineReason = { id: string; kind: string; text: string; actor: 'creator' | 'analysis' };
type TimelineCommand = {
  id: string; kind: string; baseRevision: number; revision: number;
  before: TimelineClip[]; after: TimelineClip[]; reasonIds: string[];
};
type TimelineHistory = { entries: TimelineCommand[]; cursor: number };
```

History needs retained abandoned commands for evidence, independent from the active undo/redo branch.
Please specify A's representation for abandoned entries, proposal/take acceptance metadata, canonical timeline initialization and monotonic revision allocation on Undo/Redo.
Required persistence is atomic timeline + history + reason append, with expected timeline revision and idempotent operation ID.
Please publish exact `commitTimeline`/read signatures, conflict/failure recovery, legacy seed behavior and lifecycle component props.
A must prevent legacy metadata writes and pickup completion from replacing the current canonical sequence.
Save accepts a displayed whole proposal in one creator command; late results remain pending review.
No B storage or Project schema will be added.

## Runtime sequence API for C

B will publish `src/features/timeline/engine.ts` with `resolveTimeline(snapshot, sources)`.
Sources are keyed by stable source ID with `{ id, uri, duration: number | null, available: boolean }`.
Resolver returns `{ revision, segments, duration, issues }`.
Each segment is `{ clipId, sourceId, uri, t0, t1, outputT0, outputT1 }`.
Intervals are half-open source-local seconds.
Only included valid available clips contribute output time.
Any included invalid/unavailable clip adds a blocking issue; consumers must not silently export a partial sequence.
An empty included sequence has zero duration and zero segments, with no raw-original fallback.
C should consume this exact snapshot for both burn-in modes and publish its export/settings props.
Captions map by source ID and interval intersection; equal timestamps from different sources never share cues.

## Identity, history and playback policy

IDs are allocated once by the command caller, never from text, array index, URI or output time.
Split allocates two child IDs, retains lineage and the parent's complete prior state in history.
Excluded rows retain every reason ID; Restore never erases historical reasons.
Preview of an excluded range is a separate source inspection and never executes a command.
Undo/Redo increment the canonical revision even when restoring older content.
New edits after Undo invalidate redo availability but retain abandoned command evidence.
Playing freezes one resolver snapshot.
An edit pauses first, then preserves clip ID and source-local position if still included, including split descendants.
If that position was removed, use the next included interval at the prior output offset, clamped to the new duration.
Empty sequences have no playhead and no preview.
The UI states this policy and distinguishes source inspection from edited playback.

## Pickup and proposal integration

A,C plus B intent yields A,B,C by stable script point order, not pickup capture order.
Reverse-order pickups are sorted by their intended original point/span positions.
One shared utterance remains one range with multiple identities.
Stale script/edit/point/transcript revisions, manual reorder/split/delete and overlapping/shared utterances require visible resolution.
Never automatically split or duplicate a shared utterance.
PR #70/#71 remain unmerged and are not imported.
Small B-owned fixtures will cover these contracts pending merged producers and A adaptation.

## Pending evidence

Implementation tests, integration, build, device/human/A/V checks remain pending.
Exact acceptance matrix and pushed commit references will be added as checks run.
Publication alone does not claim A/C agreement.

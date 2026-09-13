# Tier 1.5 Session 3 proposed shared foundation

Status: historical design proposal, superseded by the merged implementation handoffs.
PRs #58, #70, #71, #74, #75 and #76 are now merged.
Use `t15-durability.md`, `t15-timeline.md` and `t15-captions-export.md` for implemented interfaces.
The ownership and dependency snapshots below describe the original proposal date, not current blockers.
Base: merged main `15d80d62c91a28457a360fe5e0389f1d37e8ea6e`.
Publication branch: `t3code/feat/t15-timeline`.
This document proposes transport and persistence interfaces; Sessions 1 and 2 have not agreed to them.
No unmerged implementation has been incorporated.

## Ownership and prerequisite

On 2026-09-13, PR #58 is OPEN at `3536a886960c597630ba0ed5cb6ed71f439e2d7e` on `feat/t1-review-wrap-reframe`.
Its separate `t1-session-3` worktree contains additional untracked tests/evidence.
It changes `session.ts`, `store.ts`, `editor.tsx`, caption controls, export planning and native composition.
This new session must not compete with that author.
After the relevant foundation merges, create `feat/t15-timeline` from freshly fetched main, then deliver the small #65 foundation PR before editor features.
Do not merge or cherry-pick #58 while it is unmerged.

Session 3 owns all changes to shared project/schema/store, caption timeline, review source/export selection, editor UI and media composition helpers.
Session 1 owns speech, script span/point interpretation, take ranking and whole-utterance boundary semantics.
Session 2 owns camera Stop/checkpoint invocation, capture clock calibration and gaze/framing semantics.
No producer should create a second project store or recorder.

## Existing implementation to extend

`src/lib/store.ts` already journals copies through `.part`, awaits copy/move, checks space, serializes per-project work, recovers operations, and registers app-owned files/work for deletion.
Reuse `saveProject`, `checkpointProjectPickup`, `completeProjectPickup`, `registerProjectFile` and the existing operation journal.
`preserveNewRecordings` protects newly added pickups from an older editor snapshot, but this is not a general compare-and-swap editor revision contract.
`Project.recordings` already maps source IDs to immutable originals; legacy primary source identity is `project.id`.
`reviewSegments` supports multiple sources but lacks stable clip IDs and a general persisted undo cursor.
`reviewExportSelection` couples original-mode export with caption removal; the V1 path needs independent caption selection.
`buildExportPlan` already rejects explicitly empty review segments; preserve this protection when replacing the selection adapter.
The legacy `normalizeProject` writes schema version 2, so a future-version guard must precede migration rather than silently relabeling unknown schemas.
PR #58 contains caption correction and framing integration that must be retained after merge.

## Proposed additive Project extension

Add optional `v15` with `version: 1`; do not reinterpret existing `clips` as the new timeline.
Use opaque nonempty strings for IDs and nonnegative integer revisions.
Persist IDs once at creation; never derive them from mutable text, array position, current URI or output playback time.

| Record | Proposed fields and identity rules |
| --- | --- |
| Revision vector | `projectRevision`, `scriptRevision`, `timelineRevision`, `captionRevision`, plus per-source `transcriptRevision`; increment project revision on every durable mutation |
| Source | Reuse `recordings[].id`; add capture metadata keyed by source ID, duration provenance, clock mapping and nullable uncertainty; file relocation does not change source identity |
| Script snapshot | `id`, `revision`, ordered `spans: { id, lineId, text }[]`; preserve old snapshots, retain span IDs for unchanged content and record deleted/replaced span lineage |
| Important point | `id`, `scriptRevision`, `spanIds`, producer suggestion/reason, separate creator importance decision, wording strictness, coverage evidence and manual action state |
| Transcript revision | `id`, `sourceId`, `revision`, complete segment records or registered chunk references; raw recognition and caption corrections remain separate |
| Observation | `id`, `sourceId`, source range, `kind`, collection status, producer payload/version, provenance and uncertainty; includes silence/filler/restart/gaze without treating missing input as verified absence |
| Take/attempt group | Preserve existing take IDs; store producer-owned group ID, source ranges, supporting observation/segment/point IDs and reasons without recomputing semantics |
| Clip | `id`, `sourceId`, `t0`, `t1`, `takeId?`, `spanIds`, `pointIds`, `included`, `reasonIds`, `parentClipId?`; excluded and unavailable are independent states |
| Proposal | `id`, job/result identity, base revision vector, proposed ordered clips, reasons and conflicts; separate from committed timeline |
| Decision | `id`, operation ID, actor `creator`, proposal/clip/take references, base/new timeline revisions; Save may accept the whole displayed proposal |
| Captions | `showInEditor`, `burnIntoExport`, correction revision references; toggles never delete recognized or corrected text |
| History | `entries`, `cursor`, initial snapshot reference; each command stores affected before/after state, stable IDs and reason/decision references |
| Extension | Namespaced `key`, `version`, availability and optional `assetIds`; unknown extensions round-trip without being interpreted |
| Asset | Stable ID, registered app-private URI, media type, byte size and optional hash; large observations/transcripts/history pages load lazily |

Legacy caption migration proposal: `showInEditor: true`, `burnIntoExport: true` for the new timeline workflow, matching captioned edited export intent.
Legacy explicit original-export remains a separate original-source action until the V1 selection path is enabled.
No prior persisted independent preference exists to infer a creator choice from.
Unknown duration/timing/confidence stays null or explicitly unknown, never zero-confidence or verified empty.
Malformed new extension data must leave original media and legacy metadata recoverable; unsupported future project versions must not be overwritten.

## Proposed timing envelope and examples

All persisted intervals are half-open `[t0,t1)` in seconds relative to that source's presentation timeline.
Require finite `0 <= t0 < t1 <= known source duration`; unknown duration requires probing before playback/export validation.
Do not use wall time or recognizer delivery time as source presentation time.

```json
{
  "id": "obs:restart:1",
  "sourceId": "source:original",
  "t0": 1.25,
  "t1": 3.75,
  "kind": "restart",
  "status": "observed",
  "provenance": {
    "origin": "fixture",
    "producer": "session-1",
    "version": "proposal-1",
    "clock": "source-presentation",
    "timingMethod": "synthetic",
    "uncertaintySeconds": null,
    "processor": "unknown"
  }
}
```

Session 2 framing remains milliseconds at its established API boundary.
Adapt `startMs: 1250, endMs: 3750` to `t0: 1.25, t1: 3.75` once, retaining the original unit/method in provenance.
Likewise divide measured millisecond uncertainty by 1000; never fabricate uncertainty when omitted.
Keep monotonic clock origin, source-zero offset and capture generation supplied by Session 2.
The existing source-relative framing adapter from #58 should be reused after merge.
Gaze directions remain producer-defined relative to the upright unmirrored source; persistence must not convert face presence into camera contact.

## Proposed durable job/result API

```ts
type AnalysisRequest = {
  id: string; projectId: string; sourceId: string;
  attempt: number; idempotencyKey: string;
  base: { scriptRevision: number; timelineRevision: number; transcriptRevision: number };
  producer: string; producerVersion: string;
};
type AnalysisResult = {
  id: string; jobId: string; attempt: number;
  projectId: string; sourceId: string;
  base: AnalysisRequest['base'];
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  observationIds: string[]; proposalIds: string[]; reasonIds: string[];
};
```

Proposed store operations: `enqueueAnalysis(request)`, `checkpointAnalysis(jobId, attempt, chunk)`, `finishAnalysis(result)` and `commitTimeline(projectId, expectedRevision, operationId, edit)`.
These extend the existing database and project locks; public signatures remain proposals until implemented.
Enqueue requires a durable registered original and records queued/running/partial/ready/failed/cancelled/retryable status without percentage progress.
Retry retains logical job ID but increments attempt; results from an older attempt cannot complete the current job.
Duplicate operation/result IDs with identical payloads return the prior outcome; reused IDs with different payloads fail visibly.
Atomic revision compare-and-swap must protect against separate connections as well as the in-process lock.
Append evidence against its historical base; a stale result is never installed as current timeline or current-script coverage.
Late compatible proposals wait for creator review even if no intervening edit occurred.
Cancellation and startup recovery invalidate execution leases; unfinished jobs become retryable while saved originals remain directly accessible.
Do not overwrite the last durable timeline when a metadata checkpoint or optional asset write fails.
Write assets to registered temporary files before committing their references; retain journal/recovery information on partial writes and clean only registered unreferenced assets.
Page complete evidence/history instead of discarding old observations to bound live memory.

## Canonical timeline fixture proposal

Fixture IDs must be static in the eventual executable fixture file, not generated on each read.
Original source has A at `[0,2)` and C at `[2,4)`; pickup source has B at `[0,2)`.
The proposed ordered included clips are:

```json
[
  { "id": "clip:A", "sourceId": "source:original", "t0": 0, "t1": 2, "included": true, "pointIds": ["point:A"] },
  { "id": "clip:B", "sourceId": "source:pickup", "t0": 0, "t1": 2, "included": true, "pointIds": ["point:B"] },
  { "id": "clip:C", "sourceId": "source:original", "t0": 2, "t1": 4, "included": true, "pointIds": ["point:C"] }
]
```

Output duration is six seconds; excluding B preserves its row/reason/source preview and gives four seconds of output A,C.
Excluding all three gives zero duration, empty preview and disabled export.
Restore changes inclusion through history; source preview does not.
Split creates two new child clip IDs with the old clip retained in history.
Undo/redo restores IDs and complete prior decisions; a new edit after Undo abandons the redo branch without erasing original media or historical evidence.
Persist compound proposal/take/pickup acceptance as one undoable creator command.
Playback captures an immutable timeline revision; editing pauses playback first.
After an edit preserve the same clip/source-local playhead when still included, otherwise seek to the next included clip at that prior output position, clamped to the new duration; empty timelines have no playhead.
The UI must expose this policy and never silently swap a playing sequence.
Preview and export resolve the same ordered included clips and revision; export freezes its request across later edits.
Map a source cue by intersection with each included clip, then offset by cumulative included duration.
Mid-cue splits repeat the existing cue text over each intersecting piece without invented word boundaries.
Both burn-in modes use identical video segments; caption visibility only controls editor overlay.

## Producer integration requests

Session 1 should publish source/span/point/take/utterance mappings, exact script and transcript revisions, stable proposal IDs, reasons and whole-utterance safety/conflict evidence.
Pickup insertion intent should include `id`, `projectId`, `sourceId`, base revisions, target point/span IDs, utterance group ID and candidate whole-source ranges.
Consumer orders eligible candidates by original script position, not pickup capture order.
Changed script, manually reordered/deleted target or an utterance spanning an unsafe insertion boundary yields a visible conflict requiring creator resolution; never split shared speech automatically.
Session 2 should checkpoint through the existing save APIs before starting optional analysis, then pass the durable source ID and clock provenance.
Session 3 supplies durable lifecycle UI with Saving, Analyzing, Ready, partial/failure/cancel and Open editor/Retry actions.
Session 2 alone changes camera Stop wiring; Session 1 alone changes the analysis engine.
No cross-session agreement or owner-authored integration is claimed by publication of this document.

## Delivery sequence after ownership release

1. Small #65 schema/migration/revision/job/history fixture PR with existing-store integration and recovery tests.
2. #67 canonical timeline commands and editor integration with fixture proposals, including persistent undo/redo and empty-selection safety.
3. #68 independent caption controls and shared preview/export mapping.
4. Integrate producer commits only after merge, rerun affected checks and collect real-device and named reviewer evidence in `docs/validation/T1.5.md`.

Keep development access explicit and release gates false until acceptance.

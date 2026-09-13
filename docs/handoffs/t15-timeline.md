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

## Executable checkpoint and explicit responses

`a83fd87` publishes the pure engine, resolver, source-local playhead policy, active/abandoned history and save coordination.
Draft PR: https://github.com/AlwinSunil/one-take-expo/pull/76.
C explicitly accepted the resolver shape in https://github.com/AlwinSunil/one-take-expo/issues/67#issuecomment-5649918017.
A explicitly accepted the clip/history fields in https://github.com/AlwinSunil/one-take-expo/issues/65#issuecomment-5649965490.
B read A's executable handoff at `de00de0` and accepted the following seam in https://github.com/AlwinSunil/one-take-expo/issues/65#issuecomment-5650058648.

```ts
initializeDurableProject(projectId): Promise<Project>
commitTimeline(projectId, expectedFullVector, operationId, {
  timeline: next.snapshot,
  history: next.history,
  reasons: next.reasons,
}): Promise<Project>
```

Replace in-memory Project with the returned Project after success.
A's full vector includes project/script/timeline/caption and per-source transcript revisions.
A definite revision conflict requires refetch, visible creator review and an explicit rebase; never merely stamp the new expected vector onto the old edit.
The UI save coordinator accepts a conflict classifier and exposes `rebaseAfterConflict` for the owner adapter.
An uncertain failure retains the exact operation ID and payload until the outcome is established.
A's optional history archive/initial snapshot fields must be retained by the future adapter, and paged history must be loaded before offering Undo outside the current window.
No persisted foundation is currently imported because #75 remains unmerged.

C's published #74 APIs are `buildTimelineExportPlan(project, sequence, burnIntoExport, framingEnabled)` and `buildTimelineEditorCaptions(project, sequence, showInEditor)`.
`CaptionSettings` is controlled by independent show/burn values and callbacks.
`ExportControls.timelinePlan = null` blocks invalid/empty export; `undefined` is legacy and must never be used on a failed canonical resolution.
C requires refreshed `availableMediaUris` and uses stable source identity for captions and framing, including aliased URIs.
No C implementation is currently imported because #74 remains unmerged.

## Current runtime APIs

```ts
createTimelineState(snapshot, reasons?, history?): TimelineState
applyTimelineAction(state, action, sources): TimelineState
undoTimeline(state): TimelineState
redoTimeline(state): TimelineState
resolveTimeline(snapshot, sources): ResolvedTimeline
playheadAt(sequence, outputTime): TimelinePlayhead | null
preserveTimelinePlayhead(previous, nextState, sources): TimelinePlayhead | null
```

`TimelineState = { snapshot, history, reasons }` is a pure runtime value, not a second Project format.
Sources are a dictionary keyed by stable source ID.
The action caller supplies a fresh command ID and the exact `baseRevision`.
Split also requires fresh `leftId` and `rightId`.
The engine freezes returned snapshots, history and resolved segments.
The resolver retains blocking issues for included invalid/unavailable clips; consumers must not use its partial diagnostic segment list for playback/export.
Undo/Redo do not remove reason records or abandoned command evidence.
Explicit user splits retain point/span/utterance references on both children because a manual cut does not invent a new semantic boundary.
Their source intervals partition the parent exactly once.

```ts
const next = applyTimelineAction(current, {
  id: 'creator:split:1', baseRevision: current.snapshot.revision,
  kind: 'split', clipId: 'clip:A', at: 1,
  leftId: 'clip:A:left', rightId: 'clip:A:right',
}, sources);
const frozen = resolveTimeline(next.snapshot, sources);
// Never play/export when frozen.issues.length > 0 or frozen.segments.length === 0.
```

Whole proposal, pickup and take acceptance use `accept-proposal`, `accept-pickup` and `choose-take` actions with the complete chosen clip list.
Omitted alternatives become excluded context rather than disappearing.
Automatic acceptance rejects duplicated shared source utterances, including disjoint automatic fragments; unchanged explicit split descendants remain valid.
These actions are single undoable commands; ordinary preview never calls them.

`buildPickupProposal` returns pending insertion intent plus the full ordered `previewClips`.
`acceptPickupProposal` rechecks the current source inventory and captured/current project/script/edit/point/transcript scopes, then returns an engine-compatible action.
It never writes storage or changes the canonical sequence.
Manual reorder/split/delete, stale identities, unavailable ranges, overlapping or non-adjacent shared utterances produce visible conflict records with recovery actions.
Fixtures exercise A,C plus B, reverse-order pickups and equal timestamps/utterance strings in different sources.
PR #70's real producer wiring remains pending its merge and A's persisted adaptation.

## Preview and precision integration gate

`TimelinePreview` consumes a frozen resolver snapshot with prepared caption/crop data.
Seeking creates a preview-only sliced native request; the canonical source ranges and output plan remain unchanged.
No native view mounts for an empty selection.
`TimelineWorkspace` pauses on background/blur and exposes source inspection separately from edited playback.
Its route adapter must pause before every command and preserve the playhead with the engine helper before updating the preview snapshot.
The new actual-project adapter is still pending A/C merges, so the fixture does not establish native freeze/playback acceptance.

The existing native composition floors source clipping to milliseconds.
B proposed canonical nearest-millisecond endpoints with integer-millisecond output accumulation and owner-authored native rounding in https://github.com/AlwinSunil/one-take-expo/issues/68#issuecomment-5650025632.
A JavaScript reproduction of the current native conversion maps `1.001` seconds to `1000` milliseconds because of floating-point truncation.
C agreement/change remains pending.
No native frame-accurate duration/parity claim is made while this seam is unresolved.
Historical evidence/transcript precision must remain intact even after canonical edit precision is agreed.

## Development UI and browser evidence

Open `/editor?timelineFixture=1` only in an Expo development build/server.
Production always rejects that access gate, and ordinary editor routes retain the existing project workflow.
The fixture creates no Project or files and clearly labels Save/reopen as temporary-memory simulation.
It exercises the real controlled timeline components and engine with synthetic source identities.
The fixture does not play media, execute native export or represent durable project integration.

The browser run used an isolated `chrome-devtools-axi` session named `t15-timeline` against port 8097.
The successful compound UI path trimmed A to `[0.5,2)`, split at 1, excluded the left child, reordered, undid/redid, saved/reopened the memory checkpoint and inspected `[1,2),[3,5)` output intervals at revision 6 with duration 3 seconds.
The separate failure path showed Save failed, then Retry succeeded without losing the draft.
Source inspection preserved the number of excluded/Restore rows.
Excluding every included clip produced revision 8, duration 0, no playhead and a disabled interval-export inspection control.
These are synthetic web interaction results, not Android/SQLite/render evidence.
The initial Metro run used CI mode before new files existed and failed module resolution; restarting the task-owned server with watching enabled resolved it.
The CLI's combined `run` command returned `fn is not a function`, so browser keyboard input and DOM button events were used through supported CLI commands.

Screenshots are under `docs/handoffs/evidence/t15-timeline/`.
The 390×844 mobile-emulated viewport had no document horizontal overflow.
Visible buttons measured at least 48×48 CSS pixels; this does not establish Android large-system-text or TalkBack behavior.

## Acceptance matrix

| #67 requirement | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Stable clips, canonical revision, immutable originals | Pure engine/input immutability tests; one resolver | A durable initialization/import; actual source hashes |
| Grey included/excluded rows, reasons, Restore, separate source preview | Controlled UI and browser fixture; excluded reasons retained | Actual saved media preview on Android |
| Trim, Split, exclude, reorder, Undo/Redo | Engine tests and compound browser fixture | Installed gestures, TalkBack, large system text |
| Positive valid available ranges | Engine rejection/recovery tests; missing-media fixture | Actual corrupt/missing media reopening |
| Persistent multistep history, abandoned redo evidence | Runtime serialization and A-compatible history shape | #75 commit/read integration and real SQLite reopen |
| Whole-proposal/pickup/take choices undoable | Engine commands and synthetic proposal fixtures | Existing T1 take control adaptation and merged #70 producer |
| Late proposals/manual conflicts | Revision and per-identity conflict fixtures; controlled review UI | A job/result consumption, real script/pickup route |
| Freeze playback and source-local playhead | Frozen resolver and preview-slicing tests | Actual-project playback adapter and device A/V |
| A,B,C and reverse-order pickups | Pure proposal fixtures preserving shared utterances | Captured human pickups, caption/export proof |
| Empty preview, zero duration, disabled export | Engine and web all-excluded checks | C native plan integration after #74 merge |
| Direct Save/Export, save failure/Retry/Back | Existing editor recovery changes; controlled workspace and failure tests | A atomically persisted history, Android Back/process interruption |
| Independent caption controls and lifecycle status | Exact A/C interfaces read and accepted where stated | Owner implementations must merge before route import |
| Existing T1 review/caption/framing/pickup UX | Baseline source suite retained | Integrated device regressions and named reviewer |
| Development-only release gate | Exact opt-in tests and fixture route | #62 acceptance before release enablement |

No partial integration is described as completed V1.
No device was reserved or mutated, and physical device/human/A/V/semantic gates remain pending.


## Final development handoff

Draft PR: https://github.com/AlwinSunil/one-take-expo/pull/76.
Branch: `feat/t15-editable-timeline`.
Base/main rechecked at `3da03c446a612c8b925e17b8b8edd04055f321c4`.
Pushed contract: `904ccc5`; engine/resolver: `a83fd87`; controlled UI/proposals/save recovery: `68fce9a`.
The full implementation remains a development checkpoint, not completed #67 or V1 acceptance.

The final browser pickup path loaded and previewed the pending A → B → C proposal, then Save accepted it as one creator command at revision 1 and 6 seconds.
Undo restored 4 seconds; Redo restored 6 seconds; excluded weaker-attempt context remained visible.
A stale HMR page initially failed this interaction; a fresh page passed without a code change.

Pickup scopes now require both `sourceTranscriptRevisions` and `pointRevisions` for every referenced source and point.
Missing scope entries fail closed; proposal scope maps are copied, and acceptance revalidates current inventory, identities, shared utterances, and manual conflicts.
The save coordinator preserves operation identity for uncertain retries.
A definite owner revision conflict instead requires refetch, visible creator resolution and `rebaseAfterConflict`, never silent restamping or an endless stale retry.

Latest dependency status read: #70, #71, #72, #74 and #75 are open drafts.
A's latest published head `f6cb95b` was inspected read-only, including archive/source checkpoint and late-capture preservation updates.
C remains at `37f140d`.
No unmerged owner/producer code was imported.
A retains proposed timeline endpoint precision without changing observation precision; the final B/C native rounding agreement remains pending.

Existing verification completed: `npm run samples`, `npm run test:samples` (19 passed), `python3 tests/speech-evaluation.test.py` (12 passed), and `python3 tests/t1-speech-evaluation.test.py` (11 passed).
Android Expo export is a JavaScript/assets bundle check, not a native build or device acceptance.
Physical Android Back, process-death/SQLite history reopen, caption/native export parity, real source hashes, human pickup quality, accessibility and A/V remain pending.


Final executable head: `6fc3698` (history validation and creator identity protections).
`npm test` passed 472/472, `npm run typecheck` passed, and `EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/t15-b-final-android-export` passed after the final engine changes.
The interim typecheck caught an implicit-any error in history validation; it was corrected before this final passing run.
Command receipts and full final test/typecheck/bundle logs are in `docs/handoffs/evidence/t15-timeline/`.
A separate automated review identified the history, creator-restoration, and save-retry defects addressed in the final commits.
Manual Split intentionally retains semantic references; automatic duplicate proposals are rejected.

# T1.5 durable foundation

Owner A, issue #65, branch `feat/t15-durable-foundation`.
Base is merged main `3da03c446a612c8b925e17b8b8edd04055f321c4`, including #58 and newer main changes.
PRs #70, #71 and #72 were OPEN when inspected on 2026-09-13.
Their older statements that #58 is open are historical, not the current integration gate.
No unmerged implementation is imported.
This publishes A's interfaces, not B/C or producer agreement and not completed V1.

## Ownership

A owns `session.ts`, `store.ts`, `project-data.ts`, `project-edit-merge.ts`, new persistence/schema/job modules, `project-lifecycle-status.tsx`, `projects.tsx`, related tests and this validation report.
B owns `editor.tsx`, timeline UI/engine and timeline command semantics.
C owns export selection/planning, caption mapping/settings and native export.
Camera Stop, capture identity and native capture/manifest edits remain with the capture owner.
Additional shared helpers require an explicit owner before editing.

## Shared snapshot and immutable records

`Project.v15` is optional and versioned independently from the existing Project schema version 2.
`initializeDurableProject(projectId)` creates and persists the additive snapshot without replacing legacy trim, captions, pickups, review decisions or #58 fields.
`src/lib/t15-schema.ts` defines the exact persisted types and executable validation.
`src/lib/t15-jobs.ts` defines the canonical request/result envelopes.
`src/lib/t15-persistence.ts` supplies the SQLite implementation used by `store.ts` in the existing `onetake.db`.
It adds tables, not a second database or recorder.
Unknown extension payloads remain data and never execute code.
Future project/schema versions reject writes rather than silently relabeling their data.

Root `sourceId = project.id`; pickup `sourceId = recordings[].id`.
The legacy `${project.id}:original` entry for the root URI is an alias, not a second source.
Allocate new source, span, point, take, clip, operation, job and result IDs once at creation and retain them on retry/reopen.
Do not mint take IDs from recognition segment IDs or mutable text.
Legacy snapshot identity is migrated once; migration does not claim missing capture history was collected.

The revision vector is `{ projectRevision, scriptRevision, timelineRevision, captionRevision, transcriptRevision: { [sourceId]: number } }`.
All revisions are nonnegative safe integers.
Every creator snapshot commit checks the full vector atomically and increments `projectRevision` exactly once.
Script, timeline, caption and per-source transcript changes must advance their own revisions.
Appending a historical evidence page or changing execution status does not change the creator snapshot revision and cannot authorize a timeline mutation.
Existing legacy edit paths invalidate the corresponding revision counters once a project has opted into the durable snapshot.

Canonical clips are `{ id, sourceId, t0, t1, included, spanIds, pointIds, reasonIds, takeId?, parentClipId? }`.
A timeline is `{ revision, clips }` in display order, retaining excluded rows.
B defines trim/split/exclude/reorder/undo/redo command semantics and produces the new snapshot.
A persists that snapshot and the creator operation with compare-and-swap, retaining the prior operation ledger.
Timeline exclusion has no file-deletion path.
Explicit project deletion alone uses the existing cancellation, registered-file cleanup and durable tombstone.

## Units and producer adaptation

Persist half-open intervals in seconds relative to their own immutable source.
Provenance retains clock, timing method, producer/version, processor and nullable uncertainty.
Unknown duration is not the last ASR timestamp.
Recognition timing is not a verified splice boundary.
Existing framing remains milliseconds at its established boundary; use the explicit milliseconds adapter once and preserve original units and uncertainty.
Root audio offset conversion remains the capture owner's `recordingTranscript` responsibility.
Gaze's JS monotonic record-request anchor is separate from calibrated media PTS and remains uncertain.
A face-only unknown gaze observation cannot become a camera-contact result during persistence.

`producerScope(request)` maps the captured numeric script/timeline/source-transcript revisions to decimal strings for #70's opaque revision DTOs.
`editRevision` means `timelineRevision`.
The full numeric vector remains in the durable request and result; do not replace it with current revisions when a result arrives.

## Store API

```ts
initializeDurableProject(projectId): Promise<Project>
commitDurableProject(projectId, expected: RevisionVector, operationId, next: DurableFoundation): Promise<Project>
checkpointProjectEvidence(projectId, records: EvidenceRecord[]): Promise<void>
readProjectEvidence(projectId, after = 0, limit = 32, kind?): Promise<EvidencePage[]>
enqueueProjectAnalysis(request: AnalysisRequest): Promise<AnalysisJob>
startProjectAnalysis(projectId, jobId, attempt, lease): Promise<AnalysisJob>
finishProjectAnalysis(result: AnalysisResult, lease): Promise<StoredAnalysisResult>
cancelProjectAnalysis(projectId, jobId): Promise<AnalysisJob>
retryProjectAnalysis(projectId, jobId, expectedAttempt): Promise<AnalysisJob>
listProjectAnalysisJobs(projectId): Promise<AnalysisJob[]>
```

Consumers must replace their in-memory snapshot with the returned durable Project after each commit.
A stale commit fails visibly; reload and resolve the creator's intent against the current snapshot.
Never retry by merely replacing the expected revision on an old edit.
Duplicate operation/checkpoint/result IDs must have the identical canonical payload; a different payload is an error.
An identical duplicate returns current durable state without reapplying the operation.

`EvidenceRecord = { id, kind, sourceId?, payload }`.
The caller supplies complete versioned producer payloads, not only a diagnostic ring or final visible transcript.
A page contains 1–128 records and at most 128 KiB of UTF-8 JSON.
Await the checkpoint before releasing the producer buffer, then read history with the returned monotonic `sequence` cursor.
The store never drops old evidence to satisfy a live-memory limit.
Oversized payloads must be explicitly split into stable pages with ordered references, including complete transcript/history boundaries.
Large optional assets use existing `registerProjectFile`; a failed write must not publish a reference as complete.

## Durable job and result envelopes

```ts
const request: AnalysisRequest = {
  id: 'job:original:1', projectId: 'project:fixture', sourceId: 'project:fixture',
  attempt: 1, idempotencyKey: 'analysis:original:1',
  base: saved.v15.revisions, producer: 'session-1', producerVersion: 'fixture-v1',
};
const job = await enqueueProjectAnalysis(request);
const lease = 'execution:caller-minted-uuid';
await startProjectAnalysis(request.projectId, request.id, 1, lease);
const stored = await finishProjectAnalysis({
  id: 'result:original:1', jobId: request.id, attempt: 1,
  projectId: request.projectId, sourceId: request.sourceId, base: request.base,
  status: 'complete', observationIds: [], proposalIds: ['proposal:1'], reasonIds: [],
  payload: { version: 1, availability: 'fixture', pages: ['proposal-page:1'] },
}, lease);
// stored.disposition is awaiting-review or historical. Neither applies a timeline.
```

Enqueue/start requires the original to be nonempty, durable, and registered (legacy canonical files are registered compatibly).
A runtime startup converts queued/running jobs into retryable jobs and invalidates old leases.
Retry retains the logical job ID, increments the attempt, captures the current vector and preserves every prior request/result.
Cancellation invalidates the lease before a late completion can affect current status.
A late, cancelled, older-attempt or revision-mismatched result is historical evidence.
A compatible result is awaiting creator review, never accepted by the analysis producer.
The producer runner must stop its work on cancellation; persistent lease rejection supplies the final write guard.
No producer runner from an open PR is installed by this foundation.
Projects Retry queues a durable request; editor/producer integration must claim and execute it.

The native implementation uses SDK 57 `withExclusiveTransactionAsync` and SQL compare-and-swap so unrelated async writes cannot enter the transaction.
This API is not supported by Expo SQLite on web; web durability acceptance remains pending.
The existing Android app is the target for this native persistence path.
A failed transaction leaves both the last snapshot and operation history unchanged.
Original/pickup media continue to use the existing `.part` copy journal and registered cleanup.
The root metadata checkpoint now completes that journal before optional caption cleanup without changing camera-owned code.

## Required owner-authored integration

B: agree these minimal types publicly before consuming them; initialize once, implement timeline commands and persistent history cursor, replace local state with committed state, and render `ProjectLifecycleStatus` in the existing editor.
B: preserve excluded clips as visible/restorable rows and resolve pickup proposals against current point/script/timeline revisions.
C: agree the canonical clip and caption snapshot types publicly, freeze the selected timeline/caption revisions for export, and persist independent caption preferences/corrections through A's commit API.
C: map source-local cues through included intervals; an empty included sequence must never fall back to the original.
Capture owner: connect full `onObservation` output to the awaited checkpoint sink, not the 120-observation diagnostic ring; register pickup metadata before collecting; pass source provenance and Stop payload after the original journal succeeds.
Capture owner: render/wire Saving/Analyzing/Open editor/Retry as needed; no camera edits are included here.
Speech producer owner: preserve span/point/take/utterance IDs, exact captured revisions, complete transcript revisions and whole-utterance boundary uncertainty; adapt #70 only after merge.
All owners: publish command results, evidence paths and unresolved gates under #62; no human or cross-session agreement is inferred from publication.

## Exact B/C adapters and lifecycle props

A accepted B's requested runtime fields in [the published #65 response](https://github.com/AlwinSunil/one-take-expo/issues/65#issuecomment-5649965490).
B's request is [commit 904ccc5](https://github.com/AlwinSunil/one-take-expo/blob/904ccc5/docs/handoffs/t15-timeline.md); C's caption request is [this comment](https://github.com/AlwinSunil/one-take-expo/issues/65#issuecomment-5649911004).
This is evidence of A's acceptance of those fields, not acceptance by B/C of this implementation.

```ts
type TimelineReason = { id: string; kind: string; text: string; actor: 'creator' | 'analysis' };
type TimelineCommand = {
  id: string; kind: string; baseRevision: number; revision: number;
  before: TimelineClip[]; after: TimelineClip[]; reasonIds: string[];
};
type TimelineHistory = {
  entries: TimelineCommand[]; cursor: number; abandonedEntries: TimelineCommand[];
  initialSnapshot?: TimelineSnapshot;
  archive?: { kind: 'timeline-command'; pageIds: string[] };
};
// TimelineClip also requires utteranceIds: string[].
commitTimeline(projectId, expectedFullVector, operationId, { timeline, history, reasons }): Promise<Project>
commitProjectCaptions(projectId, expectedFullVector, operationId, captions, appendedCorrections?): Promise<Project>
checkpointProjectObservations(projectId, observations: Observation[]): Promise<void>
registerDurableProjectAsset(projectId, expectedFullVector, operationId, completedAsset): Promise<Project>
readProjectEvidenceRecord(projectId, id): Promise<EvidenceRecord | null>
```

B supplies the complete retained reason list, the next monotonic timeline revision, and its active/abandoned command state.
Every command is additionally archived as an immutable `timeline-command` evidence row, so older windows can be paged without erasing undo evidence.
If B pages commands out of its in-memory window, it must retain `history.archive` and load the older commands before offering Undo/Redo across that boundary.
A does not infer the cursor or choose command semantics.
Large creator snapshots and command records automatically use `json-chunks-v1` archives with a stable prefix, chunk count and character count.
Read each `archive:<record-id>:<index>` record with `readProjectEvidenceRecord`; concatenate JSON chunks only when the consumer needs the full snapshot.
The ordinary observation checkpoint limit still rejects oversized producer pages rather than silently dropping evidence.

```tsx
<ProjectLifecycleStatus
  state={projectLifecycle(project, jobs, saving)}
  onOpenEditor={() => openExistingEditor(project.id)}
  onRetry={() => retryProjectAnalysis(project.id, jobId, attempt)}
  retrying={retrying}
/>
```

`state` contains `phase`, `message`, `canOpenEditor`, and optional `retryJob: { id, attempt }`.
The component never runs analysis, navigates, exports or deletes media on its own.
The caller owns those callbacks and must show rejected save/retry errors.


## Published implementation and final review corrections

Initial executable foundation: `de00de0`, draft [PR #75](https://github.com/AlwinSunil/one-take-expo/pull/75).
Recovery/archive/reference validation increment: `0209195` on the same branch.
Read the PR head for later verification-only updates.
`checkpointProjectSource(projectId, operationId, source: SourceRecord)` registers source provenance after `beginRecording` or `beginProjectPickup`, permits a pending URI/duration to become known from the existing journal-owned Project, and rejects rewriting a known duration.
Capture should checkpoint the pending pickup source before streaming its observations and checkpoint the durable URI after save.
No producer or capture code is imported or edited by this API publication.

An instantaneous observation uses equal `t0` and `t1`; it is evidence, never an exportable clip.
Capture-clock observations may extend past the probed media duration because their record-request clock is not calibrated PTS; presentation-clock samples still validate against media duration.
Their clock/provenance/uncertainty must remain explicit.
B's proposed nearest-millisecond timeline endpoints are retained exactly by persistence; A does not re-quantize observations or transcripts.
Legacy seeding retains legacy trim/cut values; B must publish any explicit first-command normalization when the B/C precision agreement is finalized.

Analysis result references must resolve to existing same-project evidence of the declared kind and correct source, or valid inline typed snapshot records.
Checkpoint proposal/reason/observation records before returning their IDs in a result.
Missing references reject completion instead of producing a fabricated Ready state.
Cancelled or stale results still preserve evidence when their reference envelope is valid.
Versioned extensions use `(key, version)` identity, so a newer unsupported version can coexist with its retained predecessor.
Archive `pageIds` must resolve to command pages and cover all commands removed from the active/abandoned window.

Existing cache-original metadata checkpoints now replay any pending original journal before treating a moved canonical file as committed.
A duplicate journal with a changed source or payload fails visibly; SQL compare-and-swap also protects the journal row.
Known file-size receipts reject empty/truncated canonical originals without overwriting the last metadata or valid cache source.
The record-copy commit uses an exclusive transaction for metadata, receipt and journal removal.
Caption/timeline/asset adapter retries retain the original caller intent, so retrying a correction cannot append it twice even after the first commit succeeded.

Run `node --experimental-strip-types tests/t15-fixture-replay.mjs` for exact source/timeline/history/caption/job/result transport envelopes.
The output is also captured in `docs/validation/evidence/t15-durability/canonical-envelopes.json`.


Late-capture preservation increment: `1f389f7`.
A cache-backed original finalization is treated as evidence delivery, preserving intervening editor trim/review/framing decisions and manual caption corrections.
The real-store replay covers finalization after a concurrent pickup/editor save.
Final source verification is recorded in `docs/validation/evidence/t15-durability/latest-commands.json`.

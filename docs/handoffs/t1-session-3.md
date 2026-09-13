# Session 3 shared contracts and integration handoff

Branch: `feat/t1-review-wrap-reframe`; draft [PR #58](https://github.com/AlwinSunil/one-take-expo/pull/58).
Initial additive contracts/gates: `46d5bc0`.
Review/wrap fixture implementation: `4b6de61`, `d78ee3c`.
Merged Tier 0 integration: `3c36d41`, incorporating merged main `11f4455`.
Native crops, multi-source wrap and provider adapter: `414d748`.
Merged producer main `15d80d6` (#59/#60) incorporated at `3536a88`.
The producer/persistence integration commit is `552fd00` (`Connect merged producer contracts and preserve concurrent review edits`).
These commits are pushed; no unmerged producer work was merged, rewritten or cherry-picked.
These seams remain proposals about transport, not agreement about recognition or vision verdicts.

## Common gate and compatibility

`src/lib/t1-gates.ts` keeps every release feature false: takeReview, wrapReport, reframing, speech and coaching.
Call `tier1Enabled(feature, __DEV__, explicitTestOptIn)` from producer and consumer entry points.
Saved project preferences never enable release features.
The editor has an explicit development toggle, and `/t1-review-fixtures` is development-only.
A native crop additionally requires `OneTakeMedia.supportsFraming === true`.
Old native builds omit crops and retain original framing.
Optional fields preserve legacy project normalization, original media, review decisions and recovery.
No schema rewrite or migration is required.

## Session 1: evidence and cleanup

Inspected published `feat/t1-speech-control` at `d026b8d87a2bb12fe1b55a5cff8ba57c4b6e1453` through PR #59.
[Coordination comment](https://github.com/AlwinSunil/one-take-expo/pull/59#issuecomment-5649390547) requests producer-owned identity mapping and gate adoption.
PR #59 is now merged at `e1d3524`; its actual pure producers are available, while live capture publication and immutable identity/revision snapshots remain incomplete.
Do not label this integrated speech evidence.

`src/lib/t1-contracts.ts` defines immutable `Tier1Evidence` snapshots keyed by projectId and a fresh revision for each changed result.
`scriptSnapshot` is the exact ordered list of `{ lineId, spokenText }` used to derive the result.
Missing or changed script identity prevents an unqualified wrap.
Take, line, recognition-segment and command IDs must remain stable for their original utterance/job and must never be reused for another one.
Reasons preserve the producer message and status.
Must-say statuses are supplied verdicts; caption corrections never recompute them.
Scratch history retains commandSegmentId, target takeId and proposed/applied/restored state even after restoration.
Cleanup retains suggestionId, source footage and kept/removed/restored state.
`boundariesReviewed` means explicit creator listening, never recognition timestamps.
The existing reversible cleanup/transcript helpers remain compatible; no competing edits were made to them.

Example source footage: `{ recordingId: 'recording-1', t0: 1.2, t1: 4.8 }`.
Times are finite seconds relative to the original recording, not wall clock or recognizer delivery time.
A single utterance covering multiple lines remains a single take unless its owner supplies reviewed split boundaries.
Merged Tier 0 `recordings` maps recordingId to owned URI and duration.
Legacy primary footage uses recordingId equal to project.id.
`resolveReviewFootage` checks current file inventory, range, pending recording state and identity before offering playback.
A supplied reference is never proof that a file exists.

Requested owner-authored next step: publish a narrow adapter from the producer result to these snapshots, or propose additive contract amendments with exact examples.
Preserve raw transcript and spoken evidence while displaying manualCorrection in captions.
Both producer agreement and held-out acceptance remain pending.

## Session 2: capture wrap and pickup

Capture supplies `firstTakeStartedAt` and `wrapRequestedAt` as epoch milliseconds from the same clock.
Omit unknown timing; never substitute project creation or editor-open time.
`T1WrapReport` accepts project, onChange, enabled, and optional onReviewFootage, onPickup and onConfirmAction callbacks.
It reports per-line coverage, supplied must-say status, take count, timing and playable supporting ranges.
Required actions remain creator confirmations separate from spoken requirements; optional actions do not block wrap.
`WrapAcknowledgement` persists only after explicit Wrap anyway and retains the remaining flags.
Its contextKey binds the exact script, action requirements/confirmations, primary source, recording identities/durations, media inventory and unavailable takes in addition to evidenceRevision.
A changed or missing context invalidates the old acknowledgement while retaining its saved flags for review.

The merged capture route supports `{ pathname: '/camera', params: { mode: 'script', script, pickupProjectId } }` plus saved `pickupRequest: { lineIds, requestedAt }`.
The editor now launches an individual baseline-needed line through this route after durable save.
Capture's `requestedPickupLineIds` still intersects with baseline cleanReview needs.
A producer-only missing must-say on an otherwise covered line therefore remains flagged with an explicit unsupported-pickup message.
Requested owner-authored capture edit: accept an explicit validated must-say pickup reason/line identity without reinterpreting wording in the editor, and present this report at capture wrap under the common gate.
Do not make optional coaching a recording or wrap blocker.

## Session 2: framing

Inspected `feat/t1-coaching-framing` at `af56b664921ad1ec885d83af7b4720d71b1b56a2` (published implementation reference `b0132b0`), PR #60.
[Coordination comment](https://github.com/AlwinSunil/one-take-expo/pull/60#issuecomment-5649390683) publishes the consumer seam.
`src/lib/t1-framing-provider.ts` structurally validates this published payload without importing unmerged implementation.
It converts source-local milliseconds to seconds exactly once and preserves sourceMediaId, takeId, analysisId/revision, selected interval, upright unmirrored frame, provenance and producer confidence.
The adapter rejects stale identities and does not infer completeness or movement from timestamps.

Requested additive producer fields: explicit coverage and movement states, relevant protected-region rectangles with stable track IDs, stable-union proof covering both interval boundaries, and a caption safe area.
All coordinates are normalized top-left rectangles in the upright, unmirrored original source; width/height are fractions, frame dimensions are pixels, rotation is degrees.
Confidence remains the producer's own value and is not a new calibrated accuracy claim.
Fixture and device provenance must be distinct; processor must be cpu/gpu/npu/unknown based on actual evidence.
Without these fields, the adapter returns an immutable original-frame fallback with the missing requirements.

Project framing stores `{ enabled, suggestions }`; runtime enablement remains separate.
`applyProjectFraming` supplies identical segment crop decisions to preview and export.
Each cut uses a static crop, bounded gentle zoom, complete stable coverage, protected regions and caption-safe checks; no continuous tracking or jitter is introduced.
Native segment crop is centered NDC `{ left, right, bottom, top }`, finite in [-1, 1].
Example normalized crop `{ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }` becomes `{ left: -0.8, right: 0.8, bottom: -0.8, top: 0.8 }`.
Media3 applies Crop before Presentation in the common composition; captions remain after video effects.
Off/reset strips crops and preserves original media.
The physical product fixture exposed a caption/hand collision; the consumer rejects unsafe crops, and caption placement in crowded original frames remains a separate rendering limitation, not proof of safe vision.

## Remaining integration and review

Tier 0 PRs #46/#48/#49/#50/#52/#54/#55/#56/#57 are now merged; they are no longer unmerged-code blockers.
The full #34 device/human regression is still required on the integrated release candidate.
PRs #59/#60 have now merged and are incorporated at `3536a88`.
The actual merged framing fixture bridge is `src/lib/t1-framing-integrated.ts`; all suggestions retain original-frame fallback until the listed proof gaps are resolved.
Complete owner-authored live capture/script wiring and rerun affected tests and native flows.
Do not import uncommitted work from another worktree.
Keep #30/#31/#38 named Sabari review, #40 Alwin review, both other contributors' independent reproductions and shared data-loss-path review pending.
See `docs/validation/T1.md` for exact evidence and limitations.

## Merged producer persistence and consumer APIs

`Project.speechControl?: T1SpeechProviderEnvelope` persists the immutable merged-producer envelope; `Project.scriptSnapshot?: ScriptDraftSnapshot` preserves accepted script intent.
These fields are optional and round-trip through legacy project storage without changing original media.
`projectWithSpeechEvidence(project, enabled)` validates the envelope against current ordered spoken line IDs/text and calls the actual merged speech reducers/evaluator through `adaptT1SpeechProviderEnvelope`.
Invalid present evidence removes any older projected verdict from the review view and displays an error; stored raw metadata remains available for recovery.
No take ID or captured requirement revision is synthesized during reopen.
Caption display corrections remain outside the must-say evidence input.
Manual scratch now has `commandSegmentId: null, source: 'manual'`; voice scratch retains its real command segment and `source: 'voice'`.
Existing nonempty commandSegmentId snapshots without source remain compatible.
This nullable amendment represents the producer's explicit manual event instead of inventing a recognition command.

Atomic script APIs in `src/lib/store.ts` are `saveTier1ScriptDraft(snapshot)`, `getTier1ScriptDraft(expectedIdentity?)`, `acceptTier1ScriptDraft(snapshot)` and `getAcceptedTier1Script(expectedIdentity?)`.
Use `createScriptDraftSnapshot({ identity, document, mustSay })` from `src/lib/t1-script-draft.ts` for an explicit edited document.
The snapshot is `{ version: 1, identity, text, structure, mustSay }`, where structure and mustSay are the existing owner serializers' strings.
The store transaction writes the raw text, legacy structure key and versioned envelope together.
Accept atomically promotes all three values and clears all draft values.
A paired read uses one SQL statement and rejects changed raw text, wrong identity, malformed structure or stale requirement metadata.
Missing legacy metadata returns null; present invalid metadata throws and must keep autosave disabled until the user recovers it.
Deserialize never repairs stale wording or stamps a new revision into saved recognition evidence.

Session 1 requested owner edit: replace the separate raw/structure draft writes with these atomic APIs, preserve one durable draft identity, mount MustSayToggle under the common gate, and attach the accepted snapshot to capture.
Session 2 requested owner edit: publish envelope source/take/segment IDs and requirementRevisions at the capture attempt boundary, retain them across refinement, and keep manual/voice scratch on the shared producer reducer.
Do not relabel legacy `needsListening` as an intentional scratch; it remains unresolved legacy evidence until the owner supplies explicit event history.

The shared legacy TranscriptReview pickup-original callback has no per-recording availability predicate.
Until an additive owner-authored `canPreviewRecording(uri)` seam is available, the editor disables that bulk callback when any listed original is unavailable; the Tier 1 per-take/footage controls continue checking each source individually.
No competing edit was made to the shared helper.

## Current route adoption and requested owner edits at `552fd00`

The atomic script APIs are available in `src/lib/store.ts`, but `src/app/script.tsx` still calls the legacy `getDraft`, `saveDraft`, `acceptDraft`, `saveScriptStructure`, `saveAcceptedScriptStructure`, and `clearScriptStructure` functions.
Its autosave currently writes the raw text and structure through separate operations, and its Continue action accepts the raw string before separately saving the structure.
The normal camera route currently receives `{ mode: 'script', script }` and calls `loadAcceptedScriptDocument(routeScript || undefined)`, so it does not yet read `getAcceptedTier1Script(expectedIdentity?)`.
The pickup route currently receives `{ mode: 'script', script, pickupProjectId }`, loads the project by id, and reconstructs the capture document from the legacy project fields.
The editor saves `pickupRequest` before pushing that route, and the camera intersects the requested line ids with the current project coverage.
These route behaviors preserve the Tier 0 flow, but they do not yet attach the accepted atomic script snapshot or the speech producer envelope to a recording attempt.

The script owner should allocate one opaque non-empty draft identity for the lifetime of a draft, persist it with the snapshot, and pass it unchanged as `expectedIdentity` on every paired read.
The identity must not be derived from mutable text, line position, recognition segment ids, or a new timestamp on each autosave.
The owner should build `createScriptDraftSnapshot({ identity, document, mustSay })` after each loaded edit, call `saveTier1ScriptDraft(snapshot)` after the initial read succeeds, and stop autosave when a present snapshot raises `ScriptDraftSnapshotError`.
The Continue action should call `acceptTier1ScriptDraft(snapshot)` and push the same opaque identity to the camera handoff or attach the accepted snapshot to the new project.
The normal camera route should prefer `getAcceptedTier1Script(expectedIdentity?)` and retain the existing legacy loader only when the versioned snapshot is absent.
The pickup camera route should prefer the target project's `scriptSnapshot` and preserve its identity and must-say metadata while retaining the existing raw project fallback for legacy projects.
No route should recover a malformed present snapshot by reparsing text and silently disabling line or must-say identity.

The store contract is intentionally strict.
`saveTier1ScriptDraft(snapshot)` validates and writes `script_draft`, `script_draft_lines`, and `t1_script_draft` in one SQLite transaction.
`getTier1ScriptDraft(expectedIdentity?)` reads the raw and versioned values together and returns `null` only when the versioned value is absent.
`acceptTier1ScriptDraft(snapshot)` writes `script_accepted`, `script_accepted_lines`, and `t1_script_accepted` together, then clears all draft keys, and returns `snapshot.text`.
`getAcceptedTier1Script(expectedIdentity?)` applies the same paired-read and identity checks to the accepted values.
Present malformed, stale, structure-mismatched, text-mismatched, or must-say-mismatched values throw `ScriptDraftSnapshotError` and must leave the caller's existing raw or legacy value available for recovery.

The speech consumer is now connected at the editor boundary through `projectWithSpeechEvidence(project, enabled)`.
When the `takeReview` gate is enabled, it passes the current ordered non-empty spoken lines from `projectScriptLines(project)` to `adaptT1SpeechProviderEnvelope`.
An invalid present `Project.speechControl` clears only the projected `tier1Evidence` and exposes the adapter error while retaining the raw envelope and original media.
The capture owner still needs to persist `Project.speechControl` at the attempt boundary and update it through pickup/refinement checkpoints.
The current camera code allocates `captureTakeId` and saves legacy `takes` and `transcript` fields, but it does not yet publish the `T1SpeechProviderEnvelope` fields `capture.recordings`, `capture.takeDecisions`, `mustSay.segments`, `requirementRevisions`, `cleanup`, `firstTakeStartedAt`, or `wrapRequestedAt`.
The capture owner must preserve one source/session/take/recognition identity across retries, carry the captured requirement revision map forward without stamping current revisions onto old takes, and persist explicit `mediaUri`/`mediaAvailable` state for every source.
Pickup sources must retain source-local seconds and their own durable `recordingId`; they must not be merged into the primary source by position or URI.
The wrap owner can then project the envelope through the adapter on reopen without reinterpreting speech or caption corrections.

The envelope shape consumed by the editor is:

```ts
{
  version: 1,
  projectId,
  provider: 'fixture' | 'integrated',
  revision,
  status,
  scriptSnapshot: [{ lineId, spokenText }],
  capture: {
    recordings: [{ recordingId, mediaUri: string | null, duration, mediaAvailable }],
    takeDecisions,
    firstTakeStartedAt?: number,
    wrapRequestedAt?: number,
  },
  mustSay: { metadata, segments, recognitionStatus?, recognitionMessage?, mediaAvailable },
  cleanup: [{ recordingId, plan }],
}
```

All segment and cleanup ranges are finite seconds relative to the original source.
The two capture timestamps are epoch milliseconds from the same capture clock.
The adapter preserves manual scratch as `{ source: 'manual', commandSegmentId: null }` and voice scratch as `{ source: 'voice', commandSegmentId: '<producer segment id>' }`.

## Framing proof status after PR #60

PR #60 is merged at `15d80d6`, and the producer bridge is available at `src/lib/t1-framing-integrated.ts`.
`integrateFramingFixture` exercises the actual merged producer for `portrait-talking-head`, `moving-vlog-subject`, `product-demo-with-hands`, and `missing-detections`.
The ready producer result currently carries source/take/analysis identity, selected interval, frame, crop, confidence, reason, supporting track ids, and provenance.
The consumer adapter still requires explicit `coverage`, `movement`, `protectedRegions`, `unionProof`, and `captionSafeArea` proof before applying a crop.
The current bridge reports all five fields in `remainingFieldGaps` for the ready fixture rows and returns an original-frame decision with `missing-proof`.
The missing-detection fixture remains an original-frame fallback with `provider-fallback`.
This is an intentional fail-closed result because sampled tracks and a stable-union reason do not prove every frame, both half-open interval boundaries, protected faces/products/hands, or a caption-safe area.

The framing owner should publish those five fields with the same immutable sourceMediaId, takeId, analysisId, analysisRevision, selected interval, upright unmirrored frame, and provenance.
The source-local millisecond-to-second conversion must happen once at the producer adapter boundary.
The review/export owner should then pass the validated suggestions through `applyProjectFraming`, which strips stale crops when framing is off and gives preview and Media3 export the same static `nativeCrop` decision.
Moving subjects, missing tracks, uncertain analysis, stale identities, unsafe protected-region unions, and missing media must retain the original frame.
The deterministic fixture/native harness does not establish real device vision, processor, held-out accuracy, or crowded-scene caption safety.

## Media inventory callback seam

`src/lib/review-media-inventory.ts` now projects `availableMediaUris` into review and restores stored take playability after transient preview failures without rewriting durable evidence.
`resolveReviewFootage(project, footage)` checks recording identity, source-local range, duration, pending evidence, and the store-refreshed inventory before returning a playable URI.
The shared `TranscriptReview` component still accepts only `onPreviewRecording(uri, duration)`.
The editor therefore supplies that bulk callback only when every listed pickup recording URI is currently available, which disables a usable pickup preview when a different pickup is missing.
Add an optional callback with a recording-shaped argument, for example `canPreviewRecording(recording: { id: string; mediaUri: string; duration: number; evidenceStatus?: 'pending' | 'complete' }): boolean`, while preserving the current `onPreviewRecording` signature for compatibility.
The row-level callback should call the inventory-aware resolver for that recording and leave other pickup rows playable when their own media is present.
Pending evidence and absent inventory entries must remain unavailable until the store refreshes the source inventory.

## Remaining owner and acceptance work

The release gates remain false by default, including speech, take review, wrap report, reframing, and coaching.
The capture owner still needs to adopt atomic script identity and publish the durable speech envelope at record, interruption, pickup, refinement, and wrap checkpoints.
The framing owner still needs to publish the five proof fields and a real device-backed protected-region/caption-safe result.
The inventory owner still needs the additive per-recording preview predicate.
The full #34 Tier 0 regression, held-out speech/command/must-say accuracy, A/V checks, processor evidence, named Sabari/Alwin/Melvin review, and independent reproductions remain pending.

## Reversible cleanup consumer

Cleanup consumer implementation: `e782e18` on `feat/t1-review-wrap-reframe`.

`Project.cleanupReview?: T1CleanupReviewState` stores the pre-cleanup prepared sequence, source identities, speech revision, explicit fingerprint-bound decisions and the applied sequence fingerprint.
The gated editor and recovery review consume `speechControl.cleanup` through `T1CleanupReview`.
A removal requires current script/project evidence, available source media, verified independent-silence or manual-review boundaries and an interval contained in exactly one existing prepared segment.
Recognition-only boundaries and mid-sentence default marks stay review-only.
Accept/reset clears `cutsReviewed`; originals and raw transcripts stay intact.
Reset refuses to overwrite a sequence changed independently since the cleanup decision.
Capture must publish actual cleanup plans with source-local seconds and immutable recording/fingerprint provenance.
This consumer has deterministic behavior tests, with device listening and splice quality still pending.

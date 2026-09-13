# Session 3 shared contracts and integration handoff

Branch: `feat/t1-review-wrap-reframe`; draft [PR #58](https://github.com/AlwinSunil/one-take-expo/pull/58).
Initial additive contracts/gates: `46d5bc0`.
Review/wrap fixture implementation: `4b6de61`, `d78ee3c`.
Merged Tier 0 integration: `3c36d41`, incorporating merged main `11f4455`.
Native crops, multi-source wrap and provider adapter: `414d748`.
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
The producer branch remains unmerged, so the editor currently exercises invented `Tier1Evidence` fixtures.
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
Integrate #59/#60 only after merge, replace fixture adapters with agreed producer mappings and rerun affected tests and native flows.
Do not import uncommitted work from another worktree.
Keep #30/#31/#38 named Sabari review, #40 Alwin review, both other contributors' independent reproductions and shared data-loss-path review pending.
See `docs/validation/T1.md` for exact evidence and limitations.

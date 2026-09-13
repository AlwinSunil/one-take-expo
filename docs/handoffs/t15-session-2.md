# T1.5 Session 2 capture contract proposal

Branch: `feat/t15-capture-signals`, based on merged main `15d80d6`.
PR #58 remains open; no unmerged dependency code is copied here.
This is an owner proposal, not other sessions' agreement or V1 acceptance.

## Gaze observations for #64 / #65 / #66

Producer-owned module: `src/features/vision/gaze.ts`.
A capture scope has stable `projectId`, `sourceId`, `takeId`, `captureSessionId`, and `generation`.
Use the existing root recording ID as the root source identity and the existing pickup recording ID for pickup sources, subject to Session 3's canonical mapping.
Allocate capture identity once before `recordAsync`; retries after a failed recording allocate a new identity.
Lens/binding generations are distinct even when returning to the same lens.
Each observation has stable `id`, scope, `relativeSeconds`, `label`, `reason`, `provenance`, and nullable confidence/uncertainty.
Directions use the upright unmirrored camera image; preview mirroring is a separate display transform.
The current bundled ML Kit 16.1.7 face-only engine cannot establish any gaze direction or verified eye contact.
It produces `unknown` with unsupported/no-face/ambiguous/stale/unavailable reasons; occlusion, glasses and low light cannot be reliably distinguished by this engine.
No new gaze model is proposed.
Sampling is approximately once per second only during recording; missed intervals produce explicit gap observations, never forward-filled certainty.
Stop/background/route exit ends collection immediately and old generation evidence is rejected.
The source-time anchor is JS monotonic time at the `recordAsync` request, not calibrated media PTS.
Native frame time is Android elapsed realtime at analyzer acceptance, normalized through an emission/JS receipt anchor with unknown bridge latency.
Persist seconds and this uncertainty; never claim sensor-clock or A/V precision.
Existing framing milliseconds require explicit `seconds * 1000` at a framing boundary.
Gaze cannot alter speech, coverage, Wrap, footage or creator choices.

## Visual Suggestions #69

Producer-owned module: `src/features/coach/suggestion-job.ts`.
A user tap creates a stable job ID scoped to capture session, lens/binding generation and intent.
Lifecycle: idle, loading, result/all-good, unavailable, cancelled/stale.
Duplicate taps deduplicate while loading; Retry creates a fresh job.
Bound evaluation count/time and expose actual starts/evaluations in debug diagnostics.
Entering camera, restoring preferences, recording, opening settings, completion and lens refresh create no jobs.
Dismissal, Stop, background and route exit cancel active work; late results cannot revive it.
Face-only observations are not calibrated lighting/framing/angle/exposure/background evidence.
Current runtime therefore returns honest unavailable results, while deterministic calibrated fixtures test result/all-good states only in tests.
Shared frame infrastructure and gaze remain independent.

## Capture and Stop owner integrations

Session 1 supplies a props/hook contract for voice-follow enabled/status/current position and explicit manual reanchor using stable script IDs and accepted transcript revisions.
Camera retains Previous/Next and remote navigation and passes every accepted manual movement through that reanchor.
Reading position does not establish coverage or resolve physical actions.
Session 1 supplies source-relative speech observations and final analysis input/output; no second recognizer or microphone is added.
Session 3 supplies canonical source identity mapping, persisted gaze extension and an idempotent metadata checkpoint API for both root and pickup originals.
Requested API semantics: save original plus available capture metadata before optional final analysis; reject scope mismatch, preserve unknown extensions and retain recovery on metadata failure.
Camera already checkpoints returned originals before caption finalization and routes to `/editor?projectId=...` after save.
Session 3 should own the visible analysis stage in the existing editor flow and expose an owner-authored route/API contract for pending, retry, cancellation and original access.
No capture-side storage, analysis engine or editor will duplicate those owners.
Targeted pickups retain original script IDs and pickup/source IDs; Session 1/3 must supply point IDs and script revision snapshots rather than camera reconstructing points from text.
Independent work proceeds against small fixtures until these contracts merge.

## Acceptance still pending

Integrated iQOO device/OS/build, model/processor, five-session cadence/confusion/drop/thermal/battery/recording-impact evidence, large-text/screen-reader UI, A/V and named human acceptance remain pending.
No device installation or recording is authorized by this handoff alone while other sessions may be testing.
Session 3 owns `docs/validation/T1.5.md`; this document and later Session 2 evidence supply its lane results.

## Published dependency inspection

Session 1 proposal inspected at `f097b0f`, `feat/t15-speech-analysis`, PR #70.
Session 3 proposal inspected at `ccce524`, `t3code/feat/t15-timeline`, PR #72.
Session 3 confirms legacy primary `sourceId = project.id` and pickup `sourceId = recordings[].id`.
Its durable observation/checkpoint APIs remain design-only pending #58; no API exists to call yet.
At the initial inspection, Session 1 had published DTOs only; the producer refresh below supersedes this status.
Revision encoding differs between proposals (Session 1 string script/edit revisions, Session 3 integer revision vector), so owners must specify conversion rather than capture inventing it.
Session 2 can provide capture/source/binding identity and source-relative timing independently.
The baseline web camera route was reproduced on port 8096 and fails before rendering at SQLite `.wasm` resolution.
Session 3 owns the Metro asset configuration fix; evidence is `evidence/t15-session-2/web-baseline-blocker.png`.

## Executable camera integration

Explicit development access is `/camera?coachingDevelopment=1` or `/camera?mode=script&coachingDevelopment=1` in a development build.
It enables the new gaze collector and request jobs; production release acceptance remains false.
The same original recorder, caption hook and native ImageAnalysis owner remain in use.

`createGazeCollector(scope, sourceZeroMonotonicMs, { onObservation })` is the producer API in `src/features/vision/gaze.ts`.
Call `sample(performance.now(), latestVisionEvidence)` approximately every 1000 ms and `stop(performance.now())` at the first Stop/background/route-exit boundary.
`scope.visionSessionId` is the current `vision.evidence.sessionId`, separate from capture/source identity.
Native binding IDs now change on each reattachment, including background/resume and front/back/front.
Sampling does not rebind or start another analyzer when recording begins.
The callback supplies observations for Session 3's future paged metadata sink; the bounded snapshot is diagnostics/recovery context, not a complete durable ledger.
The current camera has no owner-authored metadata sink to call, so its observations remain development-only in memory and are not claimed persisted.

`createSuggestionJobController()` starts inert; `bind(identity)` never evaluates scenes.
Only the camera's Visual Suggestions tap calls `start({ ...identity, requestedAtMs: performance.now(), evidence })`.
The controller evaluates one recent snapshot and bounds an asynchronous evaluator by a 2500 ms timeout.
It reuses the Tier 0 coach policy's calibrated cue constraints; the current face-only camera adapter supplies no calibrated cues.
Retry takes a new current snapshot; no periodic refresh or preference restoration invokes an evaluator.
Job identity includes camera/capture session, native binding/lens generation, zoom and creator intent.
The inline scrollable result panel precedes the bottom controls, so it does not cover Record/Stop or the prompter/transcript overlays.
Actual job start/evaluation counters appear only in development diagnostics.

`src/features/capture/stop-handoff.ts` exports `CaptureScope`, `CaptureEvent`, `checkpointCaptureOriginal`, and `buildCaptureStopHandoff`.
Camera emits record-requested, stop-requested and original-saved events with stable capture/source identity.
Lifecycle `relativeSeconds` is elapsed time from the record request; original-saved may occur after media duration and is NOT an exportable source range.
`durationSeconds` comes from the existing native media metadata probe.
The existing root `saveProject` now completes its durable copy before awaiting caption finalization, matching the pickup checkpoint's existing ordering.
Save failure keeps the returned original and existing retry closure; optional metadata cannot authorize editing or deletion.
The capture handoff contains source scope, duration, lifecycle events, and either a gaze snapshot or explicit not-collected state.
It is marked `metadataPersistence: pending-owner-integration` until Session 3 supplies a durable checkpoint.
Full raw transcript revisions remain supplied by the existing caption hook and saved-project path, not the bounded visible text.
Audio alignment retains the existing live-estimate wall-clock start offset; gaze uses a separate JS monotonic record-request anchor.
Neither timing path claims calibrated sensor/PTS or verified splice boundaries.

## Exact remaining owner edits

Session 3: add the #65 durable observation sink and source metadata checkpoint, preserving every emitted record/overflow range through paged storage.
Wire the callback at `createGazeCollector` and persist `buildCaptureStopHandoff` with the original before enqueueing final analysis.
Do not serialize only the 120-observation diagnostic ring as complete collection history.
Session 3: supply the final-analysis route/job API in the existing editor; camera continues routing directly to `/editor` after durable save, without rendering/export.
Session 1: merge the published follower/component and confirm caption revision adaptation; camera must feed accepted caption revisions and all manual/remote movements through it after merge.
Session 1/3: supply stable important-point/revision pickup fields through the existing pickup request schema; current camera preserves existing requested line/source IDs.
No unmerged producer or shared-schema implementation is copied here.

## Review corrections

New capture/root/pickup identities use the existing Expo UUID generator; a wall-clock rollback cannot reuse a source ID.
The JS monotonic anchor now immediately precedes `recordAsync()` rather than collector construction.
`startVisionBinding` issues a binding-specific compensating stop when an asynchronous start settles after its owner exits.
Starting recording retains the current binding instead of treating the recording-state render as ownership cancellation.
The metadata-persistence review finding remains open: the camera's in-memory handoff is lost when its route unmounts until Session 3 supplies and integrates the durable sink/checkpoint.
This is why #64 and the Stop-to-analysis integration cannot be described as complete or release-ready.

Published executable references: gaze producer `1d7c8d6`; integrated camera/jobs/Stop payload `8709a7f`.
See `t15-session-2-verification.md` for the issue acceptance matrix and exact command results.

Final reviewed source reference: `3bd5a01`.
`retry(freshEvidence?)` never reuses old scene evidence; camera Retry calls its current-snapshot request handler.
Native cleanup also covers rejected partial starts, and the root's cache-URI checkpoint is retained before durable copy for low-space recovery.

## Latest producer refresh

Session 1 implementation inspected read-only at `5947706053dde425bb30d2a20f47a23e7f657a4a` on `feat/t15-speech-analysis`, open PR #70.
`VoiceFollowToggle` accepts `enabled`, `onEnabledChange`, optional `status`, `disabled`, and `featureEnabled` (default false).
`createAlignmentFollower(options)` exposes `state`/`getState`, `consume`, `manualNext(at?)`, `manualPrevious(at?)`, `reanchor(lineId, at?)`, `setEnabled`, `setPickupLineIds`, and `reset`.
Its state carries `currentLineId` and `nextLineId`; camera can resolve those IDs to existing script text after integration.
Manual timestamps and incoming speech must share the producer's source-relative seconds contract, with unknown clocks left explicit.
These are published APIs, not code integrated into this branch; no unmerged implementation was copied.
Session 3 remains at `ccce52479e741b3853d7a8bdf4253ebb4e4691b5`, open PR #72.
Its durable metadata/job methods remain proposals, so the in-memory gaze/Stop limitation above remains open.
Session 2 CI passed at `7bbbcc7`: https://github.com/AlwinSunil/one-take-expo/actions/runs/34729254239.

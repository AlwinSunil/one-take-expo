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
Session 1's voice-follow hook/component is not published yet; its initial DTOs alone do not implement following.
Revision encoding differs between proposals (Session 1 string script/edit revisions, Session 3 integer revision vector), so owners must specify conversion rather than capture inventing it.
Session 2 can provide capture/source/binding identity and source-relative timing independently.
The baseline web camera route was reproduced on port 8096 and fails before rendering at SQLite `.wasm` resolution.
Session 3 owns the Metro asset configuration fix; evidence is `evidence/t15-session-2/web-baseline-blocker.png`.

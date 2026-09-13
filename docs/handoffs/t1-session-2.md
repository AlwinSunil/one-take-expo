# Session 2 additive handoff: framing v1

Latest integration: merged `origin/main` at `11f4455` in merge commit `cdbd0fa`.
Tier 0 PRs #54, #55, #56 and #57 are now merged.
Session 2 implementation is published at `b0132b0`; subsequent integration commits stay on `feat/t1-coaching-framing`, draft PR #60.
The camera now passes the development opt-in into the existing `CaptureSuggestions`; the Tier 1 intent/manual controls replace its legacy picker/tips only for that opt-in.
The existing `CompositionCoach`, vision hook, recording lifecycle and transcript/coverage UI are retained.
Recording-time optional coaching remains quiet because the setup sheet is unavailable while recording.
Native product/hand extraction, validated automatic cues, Session 1 recording-time speech/priority publication and Session 3 common gate/persistence/application remain pending.

Branch: `feat/t1-coaching-framing`, based on merged `e050a0d`.
Contract publication is the first commit on this branch; implementation commits follow on the same branch.

## Framing contract for Session 3

Suggestions are optional edit metadata, never media mutations or splice boundaries.
A request identifies `sourceMediaId`, `takeId`, `analysisId` (new per analysis attempt), source `durationMs`, selected half-open `[startMs,endMs)` and creator `intent: talking-head | vlog | product-demo`.
All timestamps are milliseconds relative to the original source presentation timeline, before trims, speed changes or concatenation.
Never use recognition timestamps as crop or splice evidence.
Reject identity mismatches and invalidate results when media, selected interval, intent, orientation or analysis revision changes.

Coordinates are normalized `[0,1]` top-left x/y/width/height rectangles in the upright, unmirrored original frame after applying clockwise metadata rotation (0/90/180/270).
`uprightWidthPx` and `uprightHeightPx` specify that frame; `rotationDegrees` records the transform from encoded media.
Preview mirroring is a display transform only and must not be baked into stored crops.
Crops preserve the original upright aspect ratio; target-aspect conversion is outside v1 and must use original-frame fallback until separately validated.
Regions include stable `trackId`, `kind: face | subject | product | hand`, rectangle, confidence `[0,1]`, and explicit creator selection/relevance.
Provenance identifies fixture versus device, model/version and actual processor (`cpu | gpu | npu | unknown`); fixture rules run on host CPU and prove no inference hardware.

Produce one static crop per selected interval, enclosing the union of all relevant regions throughout that interval with margin.
No per-frame crop chasing; maximum zoom 1.35x.
Missing, low-confidence, off-frame, discontinuous or unsafe multi-subject evidence produces the full original rectangle `{x:0,y:0,width:1,height:1}` with a reason.
Product demos require selected product and relevant hands; never replace these with presenter-only crops.
Return confidence conservatively as minimum supporting confidence, reasons, source identities, interval and provenance.
Consumers must keep originals and explicit apply/undo decisions, validate the payload, and never auto-apply.

Examples: portrait 1080x1920 talking head uses a stable portrait crop containing all selected face positions; moving subjects use their temporal union or original fallback; two people require both faces preserved or original; product with hands preserves all three regions; missing detections returns original, never a guessed center crop.
Executable types and fixtures will live under `src/features/vision/framing*`.

## Owner-authored integration requests

Session 3: add a common default-false Tier 1 gate for coaching and framing, retaining false until individual acceptance and Tier 0 regression pass.
Persist framing metadata additively keyed by immutable source/take/analysis identity, and apply only in your preview/export lane after validation and explicit choice.
Session 1: supply a props-only transcript/priority seam with take identity, monotonic timestamp, speech `silent | speaking | unknown`, observed between-lines boolean, and coverage/action priority boolean.
Unknown or stale speech signals suppress recording coaching; coverage/action signals always outrank optional tips.
No transcript strings or microphone consumer are required by coaching.

## Initial Tier 0 dependency snapshot (superseded by integration above)

#28 depends on #10 research, #15 / PR #56 vision readiness, and #18 / PR #55 composition coach.
The existing policy consumes calibrated observations, not raw face rectangles; separation and lighting remain manual until real-frame validation exists.
Extend the existing coach after merge, do not mount a second coach.
PR #57 owns incoming capture integration and PR #54 recording hardening; resolve camera changes only after merge.
#35 additionally depends on #28 and selected-take/source identity from Session 3.
No unmerged Tier 0 changes are copied or cherry-picked here.

## Published references and browser blocker

Initial contract commit: `2f18288` on `feat/t1-coaching-framing` (pushed).
Session 3 can inspect it immediately without access to this worktree.
At initial publication, main displayed unavailable visual analysis and the Tier 0 coach was not merged.
Session 2 adds an explicit development-only camera parameter `coachingDevelopment=1` for manual setup control review; it is not a common release gate and cannot enable production coaching.
Replace this temporary exposure with Session 3's accepted common gate only after release acceptance.

Browser baseline reproduction: `EXPO_NO_DOTENV=1 npx expo start --web --port 8094`, open `/camera?coachingDevelopment=1`.
Metro fails resolving `expo-sqlite/web/wa-sqlite/wa-sqlite.wasm` before rendering any route.
The file exists in installed dependencies; current `metro.config.js` only wraps Expo defaults with NativeWind.
Session 3 should inspect Expo SQLite web asset configuration and land the owner-authored fix.
Evidence: `docs/handoffs/evidence/t1-session-2/web-baseline-blocker.png`.
This is a baseline app-flow blocker, not a passed camera/UI check.
No config, package or lock files were edited.

## Integration order

1. Merge dependency PRs through their owners and normal review; then merge latest `origin/main` into this lane branch.
2. Preserve incoming recording lifecycle and the single vision hook in `camera.tsx`.
3. Replace the development-only manual sheet exposure with the existing `CaptureSuggestions` surface, mapping `talking-head` to `talking-head`, `vlog` to `subject`, and `product-demo` to `product`.
4. Feed the Tier 1 priority gate from Session 1, then invoke the existing `CompositionCoach` only on delegation.
5. Keep the Tier 0 cue stability/cooldown/dismissal mechanism and observation calibration checks; do not derive calibrated cues from ML Kit face-presence boxes.
6. Add source-relative track extraction behind the #15 producer only once orientation, subject selection, relevant hands/products and actual inference provenance are available.
7. Session 3 persists optional suggestions, validates immutable identity and applies explicit reversible preview/export choices.
8. Rerun affected regression and device/human checks before the common gate can be enabled.

Framing-track sampling is evidence at sampled instants, not proof of every intervening frame.
Even a mathematically valid suggested crop requires creator preview; no suggestion certifies media quality or safe splice timing.

## Transcript and priority adapter details

Executable API: `gateTier1Coach` in `src/features/coach/tier1-policy.ts`.
The gate does not choose cues; `delegate` maps the intent for the incoming Tier 0 policy.
Its `nowMs` and signal `observedAtMs` are monotonic milliseconds on the same clock, never source PTS or wall-clock timestamps.
Signals older than 1000 ms or from the future are unusable during recording.
`captureGeneration` is an opaque string replaced whenever capture/lens binding or take lifecycle changes.
Use a new `takeId` at each new recording and clear cached transcript/priority state on rebinding.
Required work must be represented by current priority state; missing priority is not permission to show coaching.
The gate never consumes transcript strings and never resolves actions, wrap or take selection.
A `delegate` result still requires fresh calibrated scene observations and the Tier 0 1.5-second issue / 1-second clear / 15-second distinct-prompt timing rules.
No fixture is converted into `on-device-vision` evidence.

## Final framing API and fixtures

Import `FramingAnalysisRequest`, `FramingRegionTrack`, `buildFramingSuggestion`, and `validateFramingSuggestion` from `src/features/vision/framing.ts`.
Each track carries `identity: { sourceMediaId, takeId, analysisId, analysisRevision }` and `frame: FramingFrame` matching the request.
The validator rejects tracks from a different rotation or upright geometry even if the producer accidentally reuses the analysis ID.
The request uses `sourceDurationMs`, `selectedInterval: { startMs, endMs }`, and the explicit `frame` and `provenance` structures.
Each region track has `trackId`, `kind`, explicit `selected`/`relevant` flags, and ordered `observations: { timestampMs, rect, confidence }[]`.
Increment analysis identity/revision whenever orientation, source, intent, region selection or analysis configuration changes.
`buildFramingSuggestion(request, tracks)` is disabled by default; explicit `{ enabled: true }` is for accepted integration or developmental replay only.
`validateFramingSuggestion(result, currentRequest)` must pass before persistence or offering apply; `originalFrameFallback` means retain the original and offer no automatic edit.
An invalid request returns an invalid-request fallback for diagnostic handling, not a persistable substitute source identity.

The 0.75 confidence floor, 500 ms maximum observation gap, 6% normalized margin and 1.35x maximum zoom are conservative fixture-policy parameters, not calibrated model thresholds.
Options may tighten these limits but cannot relax them.
Use `source: 'fixture', processor: 'cpu'` only for explicitly developmental region fixtures; a native producer must report its actual runtime/model/processor without guessing.
Unsupported, pending, failed or thermally disabled native analysis must clear tracks and retain the original; never reuse an old result as a fresh detection.
Framing does not infer missing hands, select a speaker, or transform sensor boxes into upright coordinates for the producer.

Replay: `node --experimental-strip-types tests/t1-session2-replay.mjs`.
The catalog in `src/features/vision/framing-fixtures.ts` contains portrait, moving vlog, product plus two hands, safe/unsafe groups, missing/off-frame/uncertain/discontinuous tracks, and missing hands.
`docs/handoffs/evidence/t1-session-2/replay-output.json` includes expected/actual crops and reasons for Session 3.
These are synthetic region observations; unseen real scenes and native detection quality remain unverified.

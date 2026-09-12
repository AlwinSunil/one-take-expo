# Session 2 verification and acceptance

## Scope and environment

Issues #28 and #35 remain partially implemented until integrated and human/device acceptance passes.
Worktree: `/Users/sabari/.t3/worktrees/one-take-expo/t1-coaching-framing`.
Branch: `feat/t1-coaching-framing`; merged baseline `e050a0d`.
Host: Darwin arm64, Apple M5, Node v26.7.0.
The policy runs JavaScript arithmetic on the host CPU, with no model inference, GPU or NPU workload.
No new model, native runtime, manifest, package or shared-store change is introduced.

## Baseline checks before implementation

- `npm ci --ignore-scripts`: exit 0; lock file unchanged.
- `npm test`: 40 passed, 0 failed.
- `npm run typecheck`: exit 0.
- `npm run samples`: exit 0, deterministic synthetic caption output.
- `npm run test:samples`: 19/19 passed.
- `python3 tests/speech-evaluation.test.py`: 12 passed.
- `EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/one-take-t1-session2-android-export`: exit 0, Android Hermes bundle and 45 assets exported.

## App-flow limits

An isolated Chrome session opened the actual camera URL at `http://localhost:8094/camera?coachingDevelopment=1`.
The baseline fails at Metro resolution of Expo SQLite's `.wasm` asset before the route renders.
The installed asset exists; Session 3 owns the configuration investigation requested in the handoff.
The screenshot in `evidence/t1-session-2/web-baseline-blocker.png` records the failure.
Android bundle export is not an installed Android build, camera flow or A/V verification.
A connected I2501 phone was listed by adb, but no app installation, recording, processor profiling or device mutation was performed during these concurrent sessions.
No physical-device or model-performance claim is made for this implementation.

## Evidence still required

Automatic lighting and background cues have no validated launch trigger in the research and remain unavailable.
Manual tips are educational guidance, not measured diagnoses.
Synthetic scene and region replays establish only policy behavior, never unseen human scene accuracy.
Collect the research's independent actual-camera positive/negative clips, intentionally good compositions, unseen products, motion, groups and missing detections before enabling automatic cues.
Measure actual processor, model/hash/config, end-to-end frame latency, memory, heat, battery and recording impact on a named device/OS/build.
Verify rotation/mirroring, original-versus-cropped preview/export, preserved hands/products, formal A/V behavior, permission/failure recovery, large text and screen-reader traversal on device.
Melvin0070 remains the named non-author reviewer for #28/#35; both other humans must review shared handoffs.
Do not mark these checks complete from host tests or the prior research harness.

## Implementation checks

- `npm test`: 63 passed, 0 failed (40 baseline, 13 coaching, 10 framing checks).
- `npm run typecheck`: exit 0 with the new camera import and feature types.
- `node --experimental-strip-types tests/t1-session2-replay.mjs docs/handoffs/evidence/t1-session-2/replay-output.json`: exit 0; all 11 framing and five coaching replay expectations matched.
- `EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/one-take-t1-session2-final-export`: exit 0; 6.4 MB Hermes bundle exported.
- `git diff --check`: exit 0.

The replay JSON is the output sample and contains exact host benchmark values.
At the recorded run, one complete 11-case framing catalog measured approximately 0.019 ms p50 and 0.053 ms p95 after 100 warmups over 500 runs on Apple M5.
These numbers measure host policy arithmetic plus validation/allocation only; they are not camera throughput or mobile performance.
Re-running changes timings but preserves deterministic suggestions and expected outcomes.

## Assigned issue acceptance status

| Issue | Implemented independently | Still open |
| --- | --- | --- |
| #28 | Explicit intent adapter, manual subject/background/lighting reason-and-action tips, intentional override, one-tip dismissal/revisit, default-off development preview, stale speech/priority suppression, replay checks | Recording-time signal integration, validated automatic cues, actual unseen camera scenes, device UX/failure/processor measurements and named review |
| #35 | Versioned source-relative track/suggestion contract, immutable identities, upright normalized crop semantics, stable temporal union, zoom limit, product/hand/group preservation, conservative fallback, consumer validation, replay fixtures | Native track extraction, selected-take/store integration, Session 3 preview/export application, on-device performance and original/crop visual review |

Neither issue is ready for release acceptance.
The common Tier 1 gate and final Tier 1 verification report belong to Session 3.

## Verification after Tier 0 merged

Merged `origin/main` at `11f4455` through `cdbd0fa`; retained all incoming capture lifecycle, vision, transcript, coverage, review and export code.
The Tier 1 development picker now extends the existing `CaptureSuggestions` component.
`npm test` passes 274/274 tests, including the merged Tier 0 coach timing/all-good/unavailable tests.
`npm run typecheck`, `npm run samples`, and `npm run test:samples` pass; the latter reports 19/19.
No native product/hand track extraction or calibrated automatic cue is manufactured from the merged face-presence bridge.
The setup sheet remains unavailable during preparation/recording/saving, so no fabricated between-lines signal is used.
`EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/one-take-t1-session2-integrated-export` passes after integration.
The isolated Chrome camera flow was repeated on the integrated tree and still fails at SQLite wasm resolution before rendering.
See `evidence/t1-session-2/web-integrated-blocker.png`; no successful UI or device flow is claimed.

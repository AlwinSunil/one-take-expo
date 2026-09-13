# Tier 1.5 Session 1 acceptance evidence

Branch: `feat/t15-speech-analysis`.
Draft PR: https://github.com/AlwinSunil/one-take-expo/pull/70.
Base: merged main `15d80d6`; initial producer contract commit `f097b0f`.
This is producer implementation evidence, not completed V1 or named human acceptance.

## Assigned-issue matrix

| Issue | Implemented producer behavior | Pending owner integration and acceptance |
| --- | --- | --- |
| #61 | Conservative English incremental alignment, independent cursor, manual reanchor, revision/event replay and controlled follow toggle | Session 2 camera hookup and source-clock barrier; coverage adapter; actual clean/flub/off-script/noisy reads, five sessions, large text/back, false/missed advances and line-end latency |
| #63 | Extractive point baseline, creator choice preservation, controlled point UI, missing-point request and script-ordered whole-utterance insertion intent | Session 3 atomic script/project point storage and span selector; Session 2 missed-point capture; Session 3 A,B,C preview/accept/reject/undo/export/reopen and failure recovery; human importance/paraphrase evaluation |
| #66 | Source-scoped repeated-attempt grouping/ranking and cancellable revisioned range proposals reusing cleanup | Session 2 durable Stop source/full-transcript adapter; Session 3 job scheduling/status/retry/editor and proposal application; actual boundary listening, no-speech/noisy flows, process-death recovery and measured Stop stages |

Each row remains partial until its integrated and physical checks are performed.
All new UI components require explicit development access and default to hidden.
No camera/editor/store/session/package/lock/config/CI files are changed.
The existing script route is not connected to an unpersisted second point store.

## Evidence and commands

Logs are under `docs/handoffs/evidence/t15-session-1/`.
Host: Darwin arm64, Node v26.7.0, Python 3.13.7.
`npm ci --ignore-scripts` installed 690 packages successfully without changing package/lock files.
The first typecheck before installation failed because `tsc` was absent; a subsequent in-progress check reported the not-yet-written alignment module.
Final source verification is against `5bed4c7`, which incorporates merged main `faeda74` and producer safety corrections `5947706`.
The final suite has 378 passing tests, including 51 Tier 1.5 producer tests; zero failures or skips.

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | Pass | `typecheck.txt` |
| `npm test` | 378/378 pass, zero failed/skipped | `tests.txt` |
| `node --experimental-strip-types tests/t15-point-evaluation.mjs` | 12 synthetic matching cases: zero false matches, one missed paraphrase; 8 extraction rows: three overselected, zero missed | `point-evaluation.json` |
| `node --experimental-strip-types tests/t15-pickup-fixtures.mjs` | Three transport fixtures generated and inspected | `pickup-fixtures.json` |
| `git diff --check` | Pass | Checked before each commit |
| `npm run test:samples` | 19/19 pass | `sample-checks.txt` |
| `npm run samples` | Pass | `caption-replay.txt` |
| `npm run coverage:report` | 2 scenarios and 16 synthetic rows pass; zero eligible human rows | `coverage-report.txt` |
| `python3 tests/speech-evaluation.test.py` | 12 tests pass | `speech-evaluator.txt` |
| `python3 tests/t1-speech-evaluation.test.py` | 11 tests pass | `t1-speech-evaluator.txt` |
| `EXPO_NO_DOTENV=1 npx expo export --platform android --output-dir /tmp/one-take-t15-speech-export` | Android Hermes bundle exported | `android-js-export.txt` |

The JavaScript export verifies the existing route bundle; new controlled components have no route consumer until the owner integrations land.
Typecheck and producer tests separately verify their source interfaces and behavior.
A native APK build and physical installation were not run for this producer-only branch; native code is unchanged and model/native artifacts are not staged in this worktree.
No phone state, recording, fixture or installation was changed while concurrent sessions were active.

## Interpretation and remaining measurements

Matching is an explicit conservative text baseline, independent of Moonshine recognition quality.
Synthetic expected text is not human-read audio and cannot establish semantic accuracy, latency, gaze, NPU use or A/V correctness.
Point extraction selects complete script lines and needs creator review; it is not a learned salience model.
No new recognizer, microphone stream, cloud service, model dependency or larger-model requirement is added.
Current model/processor/device evidence remains historical T0/T1 evidence, not a new run of this branch.
Actual phone/OS/build/model/processor and clock uncertainty must be captured on the final integrated build.

Measure STT error rate against consented reference speech separately from alignment false/missed advances against the text actually emitted.
Measure human line-end to visible advancement on a calibrated source/monotonic clock separately from recognizer finalization and reducer execution time.
Unknown clock offset or bridge delay must stay unknown rather than becoming zero latency.
Measure Stop-to-durable-save, Stop-to-raw-first-frame and Stop-to-proposal-ready independently.
Listen to every proposed boundary for clipped words and deliberate pauses and compare source-local captions with the accepted export.
Unrun recovery checks include app process death, low storage, interrupted pickup save, missing media, reopen and export failure on the integrated path.
Named reviews from the issue reviewers and shared-handoff peers remain outstanding.

## Integration dependencies

PR #58 is still open and its code has not been copied, cherry-picked or merged.
Session 3's published design at `ccce524` explicitly waits for that ownership seam.
Session 2's proposal at `aa8ec85` defines capture scope and honest unknown gaze for its current face-only provider.
Those proposals are not an agreed or implemented consumer contract.
The Session 1 handoff describes required owner-authored adapters and APIs.
After consumers merge, incorporate merged main and rerun affected source/build checks and the integrated device matrix before enabling the features by default.

## Published implementation references

- `f097b0f`: initial producer contracts.
- `170b4dc`: alignment follower, existing caption-update adapter and controlled toggle.
- `5a9710c`: important points, manual selection/missed-point controls and pickup intent.
- `9fcff29`: revisioned final analysis, cleanup reuse and safety tests.
- `5947706`: conservative meaning-change guards and required final transcript revision typing.

## Review and diagnostic limits

Automated review and parent reproductions identified and corrected stale transcript suppression, manual subspan invalidation, overlapping pickup ranges, ambiguous revision ordering, unique multi-line content loss, manual overrides without clocks, temporal-role reversal and unsupported extra content.
Regression tests include explicit revision chains in either arrival order, cycles, newer provisional corrections, source-scoped duplicate IDs and 270 retained transcript observations beyond the live UI cap.
These are source-level reproductions, not integrated app-flow reproductions or named human acceptance.
The independent safety fixture keeps all 540 source seconds, including gaps, while retaining every supplied observation.

The diagnostic's missed case is a clause-reordered paraphrase.
The baseline deliberately leaves that unresolved because a generic token-reorder rule also accepted reversed temporal meaning.
Only narrow lexical/inflection/contraction equivalents and supported full ordered content advance the reader.
The sample extraction baseline flags three greeting/sign-off lines as important, which is why creator controls and manual selection are required.
The diagnostic is agent-authored synthetic data, not a held-out human dataset, and these counts must not be reported as production precision or recall.

## Merged-main refresh

PR #73 merged during final verification as `faeda74`.
It was incorporated through `5bed4c7` without conflicts or owner-file edits by Session 1.
Typecheck, all 378 tests, 19 sample checks and Android JavaScript export pass again on this merged source.
The producer diff against current main still contains only Session 1 modules/components/tests and its own handoff/evidence documents.
PR #58 remains open and is not incorporated.
GitHub checks on producer revision `5947706` passed in runs `34729312771` and `34729311115`; subsequent head checks are separate from these local results.

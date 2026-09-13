# Session 1 acceptance and verification

Branch `feat/t1-speech-control`; draft PR https://github.com/AlwinSunil/one-take-expo/pull/59.
This is a lane report, not Session 3's integrated Tier 1 verification report.
All four assigned issues remain partial and release-disabled.

## Acceptance map

| Issue | Independent behavior | Remaining integration and acceptance |
| --- | --- | --- |
| #22 | Durable take, reason and scratch contracts with adversarial deterministic replay | Capture/manual voice routing, persisted history, caption exclusion and reviewed playback exclusion; held-out reason agreement and false-trigger measurements; named review |
| #23 | Strict wording metadata, evidence/status matching and isolated toggle | Merged #12 parser/serializer compatibility verified; `script.tsx` wiring; owner-authored draft/project persistence and reopen; wrap consumers; 20 consecutive clean held-out reads; named review |
| #24 | Review-only cleanup extensions preserving raw speech and reversible decisions | Saved-audio candidate adapter and editor consumption; independent boundaries; original/cleanup listening and captioned export validation |
| #29 | Bounded optional live transcript component and long-text projection | Camera owner integration; physical long-session, large-text, no-speech, unavailable and delayed-state review |

No unmerged Tier 0 implementation is copied, merged or cherry-picked.
No camera, editor, shared session/store, package, lock, config or CI file is changed.
The native speech engine and its working lifecycle are preserved.
The optional Tier 1 components are disabled by default and have no production route consumers yet.

## Local environment and baseline

Host execution uses Node v26.7.0 and Python 3.13.7.
Dependencies were installed with `npm ci --ignore-scripts`; package and lock files are unchanged.
At merged main `e050a0d`, `npm run typecheck`, `npm test` (40 passing), `npm run samples`, `python3 tests/speech-evaluation.test.py` (12 passing), and `python3 tools/speech-fixtures/run_synthetic.py` (16 synthetic rows) pass.
The existing synthetic data qualifies for no human accuracy claims.

## Physical and human evidence

Read-only `adb devices -l` found an iQOO I2501 device and `getprop ro.build.version.release` returned Android 16.
The installed app is not established as this branch's build, and no new Tier 1 device flow was run.
No new build/model/config/processor evidence is asserted.
The previous phone results in `docs/issue-acceptance.md` remain historical evidence for the merged implementation only.

Remaining required evidence includes recorded original/cleanup listening for clipped speech, audio/video and caption-export checks, held-out consented speech with frozen predictions, and long-session/large-text camera behavior.
The issue reviewer remains @AlwinSunil.
Both peers must review shared handoffs and timing/export changes; automated review does not replace those named reviews.

## Dependency refresh

PR #46 merged during this run.
Merged `origin/main` at `b3240f2` into this branch and added a real script-document compatibility test for editing, reorder, metadata serialization and restore.
This is an in-memory serializer test, not SQLite/project persistence or force-close proof.
#13 / PR #50 and #16 / PR #48 remained open at that refresh.

The remaining Tier 0 integration then merged and was incorporated at `11f4455`.
#13, #16 and capture/review baseline dependencies are no longer open-PR blockers.
The remaining integration work is the owner-authored Tier 1 envelope/gates, command-context provider, camera/editor consumption, and script persistence wiring.
After this merge, typecheck, 299 JavaScript tests and the coverage report (2 scenarios, 16 synthetic rows) pass.

## Final checks

- `npm run typecheck`: pass.
- `npm test`: 299 passed, zero failed or skipped.
- `npm run samples`: pass.
- `npm run coverage:report`: 2 scenarios and 16 synthetic rows passed; zero eligible human rows.
- `python3 tests/t1-speech-evaluation.test.py`: 11 passed.
- `python3 tests/speech-evaluation.test.py`: 12 passed.
- `python3 tools/speech-fixtures/run_synthetic.py`: 16 synthetic rows processed successfully.
- `node --experimental-strip-types tools/replay-t1-speech.mjs`: 10 adversarial synthetic command cases, zero false triggers or misses; reason example asserted.
- `python3 tools/evaluate_t1_speech.py tools/speech-fixtures/synthetic-small.jsonl`: report generated, zero human rows, acceptance gates false.
- `git diff --check`: pass.

`npm run lint` could not complete because Expo's automatic ESLint dependency installation failed.
The resulting package/config edits were restored; no lint success is claimed.
Node emits the existing module-type warning for TypeScript replay imports.

Generated command and eligibility reports sit beside this document.
The #22 reason-quality target of at least 8/10 and #23 twenty consecutive clean-read target remain unmeasured on real held-out speech.

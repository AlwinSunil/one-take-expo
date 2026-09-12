# Related issue acceptance map

This map records the implementation and evidence for #6, #8, #11, #12, #13, #14, #16, #21, #24, #25, #29, #30 and #33.

The audit snapshot is 2026-09-13.

The main implementation was merged in [PR #43](https://github.com/AlwinSunil/one-take-expo/pull/43).

The implementation branch is [`feat/offline-speech-workflow`](https://github.com/AlwinSunil/one-take-expo/tree/feat/offline-speech-workflow).

`[x]` means that the implementation and the available evidence cover the check.
`[~]` means that code or partial evidence exists, but an acceptance condition remains.
`[ ]` means that the required implementation or evidence is missing.

## Evidence snapshot

- `npm run typecheck` passes.
- `npm test` passes 40 behavior-focused JavaScript tests.
- `npm run samples` passes the deterministic caption replay.
- `python3 tests/speech-evaluation.test.py` passes 12 evaluator tests.
- `python3 tools/speech-fixtures/run_synthetic.py` passes 16 synthetic rows, while reporting zero eligible human held-out clean rows and zero eligible human held-out flub rows.
- The Android caption module has 9 passing unit tests and the Media3 export module has 5 passing unit tests.
- The APK verifier reports all 19 declared native and model hashes matching the manifest.
- The clean-checkout GitHub workflow passed for commit `80536dca7be5ae89f02839f28f8d71010dc2924c` in run [34718307885](https://github.com/AlwinSunil/one-take-expo/actions/runs/34718307885).
- The Android build targets API 26+ and the verified physical device run was arm64-v8a on API 36, using Moonshine Tiny Streaming on the CPU with the custom Moonshine v0.1.5 native build linked against Android ONNX Runtime 1.28.0.

The physical device was an iQOO 15 (I2501, Qualcomm SM8850), Android 16 / API 36, connected over USB.
The two-minute application run used 1080p capture and a 123.474-second host-played speech fixture.
It saved a 312,825,688-byte MP4, remained alive through stop, and reopened the saved preview.
The extracted video and audio tracks were 123.210233 seconds and 123.200979 seconds respectively, a 9.25 ms duration difference.
The audio contained non-silent AAC content with mean volume -17.4 dB and maximum volume -0.8 dB.
This duration comparison is useful file evidence, but is not a complete lip-sync measurement.

The first phone recording exposed two issues that are fixed in the branch:
the default video allocator allowed two players to target approximately 125 MiB each, and the Expo 57 file copy/move calls were asynchronous.
The player buffer is now capped at 16 MiB and project video persistence awaits both operations through a `.part` file.

Saved-audio refinement completed with both Tiny and Small on the same phone while the existing video stayed available.
The completed captioned export contained 24 visual caption cues.
An extracted frame was inspected for lower-third placement and readable wrapping.
The output retained video and audio, saved successfully to the gallery, and opened the Android share sheet.
An in-progress export reached 2% before cancellation and persisted `cancelled`.
A private-files directory readback found neither an output nor a `.part` file for the cancelled jobs.
Background export was exercised after returning the app to the home screen, and the final job readback recorded a completed 100% result.
No recipient was selected and no external message was sent during share testing.

## Issue status

| Issue | Current status | Implementation and evidence | Remaining acceptance gate |
| --- | --- | --- | --- |
| #6 | Partial | Ownership handoff docs, shared types, fixtures, runners, CI checks and setup documentation | Fixture breadth, camera/vision examples, PR checklist, independent fresh-checkout runs and the two named peer reviews |
| #8 | Research and evaluator implemented; accuracy gate open | Moonshine decision, pinned runtime notes, CPU timings and replayable evaluator | Candidate slice comparison, then 60 clean and 30 flub consented held-out rows and a human accuracy report |
| #11 | Partial | Camera lifecycle recovery, optional captions, memory fix and two-minute saved take | Permission, interruption, route, low-storage and formal A/V sync scenarios |
| #12 | Partial | Editable spoken lines, stable ids, bracketed action cues, manual required/done/skipped status and a published change intent | Device keyboard layout, draft recovery on a phone, a UX recording and the reviewer reproduction |
| #13 | Partial | Offline Moonshine bridge, honest live/provisional/delayed/unavailable states and device live-caption run | Quiet/noisy/empty behavior, replay identity, model failure and interruption on device |
| #14 | Partial | Durable projects, normalization, recovery metadata, missing-media states and coverage counts | Force-close, migration, failed-save and low-storage reopen scenarios |
| #16 | Partial | Conservative coverage, take ranking, script normalization, multi-line utterances and retake history | End-to-end multi-take capture and held-out precision evidence |
| #21 | Partial | Media3 cuts, partitioned captions, progress, cancellation, retry, background service, gallery and share | Low-storage/permission/process-restart checks and formal A/V sync review |
| #24 | Partial | Timed refinement, quiet/repeat review suggestions, filler flags and reversible decisions | Listening to quiet/noisy/stutter/filler outputs and accepting safe boundaries |
| #25 | Research only | CPU baseline, explicit fallback and NNAPI/QNN candidate matrix | Integrated NPU delegation, five warm sessions, power, heat and memory evidence |
| #29 | Partial | Collapsible bounded live caption overlay with provisional, delayed and unavailable states | Long-session, accessibility and no-speech device review |
| #30 | Partial | Review explanations, take selection, reversible cuts, segment text editing and export plumbing | Installed-app edit/reopen/export flow and original-versus-edited review |
| #33 | Partial | Tiny/Small saved-audio refinement, progress, cancellation plumbing and correction-preserving merge | Held-out comparison, confidence/provenance acceptance, NPU and UX review |

## Issue-specific acceptance notes

### #6

The handoff is documented in [offline-workflow.md](plans/offline-workflow.md), with shared session, transcript, coverage, review and export structures in `src/lib/session.ts`, `src/lib/transcript-workflow.ts`, `src/lib/project-workflow.ts` and the export modules.
The deterministic caption replay is [replay-captions.mjs](../tools/replay-captions.mjs), and the synthetic speech runner is [run_synthetic.py](../tools/speech-fixtures/run_synthetic.py).
The CI workflow runs typecheck, JavaScript tests, sample replay and the speech evaluator.
The Android modules have separate native test suites and the APK hash verifier is available for the custom runtime package.
The remaining enablement work is evidence from both other contributors running a fresh checkout and reviewing the ownership handoff.

### #8

The application decision is Moonshine Tiny Streaming using the rebuilt v0.1.5 native library and ONNX Runtime 1.28.0.
The physical iQOO benchmark established paced CPU timing and the application has a replayable, leakage-guarded evaluator.
The existing research also records a separate Nemotron QNN experiment, but that does not mean this application has integrated NPU execution.
Human speech accuracy remains unmeasured because no consented held-out set exists.
The synthetic report must not be used as a design-target accuracy claim.
GitHub currently shows #8 closed; this map records the remaining evidence limitation without reopening or claiming a new accuracy result.

### #12

`src/lib/script-lines.ts` parses a draft into ordered lines whose ids survive edits, reorders and deletes, and reports spoken word count and an estimated read time at 150 words per minute.
Bracketed directions become action cues through the single `extractBracketedCues` regex that `transcript-workflow.ts` already owned, so cue text never reaches the spoken count.
Inline, standalone, multiple, nested and empty brackets are covered by tests; an unclosed bracket stays spoken text, is flagged ambiguous and can be corrected either into an action cue or into plain spoken text.
Action cues are optional until the creator requires them, and a required cue carries a manual `pending`, `done` or `skipped` status where `skipped` stays unresolved for wrap.
Nothing infers that a visual action happened.
An actions-only script reports `add-spoken-line`.
`scriptChangeIntent` publishes edited, deleted, added and reordered line ids; the coverage and persistence owners implement the effects, which is why this row stays partial.
`src/app/script.tsx` keeps the existing paste, 400 ms debounced draft save and `acceptDraft` behavior, and the raw `script_draft` value stays the exact string the camera route consumes; line ids and cue statuses go to a separate `script_draft_lines` key.
`tests/script-lines.test.mjs` adds 30 behavior tests, including a 5,000-word parse under 100 ms, a check that the accepted string re-chunks into the same lines the screen showed, and three data-loss guards: correcting a bracket at the end of a sentence cannot emit a junk line, ordinary typing cannot manufacture deleted history, and a failed structure read still restores the creator's text.

These are pure Node tests. They are not device evidence.
Keyboard layout with the line list on screen, draft recovery after a force-close on a phone, the UX recording and the named reviewer's reproduction all remain open.
The line list is not virtualized and every keystroke re-parses, so typing and scrolling feel on a long script is also unmeasured.
The handoff for capture and coverage is [issue-12.md](development/handoffs/issue-12.md).

### #11 and #13

The camera and caption microphone remain separate consumers, with the caption path optional to recording.
The camera route handles stop, backgrounding, interruption metadata, save recovery and unavailable caption status.
The Kotlin bridge owns bounded microphone reads, Moonshine lifecycle, stale-session suppression and delayed-state reporting.
The physical two-minute run proves a saved recording with non-silent audio and live caption events.
It does not prove every permission, audio-route, call, low-storage or long-session condition.

### #14, #16 and #30

Project normalization preserves legacy records and marks missing media or interrupted work explicitly.
Nested action cues are validated before review; malformed cue metadata follows the existing unreadable-project path so it cannot crash the library or silently drop required actions.
A regression test covers malformed cues and valid required-action preservation.
Coverage requires final transcript evidence and playable media, keeps earlier good takes, handles normalized numbers and brands, and treats required action cues separately from speech.
Review state supports selecting takes, preparing cuts, undoing decisions and editing a segment's caption text.
The editor currently edits a segment's text field rather than offering a separate tap-on-individual-word editor.
Manual corrections remain separate from raw recognition evidence and therefore do not change a spoken-script verdict.

### #21, #24 and #33

The Media3 module receives one validated export plan, maps captions to the concatenated cut timeline, renders bounded lower-third overlays, persists job state and supports cancellation and recovery.
The saved-audio path decodes bounded 16 kHz mono audio, runs Tiny or Small, reports progress and retains the current transcript when a candidate is empty, cancelled or conflicts with manual edits.
The physical run completed both refinement models and a 24-cue captioned export.
Review-only cleanup suggestions remain reversible and are not automatically spliced at a mid-sentence filler boundary.

### #25

The current app deliberately reports CPU execution for Moonshine and retains a documented fallback.
The NNAPI and QNN matrix records candidate requirements and reasons that no provider is enabled in this branch.
There is no supported NPU claim, power or thermal result, or five-session concurrent camera-analysis run.

### #29

The live overlay is optional, collapsible and bounded so it does not cover recording controls.
Provisional text, delayed processing, unavailable recognition and no-speech guidance have separate UI states.
The iQOO run displayed live caption events while recording.
Long-session accessibility and quiet/no-speech behavior still need a device review.

## Release gates

The remaining release evidence is:

- collect at least 60 clean and 30 flub consented held-out speech rows with disjoint tuning identities and report human accuracy;
- run permission denial, interruption, route-change, low-storage, force-close and process-restart scenarios on the physical phone;
- repeat export/refinement with formal cancellation, recovery, audio/video sync and output inspection reports;
- measure CPU and any future NNAPI or QNN path across five warm camera sessions, including memory, heat and battery;
- obtain the named non-author peer reproductions and UX review.

Pure tests, synthetic fixtures, emulator runs and hash checks do not satisfy those device, accuracy, NPU or peer-review gates.

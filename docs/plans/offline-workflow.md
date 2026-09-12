# Offline speech workflow implementation plan

Scope: GitHub issues #6, #8, #11, #13, #14, #16, #21, #24, #25, #29, #30 and #33.
The user approved all twelve on September 13, 2026.

Preserve the working Expo 57 camera, draft, SQLite library and trim UI.
Keep Moonshine Tiny Streaming with the verified custom ONNX Runtime 1.28.0 build as the live CPU engine.
Do not introduce Whisper or claim NPU acceleration without measurements.
All timestamps crossing feature boundaries use seconds relative to the source recording, with explicit provenance and uncertainty.
Keep source footage and recognition separate from manual corrections and edit decisions.

## Speech and capture

- [ ] Extend the native caption contract with stable utterance IDs, start/end times, provisional/final state and capture timing.
- [ ] Bound live display history while retaining final utterances for project persistence.
- [ ] Publish processing lag and audio-route diagnostics, with delayed/unavailable states that preserve recording.
- [ ] Extract a collapsible accessible live-caption component and add replay fixtures for no speech, corrections, long text and delayed output.
- [ ] Save interrupted recording status honestly and expose permission/settings recovery.
- [ ] Add cancellable offline transcription of saved audio for refinement, keeping existing playback and manual corrections intact.

## Project, coverage and review

- [ ] Extend project data compatibly with versioned transcript segments, script-line/take evidence, cleanup decisions and export state.
- [ ] Implement deterministic conservative coverage and repeat/silence suggestions with tests for wrong-line matches, one-breath multi-line takes and prior good takes.
- [ ] Preserve revisions, originals and manual corrections; exclude pending or missing-media evidence from coverage.
- [ ] Recover saved/unfinished projects, identify missing media and isolate corrupt rows.
- [ ] Extend the existing editor with timed captions, correction, take selection, original comparison and undo.

## Native media export

- [ ] Add a local Kotlin Media3 module for captioned trimmed/cut export with progress, cancellation and explicit recovery after process interruption.
- [ ] Use one cut/caption plan for preview and export, retaining original media.
- [ ] Expose explicit gallery save and share actions and report failures accurately.
- [ ] Verify output structure and A/V timing on fixtures; retain real-phone sync as a separate acceptance check.

## Reproduction and research

- [ ] Add a deterministic local sample runner and meaningful CI checks without requiring private audio or model files.
- [ ] Document and automate rebuilding the pinned Moonshine runtime, with source/dependency hashes and setup requirements.
- [ ] Add held-out speech evaluation tooling with dataset-split validation and counts, never inventing samples or accuracy results.
- [ ] Publish an honest processor/device matrix and executable measurement procedure for unsupported/unmeasured NPU paths.

## Acceptance and delivery

- [ ] Run TypeScript, behavioral tests, native tests, Android build and packaged artifact verification after integration.
- [ ] Review actual changes, push incremental commits and keep per-issue acceptance evidence.
- [ ] Close only issues whose complete acceptance checks have evidence, including required peer/device validation.
Held-out human accuracy, peer reproduction, two-minute A/V checks and measured NPU behavior cannot be replaced with passing unit tests.
The user currently prefers to perform phone recording tests personally.

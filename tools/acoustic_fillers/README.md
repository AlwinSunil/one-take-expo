# Acoustic filler detection benchmark

This is an experimental saved-audio pipeline, evaluator, and cleanup adapter.
It does not ship a trained filler detector or enable a recording/editor feature.
No model has passed the real-speech or device acceptance gates.
The user has no local consented benchmark recordings available at this time.

## Real pretrained model smoke benchmark

`uhm.py` runs the actual pretrained Uhm fp16 model with ONNX Runtime on CPU.
It requires a separately obtained local artifact and verifies its exact size and SHA-256 before loading.
Review the [model/license findings](../../docs/research/acoustic-filler-models.md) before obtaining or distributing weights.
The code does not download weights or add them to the Android app.

```sh
/tmp/one-take-filler-python/bin/python tools/acoustic_fillers/uhm.py /path/to/recording.wav \
  --model /path/to/uhm-web-fp16.onnx \
  --source-id recording-123 --revision 1 --threshold 0.5 \
  --output /tmp/uhm-observations.json
```

This adapter retains only `um` and `uh`; `hmm`, `and`, and other classes remain competing predictions.
It uses a simple uncalibrated class-score threshold policy with 15-second ownership hops, not the vendor SDK's overlap-averaged detection policy.
Each model call receives 479680 source/padded samples plus 320 zero context samples and returns 1499 frames.
A second window handles the final 20 ms of an exactly 30-second source, rather than fabricating a missing output frame.
Whole-source coverage and original preservation are tested, but event boundaries still have unknown acoustic error.
The threshold of 0.5 is a smoke-test setting, not an accepted product threshold.

The recorded [smoke result](../../docs/research/acoustic-filler-smoke.json) uses macOS-generated speech, not a human benchmark.
To recreate the smoke input on macOS with the Samantha voice installed:

```sh
say -v Samantha -o /tmp/one-take-filler-smoke.aiff \
  'Um, welcome to One Take. Uh, let me think. Hmm, that sounds good.'
afconvert -f WAVE -d LEI16@16000 -c 1 \
  /tmp/one-take-filler-smoke.aiff /tmp/one-take-filler-smoke.wav
```

Voice/OS changes may change the generated waveform and detections.
Run the real-model CLI and its TypeScript cleanup handoff test with explicitly supplied local inputs:

```sh
UHM_TEST_MODEL=/path/to/uhm-web-fp16.onnx UHM_TEST_AUDIO=/path/to/tts.wav \
  /tmp/one-take-filler-python/bin/python tests/acoustic-filler-uhm.test.py
```

Without those variables, the real-model test is explicitly skipped and the synthetic tail-mapping test still runs.

## Implemented boundary

`run.py` accepts mono PCM16 WAV audio and a local, hash-pinned ONNX frame classifier.
It reads bounded overlapping windows, preserves source sample coordinates, merges consecutive same-label frames, and publishes complete results atomically.
Overlapping windows do not produce duplicate source frames.
The input file is never changed.
Analysis is limited to one hour per source to bound result growth.
Failure leaves an existing result untouched and exits nonzero; it is not an empty successful detection.

`src/features/speech-control/acoustic-fillers.ts` validates results before adapting them into the existing cleanup marks.
An acoustic prediction does not establish sentence placement, a safe splice boundary, or permission to remove media.
The adapter remains isolated from app routes while the existing Tier 1.5 sessions own capture, persistence, and editing integration.

## Run plumbing checks

The standard-library checks do not require a model or download audio:

```sh
python3 tests/acoustic-filler-runner.test.py
python3 tests/acoustic-filler-evaluation.test.py
node --experimental-strip-types --test tests/acoustic-fillers.test.mjs
```

For the optional real ONNX Runtime smoke test, use an isolated environment:

```sh
python3 -m venv /tmp/one-take-filler-python
/tmp/one-take-filler-python/bin/pip install onnxruntime==1.24.3 onnx==1.20.1
/tmp/one-take-filler-python/bin/python tests/acoustic-filler-runner.test.py
```

The smoke test constructs a constant-output synthetic graph and executes the actual runtime and command line.
This proves runtime/result plumbing only, not recognition accuracy.
The constant graph is temporary and is never distributed as a filler model.
The runner uses CPUExecutionProvider explicitly and makes no NPU claim.

## Model ABI

The real pretrained candidate uses a separate model-specific adapter; see [model research](../../docs/research/acoustic-filler-models.md).
The generic ABI below is for explicitly exported compatible models, not a claim that Uhm has this output shape.

A model exporter must implement all preprocessing inside the graph except PCM16-to-float scaling by 32768.
The input is float32 `[1, windowSamples]` at the declared sample rate.
The output is `[1, windowSamples / frameSamples, 3]`, containing finite scores in `[0, 1]` ordered as `other`, `um`, `uh`.
Scores are uncalibrated model scores, not probabilities of correct detection.
Frame index `i` must describe the interval `[i * frameSamples, (i + 1) * frameSamples)` relative to the input window, without an undocumented receptive-field or padding shift.
Exported model parity and boundary alignment must be tested before using its output on recordings.
Existing research architectures are not assumed to satisfy this ABI without an explicit exporter.

Example manifest shape, with values supplied by a real model exporter:

```json
{
  "schemaVersion": 1,
  "id": "your-evaluated-model",
  "version": "your-pinned-version",
  "modelFile": "model.onnx",
  "sha256": "replace-with-the-actual-64-character-lowercase-digest",
  "source": "primary-model-source-and-revision",
  "license": "verified-model-license",
  "inputKind": "pcm-float32",
  "inputName": "audio",
  "outputKind": "frame-scores",
  "outputName": "scores",
  "labels": ["other", "um", "uh"],
  "sampleRate": 16000,
  "windowSamples": 32000,
  "hopSamples": 16000,
  "frameSamples": 320
}
```

This example is deliberately not a usable model manifest.
Neither these example window sizes nor the default score threshold of 0.9 are evaluated detection parameters.
Tune thresholds on validation speakers, then freeze them before test evaluation.

```sh
/tmp/one-take-filler-python/bin/python tools/acoustic_fillers/run.py recording.wav \
  --manifest /absolute/path/to/model-manifest.json \
  --source-id recording-123 --revision 1 --output /tmp/filler-observations.json
```

The WAV must start at the source audio origin.
Container-to-WAV decoding, resampling, channel selection, and A/V presentation-time offsets are not silently inferred by this tool.
The native Android handoff must preserve those offsets when analyzing saved MP4 recordings.
`timingResolutionSeconds` records frame quantization.
`timingUncertaintySeconds` is null because model boundary error remains unmeasured.
Do not use it to authorize a cut.

## Remaining implementation and release work

1. Decide whether Uhm's licensing/platform terms fit the app, or select/train a permitted alternative.
2. Implement the model-specific exporter, verify preprocessing/output parity, and evaluate acoustic events on complete recordings with disjoint speakers.
3. Report event precision/recall, false positives per minute, and onset/offset errors, including fillers absent from Moonshine text and difficult negative sounds.
4. Integrate bounded native saved-audio inference through the existing decoder, preserving source identity and clock provenance.
5. Persist results through the current project schema and render review markers with original-context playback and keep/dismiss controls.
6. Verify iQOO latency, memory, thermal behavior, cancellation, retry, source isolation, and stale job protection.
7. Evaluate edit boundaries separately before offering reversible removal proposals; keep automatic mid-sentence splicing off.

No real audio accuracy, model-export parity, native device throughput, or filler-removal result is claimed by these plumbing tests.

## Evaluation and app handoff

```sh
python3 tools/acoustic_fillers/evaluate.py \
  tools/acoustic_fillers/fixtures/evaluation-example.json \
  --output /tmp/acoustic-filler-evaluation.json
```

The example is synthetic, and its human eligibility remains false.
The evaluator counts one-to-one same-source/same-label event matches using interval IoU, reports false alarms per minute and onset/offset errors, and rejects speaker leakage between splits.
An eligible human dataset is not itself evidence that model accuracy or release targets passed.
Keep tuning thresholds and test recordings separate.

For a future native result consumer, always supply the current source/revision scope:

```ts
const adapted = adaptAcousticFillerResult(nativeResult, {
  sourceId: recording.id,
  analysisRevision: currentJob.revision,
  durationSeconds: recording.duration,
});
if (adapted.status === 'ready') {
  const plan = createCleanupPlan({
    recordingId: recording.id,
    segments: transcriptSegments,
    fillerMarks: adapted.marks,
  });
  // Persist observations and present plan marks; do not apply source cuts.
}
```

The storage owner should persist `adapted.result` beside the source, not just the lossy mark projection.
Keep unavailable status visible and preserve prior observations through retry.
Check audio/model hashes when reconnecting results to durable media.
Late or cross-source output must be rejected before committing any state.
This branch intentionally does not compete with active Tier 1.5 changes to camera, editor, or project storage.

# Acoustic filler model feasibility

Research date: 2026-09-13.
No local consented human benchmark recordings are available.

## First benchmark candidate: Uhm

[Desert Ant Uhm](https://huggingface.co/desert-ant-labs/uhm) publishes real pretrained ONNX weights.
The [SDK catalog](https://github.com/Desert-Ant-Labs/desert-ant-core/blob/main/Sources/Uhm/Catalog.swift) pins revision `612592c10ad7b2a51f3237725448a1aad212480b`.
The downloaded `uhm-web-fp16.onnx` contains 47,047,128 bytes and has SHA-256 `c266faf7db4cdced6f18aa9119ff2800a20707d7159be645d487ec191a9d79ff`.
It remains outside the repository at `/private/tmp/uhm-web-fp16.onnx`.
No weights are bundled or automatically downloaded by this implementation.

The model accepts float32 mono 16 kHz waveform input named `audio`, shape `[1, 480000]`.
It returns float32 `probs`, shape `[1, 1499, 6]`, with 20 ms output steps.
Class indices are `not_filler`, `uh`, `um`, `hmm`, `and`, and `other`.
The benchmark exposes only `um` and `uh`; the remaining categories must not be silently relabeled as these fillers.
The 1499-frame output requires explicit tail handling, rather than assuming a 1500th prediction exists.

The research smoke run loaded the artifact with ONNX Runtime 1.22.0 CPUExecutionProvider.
A padded synthetic TTS sample ran in approximately 0.771 seconds and produced positive filler spans.
This establishes model loading and synthetic inference feasibility only, not human accuracy or device throughput.
The implementation's independently rerunnable benchmark uses an isolated ONNX Runtime 1.24.3 environment.

The [vendor documentation](https://github.com/Desert-Ant-Labs/desert-ant-core/blob/main/docs/models/uhm.md) currently describes Uhm SDK support as Apple-only.
The public ONNX artifact makes a direct Android implementation worth investigating, but does not prove that integration works.
This app already links Moonshine against a custom ONNX Runtime 1.28.0 build.
Adding another native ORT binary needs an ABI/library-collision review first.

## License decision before distribution

The model uses [LicenseRef-DAL-Source-Available-1.0](https://license.desertant.com/1.0), not an open-source license.
The research inspection found explicit benchmarking permission and restrictions covering redistribution, competing-model training, attribution, usage tiers, and SDK telemetry.
Benchmark outputs must not become training data for a competing detector.
Do not infer that a raw ONNX host benchmark resolves direct Android distribution or telemetry requirements.
Confirm those terms with the vendor before bundling this model in the app.
The current work performs local feasibility benchmarking only and does not add vendor SDK telemetry or an app dependency.

## Alternatives inspected

| Candidate | Finding |
| --- | --- |
| [Filler-semi-CRF](https://github.com/gzhu06/Filler-semi-CRF) | MIT source, but no published pretrained checkpoint found at `bf39c6b851367656b9e678789013b1c9e017f451`; supplied training entrypoint requires CUDA. |
| [PodcastFillers](https://podcastfillers.github.io/dataset/) | Relevant filler/non-filler annotations; [Zenodo](https://zenodo.org/records/7121457) describes non-commercial research restrictions on metadata and extracted clips, so do not adopt as commercial training data without permission. Full dataset was not downloaded. |
| [um_detector](https://github.com/ezxzeng/um_detector) | No usable pretrained checkpoint or license found during the bounded inspection. |
| [wav2vecbert2-filledPause](https://huggingface.co/classla/wav2vecbert2-filledPause) | Large, primarily Slovenian-oriented checkpoint; approximately 2.32 GB weights, outside this mobile English benchmark's scope. Not downloaded. |

## Acceptance still open

Human event precision/recall, false alarms per minute, and boundary errors remain unmeasured.
No Android/iQOO, NPU, A/V, source-clock, safe-splice, or production-license acceptance is claimed.
Keep observations separate from transcript evidence and creator edit decisions.
Only integrate review markers after source/revision and native timing checks pass; removal requires its own boundary validation.

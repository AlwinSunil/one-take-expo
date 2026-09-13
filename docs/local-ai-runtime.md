# Local AI runtime

## Selected language model

The Android integration uses **Qwen3-0.6B W4A16** through Qualcomm's **GenieX Android SDK 0.4.0**, with the `qairt` runtime and Hexagon NPU compute unit. It supports script importance selection and spoken-line meaning checks. Qwen inference is verified on the connected phone using the NPU; a native probe measured approximately 126 generated tokens per second. This throughput measurement is not a semantic-accuracy benchmark.

The current application gate requires Android API 31 or newer, `arm64-v8a`, and `Build.SOC_MODEL == "SM8850"`. The connected iQOO I2501 reports SM8850 (Snapdragon 8 Elite Gen 5). This gate intentionally matches the downloaded chipset-specific bundle; it does not claim support for other Snapdragon models.

The model bundle was compiled with QAIRT **2.45.0.260326154327**. Inspection of SDK 0.4.0's packaged `libQnnHtp.so` confirms the same runtime version. Its 4096-token context is compiled into the bundle. Android passes `nCtx = 0` and `nGpuLayers = 0`, as required by the QAIRT plugin. Generation uses the model's chat template with thinking disabled and a bounded response.

Sources: [Qualcomm model page](https://aihub.qualcomm.com/models/qwen3_0_6b), [Qualcomm's Hugging Face model repository](https://huggingface.co/qualcomm/Qwen3-0.6B), [GenieX Android API](https://github.com/qualcomm/GenieX/blob/main/docs/en/run/android/api-reference.mdx), [runtime constraints](https://github.com/qualcomm/GenieX/blob/main/docs/en/get-started/platforms.mdx).

## Download without Google Play

The application downloads the pinned Qualcomm release directly over HTTPS, verifies its size and SHA-256, and imports the archive through `ModelManagerWrapper` using `HubSource.LOCALFS`. The SDK's remote model registry is bypassed. Google Play, AICore, and a Google account are not part of this path. Network access is needed for the initial model download; inference uses local files.

| Artifact | Value |
| --- | --- |
| Release | AI Hub Models `v0.62.2` |
| Runtime/precision | `geniex_qairt` / `w4a16` |
| Chipset bundle | `qualcomm_snapdragon_8_elite_gen5` |
| Archive filename | `qwen-sm8850-v0.62.2.zip` |
| Download size | 643,327,810 bytes, approximately 643 MB |
| Extracted files | 765,458,644 bytes, approximately 765 MB |
| SHA-256 | `6059d8f23a36557d7cd5aa9f1c8f0c5769f9b4272b38532b81851dc4e5f0ef6b` |
| SDK cache key | `local/onetake-qwen3-sm8850` |

The retained archive and imported files together require approximately 1.41 GB before other app data and temporary files. The archive includes metadata, tokenizer files, configuration, and two compiled model shards. SDK 0.4.0's shipped native library contains the local ZIP importer; this was checked independently of the latest online documentation.

Sources: [pinned Qualcomm archive](https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/qwen3_0_6b/releases/v0.62.2/qwen3_0_6b-geniex_qairt-w4a16-qualcomm_snapdragon_8_elite_gen5.zip), [official release manifest](https://huggingface.co/qualcomm/Qwen3-0.6B/blob/main/release_assets.json), [local bundle import documentation](https://github.com/qualcomm/GenieX/blob/main/docs/en/models/supported.mdx).

## Speech timing validation

The app already uses Moonshine Tiny Streaming for live recognition and supports Small Streaming for offline refinement. Its pinned Moonshine 0.1.5 native library was rebuilt against ONNX Runtime 1.28.0 for this phone. The optional attention decoders are pinned in `tools/moonshine-artifacts.json`; both Tiny and Small assets were staged and hash-verified.

A standalone native test on the actual SM8850 phone transcribed a synthetic English recording with leading and trailing silence. **Tiny and Small both produced ordered, positive-duration word boundaries when called through `transcribeWithoutStreaming`.** This verifies the native timing path on the target hardware, not accuracy across speakers, accents, or recording conditions.

The same Tiny model and audio, fed through streaming inference at a 0.2-second cadence, produced backward and zero-duration word boundaries. Consequently:

- Live streaming word timestamps are disabled. Live following still uses recognized text.
- Offline refinement uses the native nonstreaming API, rather than replaying audio through the streaming engine.
- A word alignment is discarded in full if it contains nonfinite values, invalid durations, out-of-line bounds, or overlapping/backward boundaries.
- Retry and video-start offsets move word boundaries together with their transcript segments; regression tests cover these translations.

All native word confidence values in these tests were **1.0**, including incorrect recognized words. Confidence is therefore not evidence that a recognized filler or a proposed cut is correct. Both models misrecognized the synthesized “um” as “On” in this sample. Word timing validation does not eliminate recognition errors, and removed footage must remain restorable.

Source: [Moonshine pinned native API](https://github.com/moonshine-ai/moonshine/blob/234f60faa0eb388b01cdf7e60aca232af37aefda/core/moonshine-c-api.h), which defines word times as absolute seconds from the beginning of the audio or stream.

## Alternative considered

**all-MiniLM-L6-v2**, approximately 22.7 million parameters, was researched as a much smaller sentence-embedding candidate for paraphrase similarity. It is **not integrated and has not been benchmarked on this phone**. Embedding similarity alone does not provide script importance classification or establish whether an incorrect amount, name, or negation preserves a line's meaning.

Source: [sentence-transformers/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2).

## Language quality and safeguards

Direct Qwen 0.6B JSON classification and pairwise entailment prompts were unreliable on this phone: examples accepted changed amounts and negation, or rejected genuine paraphrases. The implementation therefore uses single-line importance categories and guarded sentence retrieval. It checks names, quantities, negation, and temporal anchors deterministically, and accepts bounded common wording equivalents before consulting the model. A model choice needs an in-range, unambiguous answer and a shared content anchor. An uncertain importance category retains the point instead of silently excluding it. Analysis uses a new cache key so earlier experimental classifications are not reused.

A final ten-case phone probe accepted three common paraphrases and two exact/factual equivalents, rejected changed amounts, changed names, negation, and unrelated speech, and recognized one explicit restart request. These cases exercise the guarded implementation, including its deterministic normalization; they do not establish broad paraphrase accuracy. Earlier unrestricted retrieval missed two of four genuine paraphrases. Subtle changes in meaning outside the protected facts remain a limitation of this small model.

The model cannot independently label speech as a fumble for automatic deletion. The automatic fumble path requires explicit restart wording plus a sufficiently distinct match to a script line. Original footage remains available for restoration.

## Validation of this app update

The final source passed 699 JavaScript tests, TypeScript checking, and 35 Android unit tests. In an emulator UI test, restoring a two-second removed clip changed the edit from six to eight seconds; removing it returned the edit to six seconds. The native export contained six seconds of video and approximately 6.03 seconds of AAC audio (encoder padding). A red-frame/880Hz interval present in the source was absent from both exported streams; the retained green/440Hz and blue/660Hz intervals remained in order. Preview transitions also exercised the repaired caption bitmap lifecycle. These are synthetic media tests, not a claim of perfect recognition on arbitrary recordings.

## Accuracy follow-up

Script analysis now stays subscribed when recording begins, shares identical in-flight requests, and protects explicit essential details with local rules. Live reminders require evidence of an incomplete attempt or that the speaker has moved past an important line; an ordinary reading pause does not imply an omitted next line. Missing trailing lines remain visible in post-recording review.

Word-level automatic filler cuts require saved-audio timing provenance. Live estimates no longer suppress offline refinement. Best-take grouping uses guarded matching or existing validated script-line semantics; ranking prefers completeness, fewer fillers, reasonable pace, available recognition confidence, and measured pauses. This does not judge emotional delivery or arbitrary visual quality. Uncertain contextual words such as “like” remain speech.

Visual hints use central-face luminance with sustained detection, threshold hysteresis, and recovery delay. A subtle opacity transition displays the hint above the recording timer. These checks detect exposure/framing issues, not general obstructions, harsh shadows, or aesthetic composition.

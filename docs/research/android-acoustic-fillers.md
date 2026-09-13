# Android acoustic filler development experiment

The Android development build can analyze a saved recording for possible `um` and `uh` sounds using Uhm.
Results are source-local review markers with unverified boundaries.
Keep and Dismiss affect markers only; they do not change captions, cuts, or exports.
The model is not included in release assets and the review panel is gated by `__DEV__`.

## Prepare and build

Run the existing Moonshine preparation first, as described in `tools/README.md`.
Then run `python3 tools/prepare_acoustic_fillers.py` to stage the optional model and its notices in `tools/.cache/acoustic-fillers/assets`.
Downloading or using the model accepts the [Desert Ant Model License 1.0](https://license.desertant.com/1.0).
The script verifies model revision `612592c10ad7b2a51f3237725448a1aad212480b`, size 47,047,128 bytes, and SHA-256 `c266faf7db4cdced6f18aa9119ff2800a20707d7159be645d487ec191a9d79ff`.
The editor exposes a discoverable Desert Ant Labs credit and license link.

Build an arm64 Android development APK using the repository's normal Gradle workflow.
Use `EXPO_NO_DOTENV=1` to build without loading local environment files when they are not required.
The bridge reuses the existing ONNX Runtime library staged for Moonshine instead of packaging another runtime.
The raw ONNX Android path is an experiment; Desert Ant's published native SDK support currently lists Apple platforms.

## Try it

1. Record a short clip with a few deliberate “um” and “uh” sounds, then open its editor.
2. Scroll to **Acoustic filler detection** and tap **Try acoustic filler detection**.
3. Select a recording if the project has pickups, then tap **Analyze audio**.
4. Use **Play context** to listen around a possible filler.
5. Dismiss incorrect markers or keep them visible, then reopen the project to check that choices persist.

Analysis runs locally on saved audio and uses the CPU.
Recordings longer than five minutes are rejected.
Start with short clips; peak memory and five-minute performance have not been measured on a device.
It does not run automatically or while capturing a recording.
Cancel stops the job, and interrupted jobs can be retried.
A missing model, unsupported build, decoding error, or inference failure is shown as unavailable or failed rather than as zero detections.

## Validation limits

Synthetic speech can verify that decoding, inference, review, and persistence work together.
It cannot establish precision, recall, accent coverage, or reliable edit boundaries for human speech.
No consented human benchmark corpus is available for this implementation.
The detector must remain review-only until that evaluation exists.

## Build verification

The implementation passed 630 JavaScript tests, TypeScript checking, and 18 Android unit tests.
The arm64 debug APK builds successfully.
APK inspection verifies the pinned Uhm model, model notices, and exactly one unchanged ONNX Runtime library alongside the existing Moonshine models.
The release asset merge contains no Uhm weights.
The iQOO I2501 running Android 16 completed local inference on 4.78-second and 30-second synthetic clips in 3.29 and 6.53 seconds respectively.
The 30-second case exercised two windows and contiguous source coverage without duplicate events.
Context playback, cancellation followed by retry, and dismissal persistence after reopening were checked through the app UI.
An initial device failure exposed an unsupported FP16 GELU fusion in ORT's extended optimizations.
The bridge uses `ORT_ENABLE_BASIC` to retain the original primitive operations; the model bytes and runtime are unchanged.
The test also fixed context playback showing zero duration when the project had no clean sequence.
A process memory snapshot during the short run was approximately 954 MiB PSS, including the debug app; this is not an isolated model peak measurement.
Five-minute performance and low-memory devices remain unvalidated.
See `android-acoustic-fillers-smoke.json` for the measured smoke results.
The headers in `modules/one-take-captions/android/src/main/cpp/onnxruntime` are from ONNX Runtime 1.28.0 and retain its MIT license.

# iQOO recording + HTP vision experiment

2026-09-13. Isolated `dev.onetake.npu` debug APK, physical iQOO I2501 / SM8850 / Android 16. Fingerprint: `iQOO/I2501i/I2501:16/BP2A.250605.031.A3_V000L1/compiler260514162557:user/release-keys`. All inference, camera/audio capture and media tests run on this phone. Host work compiled the APK and summarized downloaded device traces. No production capture or dependency files were changed.

## Actual processor evidence

Working combination: Qualcomm QNN runtime **2.50.0**, QNN ORT plugin **2.3.0**, ONNX Runtime Android **1.27.0**, arm64-v8a. Models: Qualcomm MediaPipe Pose v0.62.2 w8a8 precompiled ONNX/context bundle for Snapdragon 8 Elite Gen5 for Galaxy, exported using QAIRT 2.45 and ORT 1.27.1. This bundle actually executed on iQOO; a Galaxy model card alone was not treated as compatibility evidence.

The runtime logged `HTP_QTI_AISW`, backend ID 6, interface 2.39.0. CPU fallback was explicitly disabled. The combined run's ORT profiles contain 600 detector node events and 35 landmark node events, all assigned to `QNNExecutionProvider`, with zero CPU-provider node events. QNN's profile independently includes accelerator execution timing and eight HVX threads. This proves HTP graph execution, **not hardware utilization percentage**. Image conversion, buffer transfer, scheduling, output processing and UI still run on CPU. The precompiled context is one ORT node; the trace does not enumerate a graph-level CPU partition because no CPU fallback was allowed.

[Backend log excerpts](evidence/backend.txt), [ORT profile hashes/counts](evidence/profile-summary.json), [QNN event aggregates](evidence/qnn-summary.json).

Two initial failures are useful reproduction evidence:

- Android's application sandbox did not expose the SoC/device discovery paths the plugin checks, so plugin registration initially returned no QNN device. The harness enables `ORT_QNN_ENABLE_CPU_BACKEND` **for device registration only**, then explicitly selects `libQnnHtp.so`. Its registration label says CPU; actual processor claims come from backend and execution traces, never this label.
- Published plugin documentation listed QNN 2.45, but the packaged EP 2.4 demanded core API 2.37 while QNN 2.45 exposed core API 2.34. EP 2.3 also rejected the 2.45 backend. Neither failure silently fell back to CPU. QNN 2.50's core API 2.39 resolved the interface failure. The normal version guard was preserved.

## Combined recording run

The isolated Camera2 activity bound 1280×720 H.264/AAC MediaRecorder output and 640×480 YUV ImageReader output. Every sixth delivered frame was converted to RGB for the model worker; the worker targeted 5 Hz with no queue. A separate microphone AudioRecord supplied mono PCM16 at 16 kHz. Raw video, PCM and frame samples remain local.

| Measurement | Device result |
| --- | --- |
| Recording start to stop | 122.522 seconds |
| Delivered camera frames | 3,531 |
| HTP detector invocations during capture | 600 |
| Detector wall time median / p95 / max | 19.015 / 22.222 / 24.453 ms |
| PCM consumer samples | 1,956,478 (122.280 seconds) |
| Nonzero PCM samples | 1,954,885 |
| PSS range, 24 samples | 108,711–178,893 KiB |
| Android thermal severity | 0 at all 24 samples |

These are one-run measurements, not power or sustained-session guarantees. No temperature-sensor series was captured. AudioTimestamp used MONOTONIC while camera timestamps followed the elapsed-realtime domain; they must not be directly subtracted.

The final phone-side MediaCodec pass decoded the recording's AAC to real PCM. Its audio duration was 122.240 seconds; video duration was 122.283 seconds. Comparing the consumer signal with the recorded signal in half-second windows at 2.0 and 119.24 seconds produced correlations **0.9767 and 0.9798**, with the same **21.75 ms offset** at both ends. The recorder and PCM consumer therefore retained matching non-silent audio with no measured relative drift in these windows. This is not physical visual-lipsync calibration. Native VideoView rendered the beginning, sought to 119.283 seconds and completed playback. [Device decode/playback evidence](evidence/audio-playback.txt).

[Scalar timing, PCM, frame and resource evidence](evidence/combined-metrics.txt). `capture.mp4`, `consumer.pcm`, sampled JPEGs, complete ORT/QNN profiles and logcat are preserved under `/tmp/one-take-npu/combined/`. No raw scene/audio is committed.

## Model usefulness and limits

Both models ran on the public positive photo, but feeding the full image to the landmark model produced only 22/256 confidence. That was incorrect ROI preparation for full pose estimation; landmark coordinates must not be used as framing advice.

The final iQOO pass decoded the detector's anchors, quantized scores and boxes using the upstream algorithm. On the public photo it returned **0.9921035**, with normalized box `[0.38127, 0.00627, 0.70557, 0.33057]`. The device-generated overlay was visually inspected and covers the person's head and upper torso; it is **not a full-body envelope**. On the actual saved camera frame it returned **0.00386168**, below the 0.75 threshold, so no detection was emitted. This one-positive/one-negative result establishes a bounded presence/localization signal, not diverse-scene accuracy or coaching quality. [Scalar results](evidence/detector.txt), [public photo with device-generated box](evidence/public-pose-detection.png).

Public fixture: [Yoga Warrior I.jpg](https://commons.wikimedia.org/wiki/File:Yoga_Warrior_I.jpg), **lululemon athletica**, [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/). Commons supplies a cropped version. The harness resizes it to model dimensions and draws a detector rectangle; those are the experiment's modifications, including the linked PNG. Source JPEG SHA-256: `c8c032a3c9376c2b82f84388546253172ba9644b36544bf3d0cf2dbae1acc3e1`. The photo does not endorse this application. Models have the Apache-2.0 license specified by their card. QNN's downloaded AAR contains `LICENSE.pdf` and `NOTICE.txt`; its proprietary runtime is kept local and is not redistributed with the source handoff.

## Fallback and integration handoff

The isolated harness also ran with its forced model-unavailable flag: optional vision was skipped while recording continued. The phone produced a 5,000 ms file with video and audio tracks, 149 delivered frames and 79,998 PCM consumer samples. This verifies the harness's disabled-vision capture branch; it is not a production fallback implementation. [Fallback evidence](evidence/fallback.txt).

**Do not combine these native libraries with speech by filename/pickFirst.** Issue #8's Moonshine native build links ORT 1.28.0, while this isolated APK uses ORT 1.27.0. A shared application must either establish one reviewed, ABI-compatible ORT build and rebuild dependents, or investigate a direct QNN context path that avoids the competing ORT library. This experiment establishes neither choice. The full app's camera, captions, recording/drafts and media editor remain outside this isolated APK.

For B/C: private `capture.mp4`, 16 kHz mono little-endian PCM16 `consumer.pcm`, 640×480 camera JPEG samples and frame/audio timestamp logs are under `/tmp/one-take-npu/combined/files/`; request these locally, do not publish them. The public photo/model URLs, detector scalar outputs and device-generated overlay can be replayed without private footage. [Artifact hashes](evidence/artifacts.json) distinguish the combined-run APK from the final verification APK. Both use the same model/runtime artifacts; final verification adds the audio decoder, detector output interpretation and forced fallback route.

Remaining limitations: no physical start/end visual-and-audible marker, no validated full-body pose ROI pipeline, no diverse held-out scene evaluation, no production combined capture/speech integration and no named-human reviewer signoff. The measured audio-consumer alignment must not be represented as a lipsync acceptance pass. These items remain explicit follow-up acceptance work.

## Reproduction on the connected phone

The user approved the isolated QNN/model download, native build and iQOO experiment. Coordinate a device lease before running these commands; they install a separate APK and, in capture mode, record camera/microphone locally.

```sh
python3 docs/research/capture-vision/f1/harness/prepare.py
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' \
  /tmp/one-take-npu/gradlew -p /tmp/one-take-npu assembleDebug
ADB=/Users/melvin/Library/Android/sdk/platform-tools/adb
SERIAL=10BFAT1U1Q000XP
"$ADB" -s "$SERIAL" install -r /tmp/one-take-npu/build/outputs/apk/debug/NpuProbe-debug.apk
"$ADB" -s "$SERIAL" shell run-as dev.onetake.npu mkdir -p files
"$ADB" -s "$SERIAL" push /tmp/one-take-npu/pose-photo.jpg /data/local/tmp/pose-photo.jpg
"$ADB" -s "$SERIAL" shell run-as dev.onetake.npu cp /data/local/tmp/pose-photo.jpg files/photo.jpg
"$ADB" -s "$SERIAL" shell am start -S -W -n dev.onetake.npu/.MainActivity \
  --es image_path /data/user/0/dev.onetake.npu/files/photo.jpg
"$ADB" -s "$SERIAL" exec-out run-as dev.onetake.npu cat files/result.txt
```

Wait for `COMPLETE` before copying outputs. Save them under a unique host path before the next inference run overwrites `result.txt`. For combined capture:

```sh
"$ADB" -s "$SERIAL" shell pm grant dev.onetake.npu android.permission.CAMERA
"$ADB" -s "$SERIAL" shell pm grant dev.onetake.npu android.permission.RECORD_AUDIO
"$ADB" -s "$SERIAL" shell am start -S -W -n dev.onetake.npu/.MainActivity --ez capture true
# After recording_end is logged, preserve private outputs locally:
"$ADB" -s "$SERIAL" exec-out run-as dev.onetake.npu tar -cf - files > /tmp/one-take-npu/capture-run.tar
# Separate on-device audio decoding and beginning/end playback:
"$ADB" -s "$SERIAL" shell am start -S -W -n dev.onetake.npu/.MainActivity --ez inspect true
"$ADB" -s "$SERIAL" exec-out run-as dev.onetake.npu cat files/inspect-result.txt
```

The `inspect` path was executed on iQOO; wait for `playback_complete` before collecting its result. To replay the verified disabled-vision branch, use `--ez fallback true`; it writes `fallback.mp4` and `fallback.pcm`, preserving the two-minute capture. Wait for `FALLBACK_COMPLETE`. No emulator or host inference tests substitute for these commands. The normal NPU probe fails loudly on initialization errors to expose research failures; a production integration must retain recording with vision disabled.

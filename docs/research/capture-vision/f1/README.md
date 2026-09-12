# Recording and NPU vision — issue #7

The isolated iQOO experiment now runs real camera recording, PCM audio and camera-frame consumers alongside a useful person-detection model on Qualcomm HTP. See [device results and exact reproduction](device-results.md), [source harness](harness/src/main/java/dev/onetake/npu/MainActivity.java) and [scalar evidence](evidence/combined-metrics.txt).

A 122.5-second recording delivered 3,531 camera frames and 1.96 million PCM samples while 600 HTP detector calls completed at 19.0 ms median / 22.2 ms p95. Recorded AAC and the PCM consumer correlated above 0.97 near both ends, with the same 21.75 ms offset. Native playback rendered the beginning and end. Public-positive and actual-camera-negative detector checks returned 0.9921 and 0.00386 respectively. An optional-vision-disabled branch preserved a five-second recording.

These are bounded research results. Physical visual lipsync, full-body pose accuracy, production integration and named-human review remain open. The [device report](device-results.md#fallback-and-integration-handoff) spells out those limits and the native-library collision with the separate speech runtime.

## Smallest practical capture path

The installed Expo Camera 57.0.5 uses CameraX 1.6.0. In its Android `ExpoCameraView.kt`, picture mode binds ImageAnalysis; video mode binds preview and video capture without that analyzer. The public JS API therefore does not supply raw frames during recording. An owner-authored native capture handoff is required, rather than polling still-photo or barcode APIs. [SDK 57 camera reference](https://docs.expo.dev/versions/v57.0.0/sdk/camera/).

The experiment uses an isolated Camera2 activity with MediaRecorder and ImageReader, avoiding production changes. A CameraX implementation can instead bind preview + video + analysis, subject to actual supported stream combinations. Keep only the latest analysis frame and release ImageProxy promptly so optional vision cannot stall recording. [CameraX analysis guidance](https://developer.android.com/media/camera/camerax/analyze).

Separate microphone consumers can be silenced under Android input-sharing policies. This phone's experiment measured both nonzero PCM and matching decoded video audio; that result is not a universal device guarantee. Prefer a reviewed single-source audio fanout if future capture integration supports it, and retain recording when optional consumers fail. [Android audio-input sharing](https://developer.android.com/media/platform/sharing-audio-input).

## Runtime comparison

| Path | Concrete requirements | Evidence / limitations |
| --- | --- | --- |
| QNN HTP + MediaPipe Pose detector | Working isolated tuple: QNN runtime 2.50.0, QNN ORT plugin 2.3.0, ORT Android 1.27.0, public v0.62.2 w8a8 context bundle. Native APK rebuild required. | Actually executed on iQOO I2501/SM8850. HTP backend logs, accelerator profile and zero CPU-provider node events corroborate execution. CPU preprocessing/UI remain. Detector localizes upper body; full-body landmark ROI is not implemented. |
| LiteRT CompiledModel | Official Android matrix lists 2.1.6, API23 minimum, NDK r26a minimum when used; accelerator/model packaging must be selected separately. | Source-reviewed alternative, not tested on this phone. Adding the base Maven library does not establish NPU execution. |
| Optional vision unavailable | Disable vision while preserving video/audio; communicate availability without a blocking recording error. | Five-second isolated fallback branch tested. Production fallback and devices without HTP still require integration validation. |

Primary sources: [Qualcomm pose card](https://aihub.qualcomm.com/models/mediapipe_pose), [public release manifest](https://huggingface.co/qualcomm/MediaPipe-Pose-Estimation/raw/main/release_assets.json), [QNN plugin versioned requirements](https://github.com/onnxruntime/onnxruntime-qnn/blob/v2.4.0/docs/execution_providers/QNN-ExecutionProvider.md), [ORT QNN provider](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html), [LiteRT Android matrix](https://developers.google.cn/edge/litert/android).

The public model bundle is about 4.14 MB. Working QNN runtime AAR is about 71.3 MB; ORT and its plugin add separate native libraries. The user approved this isolated download/build/device experiment. Model license: Apache-2.0 according to the card. Runtime license/notices are supplied in the downloaded QNN AAR and remain local; no proprietary libraries are redistributed in this source handoff. The reusable public photo's CC BY2.0 attribution is in [device-results.md](device-results.md#model-usefulness-and-limits).

## Handoff

Run [prepare.py](harness/prepare.py) to stage public artifacts under `/tmp/one-take-npu`; then follow the device report. The harness needs normal CAMERA and RECORD_AUDIO permissions for live capture, and a foreground activity. It has no Internet permission. The public static model check needs no camera/microphone permission.

B/C can reuse the public detector outputs, annotated public image, scalar measurements and local private capture manifest described in the report. Native output/model/runtime hashes distinguish the actual runs. Keep private camera/audio files local. The harness also hosts the sibling media lane's [PCM export probe](../../review-export/f3/harness/README.md), without rebuilding the production application.

The initial inventory found no capture branch, PR or prior vision evidence; issue #8's speech results were retained and not duplicated. This work adds the missing isolated vision/capture evidence while keeping production ownership unchanged.

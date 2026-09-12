# CPU and NPU execution matrix

This matrix addresses issue #25.
It records measured paths separately from possible accelerators so an untested delegate is never presented as a device result.
It is a partial matrix: the required five-warm integrated app run has not been collected yet.

The current Moonshine native path is a CPU baseline using ONNX Runtime 1.28.0 on arm64-v8a.
The benchmark device was an iQOO 15 reporting Qualcomm SM8850.
No NPU execution provider has been validated for the caption feature.

| Feature | Candidate execution path | Current evidence | Status on the tested device | Fallback |
| --- | --- | --- | --- | --- |
| Moonshine Tiny Streaming captions | ONNX Runtime CPU execution | 30-second and 90-second foreground file-fed timing runs are recorded in [moonshine-runtime.md](moonshine-runtime.md). | Measured baseline. | None needed. |
| Moonshine Tiny Streaming captions | ONNX Runtime NNAPI EP | The [NNAPI provider documentation](https://onnxruntime.ai/docs/execution-providers/NNAPI-ExecutionProvider.html) describes Android registration and partitioning behavior. | Not enabled or measured. | CPU execution. |
| Moonshine Tiny Streaming captions | ONNX Runtime QNN EP | The [QNN provider documentation](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html) requires the Qualcomm AI Engine SDK and a compatible provider build. | No SDK, provider trace, latency, accuracy, or power result is present. | CPU execution. |
| Moonshine Tiny Streaming captions | ONNX Runtime XNNPACK or another optional EP | The [execution provider overview](https://onnxruntime.ai/docs/execution-providers/) lists provider-specific tradeoffs. | Not enabled or measured for this app. | CPU execution. |
| Camera and microphone capture | Android CameraX and `AudioRecord` | The application capture path is separate from model execution. | App integration testing is still required for contention and thermal behavior. | Keep video recording if captions fail. |

The locally available `Pixel_10a` emulator is an arm64 API 37.1 image with a virtual camera and host audio input.
It can exercise app control flow and file-based Media3/refinement fixtures after launch, but it cannot establish iQOO 15 SM8850 CPU, NPU, camera, microphone, or thermal behavior.
No emulator run has been used as NPU or human speech evidence.

NNAPI is an Android device delegate rather than a universal guarantee of NPU execution.
The [NNAPI provider documentation](https://onnxruntime.ai/docs/execution-providers/NNAPI-ExecutionProvider.html) notes that unsupported graph portions can remain on CPU and that CPU fallback may be slower.
Therefore a future NNAPI result must record the provider options, partition counts, delegated operators, and the CPU fallback portion.

QNN is a viable investigation path on supported Snapdragon devices.
The [QNN execution provider documentation](https://onnxruntime.ai/docs/execution-providers/QNN-ExecutionProvider.html) describes the required Qualcomm SDK and supported provider setup.
No QNN or NPU accuracy number is claimed here because no QNN trace has been collected.

The next device matrix pass should use the installed app and the same consented speech fixtures across each path.
For each path, record model load time, first partial latency, partial event cadence, end-to-end lag, CPU utilization, memory, battery drain, device temperature, and whether any graph ran on CPU fallback.
Repeat each path across at least five warmed sessions and include a camera recording session.
Keep the exact device build, Android version, provider options, model hash, and APK hash with each result.

The acceptance rule is a measured path with a working fallback.
An accelerator is not considered available merely because a phone advertises an NPU or because an execution provider is documented.

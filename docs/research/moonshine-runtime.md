# Moonshine streaming runtime evidence

The Android caption prototype uses Moonshine Tiny Streaming from the v0.1.5 source snapshot at commit `234f60faa0eb388b01cdf7e60aca232af37aefda`.
The source snapshot is rebuilt against the official ONNX Runtime Android 1.28.0 AAR because the stock Moonshine AAR carried the older runtime used by the failed SM8850 test.
The rebuild is pinned to arm64-v8a, Android API 26, NDK `30.0.16248370`, and CMake `4.1.2`.

The reproducible script is [tools/rebuild_moonshine.py](../../tools/rebuild_moonshine.py).
Its default mode is read-only and performs no network access, source mutation, CMake invocation, Ninja invocation, or Gradle invocation.

Inspect the plan against an existing checkout and cached AAR with:

```sh
python3 tools/rebuild_moonshine.py \
  --dry-run \
  --source-dir /path/to/moonshine-src \
  --ort-aar /path/to/onnxruntime-android-1.28.0.aar
```

An actual rebuild is an explicit operation on a machine with Git LFS and the pinned Android SDK tools:

```sh
python3 tools/rebuild_moonshine.py --execute --strict-output
```

The script fetches the Moonshine repository at the exact commit and pulls these Git LFS objects.

| Relative path | Size | SHA-256 |
| --- | ---: | --- |
| `core/cpp-annote/src/community1_cpp_annote_embedded.cpp` | 2,535,244 | `9424da4176b33e67e4000ea2a776d64b6a78ee9bbf72d40405fb6805d12758c4` |
| `core/moonshine-tts/src/zipvoice-voices-data.cpp` | 11,695,724 | `f3e4d62cae93c465e1de8521bc5706b9a20f834cbbf37404bf03f0d35dffa012` |

The old ONNX Runtime LFS object is intentionally not fetched.
The script verifies the official [ONNX Runtime Android 1.28.0 AAR](https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/1.28.0/onnxruntime-android-1.28.0.aar) before extracting only its headers and arm64 library into the pinned source tree.

| Artifact | SHA-256 |
| --- | --- |
| ORT 1.28.0 Android AAR | `f351a0638696f54b35184290dbc001d66daae17281ad0b548d2c70347d53b8a9` |
| ORT 1.28.0 arm64 library | `f826d8efb03adf0a84f10e7ba408f9d4cd11b0a2ccd8d08aeb0f7451fb50cacc` |
| Verified `libmoonshine.so` build | `a871c01b7fffbbe9f35926b6e70c0e70a9df04b95e95dd1080748d4d7192dc24` |
| Verified `libmoonshine-jni.so` build | `7daef883460c88f676ed2e651965a728631afddf3ea9684413b61a915bad2957` |

The build target is `moonshine-jni` with shared Moonshine libraries and ONNX Runtime linkage.
The native artifact is arm64 only because that is the verified device path.
The app can keep a lower global Android minimum when the native module checks API and ABI capability before loading JNI.

The existing benchmark recorded these foreground, file-fed CPU measurements for Tiny Streaming on an iQOO 15 (I2501) reporting Qualcomm SM8850 on Android 16.
They are timing measurements rather than speech accuracy measurements.

| Fixture | Model load | First partial | Stream duration | Native processing | Longest call | Max lag | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 30-second Tiny stream | 98 ms | 485.6 ms | 30.005 s | 6.547 s | 119.5 ms | 122.0 ms | No remaining backlog. |
| 90-second Tiny stream | Not repeated in this run | 483.3 ms | 90.004 s | 22.838 s | 192.2 ms | Not retained | 258 partial events and 21 completed lines. |

The measurements came from a single foreground run per fixture.
They do not establish human WER, camera concurrency, thermal behavior, battery impact, NPU delegation, or long-term reliability.
The next evidence pass must measure those properties on the actual application and device.

The relevant primary references are the [Moonshine v0.1.5 source](https://github.com/moonshine-ai/moonshine/tree/v0.1.5), [ONNX Runtime Android build guide](https://onnxruntime.ai/docs/build/android.html), and [ONNX Runtime mobile documentation](https://onnxruntime.ai/docs/tutorials/mobile/).
The upstream [ONNX Runtime issue tracker](https://github.com/microsoft/onnxruntime/issues/27884) is a useful reference for investigating instruction-set crashes, but it is not evidence that a particular phone will fail or pass.

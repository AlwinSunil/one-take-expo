# Issue 15 vision handoff

This lane adds an optional Android face-presence signal, device readiness status and honest debug diagnostics.

The implementation follows the Expo SDK 57 camera contract documented at https://docs.expo.dev/versions/v57.0.0/sdk/camera/.

## Native ownership

`modules/one-take-vision` is an Android-only Expo module that autolinks from the repository's `modules` directory.

It uses CameraX 1.6.0, which is the CameraX line bundled by `expo-camera` 57.0.5 in this app.

`OneTakeVision.start(sessionId, lensFacing)` must be called after the existing `CameraView` fires `onCameraReady` and before recording begins.

The module obtains the existing `ProcessCameraProvider` and current activity lifecycle owner, then binds exactly one `ImageAnalysis` use case with the requested lens selector.

It never creates a preview, `VideoCapture`, `Recorder` or `Recording`, and it never calls `unbindAll`.

Stopping or failing vision unbinds only that module's `ImageAnalysis` instance, so recording remains owned by `expo-camera`.

The analyzer uses `STRATEGY_KEEP_ONLY_LATEST`, a 640 by 480 target, one in-flight ML Kit task and prompt `ImageProxy.close()` calls.

Normal analysis targets five frames per second.

The thermal gate lowers the optional analysis rate to approximately 3.3, 2, 1.25 or 1 frame per second as the reported thermal state rises.

Critical, emergency or shutdown thermal states release the analyzer and publish `thermal-pressure` while leaving the camera owner untouched.

## Face signal

Face detection uses Google's bundled ML Kit model from `com.google.mlkit:face-detection:16.1.7`.

The dependency and API follow the official Android guide at https://developers.google.com/ml-kit/vision/face-detection/android.

Bundling keeps model availability independent of a first-use network download.

The detector runs in fast mode with tracking enabled and no contours, landmarks or classification work.

The result contains normalized face bounds, an optional ML Kit tracking id, inference time and dropped-frame count.

ML Kit face detection does not expose a calibrated confidence value for this path, so the event does not invent one.

Two present observations or three absent observations over the hysteresis window are required before `facePresent` changes.

The event's `stable` and `stableForMs` fields allow the UI and take-selection consumers to ignore a transient miss.

The frame clock is Android elapsed realtime at analyzer acceptance.

It is exposed as `frameCapturedAtMs` for the shared consumer clock, with the limitation that this bounded module does not claim a sensor timestamp calibration.

Each frame also carries `frameEmittedAtMs` from the same native clock so the JS hook can normalize the source timestamp without treating bridge delay as capture time.

The JS hook filters session and lens identity before applying that clock anchor, then normalizes the native clock to its local monotonic clock before applying stale checks.

## Session and failure behavior

The JS state layer requires an explicit `beginVisionSession(sessionId, lensFacing)` before accepting native callbacks.

Callbacks from an older take or a previous lens are ignored even if they arrive after a new session starts.

If no accepted frame arrives for 500 milliseconds, evidence becomes unavailable with `stale-frame` and face presence resets to unknown.

The native controller emits the same stale transition after one second without a detector result and can recover on a later frame.

Model initialization, camera binding, activity, permission and thermal failures publish an unavailable reason and do not stop recording.

The bundled face model has no app-private model import path and no runtime hash check is needed for this dependency.

## Readiness and diagnostics

`getDeviceStatus()` reports battery percentage and state, charging, Android thermal status and severity, camera and microphone feature availability, permission state and the elapsed-realtime sample time.

The camera screen can use these values for a short readiness row without exposing native implementation detail.

`getDiagnostics()` returns detailed counters only in debug builds.

Release builds return `{ enabled: false, reason: "debug-only" }` and do not expose session counters, inference timings or build identity.

Debug diagnostics include the module and bundled model identity, engine and processor labels, active session and lens, received, processed and dropped frames, detector successes and failures, last, median and p95 inference time, thermal state, app version and build configuration.

The engine label is `mlkit-face` and the processor label is `cpu-fallback`.

## NPU status

This module does not add ONNX Runtime, QNN, a precompiled context bundle or an unverified face model.

The isolated research run in `docs/research/capture-vision/f1/device-results.md` used ORT 1.27.0 with QNN and explicitly found a native collision with the Moonshine lane's ORT 1.28.0 build.

It also did not establish a reviewed production face model.

The module therefore reports NPU execution as unavailable with the explicit reason `qnn-face-engine-unavailable: ORT 1.27/1.28 native collision and no reviewed bundled face model`.

This is not a claim that the phone cannot run an NPU path.

LiteRT's Qualcomm runtime bundle path is a possible future option, but it is not integrated or measured by this issue and must not be presented as current evidence.

## Validation

Run the pure state checks with:

```sh
node --experimental-strip-types --test tests/vision-state.test.mjs
```

Run the TypeScript check with:

```sh
npx tsc --noEmit --pretty false
```

Verify Android compilation and Expo module autolinking with:

```sh
npx expo-modules-autolinking resolve --platform android
EXPO_NO_DOTENV=1 \
  JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' \
  ANDROID_HOME='/Users/sabari/Library/Android/sdk' \
  ./gradlew :one-take-vision:compileDebugKotlin \
  -PreactNativeArchitectures=arm64-v8a
```

The connected phone still needs an integrated application build and parent-coordinated install before it can provide production face accuracy, thermal or five-session evidence for this module.

The phone-only setup has no Bluetooth selfie remote, so hands-free remote checks remain outside this lane.

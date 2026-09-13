package com.onetake.captions

/**
 * Thin JNI surface for the debug-only Uhm runner.
 *
 * The implementation resolves OrtGetApiBase at runtime so it reuses the
 * libonnxruntime.so already loaded by Moonshine. No second ORT dependency is
 * linked into the captions module.
 */
internal object AcousticFillerNative {
  private var loadAttempted = false
  private var loadError: String? = null

  @Synchronized
  fun ensureLoaded(): String? {
    if (!loadAttempted) {
      loadAttempted = true
      try {
        System.loadLibrary("onetake_acoustic_fillers")
      } catch (failure: UnsatisfiedLinkError) {
        loadError = failure.message ?: "The native acoustic filler bridge could not be loaded"
      } catch (failure: SecurityException) {
        loadError = failure.message ?: "The native acoustic filler bridge could not be loaded"
      }
    }
    return loadError
  }

  @JvmStatic
  external fun detect(
    jobId: String,
    modelPath: String,
    audio: FloatArray,
    threshold: Float,
  ): DoubleArray

  @JvmStatic
  external fun cancel(jobId: String)

  @JvmStatic
  external fun runtimeVersion(): String
}

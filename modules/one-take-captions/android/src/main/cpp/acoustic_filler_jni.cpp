// Debug-only saved-audio bridge for the pinned Uhm model.
//
// The ONNX Runtime C API is loaded from the Moonshine runtime already shipped
// by this module. There is intentionally no link-time ORT dependency here:
// loading a second libonnxruntime.so would make the two native engines compete
// for the same process symbols.

#include "onnxruntime_c_api.h"

#include <jni.h>
#include <android/log.h>
#include <dlfcn.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

constexpr size_t kModelBytes = 47'047'128;
constexpr size_t kInputSamples = 480'000;
constexpr size_t kWindowSamples = 479'680;
constexpr size_t kHopSamples = 240'000;
constexpr size_t kFrameSamples = 320;
constexpr size_t kOutputFrames = 1'499;
constexpr size_t kOutputClasses = 6;
constexpr float kThreshold = 0.5f;

class Cancelled final : public std::runtime_error {
 public:
  Cancelled() : std::runtime_error("Acoustic filler analysis cancelled") {}
};

struct JobState {
  std::atomic_bool cancelled{false};
  std::mutex run_mutex;
  OrtRunOptions* run_options = nullptr;
};

std::mutex g_jobs_mutex;
std::unordered_map<std::string, std::shared_ptr<JobState>> g_jobs;

class OrtRuntime {
 public:
  static const OrtRuntime& get() {
    static const OrtRuntime runtime;
    return runtime;
  }

  const OrtApi* api = nullptr;
  const OrtApiBase* base = nullptr;

 private:
  OrtRuntime() {
    // The Moonshine AAR exposes this exact SONAME. The fallback is useful for
    // locally rebuilt debug APKs whose packager retains the version suffix.
    library_ = dlopen("libonnxruntime.so", RTLD_NOW | RTLD_LOCAL);
    if (library_ == nullptr) {
      library_ = dlopen("libonnxruntime.so.1.28.0", RTLD_NOW | RTLD_LOCAL);
    }
    if (library_ == nullptr) {
      throw std::runtime_error("The shared Moonshine ONNX Runtime is unavailable");
    }

    auto* symbol = dlsym(library_, "OrtGetApiBase");
    if (symbol == nullptr) {
      throw std::runtime_error("ONNX Runtime does not export OrtGetApiBase");
    }
    using GetApiBase = const OrtApiBase* (*)();
    const auto get_api_base = reinterpret_cast<GetApiBase>(symbol);
    base = get_api_base();
    if (base == nullptr || base->GetApi == nullptr) {
      throw std::runtime_error("ONNX Runtime returned no API base");
    }
    api = base->GetApi(ORT_API_VERSION);
    if (api == nullptr) {
      const char* version = base->GetVersionString == nullptr ? "unknown" : base->GetVersionString();
      throw std::runtime_error(std::string("ONNX Runtime C API version 28 is unavailable (runtime ") + version + ")");
    }
  }

  ~OrtRuntime() = default;
  void* library_ = nullptr;
};

void throw_status(const OrtApi* api, OrtStatus* status) {
  if (status == nullptr) {
    return;
  }
  const char* message = api->GetErrorMessage == nullptr ? nullptr : api->GetErrorMessage(status);
  std::string error = message == nullptr ? "ONNX Runtime call failed" : message;
  api->ReleaseStatus(status);
  throw std::runtime_error(error);
}

void check_status(const OrtApi* api, OrtStatus* status) {
  throw_status(api, status);
}

template <typename T, typename Release>
class OrtGuard {
 public:
  OrtGuard(const OrtGuard&) = delete;
  OrtGuard& operator=(const OrtGuard&) = delete;

  OrtGuard(const OrtApi* api, T* value, Release release)
      : api_(api), value_(value), release_(std::move(release)) {}

  ~OrtGuard() {
    if (value_ != nullptr) {
      release_(api_, value_);
    }
  }

  T* get() const { return value_; }
  T** out() { return &value_; }
  T* release() {
    T* value = value_;
    value_ = nullptr;
    return value;
  }

 private:
  const OrtApi* api_;
  T* value_;
  Release release_;
};

using EnvGuard = OrtGuard<OrtEnv, void (*)(const OrtApi*, OrtEnv*)>;
using SessionOptionsGuard = OrtGuard<OrtSessionOptions, void (*)(const OrtApi*, OrtSessionOptions*)>;
using SessionGuard = OrtGuard<OrtSession, void (*)(const OrtApi*, OrtSession*)>;
using RunOptionsGuard = OrtGuard<OrtRunOptions, void (*)(const OrtApi*, OrtRunOptions*)>;
using MemoryInfoGuard = OrtGuard<OrtMemoryInfo, void (*)(const OrtApi*, OrtMemoryInfo*)>;
using ValueGuard = OrtGuard<OrtValue, void (*)(const OrtApi*, OrtValue*)>;
using ShapeGuard = OrtGuard<OrtTensorTypeAndShapeInfo, void (*)(const OrtApi*, OrtTensorTypeAndShapeInfo*)>;

void release_env(const OrtApi* api, OrtEnv* value) { api->ReleaseEnv(value); }
void release_session_options(const OrtApi* api, OrtSessionOptions* value) { api->ReleaseSessionOptions(value); }
void release_session(const OrtApi* api, OrtSession* value) { api->ReleaseSession(value); }
void release_run_options(const OrtApi* api, OrtRunOptions* value) { api->ReleaseRunOptions(value); }
void release_memory_info(const OrtApi* api, OrtMemoryInfo* value) { api->ReleaseMemoryInfo(value); }
void release_value(const OrtApi* api, OrtValue* value) { api->ReleaseValue(value); }
void release_shape(const OrtApi* api, OrtTensorTypeAndShapeInfo* value) { api->ReleaseTensorTypeAndShapeInfo(value); }

std::vector<uint8_t> read_model(const std::string& path) {
  std::ifstream input(path, std::ios::binary | std::ios::ate);
  if (!input) {
    throw std::runtime_error("The verified Uhm model file cannot be opened");
  }
  const std::streamoff size = input.tellg();
  if (size != static_cast<std::streamoff>(kModelBytes)) {
    throw std::runtime_error("The Uhm model size differs from the pinned artifact");
  }
  input.seekg(0, std::ios::beg);
  std::vector<uint8_t> bytes(kModelBytes);
  input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  if (input.gcount() != static_cast<std::streamsize>(bytes.size())) {
    throw std::runtime_error("The Uhm model is truncated");
  }
  return bytes;
}

std::shared_ptr<JobState> register_job(const std::string& job_id) {
  if (job_id.empty()) {
    throw std::invalid_argument("Acoustic filler jobId is required");
  }
  auto state = std::make_shared<JobState>();
  std::lock_guard<std::mutex> lock(g_jobs_mutex);
  if (!g_jobs.emplace(job_id, state).second) {
    throw std::invalid_argument("Acoustic filler analysis is already running");
  }
  return state;
}

void unregister_job(const std::string& job_id) {
  std::lock_guard<std::mutex> lock(g_jobs_mutex);
  g_jobs.erase(job_id);
}

void ensure_not_cancelled(const std::shared_ptr<JobState>& state) {
  if (state->cancelled.load(std::memory_order_relaxed)) {
    throw Cancelled();
  }
}

void set_run_options(const std::shared_ptr<JobState>& state, OrtRunOptions* options) {
  std::lock_guard<std::mutex> lock(state->run_mutex);
  state->run_options = options;
  if (state->cancelled.load(std::memory_order_relaxed)) {
    const OrtApi* api = OrtRuntime::get().api;
    check_status(api, api->RunOptionsSetTerminate(options));
  }
}

void clear_run_options(const std::shared_ptr<JobState>& state) {
  std::lock_guard<std::mutex> lock(state->run_mutex);
  state->run_options = nullptr;
}

class RunOptionsBinding {
 public:
  explicit RunOptionsBinding(std::shared_ptr<JobState> state) : state_(std::move(state)) {}
  RunOptionsBinding(const RunOptionsBinding&) = delete;
  RunOptionsBinding& operator=(const RunOptionsBinding&) = delete;
  ~RunOptionsBinding() { clear_run_options(state_); }

 private:
  std::shared_ptr<JobState> state_;
};

struct FrameRow {
  double start_sample;
  double label;
  double score;
};

std::vector<FrameRow> run_model(
    const std::shared_ptr<JobState>& state,
    const std::string& model_path,
    const float* audio,
    size_t sample_count) {
  if (audio == nullptr || sample_count == 0) {
    throw std::invalid_argument("Acoustic filler audio is empty");
  }
  if (sample_count > 16'000 * 300) {
    throw std::invalid_argument("Acoustic filler audio is longer than five minutes");
  }

  const OrtRuntime& runtime = OrtRuntime::get();
  const OrtApi* api = runtime.api;
  std::vector<uint8_t> model_bytes = read_model(model_path);
  ensure_not_cancelled(state);

  OrtEnv* env_raw = nullptr;
  check_status(api, api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "onetake-acoustic-fillers", &env_raw));
  EnvGuard env(api, env_raw, release_env);

  OrtSessionOptions* options_raw = nullptr;
  check_status(api, api->CreateSessionOptions(&options_raw));
  SessionOptionsGuard options(api, options_raw, release_session_options);
  check_status(api, api->SetIntraOpNumThreads(options.get(), 1));
  check_status(api, api->SetInterOpNumThreads(options.get(), 1));
  check_status(api, api->SetSessionGraphOptimizationLevel(options.get(), ORT_ENABLE_ALL));

  OrtSession* session_raw = nullptr;
  check_status(api, api->CreateSessionFromArray(
      env.get(), model_bytes.data(), model_bytes.size(), options.get(), &session_raw));
  SessionGuard session(api, session_raw, release_session);

  OrtRunOptions* run_options_raw = nullptr;
  check_status(api, api->CreateRunOptions(&run_options_raw));
  RunOptionsGuard run_options(api, run_options_raw, release_run_options);

  OrtMemoryInfo* memory_raw = nullptr;
  check_status(api, api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memory_raw));
  MemoryInfoGuard memory(api, memory_raw, release_memory_info);

  std::vector<FrameRow> rows;
  rows.reserve((sample_count + kFrameSamples - 1) / kFrameSamples);
  std::vector<float> input(kInputSamples, 0.0f);
  const char* input_name = "audio";
  const char* output_name = "probs";
  const char* input_names[] = {input_name};
  const char* output_names[] = {output_name};

  for (size_t window_start = 0; window_start < sample_count; window_start += kHopSamples) {
    ensure_not_cancelled(state);
    std::fill(input.begin(), input.end(), 0.0f);
    const size_t valid = std::min(kWindowSamples, sample_count - window_start);
    std::copy(audio + window_start, audio + window_start + valid, input.begin());

    const int64_t shape[] = {1, static_cast<int64_t>(kInputSamples)};
    OrtValue* input_value_raw = nullptr;
    check_status(api, api->CreateTensorWithDataAsOrtValue(
        memory.get(), input.data(), input.size() * sizeof(float), shape, 2,
        ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &input_value_raw));
    ValueGuard input_value(api, input_value_raw, release_value);

    OrtValue* output_value_raw = nullptr;
    const OrtValue* inputs[] = {input_value.get()};
    OrtValue* outputs[] = {nullptr};
    RunOptionsBinding run_options_binding(state);
    set_run_options(state, run_options.get());
    OrtStatus* run_status = api->Run(
        session.get(), run_options.get(), input_names, inputs, 1, output_names, 1, outputs);
    clear_run_options(state);
    ValueGuard output_value(api, outputs[0], release_value);
    if (run_status != nullptr) {
      if (state->cancelled.load(std::memory_order_relaxed)) {
        api->ReleaseStatus(run_status);
        throw Cancelled();
      }
      throw_status(api, run_status);
    }
    ensure_not_cancelled(state);
    if (output_value.get() == nullptr) {
      throw std::runtime_error("Uhm returned no output tensor");
    }

    OrtTensorTypeAndShapeInfo* shape_raw = nullptr;
    check_status(api, api->GetTensorTypeAndShape(output_value.get(), &shape_raw));
    ShapeGuard output_shape(api, shape_raw, release_shape);
    size_t rank = 0;
    check_status(api, api->GetDimensionsCount(output_shape.get(), &rank));
    if (rank != 3) {
      throw std::runtime_error("Uhm output rank does not match the pinned ABI");
    }
    int64_t dimensions[3] = {0, 0, 0};
    check_status(api, api->GetDimensions(output_shape.get(), dimensions, 3));
    if (dimensions[0] != 1 || dimensions[1] != static_cast<int64_t>(kOutputFrames) ||
        dimensions[2] != static_cast<int64_t>(kOutputClasses)) {
      throw std::runtime_error("Uhm output shape does not match the pinned ABI");
    }
    ONNXTensorElementDataType element_type = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED;
    check_status(api, api->GetTensorElementType(output_shape.get(), &element_type));
    if (element_type != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
      throw std::runtime_error("Uhm output type does not match the pinned ABI");
    }
    void* output_data = nullptr;
    check_status(api, api->GetTensorMutableData(output_value.get(), &output_data));
    if (output_data == nullptr) {
      throw std::runtime_error("Uhm returned an empty output tensor");
    }

    const float* scores = static_cast<const float*>(output_data);
    const bool last_window = window_start + kWindowSamples >= sample_count;
    const size_t owned_samples = last_window ? valid : kHopSamples;
    for (size_t frame = 0; frame < kOutputFrames; ++frame) {
      const size_t offset = frame * kFrameSamples;
      if (offset >= owned_samples) {
        break;
      }
      const float* row = scores + frame * kOutputClasses;
      for (size_t index = 0; index < kOutputClasses; ++index) {
        if (!std::isfinite(row[index]) || row[index] < 0.0f || row[index] > 1.0f) {
          throw std::runtime_error("Uhm returned malformed frame scores");
        }
      }

      const float competitor = std::max(std::max(row[0], row[3]), std::max(row[4], row[5]));
      const float um = row[2];
      const float uh = row[1];
      double label = 0.0;
      double score = std::max(competitor, std::max(um, uh));
      if (score >= kThreshold) {
        const bool um_wins = um > competitor && um > uh;
        const bool uh_wins = uh > competitor && uh > um;
        if (um_wins) {
          label = 1.0;
          score = um;
        } else if (uh_wins) {
          label = 2.0;
          score = uh;
        }
      }
      rows.push_back(FrameRow{
          static_cast<double>(window_start + offset), label, score});
    }
    if (last_window) {
      break;
    }
  }
  clear_run_options(state);
  ensure_not_cancelled(state);
  return rows;
}

std::string jstring_to_string(JNIEnv* env, jstring value, const char* name) {
  if (value == nullptr) {
    throw std::invalid_argument(std::string(name) + " is required");
  }
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) {
    throw std::runtime_error(std::string("Could not read ") + name);
  }
  std::string result(chars);
  env->ReleaseStringUTFChars(value, chars);
  return result;
}

void throw_java(JNIEnv* env, const char* class_name, const std::string& message) {
  jclass clazz = env->FindClass(class_name);
  if (clazz != nullptr) {
    env->ThrowNew(clazz, message.c_str());
    env->DeleteLocalRef(clazz);
  }
}

void throw_for_exception(JNIEnv* env, const std::exception& error) {
  if (dynamic_cast<const Cancelled*>(&error) != nullptr) {
    throw_java(env, "java/util/concurrent/CancellationException", error.what());
  } else if (dynamic_cast<const std::invalid_argument*>(&error) != nullptr) {
    throw_java(env, "java/lang/IllegalArgumentException", error.what());
  } else {
    throw_java(env, "java/lang/IllegalStateException", error.what());
  }
}

}  // namespace

extern "C" JNIEXPORT jdoubleArray JNICALL
Java_com_onetake_captions_AcousticFillerNative_detect(
    JNIEnv* env, jclass, jstring job_id_value, jstring model_path_value,
    jfloatArray audio_value, jfloat threshold) {
  try {
    if (threshold != kThreshold) {
      throw std::invalid_argument("The experimental acoustic filler threshold must be 0.5");
    }
    const std::string job_id = jstring_to_string(env, job_id_value, "jobId");
    const std::string model_path = jstring_to_string(env, model_path_value, "modelPath");
    if (audio_value == nullptr) {
      throw std::invalid_argument("audio is required");
    }
    const jsize length = env->GetArrayLength(audio_value);
    if (length <= 0) {
      throw std::invalid_argument("Acoustic filler audio is empty");
    }
    auto state = register_job(job_id);
    struct JobCleanup {
      const std::string& id;
      ~JobCleanup() { unregister_job(id); }
    } cleanup{job_id};

    jboolean copied = JNI_FALSE;
    jfloat* audio = env->GetFloatArrayElements(audio_value, &copied);
    if (audio == nullptr) {
      throw std::runtime_error("Could not read decoded audio");
    }
    std::vector<FrameRow> rows;
    try {
      rows = run_model(state, model_path, audio, static_cast<size_t>(length));
    } catch (...) {
      env->ReleaseFloatArrayElements(audio_value, audio, JNI_ABORT);
      throw;
    }
    env->ReleaseFloatArrayElements(audio_value, audio, JNI_ABORT);

    if (rows.size() > (std::numeric_limits<jsize>::max() / 3)) {
      throw std::runtime_error("Acoustic filler result is too large");
    }
    jdoubleArray result = env->NewDoubleArray(static_cast<jsize>(rows.size() * 3));
    if (result == nullptr) {
      throw std::runtime_error("Could not allocate acoustic filler result");
    }
    std::vector<jdouble> packed;
    packed.reserve(rows.size() * 3);
    for (const FrameRow& row : rows) {
      packed.push_back(row.start_sample);
      packed.push_back(row.label);
      packed.push_back(row.score);
    }
    env->SetDoubleArrayRegion(result, 0, static_cast<jsize>(packed.size()), packed.data());
    if (env->ExceptionCheck()) {
      env->DeleteLocalRef(result);
      return nullptr;
    }
    return result;
  } catch (const std::exception& error) {
    throw_for_exception(env, error);
    return nullptr;
  } catch (...) {
    throw_java(env, "java/lang/IllegalStateException", "Unknown acoustic filler failure");
    return nullptr;
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_onetake_captions_AcousticFillerNative_cancel(
    JNIEnv* env, jclass, jstring job_id_value) {
  try {
    const std::string job_id = jstring_to_string(env, job_id_value, "jobId");
    std::shared_ptr<JobState> state;
    {
      std::lock_guard<std::mutex> lock(g_jobs_mutex);
      const auto found = g_jobs.find(job_id);
      if (found == g_jobs.end()) {
        return;
      }
      state = found->second;
    }
    state->cancelled.store(true, std::memory_order_relaxed);
    std::lock_guard<std::mutex> lock(state->run_mutex);
    if (state->run_options != nullptr) {
      const OrtApi* api = OrtRuntime::get().api;
      check_status(api, api->RunOptionsSetTerminate(state->run_options));
    }
  } catch (const std::exception& error) {
    throw_for_exception(env, error);
  } catch (...) {
    throw_java(env, "java/lang/IllegalStateException", "Unknown acoustic cancellation failure");
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_onetake_captions_AcousticFillerNative_runtimeVersion(
    JNIEnv* env, jclass) {
  try {
    const OrtRuntime& runtime = OrtRuntime::get();
    const char* version = runtime.base == nullptr || runtime.base->GetVersionString == nullptr
        ? "unknown"
        : runtime.base->GetVersionString();
    return env->NewStringUTF(version == nullptr ? "unknown" : version);
  } catch (const std::exception& error) {
    throw_for_exception(env, error);
    return nullptr;
  } catch (...) {
    throw_java(env, "java/lang/IllegalStateException", "Unknown ONNX Runtime failure");
    return nullptr;
  }
}

cmake_minimum_required(VERSION 3.22.1)

project(onetake_acoustic_fillers)

add_library(onetake_acoustic_fillers SHARED acoustic_filler_jni.cpp)

target_compile_features(onetake_acoustic_fillers PRIVATE cxx_std_17)
target_compile_options(onetake_acoustic_fillers PRIVATE -fvisibility=hidden)
target_include_directories(onetake_acoustic_fillers PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/onnxruntime
)
target_link_libraries(onetake_acoustic_fillers PRIVATE log dl)

#include <fbjni/fbjni.h>
#include <jni.h>

#include "Capabilities.hpp"
#include "NitroWebCodecsOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, []() {
    margelo::nitro::webcodecs::registerAllNatives();
    margelo::nitro::webcodecs::JCapabilities::preload();
  });
}

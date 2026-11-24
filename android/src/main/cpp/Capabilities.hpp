#pragma once

#include <fbjni/fbjni.h>

#include <optional>
#include <string>

namespace margelo::nitro::webcodecs {

// com.margelo.nitro.webcodecs.Capabilities: the encoders' capabilities, from
// MediaCodecList (the NDK has no capability queries before API 36).
struct JCapabilities : facebook::jni::JavaClass<JCapabilities> {
  static constexpr auto kJavaDescriptor = "Lcom/margelo/nitro/webcodecs/Capabilities;";

  // Resolves the class while the app's class loader is at hand (JNI_OnLoad):
  // threads started natively only see the system's.
  static void preload() {
    javaClassStatic();
  }

  // The name of the first encoder for `mime` that takes this config, or none.
  // frameRate, bitrate and profile are ignored when 0 or less.
  static std::optional<std::string> findVideoEncoder(const std::string& mime, int width, int height, double frameRate, int bitrate,
                                                     int profile, int colorFormat) {
    std::optional<std::string> name;
    facebook::jni::ThreadScope::WithClassLoader([&] {
      static const auto method =
          javaClassStatic()->getStaticMethod<facebook::jni::local_ref<facebook::jni::JString>(facebook::jni::alias_ref<facebook::jni::JString>, jint, jint, jdouble, jint, jint, jint)>(
              "findVideoEncoder");
      auto result = method(javaClassStatic(), facebook::jni::make_jstring(mime), width, height, frameRate, bitrate, profile, colorFormat);
      if (result) {
        name = result->toStdString();
      }
    });
    return name;
  }
};

}  // namespace margelo::nitro::webcodecs

#pragma once

#include <fbjni/fbjni.h>

#include <optional>
#include <sstream>
#include <string>
#include <vector>

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

  // The name of the encoder for `mime` that takes this size, profile
  // (ignored when 0 or less; dropped when `profileOptional` and no encoder
  // takes it) and input color format, or none: see Capabilities.java. The
  // frame rate and bitrate are hints, which refuse no encoder.
  static std::optional<std::string> findVideoEncoder(const std::string& mime, int width, int height, int profile, bool profileOptional,
                                                     int colorFormat) {
    std::optional<std::string> name;
    facebook::jni::ThreadScope::WithClassLoader([&] {
      static const auto method =
          javaClassStatic()->getStaticMethod<facebook::jni::local_ref<facebook::jni::JString>(facebook::jni::alias_ref<facebook::jni::JString>, jint, jint, jint, jboolean, jint)>(
              "findVideoEncoder");
      auto result = method(javaClassStatic(), facebook::jni::make_jstring(mime), width, height, profile, profileOptional ? JNI_TRUE : JNI_FALSE, colorFormat);
      if (result) {
        name = result->toStdString();
      }
    });
    return name;
  }

  // The bitrate to configure the encoder `name` with: `requested`, or when 0
  // or less width * height * fps * 0.1, clamped into the encoder's range.
  static int32_t videoBitrate(const std::string& name, const std::string& mime, double requested, int width, int height,
                              double frameRate) {
    int32_t bitrate = 0;
    facebook::jni::ThreadScope::WithClassLoader([&] {
      static const auto method =
          javaClassStatic()
              ->getStaticMethod<jint(facebook::jni::alias_ref<facebook::jni::JString>, facebook::jni::alias_ref<facebook::jni::JString>, jdouble,
                                     jint, jint, jdouble)>("videoBitrate");
      bitrate = method(javaClassStatic(), facebook::jni::make_jstring(name), facebook::jni::make_jstring(mime), requested, width, height,
                       frameRate);
    });
    return bitrate;
  }

  // The decoders for `mime` that take this size, in the platform's order:
  // with "prefer-software" only software ones, with "prefer-hardware" none
  // of those.
  static std::vector<std::string> findVideoDecoders(const std::string& mime, int width, int height, const std::string& preference) {
    std::vector<std::string> names;
    facebook::jni::ThreadScope::WithClassLoader([&] {
      static const auto method =
          javaClassStatic()
              ->getStaticMethod<facebook::jni::local_ref<facebook::jni::JString>(facebook::jni::alias_ref<facebook::jni::JString>, jint,
                                                                                 jint, facebook::jni::alias_ref<facebook::jni::JString>)>(
                  "findVideoDecoders");
      auto result = method(javaClassStatic(), facebook::jni::make_jstring(mime), width, height, facebook::jni::make_jstring(preference));
      if (result) {
        std::istringstream lines(result->toStdString());
        std::string line;
        while (std::getline(lines, line)) {
          if (!line.empty()) {
            names.push_back(line);
          }
        }
      }
    });
    return names;
  }
};

}  // namespace margelo::nitro::webcodecs

#pragma once

// The video encoder's configure attempts, with no NDK in them, so that a
// host test (android/src/test/cpp, `yarn test:cpp`) can check them.

#include <climits>
#include <cstdint>
#include <string>
#include <vector>

namespace margelo::nitro::webcodecs {

// The operating rate to ask for: as fast as the encoder goes (INT32_MAX),
// 1000 (some chipsets throw on INT32_MAX: Media3's
// deviceNeedsLowerOperatingRateAvoidingOverflowWorkaround), or none.
constexpr int32_t kOperatingRateMax = INT32_MAX;
constexpr int32_t kOperatingRateLow = 1000;
constexpr int32_t kOperatingRateNone = -1;

// One configure() of the encoder: with or without H.264's profile and level,
// an operating rate (offline only), and the frame rate as asked or capped at
// 30 (KEY_FRAME_RATE only budgets the bitrate; some encoders refuse a high
// one even when they list it).
struct EncoderAttempt {
  bool profile;
  int32_t operatingRate;
  bool capFrameRate;
};

// From the most to the least demanding, each attempt relaxing one setting
// some encoders refuse at configure time (as #641's writer, after Media3 and
// react-native-skia-video). The rate settings are relaxed with the profile
// kept first, then again without it: dropping the profile and level does not
// also cap the frame rate and drop the operating rate. `profile`: whether
// there is a profile (and level) that may be dropped. `realtime`: no
// operating rate is set.
inline std::vector<EncoderAttempt> videoEncoderAttempts(bool profile, bool realtime) {
  std::vector<EncoderAttempt> rates;
  if (realtime) {
    rates = {{true, kOperatingRateNone, false}, {true, kOperatingRateNone, true}};
  } else {
    rates = {{true, kOperatingRateMax, false}, {true, kOperatingRateLow, false}, {true, kOperatingRateNone, true}};
  }
  std::vector<EncoderAttempt> attempts;
  if (profile) {
    attempts = rates;
  }
  for (EncoderAttempt attempt : rates) {
    attempt.profile = false;
    attempts.push_back(attempt);
  }
  return attempts;
}

// For the log and the error message.
inline std::string describeAttempt(const EncoderAttempt& attempt) {
  std::string text = attempt.profile ? "profile and level" : "no profile";
  if (attempt.operatingRate == kOperatingRateMax) {
    text += ", operating rate max";
  } else if (attempt.operatingRate == kOperatingRateNone) {
    text += ", no operating rate";
  } else {
    text += ", operating rate " + std::to_string(attempt.operatingRate);
  }
  if (attempt.capFrameRate) {
    text += ", at most 30 fps";
  }
  return text;
}

// The name of a media_status_t (NdkMediaError.h), or of a status_t that
// MediaCodec passes through (utils/Errors.h, -errno): "" when unknown.
inline const char* mediaStatusName(int32_t status) {
  switch (status) {
    case 1100:
      return "ERROR_INSUFFICIENT_RESOURCE";
    case 1101:
      return "ERROR_RECLAIMED";
    case -10000:
      return "AMEDIA_ERROR_UNKNOWN";
    case -10001:
      return "AMEDIA_ERROR_MALFORMED";
    case -10002:
      return "AMEDIA_ERROR_UNSUPPORTED";
    case -10003:
      return "AMEDIA_ERROR_INVALID_OBJECT";
    case -10004:
      return "AMEDIA_ERROR_INVALID_PARAMETER";
    case -10005:
      return "AMEDIA_ERROR_INVALID_OPERATION";
    case -10006:
      return "AMEDIA_ERROR_END_OF_STREAM";
    case -10007:
      return "AMEDIA_ERROR_IO";
    case -10008:
      return "AMEDIA_ERROR_WOULD_BLOCK";
    case -12:
      return "NO_MEMORY";
    case -19:
      return "NO_INIT";
    case -22:
      return "BAD_VALUE";
    case -32:
      return "DEAD_OBJECT";
    case -38:
      return "INVALID_OPERATION";
    case -110:
      return "TIMED_OUT";
    case INT32_MIN:
      return "UNKNOWN_ERROR";
    default:
      return "";
  }
}

// A status for a message: "-12 NO_MEMORY", or the number alone.
inline std::string describeMediaStatus(int32_t status) {
  std::string name = mediaStatusName(status);
  return name.empty() ? std::to_string(status) : std::to_string(status) + " " + name;
}

}  // namespace margelo::nitro::webcodecs

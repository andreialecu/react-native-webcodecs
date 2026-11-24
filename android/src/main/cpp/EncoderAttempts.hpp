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

}  // namespace margelo::nitro::webcodecs

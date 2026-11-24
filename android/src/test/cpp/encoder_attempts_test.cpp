// Host test of android/src/main/cpp/EncoderAttempts.hpp: `yarn test:cpp`.

#include "EncoderAttempts.hpp"

#include <cstdio>
#include <cstdlib>
#include <string>

using namespace margelo::nitro::webcodecs;

static int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                \
    }                                                            \
  } while (0)

static bool same(const EncoderAttempt& a, bool profile, int32_t operatingRate, bool capFrameRate) {
  return a.profile == profile && a.operatingRate == operatingRate && a.capFrameRate == capFrameRate;
}

// With a profile, the rate settings are relaxed one at a time with the
// profile kept; dropping the profile starts the rates over (it no longer
// also caps the frame rate and drops the operating rate).
static void withProfile() {
  auto attempts = videoEncoderAttempts(true, false);
  CHECK(attempts.size() == 6);
  if (attempts.size() == 6) {
    CHECK(same(attempts[0], true, kOperatingRateMax, false));
    CHECK(same(attempts[1], true, kOperatingRateLow, false));
    CHECK(same(attempts[2], true, kOperatingRateNone, true));
    CHECK(same(attempts[3], false, kOperatingRateMax, false));
    CHECK(same(attempts[4], false, kOperatingRateLow, false));
    CHECK(same(attempts[5], false, kOperatingRateNone, true));
  }
}

// No profile to drop (none asked for, the encoder lists none, or AV1's,
// which is required): the rate steps only.
static void withoutProfile() {
  auto attempts = videoEncoderAttempts(false, false);
  CHECK(attempts.size() == 3);
  if (attempts.size() == 3) {
    CHECK(same(attempts[0], false, kOperatingRateMax, false));
    CHECK(same(attempts[1], false, kOperatingRateLow, false));
    CHECK(same(attempts[2], false, kOperatingRateNone, true));
  }
}

// Realtime sets no operating rate: no two attempts are the same.
static void realtime() {
  auto attempts = videoEncoderAttempts(true, true);
  CHECK(attempts.size() == 4);
  if (attempts.size() == 4) {
    CHECK(same(attempts[0], true, kOperatingRateNone, false));
    CHECK(same(attempts[1], true, kOperatingRateNone, true));
    CHECK(same(attempts[2], false, kOperatingRateNone, false));
    CHECK(same(attempts[3], false, kOperatingRateNone, true));
  }
  CHECK(videoEncoderAttempts(false, true).size() == 2);
}

static void describe() {
  CHECK(describeAttempt(EncoderAttempt{true, kOperatingRateMax, false}) == "profile and level, operating rate max");
  CHECK(describeAttempt(EncoderAttempt{false, kOperatingRateLow, false}) == "no profile, operating rate 1000");
  CHECK(describeAttempt(EncoderAttempt{false, kOperatingRateNone, true}) == "no profile, no operating rate, at most 30 fps");
}

// media_status_t values by name, for the error message.
static void statusNames() {
  CHECK(std::string(mediaStatusName(-10000)) == "AMEDIA_ERROR_UNKNOWN");
  // A status_t MediaCodec passes through: -ENOMEM.
  CHECK(std::string(mediaStatusName(-12)) == "NO_MEMORY");
  CHECK(std::string(mediaStatusName(-10004)) == "AMEDIA_ERROR_INVALID_PARAMETER");
  CHECK(std::string(mediaStatusName(1100)) == "ERROR_INSUFFICIENT_RESOURCE");
  CHECK(std::string(mediaStatusName(1101)) == "ERROR_RECLAIMED");
  CHECK(std::string(mediaStatusName(42)) == "");
  CHECK(describeMediaStatus(-12) == "-12 NO_MEMORY");
  CHECK(describeMediaStatus(7) == "7");
}

int main() {
  withProfile();
  withoutProfile();
  realtime();
  describe();
  statusNames();
  if (failures > 0) {
    std::fprintf(stderr, "%d failed\n", failures);
    return EXIT_FAILURE;
  }
  std::printf("encoder_attempts: ok\n");
  return EXIT_SUCCESS;
}

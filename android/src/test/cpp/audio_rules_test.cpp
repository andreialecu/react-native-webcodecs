// Host test of android/src/main/cpp/AudioRules.hpp: `yarn test:cpp`.

#include "AudioRules.hpp"

#include <cstdio>
#include <cstdlib>

using namespace margelo::nitro::webcodecs;

static int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                \
    }                                                            \
  } while (0)

static void encoderDelay() {
  CHECK(aacEncoderDelay("c2.android.aac.encoder") == 1600);
  CHECK(aacEncoderDelay("OMX.google.aac.encoder") == 1600);
  CHECK(!aacEncoderDelay("c2.sec.aac.encoder").has_value());
  CHECK(!aacEncoderDelay("OMX.qcom.audio.encoder.aac").has_value());
  CHECK(!aacEncoderDelay("").has_value());
}

static void keepFrame() {
  // 1 s at 48 kHz with FDK's delay: frames 0 to 48 carry sound (48 * 1024 =
  // 49152 < 49600), frame 49 only the padding.
  int64_t kept = 0;
  for (int64_t n = 0; n < 60; n++) {
    kept += aacKeepFrame(n, 48000, 1600) ? 1 : 0;
  }
  CHECK(kept == 49);
  CHECK(aacKeepFrame(48, 48000, 1600));
  CHECK(!aacKeepFrame(49, 48000, 1600));
  // Nothing fed: nothing past the delay.
  CHECK(aacKeepFrame(1, 0, 1600));
  CHECK(!aacKeepFrame(2, 0, 1600));
  // An encoder of unknown delay: nothing is trimmed.
  CHECK(aacKeepFrame(49, 48000, std::nullopt));
  CHECK(aacKeepFrame(1000, 48000, std::nullopt));
}

static void decoderFlush() {
  CHECK(decoderFlushAction(0, false) == DecoderFlush::Skip);
  CHECK(decoderFlushAction(0, true) == DecoderFlush::Skip);
  CHECK(decoderFlushAction(1, true) == DecoderFlush::Flush);
  CHECK(decoderFlushAction(376, true) == DecoderFlush::Flush);
  CHECK(decoderFlushAction(1, false) == DecoderFlush::Recreate);
}

int main() {
  encoderDelay();
  keepFrame();
  decoderFlush();
  if (failures > 0) {
    std::fprintf(stderr, "%d check(s) failed\n", failures);
    return EXIT_FAILURE;
  }
  std::printf("audio rules: all checks passed\n");
  return EXIT_SUCCESS;
}

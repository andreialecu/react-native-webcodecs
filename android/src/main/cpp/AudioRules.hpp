#pragma once

// The audio codecs' rules that need no NDK, so that a host test
// (android/src/test/cpp, `yarn test:cpp`) can check them.

#include <cstdint>
#include <optional>
#include <string_view>

namespace margelo::nitro::webcodecs {

// The AAC encoders asked for by name, in order, before any other: FDK, whose
// delay is known (c2.android.aac.encoder from API 29, OMX.google.aac.encoder
// before). Whatever "audio/mp4a-latm" gives comes after them.
inline constexpr const char* kAacEncoderNames[] = {"c2.android.aac.encoder", "OMX.google.aac.encoder"};

// The AAC-LC encoder's delay in sample frames, when known: FDK's,
// 1024 + 576. Unknown for any other encoder.
inline std::optional<int64_t> aacEncoderDelay(std::string_view name) {
  for (std::string_view fdk : kAacEncoderNames) {
    if (name == fdk) {
      return 1600;
    }
  }
  return std::nullopt;
}

// Whether the AAC frame numbered `framesOut` (from 0) carries input, of
// `framesIn` sample frames, given the encoder's delay: frames past the input
// plus the delay hold only the silence flush() pads with. With the delay
// unknown, every frame is kept (at worst a few frames of that silence).
inline bool aacKeepFrame(int64_t framesOut, int64_t framesIn, std::optional<int64_t> delay) {
  return !delay.has_value() || framesOut * 1024 < framesIn + *delay;
}

// What a decoder's flush() does with its codec.
enum class DecoderFlush {
  // Nothing fed since the last flush: nothing to drain. No end of stream is
  // queued (as a first input it can lose the AAC config on API 29's
  // c2.android.aac.decoder) and the codec is left as it is.
  Skip,
  // An end of stream, drained, then AMediaCodec_flush.
  Flush,
  // An end of stream, drained, then a new codec: flushed before its first
  // output format, a codec forgets its config (csd) (b/141097367, API 29's
  // c2.android.aac.decoder; Media3 releases the codec then too). Done for
  // every decoder, so no name or API level is checked.
  Recreate,
};

inline DecoderFlush decoderFlushAction(int64_t fedSinceFlush, bool formatSeen) {
  if (fedSinceFlush == 0) {
    return DecoderFlush::Skip;
  }
  return formatSeen ? DecoderFlush::Flush : DecoderFlush::Recreate;
}

} // namespace margelo::nitro::webcodecs

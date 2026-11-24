package com.margelo.nitro.webcodecs;

import java.util.List;

// The rules Capabilities applies to MediaCodecList's answers, apart from
// MediaCodecInfo (whose classes are stubs on the JVM): unit-tested in
// android/src/test/java (`yarn test:jvm`).
final class EncoderRules {
  private EncoderRules() {}

  /** What an encoder says it takes, as MediaCodecInfo's capabilities say. */
  interface Encoder {
    String name();

    boolean isSizeSupported(int width, int height);

    boolean areSizeAndRateSupported(int width, int height, double frameRate);

    int bitrateLower();

    int bitrateUpper();

    int[] profiles();

    int[] colorFormats();
  }

  /**
   * Whether the encoder takes frames of this size, at this frame rate and
   * bitrate, in this profile and input color format. `frameRate`, `bitrate`
   * and `profile` are ignored when 0 or less.
   */
  static boolean fits(Encoder encoder, int width, int height, double frameRate, int bitrate, int profile, int colorFormat) {
    boolean size = frameRate > 0
        ? encoder.areSizeAndRateSupported(width, height, frameRate)
        : encoder.isSizeSupported(width, height);
    if (!size) {
      return false;
    }
    if (bitrate > 0 && (bitrate < encoder.bitrateLower() || bitrate > encoder.bitrateUpper())) {
      return false;
    }
    if (profile > 0 && !contains(encoder.profiles(), profile)) {
      return false;
    }
    return contains(encoder.colorFormats(), colorFormat);
  }

  /** The first encoder, in the platform's order, that fits; or null. */
  static String choose(
      List<? extends Encoder> encoders, int width, int height, double frameRate, int bitrate, int profile, int colorFormat) {
    for (Encoder encoder : encoders) {
      if (fits(encoder, width, height, frameRate, bitrate, profile, colorFormat)) {
        return encoder.name();
      }
    }
    return null;
  }

  static boolean contains(int[] values, int value) {
    for (int v : values) {
      if (v == value) {
        return true;
      }
    }
    return false;
  }
}

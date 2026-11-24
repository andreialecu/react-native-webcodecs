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

    int bitrateLower();

    int bitrateUpper();

    int[] profiles();

    int[] colorFormats();
  }

  /**
   * Whether the encoder takes frames of this size, in this profile (ignored
   * when 0 or less) and input color format. The frame rate and bitrate are
   * hints, as in Media3: they never refuse an encoder (the bitrate is
   * clamped into its range, see bitrate()).
   */
  static boolean fits(Encoder encoder, int width, int height, int profile, int colorFormat) {
    if (!encoder.isSizeSupported(width, height)) {
      return false;
    }
    if (profile > 0 && !contains(encoder.profiles(), profile)) {
      return false;
    }
    return contains(encoder.colorFormats(), colorFormat);
  }

  /** The first encoder, in the platform's order, that fits; or null. */
  static String choose(List<? extends Encoder> encoders, int width, int height, int profile, int colorFormat) {
    for (Encoder encoder : encoders) {
      if (fits(encoder, width, height, profile, colorFormat)) {
        return encoder.name();
      }
    }
    return null;
  }

  /**
   * The frame rate to configure: a hint, floored to whole frames (some
   * encoders refuse a fractional one); 0 (none: the default) below 1.
   */
  static double frameRate(double frameRate) {
    if (!(frameRate >= 1)) {
      return 0;
    }
    return Math.floor(frameRate);
  }

  /**
   * The bitrate to configure: the one asked for, or when none (0 or less)
   * width * height * fps * 0.1 (fps 30 when none); a hint either way,
   * clamped into the encoder's range [lower, upper].
   */
  static int bitrate(double requested, int width, int height, double frameRate, int lower, int upper) {
    double fps = frameRate(frameRate) > 0 ? frameRate(frameRate) : 30;
    double bitrate = requested > 0 ? requested : (double) width * height * fps * 0.1;
    return (int) Math.max(lower, Math.min(upper, bitrate));
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

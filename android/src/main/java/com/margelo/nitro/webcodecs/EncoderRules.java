package com.margelo.nitro.webcodecs;

import java.util.List;
import java.util.function.IntPredicate;

// The rules Capabilities applies to MediaCodecList's answers, apart from
// MediaCodecInfo (whose classes are stubs on the JVM): unit-tested in
// android/src/test/java (`yarn test:jvm`).
final class EncoderRules {
  private EncoderRules() {}

  /** What an encoder says it takes, as MediaCodecInfo's capabilities say. */
  interface Encoder {
    String name();

    /** False for software-only encoders (c2.android.*, OMX.google.*). */
    boolean hardware();

    boolean isSizeSupported(int width, int height);

    int widthAlignment();

    int heightAlignment();

    int bitrateLower();

    int bitrateUpper();

    int[] profiles();

    int[] colorFormats();
  }

  /**
   * Whether the encoder takes frames of this size (see sizeSupported), in
   * this profile (ignored when 0 or less) and input color format. The frame
   * rate and bitrate are hints, as in Media3: they never refuse an encoder
   * (the bitrate is clamped into its range, see bitrate()).
   */
  static boolean fits(Encoder encoder, int width, int height, int profile, int colorFormat, IntPredicate camcorderHasHeight) {
    if (!sizeSupported(encoder, width, height, camcorderHasHeight)) {
      return false;
    }
    if (profile > 0 && !contains(encoder.profiles(), profile)) {
      return false;
    }
    return contains(encoder.colorFormats(), colorFormat);
  }

  /** fits(), with no camcorder profile to vouch for a size. */
  static boolean fits(Encoder encoder, int width, int height, int profile, int colorFormat) {
    return fits(encoder, width, height, profile, colorFormat, h -> false);
  }

  /**
   * The first hardware encoder, in the platform's order, that fits; else
   * the first software one; or null. A hardware encoder the lenient checks
   * let through beats a software one the platform lists first.
   */
  static String choose(
      List<? extends Encoder> encoders, int width, int height, int profile, int colorFormat, IntPredicate camcorderHasHeight) {
    String software = null;
    for (Encoder encoder : encoders) {
      if (fits(encoder, width, height, profile, colorFormat, camcorderHasHeight)) {
        if (encoder.hardware()) {
          return encoder.name();
        }
        if (software == null) {
          software = encoder.name();
        }
      }
    }
    return software;
  }

  /**
   * Whether the encoder takes frames of this size, read leniently, as Media3
   * and ExoPlayer do (the encoder is still given the size asked for):
   * - also aligned up to the encoder's alignment, for even sizes: encoders
   *   listing 16 often take 1080 rows (ExoPlayer #6551), while odd sizes
   *   are refused by encoders aligned to 2;
   * - also swapped: encoders limit the number of macroblocks rather than
   *   the orientation;
   * - 1920x1080 and 3840x2160 also when `camcorderHasHeight` (the device's
   *   CamcorderProfile) has 1080 or 2160: some Samsung, Huawei and Pixel 6
   *   encoders list 1072 and 2144 rows (b/222095724, b/229825948).
   */
  static boolean sizeSupported(Encoder encoder, int width, int height, IntPredicate camcorderHasHeight) {
    return landscapeOrPortraitSupported(encoder, width, height, camcorderHasHeight)
        || landscapeOrPortraitSupported(encoder, height, width, camcorderHasHeight);
  }

  private static boolean landscapeOrPortraitSupported(Encoder encoder, int width, int height, IntPredicate camcorderHasHeight) {
    if (encoder.isSizeSupported(width, height)) {
      return true;
    }
    // Even sizes only: the encoder is given the size asked for, and an odd
    // one is refused by encoders aligned to 2 (the 1080-rows case is even).
    if (width % 2 == 0 && height % 2 == 0) {
      int alignedWidth = alignUp(width, encoder.widthAlignment());
      int alignedHeight = alignUp(height, encoder.heightAlignment());
      if ((alignedWidth != width || alignedHeight != height) && encoder.isSizeSupported(alignedWidth, alignedHeight)) {
        return true;
      }
    }
    if (width == 1920 && height == 1080) {
      return camcorderHasHeight.test(1080);
    }
    if (width == 3840 && height == 2160) {
      return camcorderHasHeight.test(2160);
    }
    return false;
  }

  static int alignUp(int value, int alignment) {
    if (alignment <= 1) {
      return value;
    }
    return (value + alignment - 1) / alignment * alignment;
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

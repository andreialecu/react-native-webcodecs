package com.margelo.nitro.webcodecs;

import java.util.List;
import java.util.function.IntPredicate;
import java.util.function.Predicate;

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

    /** The level of each of profiles(), as MediaCodecInfo pairs them. */
    int[] levels();

    int[] colorFormats();
  }

  /**
   * Whether the encoder takes frames of this size (see sizeSupported), in
   * this profile (ignored when 0 or less) and input color format. The frame
   * rate and bitrate are hints, as in Media3: they never refuse an encoder
   * (the bitrate is clamped into its range, see bitrate()).
   */
  static boolean fits(Encoder encoder, int width, int height, int profile, int colorFormat, IntPredicate camcorderHasHeight) {
    return sizeSupported(encoder, width, height, camcorderHasHeight) && takes(encoder, profile, colorFormat);
  }

  /** fits(), with no camcorder profile to vouch for a size. */
  static boolean fits(Encoder encoder, int width, int height, int profile, int colorFormat) {
    return fits(encoder, width, height, profile, colorFormat, h -> false);
  }

  /** fits(), with the size as asked for: as the encoder says, not leniently. */
  static boolean fitsStrictly(Encoder encoder, int width, int height, int profile, int colorFormat) {
    return encoder.isSizeSupported(width, height) && takes(encoder, profile, colorFormat);
  }

  private static boolean takes(Encoder encoder, int profile, int colorFormat) {
    if (profile > 0 && !contains(encoder.profiles(), profile)) {
      return false;
    }
    return contains(encoder.colorFormats(), colorFormat);
  }

  /**
   * The encoder to make, or null when none fits. The encoder is configured
   * with the size asked for, and configure() falls back on no other one, so
   * as in Media3 the encoders that take that size as they say come first:
   * 1. that take the size strictly, in the profile;
   * 2. that take it strictly, in any profile (when `profileOptional`);
   * 3. that take it as read leniently (see sizeSupported), in the profile;
   * 4. that take it leniently, in any profile (when `profileOptional`).
   * In each, the first hardware encoder in the platform's order, else the
   * first software one.
   */
  static String choose(List<? extends Encoder> encoders, int width, int height, int profile, boolean profileOptional, int colorFormat,
      IntPredicate camcorderHasHeight) {
    boolean dropProfile = profileOptional && profile > 0;
    String name = pick(encoders, e -> fitsStrictly(e, width, height, profile, colorFormat));
    if (name == null && dropProfile) {
      name = pick(encoders, e -> fitsStrictly(e, width, height, 0, colorFormat));
    }
    if (name == null) {
      name = pick(encoders, e -> fits(e, width, height, profile, colorFormat, camcorderHasHeight));
    }
    if (name == null && dropProfile) {
      name = pick(encoders, e -> fits(e, width, height, 0, colorFormat, camcorderHasHeight));
    }
    return name;
  }

  /** choose(), with the profile required. */
  static String choose(
      List<? extends Encoder> encoders, int width, int height, int profile, int colorFormat, IntPredicate camcorderHasHeight) {
    return choose(encoders, width, height, profile, false, colorFormat, camcorderHasHeight);
  }

  // The first hardware encoder that `fit` takes, in the platform's order;
  // else the first software one; or null.
  private static String pick(List<? extends Encoder> encoders, Predicate<Encoder> fit) {
    String software = null;
    for (Encoder encoder : encoders) {
      if (fit.test(encoder)) {
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

  // H.264's levels (Rec. ITU-T H.264 Table A-1): level_idc, the
  // MediaCodecInfo.CodecProfileLevel.AVCLevel* constant, the most
  // macroblocks a second (MaxMBPS) and in a frame (MaxFS). Level 1b is
  // level_idc 9 here (in avc1 codec strings it is 11 with a constraint flag,
  // read as 1.1). The constants grow with the level.
  private static final int[][] AVC_LEVELS = {
    {10, 0x01, 1485, 99},
    {9, 0x02, 1485, 99},
    {11, 0x04, 3000, 396},
    {12, 0x08, 6000, 396},
    {13, 0x10, 11880, 396},
    {20, 0x20, 11880, 396},
    {21, 0x40, 19800, 792},
    {22, 0x80, 20250, 1620},
    {30, 0x100, 40500, 1620},
    {31, 0x200, 108000, 3600},
    {32, 0x400, 216000, 5120},
    {40, 0x800, 245760, 8192},
    {41, 0x1000, 245760, 8192},
    {42, 0x2000, 522240, 8704},
    {50, 0x4000, 589824, 22080},
    {51, 0x8000, 983040, 36864},
    {52, 0x10000, 2073600, 36864},
    {60, 0x20000, 4177920, 139264},
    {61, 0x40000, 8355840, 139264},
    {62, 0x80000, 16711680, 139264},
  };

  /** The AVCLevel* constant of an H.264 level_idc, or 0 when there is none. */
  static int avcLevelOf(int levelIdc) {
    for (int[] level : AVC_LEVELS) {
      if (level[0] == levelIdc) {
        return level[1];
      }
    }
    return 0;
  }

  // The lowest level whose limits take this size at this frame rate (30
  // when none); the highest when none does.
  private static int avcLevelNeeded(int width, int height, double frameRate) {
    double fps = frameRate(frameRate) > 0 ? frameRate(frameRate) : 30;
    long macroblocks = (long) ((width + 15) / 16) * ((height + 15) / 16);
    for (int[] level : AVC_LEVELS) {
      if (level[0] != 9 && macroblocks <= level[3] && macroblocks * fps <= level[2]) {
        return level[1];
      }
    }
    return AVC_LEVELS[AVC_LEVELS.length - 1][1];
  }

  // AVCProfileHigh, AVCProfileMain, AVCProfileBaseline: each decodable by a
  // decoder of the one before (the encoders' Baseline is the constrained
  // one).
  private static final int[] AVC_PROFILES_DOWN = {8, 2, 1};

  /**
   * The H.264 profile to configure the encoder with: `profile` when it
   * lists it, else the next one down it lists (High, Main, Baseline), so
   * that the stream still decodes as the codec string says; 0 (none) when
   * it lists none of them, or none is asked for.
   */
  static int avcProfile(Encoder encoder, int profile) {
    boolean below = false;
    for (int candidate : AVC_PROFILES_DOWN) {
      below = below || candidate == profile;
      if (below && contains(encoder.profiles(), candidate)) {
        return candidate;
      }
    }
    return 0;
  }

  /**
   * The H.264 level (an AVCLevel* constant) to configure along with
   * `profile`, as Media3 and Chromium set both (OMX encoders refuse a
   * profile without a level): the codec string's level (`levelIdc`; when 0
   * or unknown, the encoder's highest for the profile, as Media3), raised to
   * the lowest one that takes the size at the frame rate, and capped at the
   * highest the encoder lists for the profile. 0 when the encoder does not
   * list the profile (or none is asked for): it is then given neither.
   */
  static int avcLevel(Encoder encoder, int profile, int levelIdc, int width, int height, double frameRate) {
    if (profile <= 0) {
      return 0;
    }
    int[] profiles = encoder.profiles();
    int[] levels = encoder.levels();
    int highest = 0;
    for (int i = 0; i < profiles.length && i < levels.length; i++) {
      if (profiles[i] == profile) {
        highest = Math.max(highest, levels[i]);
      }
    }
    if (highest == 0) {
      return 0;
    }
    int asked = avcLevelOf(levelIdc);
    int level = asked > 0 ? Math.max(asked, avcLevelNeeded(width, height, frameRate)) : highest;
    return Math.min(level, highest);
  }
}

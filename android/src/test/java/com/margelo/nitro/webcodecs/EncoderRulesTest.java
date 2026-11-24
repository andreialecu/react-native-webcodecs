package com.margelo.nitro.webcodecs;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.function.IntPredicate;

import org.junit.Test;

// `yarn test:jvm`: EncoderRules, with encoders made up here.
public class EncoderRulesTest {
  static final int SURFACE = 0x7f000789;
  static final int P010 = 0x36;
  static final int AVC_BASELINE = 1;
  static final int AVC_MAIN = 2;
  static final int AVC_HIGH = 8;
  // MediaCodecInfo.CodecProfileLevel.AVCLevel*.
  static final int AVC_LEVEL_3 = 0x100;
  static final int AVC_LEVEL_31 = 0x200;
  static final int AVC_LEVEL_4 = 0x800;
  static final int AVC_LEVEL_41 = 0x1000;
  static final int AVC_LEVEL_42 = 0x2000;
  static final int AVC_LEVEL_5 = 0x4000;
  static final int AVC_LEVEL_51 = 0x8000;
  static final int AVC_LEVEL_52 = 0x10000;

  // An encoder taking sizes up to maxWidth x maxHeight, each a multiple of
  // its alignment, and bitrates in [1, maxBitrate].
  static class Fake implements EncoderRules.Encoder {
    final String name;
    boolean hardware = true;
    int maxWidth = 4096;
    int maxHeight = 4096;
    int widthAlignment = 2;
    int heightAlignment = 2;
    int maxBitrate = 12_000_000;
    int[] profiles = {AVC_BASELINE};
    // The level of each of `profiles`.
    int[] levels = {AVC_LEVEL_41};
    int[] colorFormats = {SURFACE};

    Fake(String name) {
      this.name = name;
    }

    Fake software() {
      hardware = false;
      return this;
    }

    Fake size(int w, int h) {
      maxWidth = w;
      maxHeight = h;
      return this;
    }

    Fake align(int w, int h) {
      widthAlignment = w;
      heightAlignment = h;
      return this;
    }

    @Override
    public String name() {
      return name;
    }

    @Override
    public boolean isSizeSupported(int width, int height) {
      return width > 0 && height > 0 && width <= maxWidth && height <= maxHeight
          && width % widthAlignment == 0 && height % heightAlignment == 0;
    }

    @Override
    public boolean hardware() {
      return hardware;
    }

    @Override
    public int widthAlignment() {
      return widthAlignment;
    }

    @Override
    public int heightAlignment() {
      return heightAlignment;
    }

    @Override
    public int bitrateLower() {
      return 1;
    }

    @Override
    public int bitrateUpper() {
      return maxBitrate;
    }

    @Override
    public int[] profiles() {
      return profiles;
    }

    @Override
    public int[] levels() {
      return levels;
    }

    @Override
    public int[] colorFormats() {
      return colorFormats;
    }

    Fake profileLevels(int[] profiles, int[] levels) {
      this.profiles = profiles;
      this.levels = levels;
      return this;
    }
  }

  @Test
  public void fitsSizeProfileAndColorFormat() {
    Fake encoder = new Fake("c2.android.avc.encoder").size(2048, 2048);
    assertTrue(EncoderRules.fits(encoder, 1280, 720, 0, SURFACE));
    assertTrue(EncoderRules.fits(encoder, 1280, 720, AVC_BASELINE, SURFACE));
    assertFalse(EncoderRules.fits(encoder, 1280, 720, AVC_HIGH, SURFACE));
    assertFalse(EncoderRules.fits(encoder, 1280, 720, 0, P010));
    assertFalse(EncoderRules.fits(encoder, 16384, 16384, 0, SURFACE));
  }

  @Test
  public void choosesTheFirstThatFitsInPlatformOrder() {
    Fake small = new Fake("small").size(640, 480);
    Fake a = new Fake("a");
    Fake b = new Fake("b");
    assertEquals("a", EncoderRules.choose(Arrays.asList(small, a, b), 1280, 720, 0, SURFACE, h -> false));
    assertNull(EncoderRules.choose(Arrays.asList(small), 1280, 720, 0, SURFACE, h -> false));
  }

  // The frame rate and bitrate are hints (as in Media3): an encoder is not
  // refused for them, the bitrate is clamped into its range.
  @Test
  public void frameRateAndBitrateDoNotRefuseAnEncoder() {
    Fake encoder = new Fake("c2.android.avc.encoder").size(2048, 2048);
    // The check knows neither: c2.android.avc.encoder lists at most
    // 12 Mbps, and about 30 fps at 1080x1920, yet takes more once configured.
    assertTrue(EncoderRules.fits(encoder, 1080, 1920, 0, SURFACE));
    assertTrue(EncoderRules.fits(encoder, 1280, 720, 0, SURFACE));
  }

  @Test
  public void frameRateIsFlooredAndIgnoredBelowOne() {
    assertEquals(29, EncoderRules.frameRate(29.97), 0);
    assertEquals(60, EncoderRules.frameRate(60), 0);
    assertEquals(0, EncoderRules.frameRate(0.5), 0);
    assertEquals(0, EncoderRules.frameRate(-1), 0);
    assertEquals(0, EncoderRules.frameRate(Double.NaN), 0);
  }

  @Test
  public void aGivenBitrateIsClampedIntoTheRange() {
    assertEquals(12_000_000, EncoderRules.bitrate(100e6, 1280, 720, 30, 1, 12_000_000));
    assertEquals(5_000_000, EncoderRules.bitrate(5e6, 1280, 720, 30, 1, 12_000_000));
    assertEquals(64_000, EncoderRules.bitrate(1000, 1280, 720, 30, 64_000, 12_000_000));
    assertEquals(Integer.MAX_VALUE, EncoderRules.bitrate(5e12, 1280, 720, 30, 1, Integer.MAX_VALUE));
  }

  // With no bitrate, width * height * fps * 0.1, in the encoder's range:
  // vision-camera's 100 Mbps default failed on an 80 Mbps encoder (#2208).
  @Test
  public void theDefaultBitrateIsClampedIntoTheRange() {
    assertEquals(2_764_800, EncoderRules.bitrate(0, 1280, 720, 30, 1, 80_000_000));
    assertEquals(80_000_000, EncoderRules.bitrate(0, 3840, 2160, 120, 1, 80_000_000));
    assertEquals(12_000_000, EncoderRules.bitrate(0, 1080, 1920, 120, 1, 12_000_000));
    // No frame rate (or below 1): 30.
    assertEquals(2_764_800, EncoderRules.bitrate(0, 1280, 720, 0.5, 1, 80_000_000));
    assertEquals(500_000, EncoderRules.bitrate(0, 64, 64, 30, 500_000, 80_000_000));
  }

  // Encoders listing a 16-pixel alignment often take 1080 rows (ExoPlayer
  // #6551): the size is checked aligned up too (the encoder is still given
  // the size asked for).
  @Test
  public void sizesAreCheckedAlignedUp() {
    Fake encoder = new Fake("hw").size(1920, 1088).align(16, 16);
    assertTrue(EncoderRules.fits(encoder, 1920, 1080, 0, SURFACE));
    assertTrue(EncoderRules.fits(encoder, 1278, 718, 0, SURFACE));
    assertFalse(EncoderRules.fits(encoder, 1930, 1080, 0, SURFACE));
  }

  // Only even sizes are aligned up: the encoder is given the size asked
  // for, and an odd one is refused by encoders aligned to 2 or more.
  @Test
  public void oddSizesAreNotAlignedUp() {
    Fake two = new Fake("c2.android.avc.encoder");
    assertFalse(EncoderRules.fits(two, 1279, 720, 0, SURFACE));
    assertFalse(EncoderRules.fits(two, 641, 481, 0, SURFACE));
    assertFalse(EncoderRules.fits(two, 720, 1279, 0, SURFACE));
    Fake sixteen = new Fake("hw").size(1920, 1088).align(16, 16);
    assertFalse(EncoderRules.fits(sixteen, 1279, 720, 0, SURFACE));
    assertFalse(EncoderRules.fits(sixteen, 1920, 1079, 0, SURFACE));
    assertTrue(EncoderRules.fits(sixteen, 1920, 1080, 0, SURFACE));
  }

  // Encoders limit the number of macroblocks rather than the orientation
  // (as Media3 assumes): a portrait size is retried swapped.
  @Test
  public void portraitSizesAreRetriedSwapped() {
    Fake encoder = new Fake("hw").size(1920, 1088);
    assertTrue(EncoderRules.fits(encoder, 1080, 1920, 0, SURFACE));
    assertTrue(EncoderRules.fits(encoder, 720, 1280, 0, SURFACE));
    assertFalse(EncoderRules.fits(encoder, 1088, 2000, 0, SURFACE));
  }

  // Some Samsung, Huawei and Pixel 6 encoders list 1072 rows for H.264
  // 1920x1080 and 2144 for HEVC 3840x2160 (b/222095724, b/229825948):
  // CamcorderProfile vouches for those two sizes, as in Media3.
  @Test
  public void camcorderProfilesVouchFor1080pAnd2160p() {
    Fake avc = new Fake("hw").size(1920, 1072).align(16, 16);
    Fake hevc = new Fake("hw").size(3840, 2144).align(16, 16);
    IntPredicate both = height -> height == 1080 || height == 2160;
    IntPredicate none = height -> false;
    assertTrue(EncoderRules.fits(avc, 1920, 1080, 0, SURFACE, both));
    assertTrue(EncoderRules.fits(avc, 1080, 1920, 0, SURFACE, both));
    assertTrue(EncoderRules.fits(hevc, 3840, 2160, 0, SURFACE, both));
    assertFalse(EncoderRules.fits(avc, 1920, 1080, 0, SURFACE, none));
    assertFalse(EncoderRules.fits(hevc, 3840, 2160, 0, SURFACE, none));
    assertFalse(EncoderRules.fits(avc, 1280, 1080, 0, SURFACE, both));
    assertFalse(EncoderRules.fits(hevc, 3840, 2160, 0, SURFACE, height -> height == 1080));
  }

  // A hardware encoder that takes the config as it is asked for is chosen
  // over a software one, wherever the platform lists it; software when no
  // hardware one does.
  @Test
  public void prefersHardwareThatFitsOverSoftware() {
    Fake software = new Fake("c2.android.avc.encoder").software().size(2048, 2048);
    Fake hardware = new Fake("c2.qti.avc.encoder").size(1920, 1088).align(16, 16);
    Fake small = new Fake("c2.small.avc.encoder").size(640, 480);
    assertEquals("c2.qti.avc.encoder",
        EncoderRules.choose(Arrays.asList(software, small, hardware), 1920, 1088, 0, SURFACE, h -> false));
    assertEquals("c2.android.avc.encoder",
        EncoderRules.choose(Arrays.asList(small, software, hardware), 2048, 2048, 0, SURFACE, h -> false));
    assertNull(EncoderRules.choose(Arrays.asList(small, software, hardware), 4096, 4096, 0, SURFACE, h -> false));
  }

  // The encoder is configured with the size asked for, and configure() has
  // no other encoder to fall back on: one that takes the size as asked for
  // (software or not) beats a hardware one only the lenient reading lets
  // through (as Media3 orders them).
  @Test
  public void anEncoderThatTakesTheSizeBeatsHardwareReadLeniently() {
    Fake software = new Fake("c2.android.avc.encoder").software().size(2048, 2048);
    Fake hardware = new Fake("c2.qti.avc.encoder").size(1920, 1088).align(16, 16);
    // 1080x1920: the hardware one only swapped and aligned up.
    assertEquals("c2.android.avc.encoder",
        EncoderRules.choose(Arrays.asList(hardware, software), 1080, 1920, 0, SURFACE, h -> false));
    // 1920x1080 by CamcorderProfile only.
    Fake hardware1072 = new Fake("c2.exynos.avc.encoder").size(1920, 1072).align(16, 16);
    assertEquals("c2.android.avc.encoder",
        EncoderRules.choose(Arrays.asList(hardware1072, software), 1920, 1080, 0, SURFACE, h -> h == 1080));
    // No encoder takes it as asked for: the lenient reading, hardware first.
    Fake smallSoftware = new Fake("c2.android.small").software().size(1088, 1088);
    assertEquals("c2.qti.avc.encoder",
        EncoderRules.choose(Arrays.asList(smallSoftware, hardware), 1080, 1920, 0, SURFACE, h -> false));
    assertEquals("c2.exynos.avc.encoder",
        EncoderRules.choose(Arrays.asList(smallSoftware, hardware1072), 1920, 1080, 0, SURFACE, h -> h == 1080));
  }

  // An optional profile (H.264's) is dropped before the size is read
  // leniently: a size the encoder may refuse at configure time is worse than
  // the encoder's default profile.
  @Test
  public void anOptionalProfileIsDroppedBeforeTheLenientReading() {
    Fake software = new Fake("c2.android.avc.encoder").software().size(2048, 2048);
    Fake hardware = new Fake("c2.qti.avc.encoder").size(1920, 1088).align(16, 16);
    hardware.profiles = new int[] {AVC_BASELINE, AVC_HIGH};
    assertEquals("c2.android.avc.encoder",
        EncoderRules.choose(Arrays.asList(hardware, software), 1080, 1920, AVC_HIGH, true, SURFACE, h -> false));
    // A required profile is not dropped.
    assertEquals("c2.qti.avc.encoder",
        EncoderRules.choose(Arrays.asList(hardware, software), 1080, 1920, AVC_HIGH, false, SURFACE, h -> false));
    // Taken as asked for, in the profile: the hardware one.
    assertEquals("c2.qti.avc.encoder",
        EncoderRules.choose(Arrays.asList(software, hardware), 1920, 1088, AVC_HIGH, true, SURFACE, h -> false));
    // No encoder lists the profile: any that takes the size.
    assertEquals("c2.android.avc.encoder",
        EncoderRules.choose(Arrays.asList(software), 1280, 720, AVC_HIGH, true, SURFACE, h -> false));
    assertNull(EncoderRules.choose(Arrays.asList(software), 1280, 720, AVC_HIGH, false, SURFACE, h -> false));
  }

  // H.264's level goes with its profile (OMX encoders refuse a profile
  // alone): the codec string's, raised to what the size and frame rate need,
  // and capped at the highest the encoder lists for the profile.
  @Test
  public void theLevelIsTheCodecStringsWithinTheEncodersRange() {
    Fake encoder = new Fake("c2.android.avc.encoder")
        .profileLevels(new int[] {AVC_BASELINE, AVC_MAIN, AVC_BASELINE}, new int[] {AVC_LEVEL_31, AVC_LEVEL_41, AVC_LEVEL_41});
    // 4.0 at 1280x720, as asked for (not the encoder's 4.1).
    assertEquals(AVC_LEVEL_4, EncoderRules.avcLevel(encoder, AVC_BASELINE, 40, 1280, 720, 30));
    assertEquals(AVC_LEVEL_31, EncoderRules.avcLevel(encoder, AVC_BASELINE, 31, 640, 480, 30));
    // Higher than the encoder lists for the profile: its highest.
    assertEquals(AVC_LEVEL_41, EncoderRules.avcLevel(encoder, AVC_MAIN, 51, 1280, 720, 30));
    // None in the codec string (0): the encoder's highest for the profile, as Media3.
    assertEquals(AVC_LEVEL_41, EncoderRules.avcLevel(encoder, AVC_BASELINE, 0, 1280, 720, 30));
  }

  @Test
  public void theLevelIsRaisedToWhatTheSizeAndFrameRateNeed() {
    Fake encoder = new Fake("hw").profileLevels(new int[] {AVC_HIGH}, new int[] {AVC_LEVEL_52});
    // avc1.42001f (3.1) at 1920x1080: 8160 macroblocks need 4.0.
    assertEquals(AVC_LEVEL_4, EncoderRules.avcLevel(encoder, AVC_HIGH, 31, 1920, 1080, 30));
    assertEquals(AVC_LEVEL_4, EncoderRules.avcLevel(encoder, AVC_HIGH, 31, 1080, 1920, 30));
    // At 60 fps: 489600 macroblocks a second, 4.2.
    assertEquals(AVC_LEVEL_42, EncoderRules.avcLevel(encoder, AVC_HIGH, 31, 1920, 1080, 60));
    // 4K at 30 fps: 5.1. No frame rate: 30.
    assertEquals(AVC_LEVEL_51, EncoderRules.avcLevel(encoder, AVC_HIGH, 40, 3840, 2160, 0));
    // 1280x720 at 30 fps fits in 3.1: a lower level asked for is raised.
    assertEquals(AVC_LEVEL_31, EncoderRules.avcLevel(encoder, AVC_HIGH, 30, 1280, 720, 30));
    // Never past the encoder's highest.
    Fake small = new Fake("small").profileLevels(new int[] {AVC_HIGH}, new int[] {AVC_LEVEL_41});
    assertEquals(AVC_LEVEL_41, EncoderRules.avcLevel(small, AVC_HIGH, 31, 3840, 2160, 30));
  }

  // An encoder that does not list the profile is given the next one down
  // that it lists (High, Main, Baseline: a High decoder decodes Main), so
  // that the level still goes with a profile: the emulator's
  // c2.android.avc.encoder has no High. 0 when it lists none of them.
  @Test
  public void aProfileTheEncoderDoesNotListFallsToTheNextOneDown() {
    Fake encoder = new Fake("c2.android.avc.encoder")
        .profileLevels(new int[] {AVC_BASELINE, AVC_MAIN}, new int[] {AVC_LEVEL_41, AVC_LEVEL_41});
    assertEquals(AVC_HIGH, EncoderRules.avcProfile(new Fake("hw").profileLevels(new int[] {AVC_HIGH}, new int[] {AVC_LEVEL_52}), AVC_HIGH));
    assertEquals(AVC_MAIN, EncoderRules.avcProfile(encoder, AVC_HIGH));
    assertEquals(AVC_MAIN, EncoderRules.avcProfile(encoder, AVC_MAIN));
    assertEquals(AVC_BASELINE, EncoderRules.avcProfile(encoder, AVC_BASELINE));
    Fake baselineOnly = new Fake("baseline").profileLevels(new int[] {AVC_BASELINE}, new int[] {AVC_LEVEL_41});
    assertEquals(AVC_BASELINE, EncoderRules.avcProfile(baselineOnly, AVC_HIGH));
    Fake highOnly = new Fake("high").profileLevels(new int[] {AVC_HIGH}, new int[] {AVC_LEVEL_41});
    assertEquals(0, EncoderRules.avcProfile(highOnly, AVC_BASELINE));
    assertEquals(0, EncoderRules.avcProfile(encoder, 0));
    // avcLevel() reads the levels of the profile it is given.
    assertEquals(0, EncoderRules.avcLevel(encoder, AVC_HIGH, 40, 1280, 720, 30));
    assertEquals(AVC_LEVEL_4, EncoderRules.avcLevel(encoder, EncoderRules.avcProfile(encoder, AVC_HIGH), 40, 1280, 720, 30));
  }

  @Test
  public void levelIdcsMapToMediaCodecLevels() {
    assertEquals(0x01, EncoderRules.avcLevelOf(10));
    assertEquals(0x02, EncoderRules.avcLevelOf(9));
    assertEquals(AVC_LEVEL_3, EncoderRules.avcLevelOf(30));
    assertEquals(AVC_LEVEL_52, EncoderRules.avcLevelOf(52));
    assertEquals(0x80000, EncoderRules.avcLevelOf(62));
    assertEquals(0, EncoderRules.avcLevelOf(0));
    assertEquals(0, EncoderRules.avcLevelOf(33));
  }
}

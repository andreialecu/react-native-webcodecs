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
  static final int AVC_HIGH = 8;

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
    public int[] colorFormats() {
      return colorFormats;
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

  // A hardware encoder that takes the config is chosen over a software one,
  // wherever the platform lists it; software when no hardware one fits.
  @Test
  public void prefersHardwareThatFitsOverSoftware() {
    Fake software = new Fake("c2.android.avc.encoder").software().size(2048, 2048);
    Fake hardware = new Fake("c2.qti.avc.encoder").size(1920, 1088).align(16, 16);
    Fake small = new Fake("c2.small.avc.encoder").size(640, 480);
    // Through the lenient reading: 1080x1920 portrait, 1080 aligned to 1088.
    assertEquals("c2.qti.avc.encoder",
        EncoderRules.choose(Arrays.asList(software, small, hardware), 1080, 1920, 0, SURFACE, h -> false));
    assertEquals("c2.android.avc.encoder",
        EncoderRules.choose(Arrays.asList(small, software, hardware), 2048, 2048, 0, SURFACE, h -> false));
    assertNull(EncoderRules.choose(Arrays.asList(small, software, hardware), 4096, 4096, 0, SURFACE, h -> false));
  }
}

package com.margelo.nitro.webcodecs;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;

import org.junit.Test;

// `yarn test:jvm`: EncoderRules, with encoders made up here.
public class EncoderRulesTest {
  static final int SURFACE = 0x7f000789;
  static final int P010 = 0x36;
  static final int AVC_BASELINE = 1;
  static final int AVC_HIGH = 8;

  // An encoder taking sizes up to maxWidth x maxHeight, each a multiple of
  // its alignment, up to maxFps at any size, and bitrates in [1, maxBitrate].
  static class Fake implements EncoderRules.Encoder {
    final String name;
    boolean hardware = true;
    int maxWidth = 4096;
    int maxHeight = 4096;
    int widthAlignment = 2;
    int heightAlignment = 2;
    double maxFps = 30;
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
    public boolean areSizeAndRateSupported(int width, int height, double frameRate) {
      return isSizeSupported(width, height) && frameRate <= maxFps;
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
    assertTrue(EncoderRules.fits(encoder, 1280, 720, 0, 0, 0, SURFACE));
    assertTrue(EncoderRules.fits(encoder, 1280, 720, 0, 0, AVC_BASELINE, SURFACE));
    assertFalse(EncoderRules.fits(encoder, 1280, 720, 0, 0, AVC_HIGH, SURFACE));
    assertFalse(EncoderRules.fits(encoder, 1280, 720, 0, 0, 0, P010));
    assertFalse(EncoderRules.fits(encoder, 16384, 16384, 0, 0, 0, SURFACE));
  }

  @Test
  public void choosesTheFirstThatFitsInPlatformOrder() {
    Fake small = new Fake("small").size(640, 480);
    Fake a = new Fake("a");
    Fake b = new Fake("b");
    assertEquals("a", EncoderRules.choose(Arrays.asList(small, a, b), 1280, 720, 0, 0, 0, SURFACE));
    assertNull(EncoderRules.choose(Arrays.asList(small), 1280, 720, 0, 0, 0, SURFACE));
  }
}

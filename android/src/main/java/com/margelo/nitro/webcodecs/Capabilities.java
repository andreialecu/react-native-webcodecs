package com.margelo.nitro.webcodecs;

import android.media.CamcorderProfile;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.os.Build;

import androidx.annotation.Keep;
import androidx.annotation.Nullable;

import java.util.ArrayList;
import java.util.List;

// What the device's codecs can do, from MediaCodecList: the NDK has no
// capability queries before API 36. Called from C++ (VideoEncoder.hpp), for
// VideoEncoder.isConfigSupported() and to create the encoder that answered,
// so the two agree.
@Keep
public final class Capabilities {
  private Capabilities() {}

  /**
   * The name of the encoder for `mime` that takes frames of this size
   * (read leniently, as in Media3: see EncoderRules.sizeSupported), in
   * this profile (ignored when 0 or less) and input color format; or null
   * when none does: the first hardware one in the platform's order (the
   * order MediaCodec.createEncoderByType tries), else the first software
   * one. The frame rate and bitrate are hints, as in Media3: they refuse no
   * encoder (see videoBitrate).
   */
  @Keep
  @Nullable
  public static String findVideoEncoder(String mime, int width, int height, int profile, int colorFormat) {
    return EncoderRules.choose(videoEncoders(mime), width, height, profile, colorFormat, Capabilities::camcorderHasHeight);
  }

  // Whether the device records 1080p (1080) or 4K (2160) video, by its
  // CamcorderProfile: Media3's cross-check for encoders that list fewer rows
  // than they take. False on devices with no camera.
  private static boolean camcorderHasHeight(int height) {
    int quality;
    if (height == 1080) {
      quality = CamcorderProfile.QUALITY_1080P;
    } else if (height == 2160) {
      quality = CamcorderProfile.QUALITY_2160P;
    } else {
      return false;
    }
    try {
      return CamcorderProfile.hasProfile(quality);
    } catch (RuntimeException e) {
      return false;
    }
  }

  /**
   * The bitrate to configure the encoder `name` with: `requested`, or when
   * 0 or less width * height * fps * 0.1, clamped into the encoder's range
   * when it lists one. `frameRate` is floored, and ignored below 1.
   */
  @Keep
  public static int videoBitrate(String name, String mime, double requested, int width, int height, double frameRate) {
    int lower = 1;
    int upper = Integer.MAX_VALUE;
    for (EncoderRules.Encoder encoder : videoEncoders(mime)) {
      if (encoder.name().equals(name)) {
        lower = encoder.bitrateLower();
        upper = encoder.bitrateUpper();
        break;
      }
    }
    return EncoderRules.bitrate(requested, width, height, frameRate, lower, upper);
  }

  // The encoders for `mime`, in the platform's order, aliases left out.
  private static List<EncoderRules.Encoder> videoEncoders(String mime) {
    List<EncoderRules.Encoder> encoders = new ArrayList<>();
    MediaCodecInfo[] infos = new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos();
    for (MediaCodecInfo info : infos) {
      if (!info.isEncoder()) {
        continue;
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && info.isAlias()) {
        continue;
      }
      if (!supportsType(info, mime)) {
        continue;
      }
      MediaCodecInfo.CodecCapabilities caps;
      try {
        caps = info.getCapabilitiesForType(mime);
      } catch (IllegalArgumentException e) {
        continue;
      }
      if (caps.getVideoCapabilities() == null) {
        continue;
      }
      encoders.add(new VideoEncoder(info, caps));
    }
    return encoders;
  }

  // MediaCodecInfo's capabilities, as EncoderRules reads them.
  private static final class VideoEncoder implements EncoderRules.Encoder {
    private final MediaCodecInfo info;
    private final MediaCodecInfo.CodecCapabilities caps;
    private final MediaCodecInfo.VideoCapabilities video;

    VideoEncoder(MediaCodecInfo info, MediaCodecInfo.CodecCapabilities caps) {
      this.info = info;
      this.caps = caps;
      this.video = caps.getVideoCapabilities();
    }

    @Override
    public String name() {
      return info.getName();
    }

    @Override
    public boolean isSizeSupported(int width, int height) {
      return video.isSizeSupported(width, height);
    }

    @Override
    public boolean hardware() {
      return !isSoftwareOnly(info);
    }

    @Override
    public int widthAlignment() {
      return video.getWidthAlignment();
    }

    @Override
    public int heightAlignment() {
      return video.getHeightAlignment();
    }

    @Override
    public int bitrateLower() {
      return video.getBitrateRange().getLower();
    }

    @Override
    public int bitrateUpper() {
      return video.getBitrateRange().getUpper();
    }

    @Override
    public int[] profiles() {
      int[] profiles = new int[caps.profileLevels.length];
      for (int i = 0; i < profiles.length; i++) {
        profiles[i] = caps.profileLevels[i].profile;
      }
      return profiles;
    }

    @Override
    public int[] colorFormats() {
      return caps.colorFormats;
    }
  }

  /**
   * The decoders for `mime` that take pictures of this size (either way
   * round), newline-separated, in the platform's order (the order
   * MediaCodec.createDecoderByType tries them in), aliases left out. With
   * `preference` "prefer-software", software decoders only; with
   * "prefer-hardware", all but the software ones; otherwise all.
   */
  @Keep
  public static String findVideoDecoders(String mime, int width, int height, String preference) {
    boolean software = "prefer-software".equals(preference);
    boolean hardware = "prefer-hardware".equals(preference);
    StringBuilder names = new StringBuilder();
    MediaCodecInfo[] infos = new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos();
    for (MediaCodecInfo info : infos) {
      if (info.isEncoder()) {
        continue;
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && info.isAlias()) {
        continue;
      }
      if (!supportsType(info, mime)) {
        continue;
      }
      boolean isSoftware = isSoftwareOnly(info);
      if ((software && !isSoftware) || (hardware && isSoftware)) {
        continue;
      }
      MediaCodecInfo.VideoCapabilities video;
      try {
        video = info.getCapabilitiesForType(mime).getVideoCapabilities();
      } catch (IllegalArgumentException e) {
        continue;
      }
      if (video != null && width > 0 && height > 0
          && !video.isSizeSupported(width, height) && !video.isSizeSupported(height, width)) {
        continue;
      }
      if (names.length() > 0) {
        names.append('\n');
      }
      names.append(info.getName());
    }
    return names.toString();
  }

  private static boolean isSoftwareOnly(MediaCodecInfo info) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      return info.isSoftwareOnly();
    }
    String name = info.getName();
    return name.startsWith("c2.android.") || name.startsWith("OMX.google.");
  }

  private static boolean supportsType(MediaCodecInfo info, String mime) {
    for (String type : info.getSupportedTypes()) {
      if (type.equalsIgnoreCase(mime)) {
        return true;
      }
    }
    return false;
  }
}

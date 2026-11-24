package com.margelo.nitro.webcodecs;

import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.os.Build;
import android.util.Range;

import androidx.annotation.Keep;
import androidx.annotation.Nullable;

// What the device's encoders can do, from MediaCodecList: the NDK has no
// capability queries before API 36. Called from C++ (VideoEncoder.hpp), for
// VideoEncoder.isConfigSupported() and to create the encoder that answered,
// so the two agree.
@Keep
public final class Capabilities {
  private Capabilities() {}

  /**
   * The name of the first encoder for `mime` (in the platform's order, as
   * MediaCodec.createEncoderByType picks) that takes frames of this size, at
   * this frame rate and bitrate, in this profile and input color format; or
   * null when none does. `frameRate`, `bitrate` and `profile` are ignored
   * when 0 or less.
   */
  @Keep
  @Nullable
  public static String findVideoEncoder(
      String mime, int width, int height, double frameRate, int bitrate, int profile, int colorFormat) {
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
      if (fits(caps, width, height, frameRate, bitrate, profile, colorFormat)) {
        return info.getName();
      }
    }
    return null;
  }

  private static boolean supportsType(MediaCodecInfo info, String mime) {
    for (String type : info.getSupportedTypes()) {
      if (type.equalsIgnoreCase(mime)) {
        return true;
      }
    }
    return false;
  }

  private static boolean fits(
      MediaCodecInfo.CodecCapabilities caps,
      int width,
      int height,
      double frameRate,
      int bitrate,
      int profile,
      int colorFormat) {
    MediaCodecInfo.VideoCapabilities video = caps.getVideoCapabilities();
    if (video == null) {
      return false;
    }
    boolean size = frameRate > 0
        ? video.areSizeAndRateSupported(width, height, frameRate)
        : video.isSizeSupported(width, height);
    if (!size) {
      return false;
    }
    if (bitrate > 0) {
      Range<Integer> range = video.getBitrateRange();
      if (!range.contains(bitrate)) {
        return false;
      }
    }
    if (profile > 0) {
      boolean found = false;
      for (MediaCodecInfo.CodecProfileLevel level : caps.profileLevels) {
        if (level.profile == profile) {
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    for (int format : caps.colorFormats) {
      if (format == colorFormat) {
        return true;
      }
    }
    return false;
  }
}

import { Platform } from "react-native";
import { VideoEncoder } from "react-native-webcodecs";

import type { Codec } from "./settings";
import { CODEC_STRINGS } from "./settings";

// The codecs this device can encode at this size, asked the WebCodecs way
// (VideoEncoder.isConfigSupported), in order of preference for sending.
export const supportedCodecs = async (width: number, height: number) => {
  const candidates: Codec[] =
    Platform.OS === "web"
      ? ["avc", "vp9", "av1", "hevc"]
      : ["avc", "hevc", "av1"];
  const supported: Codec[] = [];
  for (const codec of candidates) {
    try {
      const { supported: ok } = await VideoEncoder.isConfigSupported({
        codec: CODEC_STRINGS[codec],
        width,
        height,
      });
      if (ok) {
        supported.push(codec);
      }
    } catch {
      // Not this one.
    }
  }
  return supported;
};

// WebCodecs for React Native on the platform's codecs (VideoToolbox and
// AudioToolbox on iOS, MediaCodec on Android), written to sit under
// Mediabunny and next to react-native-webgpu. The two only share native
// handles: a VideoFrame wraps any `{ handle: bigint }` surface, and exposes
// `pixelBuffer` for react-native-webgpu's createNativeBufferFromPointer().

import { AudioData, AudioDecoder, AudioEncoder } from "./lib/audio";
import { DOMExceptionPolyfill } from "./lib/native";
import { installStreams } from "./lib/streams";
import {
  EncodedAudioChunk,
  EncodedVideoChunk,
  VideoColorSpace,
  VideoDecoder,
  VideoEncoder,
  VideoFrame,
} from "./lib/video";

export * from "./lib/audio";
export * from "./lib/background";
export * from "./lib/files";
export type { NativeBufferColorSpace } from "./lib/colorSpace";
export type { WebCodecsError } from "./lib/native";
export * from "./lib/video";

const classes = {
  VideoFrame,
  VideoColorSpace,
  EncodedVideoChunk,
  EncodedAudioChunk,
  VideoEncoder,
  VideoDecoder,
  AudioData,
  AudioEncoder,
  AudioDecoder,
};

/**
 * Installs the WebCodecs classes, and a WritableStream for Mediabunny's
 * StreamTarget, on globalThis where they are missing, so libraries written
 * for the web (Mediabunny) find them. Returns false when another WebCodecs
 * implementation was already installed (and kept).
 */
export const installWebCodecs = () => {
  const g = globalThis as Record<string, unknown>;
  g.DOMException ??= DOMExceptionPolyfill;
  // Mediabunny's StreamTarget needs a WritableStream, which Hermes lacks.
  installStreams();
  let ours = true;
  for (const [name, value] of Object.entries(classes)) {
    g[name] ??= value;
    ours = ours && g[name] === value;
  }
  return ours;
};

import type { HybridObject, UInt64 } from "react-native-nitro-modules";

type Native = { ios: "swift"; android: "c++" };

// A retained native surface: an IOSurface (and the CVPixelBuffer around it,
// when there is one) on Apple platforms, an AHardwareBuffer on Android.
// Wrapping takes its own reference, so the surface outlives the buffer it
// came from (a react-native-webgpu NativeBuffer, a camera frame) until
// release().
export interface NativeSurface extends HybridObject<Native> {
  // IOSurfaceRef / AHardwareBuffer*
  readonly handle: UInt64;
  // CVPixelBufferRef on Apple platforms, what react-native-webgpu's
  // createNativeBufferFromPointer() takes; AHardwareBuffer* on Android.
  readonly pixelBuffer: UInt64;
  readonly width: number;
  readonly height: number;
  // The WebCodecs VideoPixelFormat of the surface: "BGRA", "NV12", …
  readonly format: string;
  // A GPU fence the writer of the surface signals once it is written: an
  // id<MTLSharedEvent> and the value to wait for on Apple platforms, a sync
  // fd (taken over, value ignored) on Android. Consumers wait natively.
  setFence(handle: UInt64, value: UInt64): void;
  // Another reference on the same surface, pixel buffer and fence, released
  // on its own.
  clone(): NativeSurface;
  release(): void;
}

// Surfaces recycled once every holder (JS, the GPU, the encoder) let go.
export interface NativeSurfacePool extends HybridObject<Native> {
  readonly width: number;
  readonly height: number;
  acquire(): NativeSurface;
}

export interface NativeFile extends HybridObject<Native> {
  readonly path: string;
  readonly size: number;
  write(position: number, data: ArrayBuffer): Promise<void>;
  read(start: number, end: number): Promise<ArrayBuffer>;
  close(): Promise<void>;
}

export interface NativeEncodedChunk {
  // Length-prefixed (AVCC / HVCC) access unit, or a raw AAC frame. Empty when
  // the encoder dropped the frame.
  data: ArrayBuffer;
  timestamp: number;
  duration: number;
  key: boolean;
  // The avcC / hvcC record, or the AudioSpecificConfig, sent with the first
  // chunk and when it changes.
  description?: ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Video

// A WebCodecs VideoColorSpaceInit: "bt709", "bt2020", "hlg", "pq", …
export interface NativeColorSpace {
  primaries?: string;
  transfer?: string;
  matrix?: string;
  fullRange?: boolean;
}

export interface NativeVideoEncoderConfig {
  // "avc", "hevc" or "av1"
  codec: string;
  width: number;
  height: number;
  bitrate?: number;
  framerate?: number;
  realtime: boolean;
  // "baseline" | "main" | "high" (avc1.PPCCLL), "main" | "main10" (hvc1.P.*)
  profile?: string;
  // H.264's level_idc, from avc1.PPCCLL (e.g. 40 for 4.0): the highest the
  // stream may need. Android sets it with the profile; iOS picks the level.
  level?: number;
  // WebCodecs' bitrateMode: "constant", "variable" or "quantizer". Android
  // ignores it.
  bitrateMode?: string;
}

export interface NativeVideoEncoder extends HybridObject<Native> {
  encode(
    surface: NativeSurface,
    timestamp: number,
    duration: number,
    keyFrame: boolean,
  ): void;
  // The color space of the frames to come, from their VideoFrame.colorSpace:
  // tags the stream and says how to read the surfaces (e.g. HLG in BT.2020
  // in RGBA16F surfaces for HDR). Called before the first encode() and when
  // it changes. BT.709 until then.
  setColorSpace(colorSpace: NativeColorSpace): void;
  flush(): Promise<void>;
  close(): void;
  // The most frames the codec holds before it outputs one (lookahead), or -1
  // when it could not be limited.
  readonly maxFrameDelay: number;
  // Whether the platform runs it on a hardware encoder.
  readonly hardwareAccelerated: boolean;
}

export interface NativeVideoDecoderConfig {
  // "avc" or "hevc"
  codec: string;
  // avcC / hvcC
  description?: ArrayBuffer;
  codedWidth?: number;
  codedHeight?: number;
  // "BGRA" (default) or "NV12"
  pixelFormat?: string;
  // WebCodecs' "prefer-software" or "prefer-hardware"; none: the platform's
  // choice. Android picks the decoder by it; iOS ignores it.
  hardwareAcceleration?: string;
}

export interface NativeDecodedFrame {
  surface: NativeSurface;
  timestamp: number;
  duration: number;
}

export interface NativeVideoDecoder extends HybridObject<Native> {
  decode(
    data: ArrayBuffer,
    timestamp: number,
    duration: number,
    key: boolean,
  ): void;
  flush(): Promise<void>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Audio: PCM crosses as interleaved float32.

export interface NativeAudioEncoderConfig {
  // "aac"
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate?: number;
}

export interface NativeAudioEncoder extends HybridObject<Native> {
  encode(pcm: ArrayBuffer, frames: number, timestamp: number): void;
  flush(): Promise<void>;
  close(): void;
}

export interface NativeAudioDecoderConfig {
  // "aac" or "mp3"
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  // AudioSpecificConfig for AAC
  description?: ArrayBuffer;
}

export interface NativeDecodedAudio {
  data: ArrayBuffer;
  frames: number;
  sampleRate: number;
  numberOfChannels: number;
  timestamp: number;
}

export interface NativeAudioDecoder extends HybridObject<Native> {
  decode(data: ArrayBuffer, timestamp: number, duration: number): void;
  flush(): Promise<void>;
  close(): void;
}

// ---------------------------------------------------------------------------

export interface WebCodecs extends HybridObject<Native> {
  wrapSurface(handle: UInt64): NativeSurface;
  createSurfacePool(
    width: number,
    height: number,
    format: string,
  ): NativeSurfacePool;

  isVideoEncoderConfigSupported(config: NativeVideoEncoderConfig): boolean;
  createVideoEncoder(
    config: NativeVideoEncoderConfig,
    output: (chunk: NativeEncodedChunk) => void,
    error: (message: string) => void,
  ): NativeVideoEncoder;

  isVideoDecoderConfigSupported(config: NativeVideoDecoderConfig): boolean;
  createVideoDecoder(
    config: NativeVideoDecoderConfig,
    output: (frame: NativeDecodedFrame) => void,
    error: (message: string) => void,
  ): NativeVideoDecoder;

  isAudioEncoderConfigSupported(config: NativeAudioEncoderConfig): boolean;
  createAudioEncoder(
    config: NativeAudioEncoderConfig,
    output: (chunk: NativeEncodedChunk) => void,
    error: (message: string) => void,
  ): NativeAudioEncoder;

  isAudioDecoderConfigSupported(config: NativeAudioDecoderConfig): boolean;
  createAudioDecoder(
    config: NativeAudioDecoderConfig,
    output: (data: NativeDecodedAudio) => void,
    error: (message: string) => void,
  ): NativeAudioDecoder;

  // Files. A relative path goes to the app's cache directory.
  resolvePath(path: string): string;
  openFile(path: string, write: boolean): NativeFile;
  removeFile(path: string): boolean;
  // iOS: keeps the app running for a while once it goes to the background
  // (UIApplication background task); codecs do not fail with `interrupted`
  // while one is held. Android: nothing to do (returns 0).
  beginBackgroundTask(name: string): number;
  endBackgroundTask(id: number): void;
  writeFile(path: string, data: ArrayBuffer): string;
}

import type {
  NativeDecodedFrame,
  NativeEncodedChunk,
  NativeSurface,
  NativeVideoDecoder,
  NativeVideoEncoder,
  NativeVideoEncoderConfig,
} from "../specs/WebCodecs.nitro";

import { avcCodedSize } from "./avc";
import {
  cloneConfig,
  CodecBase,
  domError,
  native,
  nativeError,
  nextMacrotask,
  rethrow,
  toArrayBuffer,
  toBytes,
  VIDEO_DECODER_CONFIG_MEMBERS,
  VIDEO_ENCODER_CONFIG_MEMBERS,
} from "./native";

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

const BT709 = {
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  fullRange: false,
} as const;

type ColorSpaceInit = {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
};

const sameColorSpace = (a: ColorSpaceInit, b: ColorSpaceInit) =>
  a.primaries === b.primaries &&
  a.transfer === b.transfer &&
  a.matrix === b.matrix &&
  a.fullRange === b.fullRange;

// A stream may say only part of its color space: BT.709 for the rest.
const withDefaults = (init?: ColorSpaceInit): ColorSpaceInit => ({
  primaries: init?.primaries ?? BT709.primaries,
  transfer: init?.transfer ?? BT709.transfer,
  matrix: init?.matrix ?? BT709.matrix,
  fullRange: init?.fullRange ?? BT709.fullRange,
});

export class VideoColorSpace {
  readonly primaries: string | null;
  readonly transfer: string | null;
  readonly matrix: string | null;
  readonly fullRange: boolean | null;
  constructor(init?: ColorSpaceInit) {
    this.primaries = init?.primaries ?? null;
    this.transfer = init?.transfer ?? null;
    this.matrix = init?.matrix ?? null;
    this.fullRange = init?.fullRange ?? null;
  }
  toJSON() {
    return {
      primaries: this.primaries,
      transfer: this.transfer,
      matrix: this.matrix,
      fullRange: this.fullRange,
    };
  }
}

// ---------------------------------------------------------------------------
// Surfaces

/**
 * A native surface the GPU draws into and a VideoFrame wraps. Not in
 * WebCodecs.
 *
 * - `handle`: the IOSurfaceRef (Apple) / AHardwareBuffer* (Android).
 * - `pixelBuffer`: what react-native-webgpu's createNativeBufferFromPointer()
 *   takes: the CVPixelBufferRef on Apple platforms.
 */
export type Surface = NativeSurface;

/**
 * Surfaces recycled once the GPU, the encoder and JS all let go of them, so
 * an export does not allocate a new one per frame:
 *
 * ```ts
 * const pool = createSurfacePool(1080, 1920);
 * const surface = pool.acquire();
 * const buffer = RNWebGPU.createNativeBufferFromPointer(surface.pixelBuffer);
 * // draw into buffer (importSharedTextureMemory, render, submit)
 * const { fences } = memory.endAccess(texture);
 * buffer.release();
 * const frame = new VideoFrame(surface, { timestamp, fence: fences[0] });
 * ```
 */
export const createSurfacePool = (
  width: number,
  height: number,
  // "RGBA16F": half floats, for HDR (iOS).
  format: "BGRA" | "NV12" | "RGBA16F" = "BGRA",
) => {
  try {
    return native().createSurfacePool(width, height, format);
  } catch (e) {
    return rethrow(e);
  }
};

// ---------------------------------------------------------------------------
// VideoFrame

export interface NativeSurfaceSource {
  readonly handle: bigint;
}

// A GPU fence the writer of the surface signals once it is written. Either
// the native handle and the value to wait for, or an entry of
// react-native-webgpu's GPUSharedTextureMemory.endAccess().fences.
export type VideoFrameFence =
  | { handle: bigint; value: bigint | number }
  | {
      fence: { export(): { handle: bigint } };
      signaledValue: bigint | number;
    };

export interface VideoFrameInit {
  timestamp?: number;
  duration?: number;
  displayWidth?: number;
  displayHeight?: number;
  // For a native surface: how its samples are encoded (default BT.709).
  colorSpace?: ColorSpaceInit;
  // Not in WebCodecs: the codec waits for it natively before reading.
  fence?: VideoFrameFence;
}

const isSurface = (x: unknown): x is NativeSurface =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as NativeSurface).clone === "function" &&
  typeof (x as NativeSurface).pixelBuffer === "bigint";

const isSurfaceSource = (x: unknown): x is NativeSurfaceSource =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as NativeSurfaceSource).handle === "bigint";

const setFence = (surface: NativeSurface, fence: VideoFrameFence) => {
  if ("fence" in fence) {
    surface.setFence(fence.fence.export().handle, BigInt(fence.signaledValue));
  } else {
    surface.setFence(fence.handle, BigInt(fence.value));
  }
};

export class VideoFrame {
  _surface: NativeSurface | null;
  _timestamp: number;
  _duration: number | null;
  _codedWidth: number;
  _codedHeight: number;
  _displayWidth: number;
  _displayHeight: number;
  _format: string | null;
  readonly colorSpace: VideoColorSpace;

  /**
   * - `new VideoFrame(frame, init?)`: a clone, with new timing if given.
   * - `new VideoFrame(surface, init)`: a surface from createSurfacePool() or
   *   a decoder. The frame takes it over: close the frame, not the surface.
   * - `new VideoFrame({ handle }, init)`: any native surface handle, such as
   *   a react-native-webgpu NativeBuffer. The frame takes its own reference,
   *   so the source can be released right after. On iOS it also keeps the
   *   producer's pool from reusing the surface until the frame is closed:
   *   frames held open can starve a camera's pool. On Android, encode()
   *   returns once such a frame has been read, so its producer may then
   *   write into the buffer again (encode() waits for the frames queued
   *   before it).
   */
  constructor(
    source: VideoFrame | NativeSurface | NativeSurfaceSource,
    init?: VideoFrameInit,
  ) {
    const [surface, timestamp, duration, colorSpace] = VideoFrame._source(
      source,
      init,
    );
    this._timestamp = timestamp;
    this._duration = duration;
    this.colorSpace = colorSpace;
    this._surface = surface;
    this._codedWidth = surface.width;
    this._codedHeight = surface.height;
    this._displayWidth = init?.displayWidth ?? surface.width;
    this._displayHeight = init?.displayHeight ?? surface.height;
    this._format = surface.format === "unknown" ? null : surface.format;
  }

  static _source(
    source: VideoFrame | NativeSurface | NativeSurfaceSource,
    init?: VideoFrameInit,
  ): [NativeSurface, number, number | null, VideoColorSpace] {
    try {
      let result: [NativeSurface, number, number | null, VideoColorSpace];
      if (source instanceof VideoFrame) {
        if (!source._surface) {
          throw domError(
            "InvalidStateError",
            "The source VideoFrame is closed",
          );
        }
        result = [
          source._surface.clone(),
          init?.timestamp ?? source.timestamp,
          init?.duration !== undefined ? init.duration : source.duration,
          source.colorSpace,
        ];
      } else if (isSurface(source) || isSurfaceSource(source)) {
        if (init?.timestamp === undefined) {
          throw new TypeError("init.timestamp is required");
        }
        result = [
          isSurface(source) ? source : native().wrapSurface(source.handle),
          init.timestamp,
          init.duration ?? null,
          new VideoColorSpace(withDefaults(init.colorSpace)),
        ];
      } else {
        throw new TypeError(
          "VideoFrame: only VideoFrame and native surface sources are supported",
        );
      }
      if (init?.fence) {
        setFence(result[0], init.fence);
      }
      return result;
    } catch (e) {
      // Native messages "Name: message" become that DOMException.
      return rethrow(e);
    }
  }

  get format() {
    return this._surface ? this._format : null;
  }
  get codedWidth() {
    return this._surface ? this._codedWidth : 0;
  }
  get codedHeight() {
    return this._surface ? this._codedHeight : 0;
  }
  get codedRect() {
    return this._surface
      ? { x: 0, y: 0, width: this._codedWidth, height: this._codedHeight }
      : null;
  }
  get visibleRect() {
    return this.codedRect;
  }
  get displayWidth() {
    return this._surface ? this._displayWidth : 0;
  }
  get displayHeight() {
    return this._surface ? this._displayHeight : 0;
  }
  get timestamp() {
    return this._timestamp;
  }
  get duration() {
    return this._duration;
  }
  get rotation() {
    return 0;
  }
  get flip() {
    return false;
  }

  /**
   * Not in WebCodecs: the native surface (IOSurfaceRef / AHardwareBuffer*)
   * as a BigInt, null once closed.
   */
  get nativeHandle(): bigint | null {
    return this._surface ? this._surface.handle : null;
  }

  /**
   * Not in WebCodecs: what react-native-webgpu's createNativeBufferFromPointer
   * takes (a CVPixelBufferRef on Apple platforms), to sample the frame with
   * importExternalTexture. 0n when the frame has no pixel buffer (one wrapped
   * from a bare IOSurface).
   */
  get pixelBuffer(): bigint | null {
    return this._surface ? this._surface.pixelBuffer : null;
  }

  /** @internal */
  _nativeSurface(): NativeSurface {
    if (!this._surface) {
      throw domError("InvalidStateError", "VideoFrame is closed");
    }
    return this._surface;
  }

  clone() {
    return new VideoFrame(this);
  }

  close() {
    this._surface?.release();
    this._surface = null;
  }

  allocationSize(): number {
    throw domError(
      "NotSupportedError",
      "VideoFrame.allocationSize is not implemented for native surfaces",
    );
  }

  copyTo(): Promise<never> {
    return Promise.reject(
      domError(
        "NotSupportedError",
        "VideoFrame.copyTo is not implemented for native surfaces",
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// EncodedVideoChunk

export type EncodedChunkType = "key" | "delta";

class EncodedChunk {
  readonly type: EncodedChunkType;
  readonly timestamp: number;
  readonly duration: number | null;
  readonly _data: Uint8Array;

  constructor(init: {
    type: EncodedChunkType;
    timestamp: number;
    duration?: number;
    data: ArrayBuffer | ArrayBufferView;
  }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    this._data = toBytes(init.data).slice();
  }

  get byteLength() {
    return this._data.byteLength;
  }

  copyTo(destination: ArrayBuffer | ArrayBufferView) {
    const dst = toBytes(destination);
    if (dst.byteLength < this._data.byteLength) {
      throw new TypeError("destination is too small");
    }
    dst.set(this._data);
  }
}

export class EncodedVideoChunk extends EncodedChunk {}
export class EncodedAudioChunk extends EncodedChunk {}

// ---------------------------------------------------------------------------
// VideoEncoder

export interface VideoEncoderConfig {
  codec: string;
  width: number;
  height: number;
  bitrate?: number;
  framerate?: number;
  latencyMode?: "quality" | "realtime";
  bitrateMode?: "constant" | "variable" | "quantizer";
  hardwareAcceleration?: string;
  avc?: { format?: "avc" | "annexb" };
  hevc?: { format?: "hevc" | "annexb" };
  [key: string]: unknown;
}

export interface EncodedVideoChunkMetadata {
  decoderConfig?: {
    codec: string;
    description?: ArrayBuffer;
    codedWidth: number;
    codedHeight: number;
    colorSpace?: ReturnType<VideoColorSpace["toJSON"]>;
  };
}

const videoCodec = (c: string) => {
  if (/^avc[13]\./.test(c)) {
    return "avc";
  }
  if (/^av01\./.test(c)) {
    return "av1";
  }
  return /^(hvc1|hev1)\./.test(c) ? "hevc" : null;
};

const avcProfile = (profileIdc: number) => {
  if (profileIdc === 66) {
    return "baseline";
  }
  return profileIdc === 77 ? "main" : "high";
};

const toNativeEncoderConfig = (
  config: VideoEncoderConfig,
): NativeVideoEncoderConfig | null => {
  const codec = videoCodec(config.codec);
  if (!codec) {
    return null;
  }
  // VideoToolbox / MediaCodec emit length-prefixed NAL units here.
  if (config.avc?.format === "annexb" || config.hevc?.format === "annexb") {
    return null;
  }
  let profile: string | undefined;
  let level: number | undefined;
  if (codec === "avc") {
    const profileIdc = parseInt(config.codec.slice(5, 7), 16);
    profile = avcProfile(profileIdc);
    const levelIdc = parseInt(config.codec.slice(9, 11), 16);
    level = levelIdc > 0 ? levelIdc : undefined;
  } else if (codec === "av1") {
    // av01.<profile>.<level><tier>.<bit depth>: Main (profile 0), 8 or 10
    // bits.
    const [, seqProfile, , bitDepth] = config.codec.split(".");
    if (seqProfile !== "0") {
      return null;
    }
    profile = bitDepth === "10" ? "main10" : "main";
  } else {
    // hvc1.[A-C]?<profile_idc>.…: 2 is Main 10.
    const profileIdc = parseInt(
      (config.codec.split(".")[1] ?? "").replace(/^[A-C]/, ""),
      10,
    );
    profile = profileIdc === 2 ? "main10" : "main";
  }
  return {
    codec,
    width: config.width,
    height: config.height,
    bitrate: config.bitrate,
    framerate: config.framerate,
    realtime: config.latencyMode === "realtime",
    profile,
    level,
    bitrateMode: config.bitrateMode,
  };
};

// Frames the codec may hold beyond its own lookahead before encode() stops
// dequeuing: this is what bounds memory, since every frame is a surface.
const MAX_IN_FLIGHT = 4;
const UNKNOWN_LOOKAHEAD = 18;

/** @internal Diagnostics for the e2e tests. */
export const _stats = {
  maxPending: 0,
  maxFrameDelay: -1,
  hardwareAccelerated: false,
};

export class VideoEncoder extends CodecBase {
  _output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void;
  _encoder: NativeVideoEncoder | null = null;
  _config: VideoEncoderConfig | null = null;
  _nativeConfig: NativeVideoEncoderConfig | null = null;
  // The color space the native encoder was given, from the frames.
  _colorSpace: ColorSpaceInit = { ...BT709 };
  // Whether the decoder config of a description-less codec (AV1) went out.
  _sentDecoderConfig = false;

  static async isConfigSupported(config: VideoEncoderConfig) {
    const nativeConfig = toNativeEncoderConfig(config);
    const supported =
      nativeConfig !== null &&
      native().isVideoEncoderConfigSupported(nativeConfig);
    return {
      supported,
      config: cloneConfig(config, VIDEO_ENCODER_CONFIG_MEMBERS),
    };
  }

  constructor(init: {
    output: (
      chunk: EncodedVideoChunk,
      meta?: EncodedVideoChunkMetadata,
    ) => void;
    error: (error: Error) => void;
  }) {
    super(init.error);
    this._output = init.output;
  }

  get encodeQueueSize() {
    return this._queue;
  }

  _limit() {
    const delay = this._encoder?.maxFrameDelay ?? -1;
    // Without a known lookahead, allow what VideoToolbox's software encoder
    // was seen holding before its first output (17 frames): fewer would
    // deadlock, since it waits for more input before any output.
    return (delay < 0 ? UNKNOWN_LOOKAHEAD : delay) + MAX_IN_FLIGHT;
  }

  configure(config: VideoEncoderConfig) {
    if (this._state === "closed") {
      throw domError("InvalidStateError", "VideoEncoder is closed");
    }
    const nativeConfig = toNativeEncoderConfig(config);
    if (!nativeConfig) {
      this._fail(
        domError("NotSupportedError", `Unsupported config ${config.codec}`),
      );
      return;
    }
    // The frames the old encoder holds go with it.
    this._replaceNative();
    this._config = config;
    this._nativeConfig = nativeConfig;
    this._colorSpace = { ...BT709 };
    this._sentDecoderConfig = false;
    try {
      this._encoder = native().createVideoEncoder(
        nativeConfig,
        this._bind((chunk: NativeEncodedChunk) => this._onChunk(chunk)),
        this._bind((message: string) => this._fail(nativeError(message))),
      );
    } catch (e) {
      this._fail(nativeError((e as Error).message));
      return;
    }
    _stats.maxFrameDelay = this._encoder.maxFrameDelay;
    _stats.hardwareAccelerated = this._encoder.hardwareAccelerated;
    this._state = "configured";
  }

  encode(frame: VideoFrame, options?: { keyFrame?: boolean }) {
    this._assertConfigured();
    if (!(frame instanceof VideoFrame)) {
      throw new TypeError("frame must be a VideoFrame");
    }
    if (!frame._surface) {
      throw new TypeError("the VideoFrame is closed");
    }
    // The encoder takes its own reference (and the frame's fence), so the
    // caller may close the frame right away, as on the web.
    try {
      const colorSpace = withDefaults(frame.colorSpace.toJSON());
      if (!sameColorSpace(colorSpace, this._colorSpace)) {
        this._encoder!.setColorSpace({
          primaries: colorSpace.primaries ?? undefined,
          transfer: colorSpace.transfer ?? undefined,
          matrix: colorSpace.matrix ?? undefined,
          fullRange: colorSpace.fullRange ?? undefined,
        });
        this._colorSpace = colorSpace;
      }
      this._encoder!.encode(
        frame._nativeSurface(),
        frame.timestamp,
        frame.duration ?? 0,
        options?.keyFrame ?? false,
      );
    } catch (e) {
      rethrow(e);
    }
    this._submitted(this._limit());
    _stats.maxPending = Math.max(_stats.maxPending, this._pending);
  }

  flush() {
    return this._flush(async () => {
      const generation = this._generation;
      await this._encoder!.flush();
      await nextMacrotask();
      if (generation !== this._generation) {
        return;
      }
      // Every output the codec had came back before its flush resolved. A
      // frame still counted is one it dropped without saying so (MediaCodec
      // does for a timestamp that does not move forward): forget it, or
      // the queue would stay blocked.
      this._pending = this._queue;
      this._drain(this._limit());
    });
  }

  reset() {
    this._resetCodec();
  }

  close() {
    this._close();
  }

  _releaseNative() {
    const encoder = this._encoder;
    this._encoder = null;
    try {
      encoder?.close();
    } catch {
      // Already closed natively.
    }
  }

  // The color space the stream says, for the decoder config: the frames'
  // own, but limited range whatever they say, since that is what the
  // encoders write (VideoToolbox converts to video range, Android sets
  // color-range 2). A full-range tag there makes muxers write a colr box
  // that disagrees with the stream.
  _streamColorSpace() {
    return new VideoColorSpace({
      ...this._colorSpace,
      fullRange: false,
    }).toJSON();
  }

  _onChunk(chunk: NativeEncodedChunk) {
    if (this._state !== "configured") {
      return;
    }
    this._pending = Math.max(0, this._pending - 1);
    this._drain(this._limit());
    if (chunk.data.byteLength > 0) {
      let meta: EncodedVideoChunkMetadata | undefined;
      // AV1 has no description: the decoder config goes with the first
      // chunk, as WebCodecs has it.
      if (
        !chunk.description &&
        this._nativeConfig!.codec === "av1" &&
        !this._sentDecoderConfig
      ) {
        this._sentDecoderConfig = true;
        meta = {
          decoderConfig: {
            codec: this._config!.codec,
            codedWidth: this._config!.width,
            codedHeight: this._config!.height,
            colorSpace: this._streamColorSpace(),
          },
        };
      }
      if (chunk.description) {
        const d = new Uint8Array(chunk.description);
        const codec =
          this._nativeConfig!.codec === "avc"
            ? `avc1.${hex2(d[1])}${hex2(d[2])}${hex2(d[3])}`
            : this._config!.codec;
        meta = {
          decoderConfig: {
            codec,
            description: chunk.description,
            codedWidth: this._config!.width,
            codedHeight: this._config!.height,
            colorSpace: this._streamColorSpace(),
          },
        };
      }
      const encoded = new EncodedVideoChunk({
        type: chunk.key ? "key" : "delta",
        timestamp: chunk.timestamp,
        duration: chunk.duration || undefined,
        data: chunk.data,
      });
      try {
        this._output(encoded, meta);
      } catch (e) {
        this._fail(e as Error);
      }
    }
    this._dispatch("output");
  }
}

// ---------------------------------------------------------------------------
// VideoDecoder

export interface VideoDecoderConfig {
  codec: string;
  description?: ArrayBuffer | ArrayBufferView;
  // The stream's color space (Mediabunny passes the track's): set on the
  // output frames, where react-native-webgpu reads it. Default BT.709.
  colorSpace?: ColorSpaceInit;
  codedWidth?: number;
  codedHeight?: number;
  // Not in WebCodecs: the layout of the output surfaces. "BGRA" samples as a
  // regular texture; "NV12" is the decoder's own picture (no copy), for
  // importExternalTexture or copyExternalImageToTexture. By default, "BGRA"
  // on iOS and "NV12" on Android.
  outputFormat?: "BGRA" | "NV12";
  // On Android, "prefer-software" decodes on a software decoder and
  // "prefer-hardware" never does; iOS leaves the choice to VideoToolbox.
  hardwareAcceleration?:
    "no-preference" | "prefer-hardware" | "prefer-software";
  [key: string]: unknown;
}

const toNativeDecoderConfig = (config: VideoDecoderConfig) => {
  const codec = videoCodec(config.codec);
  if (!codec || !config.description) {
    return null;
  }
  // Without a size, the SPS's: Android sizes the decoder's input buffers
  // (and its pictures) from it.
  const sized =
    config.codedWidth !== undefined && config.codedHeight !== undefined;
  const size =
    !sized && codec === "avc" ? avcCodedSize(config.description) : undefined;
  return {
    codec,
    description: toArrayBuffer(config.description),
    codedWidth: config.codedWidth ?? size?.width,
    codedHeight: config.codedHeight ?? size?.height,
    pixelFormat: config.outputFormat,
    hardwareAcceleration:
      config.hardwareAcceleration === "prefer-software" ||
      config.hardwareAcceleration === "prefer-hardware"
        ? config.hardwareAcceleration
        : undefined,
  };
};

export class VideoDecoder extends CodecBase {
  _output: (frame: VideoFrame) => void;
  _decoder: NativeVideoDecoder | null = null;
  _colorSpace: VideoDecoderConfig["colorSpace"];
  _key = false;

  static async isConfigSupported(config: VideoDecoderConfig) {
    const nativeConfig = toNativeDecoderConfig(config);
    const supported =
      nativeConfig !== null &&
      native().isVideoDecoderConfigSupported(nativeConfig);
    return {
      supported,
      config: cloneConfig(config, VIDEO_DECODER_CONFIG_MEMBERS),
    };
  }

  constructor(init: {
    output: (frame: VideoFrame) => void;
    error: (error: Error) => void;
  }) {
    super(init.error);
    this._output = init.output;
  }

  get decodeQueueSize() {
    return this._queue;
  }

  configure(config: VideoDecoderConfig) {
    if (this._state === "closed") {
      throw domError("InvalidStateError", "VideoDecoder is closed");
    }
    const nativeConfig = toNativeDecoderConfig(config);
    if (!nativeConfig) {
      this._fail(
        domError(
          "NotSupportedError",
          `Unsupported config ${config.codec} (a description is required)`,
        ),
      );
      return;
    }
    this._replaceNative();
    try {
      this._decoder = native().createVideoDecoder(
        nativeConfig,
        // A frame of a decoder since reset or closed is not output, but
        // goes back to its decoder.
        this._bind(
          (frame: NativeDecodedFrame) => this._onFrame(frame),
          (frame) => frame.surface.release(),
        ),
        this._bind((message: string) => this._fail(nativeError(message))),
      );
    } catch (e) {
      this._fail(nativeError((e as Error).message));
      return;
    }
    this._colorSpace = config.colorSpace;
    this._key = false;
    this._state = "configured";
  }

  decode(chunk: EncodedVideoChunk) {
    this._assertConfigured();
    if (!this._key && chunk.type !== "key") {
      throw domError("DataError", "A key frame is required after configure()");
    }
    this._key = true;
    try {
      this._decoder!.decode(
        toArrayBuffer(chunk._data),
        chunk.timestamp,
        chunk.duration ?? 0,
        chunk.type === "key",
      );
    } catch (e) {
      rethrow(e);
    }
    this._queue++;
    setTimeout(() => this._drain(), 0);
  }

  flush() {
    return this._flush(async () => {
      await this._decoder!.flush();
      await nextMacrotask();
      this._key = false;
    });
  }

  reset() {
    this._resetCodec();
  }

  close() {
    this._close();
  }

  _releaseNative() {
    const decoder = this._decoder;
    this._decoder = null;
    try {
      decoder?.close();
    } catch {
      // Already closed natively.
    }
  }

  _onFrame(frame: NativeDecodedFrame) {
    if (this._state !== "configured") {
      frame.surface.release();
      return;
    }
    // RGB pictures were converted from the stream's YCbCr to full range,
    // whatever range the stream has; NV12 ones keep the stream's tags.
    const rgb =
      frame.surface.format === "BGRA" || frame.surface.format === "RGBA";
    const videoFrame = new VideoFrame(frame.surface, {
      timestamp: frame.timestamp,
      duration: frame.duration || undefined,
      colorSpace: rgb
        ? { ...this._colorSpace, fullRange: true }
        : this._colorSpace,
    });
    try {
      this._output(videoFrame);
    } catch (e) {
      this._fail(e as Error);
    }
  }
}

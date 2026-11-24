import type {
  NativeAudioDecoder,
  NativeAudioEncoder,
  NativeDecodedAudio,
  NativeEncodedChunk,
} from "../specs/WebCodecs.nitro";

import {
  AUDIO_DECODER_CONFIG_MEMBERS,
  AUDIO_ENCODER_CONFIG_MEMBERS,
  cloneConfig,
  CodecBase,
  domError,
  native,
  nativeError,
  rethrow,
  toArrayBuffer,
  toBytes,
} from "./native";
import { EncodedAudioChunk } from "./video";

// ---------------------------------------------------------------------------
// AudioData

export type AudioSampleFormat =
  | "u8"
  | "s16"
  | "s32"
  | "f32"
  | "u8-planar"
  | "s16-planar"
  | "s32-planar"
  | "f32-planar";

const bytesPer = (format: AudioSampleFormat) => {
  if (format.startsWith("u8")) {
    return 1;
  }
  return format.startsWith("s16") ? 2 : 4;
};
const isPlanar = (format: AudioSampleFormat) => format.endsWith("-planar");

type Reader = (view: DataView, offset: number) => number;
type Writer = (view: DataView, offset: number, value: number) => void;

const clamp = (v: number) => Math.min(1, Math.max(-1, v));

const readers: Record<string, Reader> = {
  u8: (v, o) => (v.getUint8(o) - 128) / 128,
  s16: (v, o) => v.getInt16(o, true) / 32768,
  s32: (v, o) => v.getInt32(o, true) / 2147483648,
  f32: (v, o) => v.getFloat32(o, true),
};
const writers: Record<string, Writer> = {
  u8: (v, o, x) => v.setUint8(o, Math.round(clamp(x) * 127 + 128)),
  s16: (v, o, x) => v.setInt16(o, Math.round(clamp(x) * 32767), true),
  s32: (v, o, x) => v.setInt32(o, Math.round(clamp(x) * 2147483647), true),
  f32: (v, o, x) => v.setFloat32(o, x, true),
};

export interface AudioDataInit {
  format: AudioSampleFormat;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: ArrayBuffer | ArrayBufferView;
}

export interface AudioDataCopyToOptions {
  planeIndex: number;
  frameOffset?: number;
  frameCount?: number;
  format?: AudioSampleFormat;
}

export class AudioData {
  _format: AudioSampleFormat | null;
  readonly sampleRate: number;
  _numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly timestamp: number;
  _data: Uint8Array | null;

  constructor(init: AudioDataInit) {
    this._format = init.format;
    this.sampleRate = init.sampleRate;
    this._numberOfFrames = init.numberOfFrames;
    this.numberOfChannels = init.numberOfChannels;
    this.timestamp = init.timestamp;
    const size =
      init.numberOfFrames * init.numberOfChannels * bytesPer(init.format);
    const bytes = toBytes(init.data);
    if (bytes.byteLength < size) {
      throw new TypeError("data is too small for the given frames");
    }
    this._data = bytes.slice(0, size);
  }

  get format() {
    return this._data ? this._format : null;
  }
  get numberOfFrames() {
    return this._data ? this._numberOfFrames : 0;
  }
  get duration() {
    return Math.round((this._numberOfFrames * 1e6) / this.sampleRate);
  }

  _check(options: AudioDataCopyToOptions) {
    if (!this._data || !this._format) {
      throw domError("InvalidStateError", "AudioData is closed");
    }
    const format = options.format ?? this._format;
    const frameOffset = options.frameOffset ?? 0;
    const frameCount = options.frameCount ?? this._numberOfFrames - frameOffset;
    if (frameOffset + frameCount > this._numberOfFrames) {
      throw new RangeError("frameOffset + frameCount is past the end");
    }
    const planes = isPlanar(format) ? this.numberOfChannels : 1;
    if (options.planeIndex < 0 || options.planeIndex >= planes) {
      throw new RangeError("planeIndex is out of range");
    }
    return { format, frameOffset, frameCount };
  }

  allocationSize(options: AudioDataCopyToOptions) {
    const { format, frameCount } = this._check(options);
    const channels = isPlanar(format) ? 1 : this.numberOfChannels;
    return frameCount * channels * bytesPer(format);
  }

  copyTo(
    destination: ArrayBuffer | ArrayBufferView,
    options: AudioDataCopyToOptions,
  ) {
    const { format, frameOffset, frameCount } = this._check(options);
    const dst = toBytes(destination);
    const size = this.allocationSize(options);
    if (dst.byteLength < size) {
      throw new RangeError("destination is too small");
    }
    const src = this._data!;
    const srcFormat = this._format!;
    const srcView = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const dstView = new DataView(dst.buffer, dst.byteOffset, dst.byteLength);
    const read = readers[srcFormat.replace("-planar", "")];
    const write = writers[format.replace("-planar", "")];
    const sb = bytesPer(srcFormat);
    const db = bytesPer(format);
    const ch = this.numberOfChannels;
    const n = this._numberOfFrames;
    const srcOffset = (f: number, c: number) =>
      isPlanar(srcFormat) ? (c * n + f) * sb : (f * ch + c) * sb;
    const channels = isPlanar(format)
      ? [options.planeIndex]
      : [...Array(ch).keys()];
    let o = 0;
    for (let f = frameOffset; f < frameOffset + frameCount; f++) {
      for (const c of channels) {
        write(dstView, o, read(srcView, srcOffset(f, c)));
        o += db;
      }
    }
  }

  clone() {
    if (!this._data || !this._format) {
      throw domError("InvalidStateError", "AudioData is closed");
    }
    return new AudioData({
      format: this._format,
      sampleRate: this.sampleRate,
      numberOfFrames: this._numberOfFrames,
      numberOfChannels: this.numberOfChannels,
      timestamp: this.timestamp,
      data: this._data,
    });
  }

  close() {
    this._data = null;
  }

  // Interleaved float32, what the native codecs take.
  _interleavedFloat32(): ArrayBuffer {
    if (this._format === "f32" && this._data) {
      return toArrayBuffer(this._data);
    }
    const out = new ArrayBuffer(
      this._numberOfFrames * this.numberOfChannels * 4,
    );
    this.copyTo(out, { planeIndex: 0, format: "f32" });
    return out;
  }
}

// ---------------------------------------------------------------------------
// AudioEncoder

export interface AudioEncoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate?: number;
  [key: string]: unknown;
}

export interface EncodedAudioChunkMetadata {
  decoderConfig?: {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
    description?: ArrayBuffer;
  };
}

const audioCodec = (c: string) => {
  if (/^mp4a\.40\.2$|^mp4a\.40$|^aac$/.test(c)) {
    return "aac";
  }
  return /^mp3$|^mp4a\.(6b|6B|69)$/.test(c) ? "mp3" : null;
};

export class AudioEncoder extends CodecBase {
  _output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void;
  _encoder: NativeAudioEncoder | null = null;
  _config: AudioEncoderConfig | null = null;

  static async isConfigSupported(config: AudioEncoderConfig) {
    const supported =
      audioCodec(config.codec) === "aac" &&
      native().isAudioEncoderConfigSupported({
        codec: "aac",
        sampleRate: config.sampleRate,
        numberOfChannels: config.numberOfChannels,
        bitrate: config.bitrate,
      });
    return {
      supported,
      config: cloneConfig(config, AUDIO_ENCODER_CONFIG_MEMBERS),
    };
  }

  constructor(init: {
    output: (
      chunk: EncodedAudioChunk,
      meta?: EncodedAudioChunkMetadata,
    ) => void;
    error: (error: Error) => void;
  }) {
    super(init.error);
    this._output = init.output;
  }

  get encodeQueueSize() {
    return this._queue;
  }

  configure(config: AudioEncoderConfig) {
    if (this._state === "closed") {
      throw domError("InvalidStateError", "AudioEncoder is closed");
    }
    if (audioCodec(config.codec) !== "aac") {
      this._fail(
        domError("NotSupportedError", `Unsupported codec ${config.codec}`),
      );
      return;
    }
    this._encoder?.close();
    this._config = config;
    try {
      this._encoder = native().createAudioEncoder(
        {
          codec: "aac",
          sampleRate: config.sampleRate,
          numberOfChannels: config.numberOfChannels,
          bitrate: config.bitrate,
        },
        (chunk) => this._onChunk(chunk),
        (message) => this._fail(nativeError(message)),
      );
    } catch (e) {
      this._fail(nativeError((e as Error).message));
      return;
    }
    this._state = "configured";
  }

  encode(data: AudioData) {
    this._assertConfigured();
    if (!(data instanceof AudioData)) {
      throw new TypeError("data must be an AudioData");
    }
    if (
      data.sampleRate !== this._config!.sampleRate ||
      data.numberOfChannels !== this._config!.numberOfChannels
    ) {
      throw domError(
        "NotSupportedError",
        "AudioData does not match the config",
      );
    }
    try {
      this._encoder!.encode(
        data._interleavedFloat32(),
        data.numberOfFrames,
        data.timestamp,
      );
    } catch (e) {
      rethrow(e);
    }
    this._queue++;
    setTimeout(() => this._drain(), 0);
  }

  async flush() {
    this._assertConfigured();
    try {
      await this._encoder!.flush();
    } catch (e) {
      rethrow(e);
    }
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
  }

  reset() {
    this._encoder?.close();
    this._encoder = null;
    this._state = "unconfigured";
    this._reset();
  }

  close() {
    this._encoder?.close();
    this._encoder = null;
    this._close();
  }

  _onChunk(chunk: NativeEncodedChunk) {
    if (this._state !== "configured") {
      return;
    }
    const meta: EncodedAudioChunkMetadata | undefined = chunk.description
      ? {
          decoderConfig: {
            codec: "mp4a.40.2",
            sampleRate: this._config!.sampleRate,
            numberOfChannels: this._config!.numberOfChannels,
            description: chunk.description,
          },
        }
      : undefined;
    try {
      this._output(
        new EncodedAudioChunk({
          type: "key",
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          data: chunk.data,
        }),
        meta,
      );
    } catch (e) {
      this._fail(e as Error);
    }
  }
}

// ---------------------------------------------------------------------------
// AudioDecoder

export interface AudioDecoderConfig {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: ArrayBuffer | ArrayBufferView;
  [key: string]: unknown;
}

export class AudioDecoder extends CodecBase {
  _output: (data: AudioData) => void;
  _decoder: NativeAudioDecoder | null = null;

  static async isConfigSupported(config: AudioDecoderConfig) {
    const codec = audioCodec(config.codec);
    const supported =
      codec !== null &&
      native().isAudioDecoderConfigSupported({
        codec,
        sampleRate: config.sampleRate,
        numberOfChannels: config.numberOfChannels,
      });
    return {
      supported,
      config: cloneConfig(config, AUDIO_DECODER_CONFIG_MEMBERS),
    };
  }

  constructor(init: {
    output: (data: AudioData) => void;
    error: (error: Error) => void;
  }) {
    super(init.error);
    this._output = init.output;
  }

  get decodeQueueSize() {
    return this._queue;
  }

  configure(config: AudioDecoderConfig) {
    if (this._state === "closed") {
      throw domError("InvalidStateError", "AudioDecoder is closed");
    }
    const codec = audioCodec(config.codec);
    if (!codec) {
      this._fail(
        domError("NotSupportedError", `Unsupported codec ${config.codec}`),
      );
      return;
    }
    this._decoder?.close();
    try {
      this._decoder = native().createAudioDecoder(
        {
          codec,
          sampleRate: config.sampleRate,
          numberOfChannels: config.numberOfChannels,
          description: config.description
            ? toArrayBuffer(config.description)
            : undefined,
        },
        (data) => this._onData(data),
        (message) => this._fail(nativeError(message)),
      );
    } catch (e) {
      this._fail(nativeError((e as Error).message));
      return;
    }
    this._state = "configured";
  }

  decode(chunk: EncodedAudioChunk) {
    this._assertConfigured();
    try {
      this._decoder!.decode(
        toArrayBuffer(chunk._data),
        chunk.timestamp,
        chunk.duration ?? 0,
      );
    } catch (e) {
      rethrow(e);
    }
    this._queue++;
    setTimeout(() => this._drain(), 0);
  }

  async flush() {
    this._assertConfigured();
    try {
      await this._decoder!.flush();
    } catch (e) {
      rethrow(e);
    }
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
  }

  reset() {
    this._decoder?.close();
    this._decoder = null;
    this._state = "unconfigured";
    this._reset();
  }

  close() {
    this._decoder?.close();
    this._decoder = null;
    this._close();
  }

  _onData(data: NativeDecodedAudio) {
    if (this._state !== "configured") {
      return;
    }
    try {
      this._output(
        new AudioData({
          format: "f32",
          sampleRate: data.sampleRate,
          numberOfFrames: data.frames,
          numberOfChannels: data.numberOfChannels,
          timestamp: data.timestamp,
          data: data.data,
        }),
      );
    } catch (e) {
      this._fail(e as Error);
    }
  }
}

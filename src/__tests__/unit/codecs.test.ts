// The WebCodecs state machine of the TypeScript classes, against a fake
// native module: what happens on reconfigure, reset, close, native errors
// and frames the codec never returns.
import { AudioData, AudioDecoder, AudioEncoder } from "../../lib/audio";
import {
  EncodedVideoChunk,
  VideoDecoder,
  VideoEncoder,
  VideoFrame,
} from "../../lib/video";
import type { NativeEncodedChunk } from "../../specs/WebCodecs.nitro";

type Output<T> = (value: T) => void;

interface FakeCodec<T> {
  output: Output<T>;
  error: (message: string) => void;
  close: jest.Mock;
  flush: jest.Mock;
  encode: jest.Mock;
  decode: jest.Mock;
  setColorSpace: jest.Mock;
  maxFrameDelay: number;
  hardwareAccelerated: boolean;
}

const made: FakeCodec<unknown>[] = [];
let createError: Error | null = null;

const fakeCodec = <T>(output: Output<T>, error: (m: string) => void) => {
  if (createError) {
    throw createError;
  }
  const codec: FakeCodec<T> = {
    output,
    error,
    close: jest.fn(),
    flush: jest.fn(() => Promise.resolve()),
    encode: jest.fn(),
    decode: jest.fn(),
    setColorSpace: jest.fn(),
    maxFrameDelay: 3,
    hardwareAccelerated: false,
  };
  made.push(codec as FakeCodec<unknown>);
  return codec;
};

// Read lazily, when the classes first create a native object.
const mockNative = {
  createVideoEncoder: (
    _c: unknown,
    o: Output<unknown>,
    e: (m: string) => void,
  ) => fakeCodec(o, e),
  createVideoDecoder: (
    _c: unknown,
    o: Output<unknown>,
    e: (m: string) => void,
  ) => fakeCodec(o, e),
  createAudioEncoder: (
    _c: unknown,
    o: Output<unknown>,
    e: (m: string) => void,
  ) => fakeCodec(o, e),
  createAudioDecoder: (
    _c: unknown,
    o: Output<unknown>,
    e: (m: string) => void,
  ) => fakeCodec(o, e),
};

jest.mock("react-native-nitro-modules", () => ({
  NitroModules: { createHybridObject: () => mockNative },
}));

const last = () => made[made.length - 1];

interface FakeSurface {
  handle: bigint;
  pixelBuffer: bigint;
  width: number;
  height: number;
  format: string;
  setFence: jest.Mock;
  clone: jest.Mock;
  release: jest.Mock;
}

const fakeSurface = (): FakeSurface => {
  const surface: FakeSurface = {
    handle: 1n,
    pixelBuffer: 1n,
    width: 16,
    height: 16,
    format: "BGRA",
    setFence: jest.fn(),
    clone: jest.fn(() => fakeSurface()),
    release: jest.fn(),
  };
  return surface;
};

const frame = (timestamp: number) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new VideoFrame(fakeSurface() as any, { timestamp, duration: 33_333 });

const chunk = (timestamp: number): NativeEncodedChunk => ({
  data: new Uint8Array([1, 2, 3]).buffer,
  timestamp,
  duration: 33_333,
  key: true,
});

const CONFIG = { codec: "avc1.640028", width: 16, height: 16 };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Resolves to "timeout" when `promise` has not settled after `ms`. */
const settles = <T>(promise: Promise<T>, ms = 200) =>
  Promise.race([
    promise.then(
      () => "resolved",
      (e: Error) => e.name,
    ),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);

beforeEach(() => {
  made.length = 0;
  createError = null;
});

const newEncoder = () => {
  const output = jest.fn();
  const error = jest.fn();
  const encoder = new VideoEncoder({ output, error });
  return { encoder, output, error };
};

describe("VideoEncoder", () => {
  it("flushes after a reconfigure with frames still in the old encoder", async () => {
    const { encoder } = newEncoder();
    encoder.configure(CONFIG);
    encoder.encode(frame(0));
    encoder.encode(frame(33_333));
    encoder.configure({ ...CONFIG, bitrate: 1_000_000 });
    encoder.encode(frame(66_666));
    last().output(chunk(66_666));
    expect(await settles(encoder.flush())).toBe("resolved");
  });

  it("flushes when the codec returned fewer frames than it took", async () => {
    const { encoder, output } = newEncoder();
    encoder.configure(CONFIG);
    encoder.encode(frame(0));
    encoder.encode(frame(0)); // dropped by the codec: no output for it
    last().output(chunk(0));
    expect(await settles(encoder.flush())).toBe("resolved");
    expect(output).toHaveBeenCalledTimes(1);
    // And the queue is open again.
    encoder.encode(frame(33_333));
    await tick();
    expect(encoder.encodeQueueSize).toBe(0);
  });

  it("drops outputs of the native encoder a reset replaced", () => {
    const { encoder, output } = newEncoder();
    encoder.configure(CONFIG);
    encoder.encode(frame(0));
    const old = last();
    encoder.reset();
    encoder.configure(CONFIG);
    old.output(chunk(0));
    expect(output).not.toHaveBeenCalled();
    last().output(chunk(0));
    expect(output).toHaveBeenCalledTimes(1);
  });

  it("reports a native NotSupportedError thrown by configure() as such", () => {
    const { encoder, error } = newEncoder();
    createError = new Error(
      "WebCodecs.createVideoEncoder(...): NotSupportedError: 8192x8192 is above the codec's highest level",
    );
    encoder.configure(CONFIG);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0].name).toBe("NotSupportedError");
    expect(error.mock.calls[0][0].message).toBe(
      "8192x8192 is above the codec's highest level",
    );
    expect(encoder.state).toBe("closed");
  });

  it("keeps the code of a native error", () => {
    const { encoder, error } = newEncoder();
    encoder.configure(CONFIG);
    last().error("EncodingError: interrupted: the app went to the background");
    expect(error.mock.calls[0][0].name).toBe("EncodingError");
    expect(error.mock.calls[0][0].code).toBe("interrupted");
  });

  it("closes the native encoder on a native error", () => {
    const { encoder } = newEncoder();
    encoder.configure(CONFIG);
    const codec = last();
    codec.error("EncodingError: encoder-failed: VideoToolbox failed (-12902)");
    expect(encoder.state).toBe("closed");
    expect(codec.close).toHaveBeenCalled();
  });

  it("closes the native encoder when the output callback throws", () => {
    const encoder = new VideoEncoder({
      output: () => {
        throw new Error("app bug");
      },
      error: jest.fn(),
    });
    encoder.configure(CONFIG);
    encoder.encode(frame(0));
    const codec = last();
    codec.output(chunk(0));
    expect(encoder.state).toBe("closed");
    expect(codec.close).toHaveBeenCalled();
  });

  it("closes the configured native encoder when a new config is unsupported", () => {
    const { encoder } = newEncoder();
    encoder.configure(CONFIG);
    const codec = last();
    encoder.configure({ ...CONFIG, codec: "vp8" });
    expect(encoder.state).toBe("closed");
    expect(codec.close).toHaveBeenCalled();
  });

  it("rejects a flush with AbortError when reset() and configure() follow at once", async () => {
    const { encoder } = newEncoder();
    encoder.configure(CONFIG);
    encoder.encode(frame(0));
    const flushed = encoder.flush();
    encoder.reset();
    encoder.configure(CONFIG);
    expect(await settles(flushed)).toBe("AbortError");
  });

  it("throws InvalidStateError on reset() once closed", () => {
    const { encoder } = newEncoder();
    encoder.close();
    expect(() => encoder.reset()).toThrow(
      expect.objectContaining({ name: "InvalidStateError" }),
    );
    expect(encoder.state).toBe("closed");
  });

  it("throws TypeError when encoding a closed frame", () => {
    const { encoder } = newEncoder();
    encoder.configure(CONFIG);
    const f = frame(0);
    f.close();
    expect(() => encoder.encode(f)).toThrow(TypeError);
  });
});

describe("VideoDecoder", () => {
  const DECODER_CONFIG = {
    codec: "avc1.640028",
    description: new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1]),
  };
  const key = () =>
    new EncodedVideoChunk({
      type: "key",
      timestamp: 0,
      data: new Uint8Array([0, 0, 0, 1, 0x65]),
    });

  it("releases frames from a decoder a reset replaced, without outputting them", () => {
    const output = jest.fn();
    const decoder = new VideoDecoder({ output, error: jest.fn() });
    decoder.configure(DECODER_CONFIG);
    decoder.decode(key());
    const old = last();
    decoder.reset();
    decoder.configure(DECODER_CONFIG);
    const surface = fakeSurface();
    old.output({ surface, timestamp: 0, duration: 0 });
    expect(output).not.toHaveBeenCalled();
    expect(surface.release).toHaveBeenCalled();
  });

  it("rejects a pending flush with AbortError on reset()", async () => {
    const decoder = new VideoDecoder({ output: jest.fn(), error: jest.fn() });
    decoder.configure(DECODER_CONFIG);
    decoder.decode(key());
    last().flush.mockReturnValue(new Promise(() => undefined));
    const flushed = decoder.flush();
    decoder.reset();
    expect(await settles(flushed)).toBe("AbortError");
  });

  it("rejects a pending flush with AbortError on close()", async () => {
    const decoder = new VideoDecoder({ output: jest.fn(), error: jest.fn() });
    decoder.configure(DECODER_CONFIG);
    decoder.decode(key());
    last().flush.mockReturnValue(new Promise(() => undefined));
    const flushed = decoder.flush();
    decoder.close();
    expect(await settles(flushed)).toBe("AbortError");
  });

  it("closes the native decoder on a native error", () => {
    const decoder = new VideoDecoder({ output: jest.fn(), error: jest.fn() });
    decoder.configure(DECODER_CONFIG);
    const codec = last();
    codec.error("EncodingError: decoder-failed: boom");
    expect(codec.close).toHaveBeenCalled();
  });
});

describe("AudioEncoder", () => {
  const AUDIO = { codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: 1 };
  const audio = () =>
    new AudioData({
      format: "f32",
      sampleRate: 48_000,
      numberOfFrames: 1024,
      numberOfChannels: 1,
      timestamp: 0,
      data: new Float32Array(1024),
    });

  it("drops outputs of the native encoder a reset replaced", () => {
    const output = jest.fn();
    const encoder = new AudioEncoder({ output, error: jest.fn() });
    encoder.configure(AUDIO);
    const old = last();
    encoder.reset();
    encoder.configure(AUDIO);
    old.output(chunk(0));
    expect(output).not.toHaveBeenCalled();
  });

  it("rejects a pending flush with AbortError on reset()", async () => {
    const encoder = new AudioEncoder({ output: jest.fn(), error: jest.fn() });
    encoder.configure(AUDIO);
    encoder.encode(audio());
    last().flush.mockReturnValue(new Promise(() => undefined));
    const flushed = encoder.flush();
    encoder.reset();
    expect(await settles(flushed)).toBe("AbortError");
  });

  it("throws TypeError when encoding a closed AudioData", () => {
    const encoder = new AudioEncoder({ output: jest.fn(), error: jest.fn() });
    encoder.configure(AUDIO);
    const data = audio();
    data.close();
    expect(() => encoder.encode(data)).toThrow(TypeError);
  });

  it("closes the native encoder on a native error", () => {
    const encoder = new AudioEncoder({ output: jest.fn(), error: jest.fn() });
    encoder.configure(AUDIO);
    const codec = last();
    codec.error("EncodingError: audio-failed: boom");
    expect(codec.close).toHaveBeenCalled();
  });

  it("throws InvalidStateError on reset() once closed", () => {
    const encoder = new AudioEncoder({ output: jest.fn(), error: jest.fn() });
    encoder.close();
    expect(() => encoder.reset()).toThrow(
      expect.objectContaining({ name: "InvalidStateError" }),
    );
  });
});

describe("AudioDecoder", () => {
  it("drops data of the native decoder a reset replaced", () => {
    const output = jest.fn();
    const decoder = new AudioDecoder({ output, error: jest.fn() });
    const config = { codec: "mp3", sampleRate: 44_100, numberOfChannels: 2 };
    decoder.configure(config);
    const old = last();
    decoder.reset();
    decoder.configure(config);
    old.output({
      data: new Float32Array(2).buffer,
      frames: 1,
      sampleRate: 44_100,
      numberOfChannels: 2,
      timestamp: 0,
    });
    expect(output).not.toHaveBeenCalled();
  });
});

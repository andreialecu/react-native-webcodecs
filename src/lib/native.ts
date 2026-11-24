import { NitroModules } from "react-native-nitro-modules";

import type { WebCodecs } from "../specs/WebCodecs.nitro";

let codecs: WebCodecs | null = null;
export const native = () => {
  if (!codecs) {
    codecs = NitroModules.createHybridObject<WebCodecs>("WebCodecs");
  }
  return codecs;
};

// Errors carry the WebCodecs DOMException name (NotSupportedError,
// EncodingError, InvalidStateError, …) and a `code` saying what happened:
// "interrupted" (the app went to the background, the codec was reclaimed),
// "encoder-failed", "decoder-failed", "audio-failed", "cancelled", …
export interface WebCodecsError extends Error {
  code?: string;
}

// Hermes has no DOMException, and Mediabunny tests `instanceof
// DOMException` on codec errors: installWebCodecs() installs this one.
export class DOMExceptionPolyfill extends Error {
  constructor(message = "", name = "Error") {
    super(message);
    this.name = name;
  }
}

export const domError = (name: string, message: string, code?: string) => {
  const Ctor =
    ((globalThis as Record<string, unknown>).DOMException as
      (new (message?: string, name?: string) => Error) | undefined) ??
    DOMExceptionPolyfill;
  const e = new Ctor(message, name) as WebCodecsError;
  if (code) {
    // A string, unlike DOMException's legacy numeric code.
    Object.defineProperty(e, "code", { value: code, enumerable: true });
  }
  return e;
};

// Native messages are "Name: code: message" (or "Name: message"). Nitro
// prefixes what a native method throws with the method's name
// ("WebCodecs.createVideoEncoder(...): Name: message"), hence no anchor.
const NATIVE_ERROR = /(\w+Error): (?:([a-z-]+): )?([\s\S]*)$/;

export const nativeError = (message: string) => {
  const m = NATIVE_ERROR.exec(message);
  return m ? domError(m[1], m[3], m[2]) : domError("EncodingError", message);
};

// A native call that throws "Name: message": rethrow as that DOMException.
export const rethrow = (e: unknown): never => {
  const message = e instanceof Error ? e.message : String(e);
  const m = NATIVE_ERROR.exec(message);
  throw m ? domError(m[1], m[3], m[2]) : e;
};

// After a native flush resolved: the outputs it sent come back through the
// JS thread's queue first.
export const nextMacrotask = () =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), 0));

export const toArrayBuffer = (
  data: ArrayBuffer | ArrayBufferView,
): ArrayBuffer => {
  if (!ArrayBuffer.isView(data)) {
    return data;
  }
  if (
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength &&
    data.buffer instanceof ArrayBuffer
  ) {
    return data.buffer;
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
    .buffer as ArrayBuffer;
};

export const toBytes = (data: ArrayBuffer | ArrayBufferView) =>
  ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);

type Listener = (event: { type: string }) => void;

// The control queue of a WebCodecs codec: state, the "dequeue" event,
// flush(), and which native codec's callbacks still count.
export class CodecBase {
  _state: "unconfigured" | "configured" | "closed" = "unconfigured";
  // Submitted calls the codec has not taken yet.
  _queue = 0;
  // Taken by the codec, output (or dropped) not yet seen.
  _pending = 0;
  _listeners = new Map<string, Set<{ fn: Listener; once: boolean }>>();
  ondequeue: Listener | null = null;
  _errorCallback: (error: Error) => void;
  // Bumped whenever the native codec is replaced or let go: callbacks of an
  // older one are ignored (reset() discards pending outputs).
  _generation = 0;
  // flush() calls not settled yet: reset() and close() reject them.
  _flushes = new Set<(error: Error) => void>();

  constructor(error: (error: Error) => void) {
    this._errorCallback = error;
  }

  get state() {
    return this._state;
  }

  addEventListener(type: string, fn: Listener, opts?: { once?: boolean }) {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add({ fn, once: !!opts?.once });
  }

  removeEventListener(type: string, fn: Listener) {
    const set = this._listeners.get(type);
    set?.forEach((l) => l.fn === fn && set.delete(l));
  }

  _dispatch(type: string) {
    const event = { type };
    if (type === "dequeue") {
      this.ondequeue?.(event);
    }
    this._listeners.get(type)?.forEach((l) => {
      if (l.once) {
        this._listeners.get(type)!.delete(l);
      }
      l.fn(event);
    });
  }

  _assertConfigured() {
    if (this._state !== "configured") {
      throw domError("InvalidStateError", `codec is ${this._state}`);
    }
  }

  // Called after each submission: dequeue asynchronously, as the spec does.
  _submitted(limit = Infinity) {
    this._queue++;
    this._pending++;
    setTimeout(() => this._drain(limit), 0);
  }

  _drain(limit = Infinity) {
    while (this._queue > 0 && this._pending - this._queue < limit) {
      this._queue--;
      this._dispatch("dequeue");
    }
  }

  /**
   * Wraps a callback of the native codec created now (after
   * _replaceNative()): once that codec is replaced or let go, its late
   * callbacks go to `stale` instead.
   */
  _bind<T>(fn: (value: T) => void, stale?: (value: T) => void) {
    const generation = this._generation;
    return (value: T) => {
      if (generation === this._generation) {
        fn(value);
      } else {
        stale?.(value);
      }
    };
  }

  /**
   * flush(): runs `flushNative` (the native flush, then whatever waits for
   * its outputs), and rejects with AbortError if reset() or close() comes
   * first, as the specification does.
   */
  _flush(flushNative: () => Promise<void>): Promise<void> {
    try {
      this._assertConfigured();
    } catch (e) {
      return Promise.reject(e);
    }
    const generation = this._generation;
    return new Promise<void>((resolve, reject) => {
      this._flushes.add(reject);
      flushNative().then(
        () => {
          this._flushes.delete(reject);
          resolve();
        },
        (e: unknown) => {
          this._flushes.delete(reject);
          // A configure() since let the codec go, with what it held: there
          // is nothing left to flush. (reset() and close() already
          // rejected this flush with AbortError.)
          if (generation !== this._generation) {
            resolve();
            return;
          }
          try {
            rethrow(e);
          } catch (error) {
            reject(error);
          }
        },
      );
    });
  }

  _outputSeen() {
    this._pending = Math.max(0, this._pending - 1);
    this._dispatch("output");
  }

  /** Lets go of the native codec. Each codec implements it. */
  _releaseNative() {}

  /**
   * Forgets what the native codec held (it was let go, so it will not come
   * back), and wakes whoever waits on the queue: Mediabunny waits for
   * "dequeue" while encodeQueueSize >= 4.
   */
  _discardPending() {
    this._queue = 0;
    this._pending = 0;
    this._dispatch("dequeue");
    this._dispatch("output");
  }

  /** A new config: the old native codec goes, with what it held. */
  _replaceNative() {
    this._releaseNative();
    this._generation++;
    this._discardPending();
  }

  _reset() {
    this._replaceNative();
    const flushes = [...this._flushes];
    this._flushes.clear();
    for (const reject of flushes) {
      reject(
        domError("AbortError", "the codec was reset or closed during flush"),
      );
    }
  }

  _fail(error: Error) {
    if (this._state === "closed") {
      return;
    }
    this._close();
    this._errorCallback(error);
  }

  /** reset() of the specification: back to unconfigured. */
  _resetCodec() {
    if (this._state === "closed") {
      throw domError("InvalidStateError", "the codec is closed");
    }
    this._state = "unconfigured";
    this._reset();
  }

  _close() {
    this._state = "closed";
    this._reset();
  }
}

// isConfigSupported() returns a copy of the config with only the members the
// specification defines for it (and this package's additions), as browsers
// do: members it does not know are left out. Buffers are copied.
export const cloneConfig = <T extends object>(
  config: T,
  members: readonly string[],
): T => {
  const clone: Record<string, unknown> = {};
  for (const key of members) {
    const value = (config as Record<string, unknown>)[key];
    if (value === undefined) {
      continue;
    }
    if (value instanceof ArrayBuffer) {
      clone[key] = value.slice(0);
    } else if (ArrayBuffer.isView(value)) {
      clone[key] = toBytes(value).slice();
    } else if (typeof value === "object" && value !== null) {
      clone[key] = { ...value };
    } else {
      clone[key] = value;
    }
  }
  return clone as T;
};

export const VIDEO_ENCODER_CONFIG_MEMBERS = [
  "codec",
  "width",
  "height",
  "displayWidth",
  "displayHeight",
  "bitrate",
  "framerate",
  "hardwareAcceleration",
  "alpha",
  "scalabilityMode",
  "bitrateMode",
  "latencyMode",
  "contentHint",
  "avc",
  "hevc",
] as const;

export const VIDEO_DECODER_CONFIG_MEMBERS = [
  "codec",
  "description",
  "codedWidth",
  "codedHeight",
  "displayAspectWidth",
  "displayAspectHeight",
  "colorSpace",
  "hardwareAcceleration",
  "optimizeForLatency",
  "rotation",
  "flip",
  // Addition: the pixel format of the decoded frames.
  "outputFormat",
] as const;

export const AUDIO_ENCODER_CONFIG_MEMBERS = [
  "codec",
  "sampleRate",
  "numberOfChannels",
  "bitrate",
  "bitrateMode",
  "opus",
  "flac",
  "aac",
] as const;

export const AUDIO_DECODER_CONFIG_MEMBERS = [
  "codec",
  "sampleRate",
  "numberOfChannels",
  "description",
] as const;

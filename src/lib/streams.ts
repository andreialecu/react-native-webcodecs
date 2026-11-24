// A WritableStream for runtimes without WHATWG streams (Hermes), with only
// what Mediabunny's StreamTarget needs: the stream, its default writer and
// controller. ReadableStream, TransformStream and pipes are not implemented.
//
// It follows the algorithms of the WHATWG Streams Standard
// (https://streams.spec.whatwg.org/#ws-class): a queue measured by the
// strategy's size() against its highWaterMark gives backpressure through the
// writer's desiredSize and ready; the sink's write() calls run one at a time,
// in order; close() runs after the queued writes; abort() and sink errors
// error the stream and reject what is pending.
//
// Written from scratch, with web-streams-polyfill by Mattias Buelens
// (https://github.com/MattiasBuelens/web-streams-polyfill, MIT License) as the
// reference for the behavior.

export interface UnderlyingSink<W> {
  start?: (controller: WritableStreamDefaultController) => unknown;
  write?: (chunk: W, controller: WritableStreamDefaultController) => unknown;
  close?: () => unknown;
  abort?: (reason: unknown) => unknown;
  type?: undefined;
}

export interface QueuingStrategy<W> {
  highWaterMark?: number;
  size?: (chunk: W) => number;
}

interface Deferred<T = undefined> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}

const defer = <T = undefined>(handled = false): Deferred<T> => {
  const d = { settled: false } as Deferred<T>;
  d.promise = new Promise<T>((resolve, reject) => {
    d.resolve = (value) => {
      d.settled = true;
      resolve(value);
    };
    d.reject = (reason) => {
      d.settled = true;
      reject(reason);
    };
  });
  // The writer's ready and closed promises are often never awaited: a
  // rejection of theirs is not an unhandled one.
  if (handled) {
    d.promise.catch(() => undefined);
  }
  return d;
};

const rejected = (reason: unknown, handled = false) => {
  const d = defer(handled);
  d.reject(reason);
  return d;
};

const resolved = () => {
  const d = defer();
  d.resolve(undefined);
  return d;
};

/** Calls a sink method; a throw becomes a rejection. */
const call = (fn: (() => unknown) | undefined): Promise<unknown> => {
  try {
    return Promise.resolve(fn?.());
  } catch (e) {
    return Promise.reject(e);
  }
};

const CLOSE = Symbol("close");

type State = "writable" | "closed" | "erroring" | "errored";

interface AbortRequest {
  deferred: Deferred;
  reason: unknown;
  wasAlreadyErroring: boolean;
}

export class WritableStreamDefaultController {
  /** @internal */ _stream: WritableStream<never>;
  /** @internal */ _queue: { value: unknown; size: number }[] = [];
  /** @internal */ _queueTotalSize = 0;
  /** @internal */ _started = false;
  /** @internal */ _sink: UnderlyingSink<unknown> | undefined;
  /** @internal */ _highWaterMark: number;
  /** @internal */ _size: ((chunk: unknown) => number) | undefined;
  /** @internal */ _abortController: AbortController | undefined;

  /** @internal */
  constructor(
    stream: WritableStream<never>,
    sink: UnderlyingSink<unknown>,
    highWaterMark: number,
    size: ((chunk: unknown) => number) | undefined,
  ) {
    this._stream = stream;
    this._sink = sink;
    this._highWaterMark = highWaterMark;
    this._size = size;
    this._abortController =
      typeof AbortController === "undefined"
        ? undefined
        : new AbortController();
  }

  /** Aborted when the stream is aborted (where AbortController exists). */
  get signal(): AbortSignal | undefined {
    return this._abortController?.signal;
  }

  /** Errors the stream: pending and later writes reject with `e`. */
  error(e?: unknown) {
    if (this._stream._state !== "writable") {
      return;
    }
    controllerError(this, e);
  }
}

export class WritableStream<
  W = unknown,
> implements globalThis.WritableStream<W> {
  /** @internal */ _state: State = "writable";
  /** @internal */ _storedError: unknown = undefined;
  /** @internal */ _writer: WritableStreamDefaultWriter<W> | undefined;
  /** @internal */ _controller: WritableStreamDefaultController;
  /** @internal */ _writeRequests: Deferred[] = [];
  /** @internal */ _inFlightWriteRequest: Deferred | undefined;
  /** @internal */ _closeRequest: Deferred | undefined;
  /** @internal */ _inFlightCloseRequest: Deferred | undefined;
  /** @internal */ _pendingAbortRequest: AbortRequest | undefined;
  /** @internal */ _backpressure = false;

  constructor(
    underlyingSink: UnderlyingSink<W> = {},
    strategy: QueuingStrategy<W> = {},
  ) {
    if (underlyingSink.type !== undefined) {
      throw new RangeError("Invalid type is specified");
    }
    const highWaterMark = strategy.highWaterMark ?? 1;
    if (Number.isNaN(highWaterMark) || highWaterMark < 0) {
      throw new RangeError("Invalid highWaterMark");
    }
    const sink = underlyingSink as UnderlyingSink<unknown>;
    const controller = new WritableStreamDefaultController(
      this as WritableStream<never>,
      sink,
      highWaterMark,
      strategy.size as ((chunk: unknown) => number) | undefined,
    );
    this._controller = controller;
    updateBackpressure(this, getBackpressure(controller));
    // A synchronous throw from start() throws from the constructor.
    const started = sink.start?.(controller);
    Promise.resolve(started).then(
      () => {
        controller._started = true;
        advanceQueueIfNeeded(controller);
      },
      (r) => {
        controller._started = true;
        dealWithRejection(this, r);
      },
    );
  }

  get locked() {
    return this._writer !== undefined;
  }

  abort(reason?: unknown): Promise<void> {
    if (this.locked) {
      return Promise.reject(new TypeError("Cannot abort a locked stream"));
    }
    return streamAbort(this, reason);
  }

  close(): Promise<void> {
    if (this.locked) {
      return Promise.reject(new TypeError("Cannot close a locked stream"));
    }
    if (closeQueuedOrInFlight(this)) {
      return Promise.reject(new TypeError("The stream is already closing"));
    }
    return streamClose(this);
  }

  getWriter(): WritableStreamDefaultWriter<W> {
    return new WritableStreamDefaultWriter(this);
  }
}

export class WritableStreamDefaultWriter<
  W = unknown,
> implements globalThis.WritableStreamDefaultWriter<W> {
  /** @internal */ _stream: WritableStream<W> | undefined;
  /** @internal */ _ready: Deferred;
  /** @internal */ _closed: Deferred;

  constructor(stream: WritableStream<W>) {
    if (!(stream instanceof WritableStream)) {
      throw new TypeError("Expected a WritableStream");
    }
    if (stream.locked) {
      throw new TypeError("The stream is already locked to a writer");
    }
    this._stream = stream;
    stream._writer = this;
    const state = stream._state;
    if (state === "writable") {
      this._ready =
        !closeQueuedOrInFlight(stream) && stream._backpressure
          ? defer(true)
          : resolved();
      this._closed = defer(true);
    } else if (state === "erroring") {
      this._ready = rejected(stream._storedError, true);
      this._closed = defer(true);
    } else if (state === "closed") {
      this._ready = resolved();
      this._closed = resolved();
    } else {
      this._ready = rejected(stream._storedError, true);
      this._closed = rejected(stream._storedError, true);
    }
  }

  get closed(): Promise<undefined> {
    return this._closed.promise;
  }

  get ready(): Promise<undefined> {
    return this._ready.promise;
  }

  /** How much more the queue takes before backpressure: null once errored. */
  get desiredSize(): number | null {
    const stream = this._stream;
    if (stream === undefined) {
      throw new TypeError("The writer has been released");
    }
    if (stream._state === "errored" || stream._state === "erroring") {
      return null;
    }
    if (stream._state === "closed") {
      return 0;
    }
    const controller = stream._controller;
    return controller._highWaterMark - controller._queueTotalSize;
  }

  abort(reason?: unknown): Promise<void> {
    if (this._stream === undefined) {
      return Promise.reject(new TypeError("The writer has been released"));
    }
    return streamAbort(this._stream, reason);
  }

  close(): Promise<void> {
    const stream = this._stream;
    if (stream === undefined) {
      return Promise.reject(new TypeError("The writer has been released"));
    }
    if (closeQueuedOrInFlight(stream)) {
      return Promise.reject(new TypeError("The stream is already closing"));
    }
    return streamClose(stream);
  }

  releaseLock() {
    const stream = this._stream;
    if (stream === undefined) {
      return;
    }
    const released = new TypeError("The writer has been released");
    ensureRejected(this, "_ready", released);
    ensureRejected(this, "_closed", released);
    stream._writer = undefined;
    this._stream = undefined;
  }

  write(chunk: W): Promise<void> {
    const stream = this._stream;
    if (stream === undefined) {
      return Promise.reject(new TypeError("The writer has been released"));
    }
    const controller = stream._controller;
    let size = 1;
    if (controller._size !== undefined) {
      try {
        size = controller._size(chunk);
      } catch (e) {
        errorIfNeeded(controller, e);
      }
    }
    if (stream !== this._stream) {
      return Promise.reject(new TypeError("The writer has been released"));
    }
    const state = stream._state;
    if (state === "errored") {
      return Promise.reject(stream._storedError);
    }
    if (closeQueuedOrInFlight(stream) || state === "closed") {
      return Promise.reject(new TypeError("The stream is closing or closed"));
    }
    if (state === "erroring") {
      return Promise.reject(stream._storedError);
    }
    const request = defer();
    stream._writeRequests.push(request);
    if (!Number.isFinite(size) || size < 0) {
      errorIfNeeded(controller, new RangeError("Invalid chunk size"));
      return request.promise;
    }
    controller._queue.push({ value: chunk, size });
    controller._queueTotalSize += size;
    if (!closeQueuedOrInFlight(stream) && stream._state === "writable") {
      updateBackpressure(stream, getBackpressure(controller));
    }
    advanceQueueIfNeeded(controller);
    return request.promise;
  }
}

// Stream algorithms (https://streams.spec.whatwg.org/#ws-abstract-ops).

type AnyStream = WritableStream<never>;

const closeQueuedOrInFlight = (stream: WritableStream<never>) =>
  stream._closeRequest !== undefined ||
  stream._inFlightCloseRequest !== undefined;

const streamAbort = (stream: AnyStream, reason: unknown): Promise<void> => {
  if (stream._state === "closed" || stream._state === "errored") {
    return Promise.resolve();
  }
  stream._controller._abortController?.abort(reason);
  // The signal's listeners may have changed the state.
  const state = stream._state as State;
  if (state === "closed" || state === "errored") {
    return Promise.resolve();
  }
  if (stream._pendingAbortRequest !== undefined) {
    return stream._pendingAbortRequest.deferred.promise;
  }
  const wasAlreadyErroring = state === "erroring";
  const deferred = defer();
  stream._pendingAbortRequest = {
    deferred,
    reason: wasAlreadyErroring ? undefined : reason,
    wasAlreadyErroring,
  };
  if (!wasAlreadyErroring) {
    startErroring(stream, reason);
  }
  return deferred.promise;
};

const streamClose = (stream: AnyStream): Promise<void> => {
  if (stream._state === "closed" || stream._state === "errored") {
    return Promise.reject(new TypeError("The stream is closed or errored"));
  }
  const request = defer();
  stream._closeRequest = request;
  const writer = stream._writer;
  if (writer && stream._backpressure && stream._state === "writable") {
    writer._ready.resolve(undefined);
  }
  const controller = stream._controller;
  controller._queue.push({ value: CLOSE, size: 0 });
  advanceQueueIfNeeded(controller);
  return request.promise;
};

const dealWithRejection = (stream: AnyStream, error: unknown) => {
  if (stream._state === "writable") {
    startErroring(stream, error);
    return;
  }
  finishErroring(stream);
};

const startErroring = (stream: AnyStream, reason: unknown) => {
  const controller = stream._controller;
  stream._state = "erroring";
  stream._storedError = reason;
  if (stream._writer) {
    ensureRejected(stream._writer, "_ready", reason);
  }
  if (
    stream._inFlightWriteRequest === undefined &&
    stream._inFlightCloseRequest === undefined &&
    controller._started
  ) {
    finishErroring(stream);
  }
};

const finishErroring = (stream: AnyStream) => {
  stream._state = "errored";
  const controller = stream._controller;
  controller._queue = [];
  controller._queueTotalSize = 0;
  const error = stream._storedError;
  for (const request of stream._writeRequests) {
    request.reject(error);
  }
  stream._writeRequests = [];
  const abortRequest = stream._pendingAbortRequest;
  if (abortRequest === undefined) {
    rejectCloseAndClosed(stream);
    return;
  }
  stream._pendingAbortRequest = undefined;
  if (abortRequest.wasAlreadyErroring) {
    abortRequest.deferred.reject(error);
    rejectCloseAndClosed(stream);
    return;
  }
  const sink = controller._sink;
  clearAlgorithms(controller);
  call(sink?.abort && (() => sink.abort!(abortRequest.reason))).then(
    () => {
      abortRequest.deferred.resolve(undefined);
      rejectCloseAndClosed(stream);
    },
    (r) => {
      abortRequest.deferred.reject(r);
      rejectCloseAndClosed(stream);
    },
  );
};

const rejectCloseAndClosed = (stream: AnyStream) => {
  if (stream._closeRequest !== undefined) {
    stream._closeRequest.reject(stream._storedError);
    stream._closeRequest = undefined;
  }
  if (stream._writer) {
    ensureRejected(stream._writer, "_closed", stream._storedError);
  }
};

const updateBackpressure = (stream: AnyStream, backpressure: boolean) => {
  const writer = stream._writer;
  if (writer && backpressure !== stream._backpressure) {
    if (backpressure) {
      writer._ready = defer(true);
    } else {
      writer._ready.resolve(undefined);
    }
  }
  stream._backpressure = backpressure;
};

const ensureRejected = (
  writer: WritableStreamDefaultWriter<never>,
  key: "_ready" | "_closed",
  reason: unknown,
) => {
  if (writer[key].settled) {
    writer[key] = rejected(reason, true);
  } else {
    writer[key].reject(reason);
  }
};

// Controller algorithms (https://streams.spec.whatwg.org/#ws-default-controller-abstract-ops).

const getBackpressure = (controller: WritableStreamDefaultController) =>
  controller._highWaterMark - controller._queueTotalSize <= 0;

const clearAlgorithms = (controller: WritableStreamDefaultController) => {
  controller._sink = undefined;
  controller._size = undefined;
};

const controllerError = (
  controller: WritableStreamDefaultController,
  error: unknown,
) => {
  clearAlgorithms(controller);
  startErroring(controller._stream, error);
};

const errorIfNeeded = (
  controller: WritableStreamDefaultController,
  error: unknown,
) => {
  if (controller._stream._state === "writable") {
    controllerError(controller, error);
  }
};

const advanceQueueIfNeeded = (controller: WritableStreamDefaultController) => {
  const stream = controller._stream;
  if (!controller._started || stream._inFlightWriteRequest !== undefined) {
    return;
  }
  if (stream._state === "erroring") {
    finishErroring(stream);
    return;
  }
  if (controller._queue.length === 0) {
    return;
  }
  const [{ value }] = controller._queue;
  if (value === CLOSE) {
    processClose(controller);
  } else {
    processWrite(controller, value);
  }
};

const dequeue = (controller: WritableStreamDefaultController) => {
  const { size } = controller._queue.shift()!;
  controller._queueTotalSize = Math.max(0, controller._queueTotalSize - size);
};

const processClose = (controller: WritableStreamDefaultController) => {
  const stream = controller._stream;
  stream._inFlightCloseRequest = stream._closeRequest;
  stream._closeRequest = undefined;
  dequeue(controller);
  const sink = controller._sink;
  clearAlgorithms(controller);
  call(sink?.close && (() => sink.close!())).then(
    () => {
      stream._inFlightCloseRequest!.resolve(undefined);
      stream._inFlightCloseRequest = undefined;
      if (stream._state === "erroring") {
        stream._storedError = undefined;
        if (stream._pendingAbortRequest !== undefined) {
          stream._pendingAbortRequest.deferred.resolve(undefined);
          stream._pendingAbortRequest = undefined;
        }
      }
      stream._state = "closed";
      stream._writer?._closed.resolve(undefined);
    },
    (r) => {
      stream._inFlightCloseRequest!.reject(r);
      stream._inFlightCloseRequest = undefined;
      if (stream._pendingAbortRequest !== undefined) {
        stream._pendingAbortRequest.deferred.reject(r);
        stream._pendingAbortRequest = undefined;
      }
      dealWithRejection(stream, r);
    },
  );
};

const processWrite = (
  controller: WritableStreamDefaultController,
  chunk: unknown,
) => {
  const stream = controller._stream;
  stream._inFlightWriteRequest = stream._writeRequests.shift();
  const sink = controller._sink;
  call(sink?.write && (() => sink.write!(chunk, controller))).then(
    () => {
      stream._inFlightWriteRequest!.resolve(undefined);
      stream._inFlightWriteRequest = undefined;
      dequeue(controller);
      if (!closeQueuedOrInFlight(stream) && stream._state === "writable") {
        updateBackpressure(stream, getBackpressure(controller));
      }
      advanceQueueIfNeeded(controller);
    },
    (r) => {
      if (stream._state === "writable") {
        clearAlgorithms(controller);
      }
      stream._inFlightWriteRequest!.reject(r);
      stream._inFlightWriteRequest = undefined;
      dealWithRejection(stream, r);
    },
  );
};

/**
 * Installs our WritableStream on globalThis where there is none, so that
 * Mediabunny's `instanceof WritableStream` checks and its own
 * `new WritableStream()` calls find it. Returns the global class.
 */
export const installStreams = (): typeof globalThis.WritableStream => {
  const g = globalThis as { WritableStream?: unknown };
  g.WritableStream ??= WritableStream;
  return g.WritableStream as typeof globalThis.WritableStream;
};

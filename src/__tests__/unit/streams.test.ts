import { WritableStream, installStreams } from "../../lib/streams";

/** Lets every pending promise callback run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise and the functions that settle it. */
const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Whether a promise has settled, without waiting for it. */
const settled = async (promise: Promise<unknown>) => {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await flush();
  return done;
};

describe("WritableStream", () => {
  it("calls start, then write in order, then close", async () => {
    const calls: unknown[] = [];
    const stream = new WritableStream<number>({
      start: () => {
        calls.push("start");
      },
      write: async (chunk) => {
        calls.push(`write ${chunk} begin`);
        await flush();
        calls.push(`write ${chunk} end`);
      },
      close: () => {
        calls.push("close");
      },
    });
    const writer = stream.getWriter();
    const writes = [writer.write(1), writer.write(2), writer.write(3)];
    const closed = writer.close();
    await Promise.all([...writes, closed, writer.closed]);
    expect(calls).toEqual([
      "start",
      "write 1 begin",
      "write 1 end",
      "write 2 begin",
      "write 2 end",
      "write 3 begin",
      "write 3 end",
      "close",
    ]);
  });

  it("waits for an async start before writing", async () => {
    const start = deferred();
    const write = jest.fn();
    const stream = new WritableStream<number>({
      start: () => start.promise,
      write,
    });
    const written = stream.getWriter().write(1);
    await flush();
    expect(write).not.toHaveBeenCalled();
    start.resolve();
    await written;
    expect(write).toHaveBeenCalledWith(1, expect.anything());
  });

  it("applies backpressure through desiredSize and ready", async () => {
    const pending: (() => void)[] = [];
    const stream = new WritableStream<Uint8Array>(
      {
        write: () => new Promise<void>((resolve) => pending.push(resolve)),
      },
      { highWaterMark: 10, size: (chunk) => chunk.byteLength },
    );
    const writer = stream.getWriter();
    await writer.ready;
    expect(writer.desiredSize).toBe(10);

    void writer.write(new Uint8Array(4));
    expect(writer.desiredSize).toBe(6);
    expect(await settled(writer.ready)).toBe(true);

    void writer.write(new Uint8Array(6));
    expect(writer.desiredSize).toBe(0);
    const { ready } = writer;
    expect(await settled(ready)).toBe(false);

    // The first write completes: 4 bytes leave the queue.
    pending.shift()!();
    await flush();
    expect(writer.desiredSize).toBe(4);
    expect(await settled(ready)).toBe(true);

    pending.shift()!();
    await flush();
    expect(writer.desiredSize).toBe(10);
  });

  it("counts chunks with the default strategy (highWaterMark 1)", async () => {
    const stream = new WritableStream<string>({
      write: () => new Promise<void>(() => undefined),
    });
    const writer = stream.getWriter();
    expect(writer.desiredSize).toBe(1);
    void writer.write("a");
    expect(writer.desiredSize).toBe(0);
    void writer.write("b");
    expect(writer.desiredSize).toBe(-1);
    expect(await settled(writer.ready)).toBe(false);
  });

  it("resolves close only after the pending writes", async () => {
    const order: string[] = [];
    const stream = new WritableStream<number>({
      write: async (chunk) => {
        await flush();
        order.push(`write ${chunk}`);
      },
      close: () => {
        order.push("close");
      },
    });
    const writer = stream.getWriter();
    void writer.write(1);
    void writer.write(2);
    await writer.close();
    order.push("closed");
    expect(order).toEqual(["write 1", "write 2", "close", "closed"]);
    expect(writer.desiredSize).toBe(0);
    await expect(writer.write(3)).rejects.toBeInstanceOf(TypeError);
    await expect(writer.close()).rejects.toBeInstanceOf(TypeError);
  });

  it("resolves ready once close is requested under backpressure", async () => {
    const write = deferred();
    const stream = new WritableStream<number>({ write: () => write.promise });
    const writer = stream.getWriter();
    void writer.write(1);
    expect(await settled(writer.ready)).toBe(false);
    const closed = writer.close();
    expect(await settled(writer.ready)).toBe(true);
    write.resolve();
    await closed;
  });

  it("rejects a second close without calling the sink twice", async () => {
    const close = jest.fn();
    const stream = new WritableStream({ close });
    const writer = stream.getWriter();
    const first = writer.close();
    await expect(writer.close()).rejects.toBeInstanceOf(TypeError);
    await first;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("aborts: rejects queued writes, calls sink.abort, not close", async () => {
    const write = deferred();
    const sink = {
      write: jest.fn(() => write.promise),
      close: jest.fn(),
      abort: jest.fn(),
    };
    const stream = new WritableStream<number>(sink);
    const writer = stream.getWriter();
    await flush(); // Started: the first write goes in flight at once.
    const first = writer.write(1);
    const second = writer.write(2);
    const reason = new Error("stop");
    const aborted = writer.abort(reason);
    expect(writer.desiredSize).toBeNull();
    await expect(writer.ready).rejects.toBe(reason);
    // The write in flight finishes before the sink is aborted.
    expect(sink.abort).not.toHaveBeenCalled();
    write.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toBe(reason);
    await aborted;
    expect(sink.abort).toHaveBeenCalledWith(reason);
    expect(sink.close).not.toHaveBeenCalled();
    expect(sink.write).toHaveBeenCalledTimes(1);
    await expect(writer.closed).rejects.toBe(reason);
    await expect(writer.write(3)).rejects.toBe(reason);
  });

  it("rejects a write after close with TypeError, even while erroring", async () => {
    const write = deferred();
    const stream = new WritableStream<number>({ write: () => write.promise });
    const writer = stream.getWriter();
    await flush();
    void writer.write(1).catch(() => undefined);
    const closing = writer.close();
    const aborted = writer.abort(new Error("stop"));
    // Erroring (a write is in flight) with a close queued.
    await expect(writer.write(2)).rejects.toBeInstanceOf(TypeError);
    write.resolve();
    await aborted;
    await expect(closing).rejects.toThrow("stop");
  });

  it("aborts through the controller's signal", async () => {
    let signal: AbortSignal | undefined;
    const stream = new WritableStream({
      start: (controller) => {
        ({ signal } = controller);
      },
    });
    await stream.abort("why");
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe("why");
  });

  it("rejects abort with the sink's abort error", async () => {
    const error = new Error("abort failed");
    const stream = new WritableStream({
      abort: () => {
        throw error;
      },
    });
    await expect(stream.abort()).rejects.toBe(error);
  });

  it("resolves abort on a closed stream without calling the sink", async () => {
    const abort = jest.fn();
    const stream = new WritableStream({ abort });
    await stream.close();
    await stream.abort();
    expect(abort).not.toHaveBeenCalled();
  });

  it("errors the stream when a sink write fails", async () => {
    const error = new Error("disk full");
    const close = jest.fn();
    const stream = new WritableStream<number>({
      write: (chunk) => {
        if (chunk === 2) {
          throw error;
        }
      },
      close,
    });
    const writer = stream.getWriter();
    const writes = [writer.write(1), writer.write(2), writer.write(3)];
    const closing = writer.close();
    await expect(writes[0]).resolves.toBeUndefined();
    await expect(writes[1]).rejects.toBe(error);
    await expect(writes[2]).rejects.toBe(error);
    await expect(closing).rejects.toBe(error);
    await expect(writer.closed).rejects.toBe(error);
    await expect(writer.ready).rejects.toBe(error);
    expect(writer.desiredSize).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it("errors the stream when start fails", async () => {
    const error = new Error("cannot open");
    const stream = new WritableStream({ start: () => Promise.reject(error) });
    const writer = stream.getWriter();
    await expect(writer.write("x")).rejects.toBe(error);
    await expect(writer.closed).rejects.toBe(error);
  });

  it("rejects close and closed when the sink's close fails", async () => {
    const error = new Error("close failed");
    const stream = new WritableStream({
      close: () => Promise.reject(error),
    });
    const writer = stream.getWriter();
    await expect(writer.close()).rejects.toBe(error);
    await expect(writer.closed).rejects.toBe(error);
    expect(writer.desiredSize).toBeNull();
  });

  it("errors the stream from controller.error()", async () => {
    const error = new Error("from the sink");
    const stream = new WritableStream({
      start: (controller) => controller.error(error),
    });
    const writer = stream.getWriter();
    await expect(writer.write(1)).rejects.toBe(error);
    await expect(writer.closed).rejects.toBe(error);
  });

  it("errors the stream when the size strategy fails", async () => {
    const error = new Error("bad size");
    const stream = new WritableStream<number>(
      {},
      {
        size: () => {
          throw error;
        },
      },
    );
    const writer = stream.getWriter();
    await expect(writer.write(1)).rejects.toBe(error);
    await expect(writer.closed).rejects.toBe(error);
  });

  it("validates the sink type and the highWaterMark", () => {
    expect(() => new WritableStream({ type: "bytes" } as never)).toThrow(
      RangeError,
    );
    expect(() => new WritableStream({}, { highWaterMark: -1 })).toThrow(
      RangeError,
    );
    expect(() => new WritableStream({}, { highWaterMark: NaN })).toThrow(
      RangeError,
    );
  });

  it("locks the stream to one writer", async () => {
    const stream = new WritableStream();
    expect(stream.locked).toBe(false);
    const writer = stream.getWriter();
    expect(stream.locked).toBe(true);
    expect(() => stream.getWriter()).toThrow(TypeError);
    await expect(stream.close()).rejects.toBeInstanceOf(TypeError);
    await expect(stream.abort()).rejects.toBeInstanceOf(TypeError);

    writer.releaseLock();
    writer.releaseLock(); // A second release does nothing.
    expect(stream.locked).toBe(false);
    await expect(writer.write(1)).rejects.toBeInstanceOf(TypeError);
    await expect(writer.close()).rejects.toBeInstanceOf(TypeError);
    await expect(writer.abort()).rejects.toBeInstanceOf(TypeError);
    await expect(writer.ready).rejects.toBeInstanceOf(TypeError);
    await expect(writer.closed).rejects.toBeInstanceOf(TypeError);
    expect(() => writer.desiredSize).toThrow(TypeError);

    const next = stream.getWriter();
    await next.write(1);
    await next.close();
    await next.closed;
  });

  it("gives a writer of a closed stream resolved ready and closed", async () => {
    const stream = new WritableStream();
    await stream.close();
    const writer = stream.getWriter();
    await writer.ready;
    await writer.closed;
    expect(writer.desiredSize).toBe(0);
  });

  it("gives a writer of an errored stream rejected ready and closed", async () => {
    const error = new Error("errored");
    const stream = new WritableStream({ start: (c) => c.error(error) });
    await flush();
    const writer = stream.getWriter();
    await expect(writer.ready).rejects.toBe(error);
    await expect(writer.closed).rejects.toBe(error);
    expect(writer.desiredSize).toBeNull();
  });

  it("installs itself on globalThis only where there is none", () => {
    const g = globalThis as { WritableStream?: unknown };
    const native = g.WritableStream;
    try {
      delete g.WritableStream;
      expect(installStreams()).toBe(WritableStream);
      expect(g.WritableStream).toBe(WritableStream);
      class Other {}
      g.WritableStream = Other;
      expect(installStreams()).toBe(Other);
      expect(g.WritableStream).toBe(Other);
    } finally {
      g.WritableStream = native;
    }
  });
});

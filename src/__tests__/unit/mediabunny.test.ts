// Drives Mediabunny's StreamTarget through our WritableStream, as
// createFileWritable() does on device, writing into memory instead of a file.
// Encoded packets need no WebCodecs: Mediabunny only muxes them.
import {
  EncodedAudioPacketSource,
  EncodedPacket,
  Mp4OutputFormat,
  Output,
  StreamTarget,
} from "mediabunny";

import { WritableStream } from "../../lib/streams";

type Chunk = { type: "write"; data: Uint8Array; position: number };

const g = globalThis as { WritableStream?: unknown };
const nativeWritableStream = g.WritableStream;

// Node has its own WritableStream: Mediabunny must see ours, as on Hermes.
beforeAll(() => {
  g.WritableStream = WritableStream;
});
afterAll(() => {
  g.WritableStream = nativeWritableStream;
});

/** A file in memory, written at the positions Mediabunny gives. */
const memoryFile = (delay = false) => {
  let bytes = new Uint8Array(0);
  const writes: number[] = [];
  const events: string[] = [];
  const writable = new WritableStream<Chunk>({
    write: async ({ data, position }) => {
      if (delay) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const end = position + data.byteLength;
      if (end > bytes.byteLength) {
        const grown = new Uint8Array(end);
        grown.set(bytes);
        bytes = grown;
      }
      bytes.set(data, position);
      writes.push(position);
    },
    close: () => {
      events.push("close");
    },
    abort: () => {
      events.push("abort");
    },
  });
  return { writable, writes, events, bytes: () => bytes };
};

/** The top-level ISO BMFF boxes: [type, size][]. */
const boxes = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: [string, number][] = [];
  for (let offset = 0; offset + 8 <= bytes.byteLength;) {
    let size = view.getUint32(offset);
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
    }
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    result.push([type, size]);
    if (size < 8) {
      break;
    }
    offset += size;
  }
  return result;
};

const SAMPLE_RATE = 48000;
const FRAME = 1024 / SAMPLE_RATE;

/** An MP4 with one AAC track of fake packets (Mediabunny never decodes them). */
const writeMp4 = async (writable: unknown, packets: number) => {
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new StreamTarget(writable as never, {
      chunked: true,
      chunkSize: 1024,
    }),
  });
  const source = new EncodedAudioPacketSource("aac");
  output.addAudioTrack(source);
  await output.start();
  for (let i = 0; i < packets; i++) {
    const data = new Uint8Array(300).fill(i);
    await source.add(
      new EncodedPacket(data, "key", i * FRAME, FRAME),
      i === 0
        ? {
            decoderConfig: {
              codec: "mp4a.40.2",
              numberOfChannels: 2,
              sampleRate: SAMPLE_RATE,
              // AudioSpecificConfig: AAC-LC, 48 kHz, stereo.
              description: new Uint8Array([0x11, 0x90]),
            },
          }
        : undefined,
    );
  }
  return output;
};

describe("Mediabunny StreamTarget on our WritableStream", () => {
  it("writes a complete MP4", async () => {
    const file = memoryFile();
    const output = await writeMp4(file.writable, 40);
    await output.finalize();

    const bytes = file.bytes();
    const top = boxes(bytes);
    expect(top[0][0]).toBe("ftyp");
    expect(top.map(([type]) => type)).toEqual(
      expect.arrayContaining(["ftyp", "mdat", "moov"]),
    );
    // The boxes span the whole file, with nothing missing or left over.
    expect(top.reduce((sum, [, size]) => sum + size, 0)).toBe(bytes.byteLength);
    // Every packet's bytes are in the file.
    for (const i of [0, 17, 39]) {
      const packet = new Uint8Array(300).fill(i);
      expect(Buffer.from(bytes).indexOf(Buffer.from(packet))).toBeGreaterThan(
        0,
      );
    }
    // Chunked: several writes, including one back at the start for the
    // mdat size once the file is done.
    expect(file.writes.length).toBeGreaterThan(5);
    expect(file.events).toEqual(["close"]);
  });

  it("writes the same file through a slow sink (backpressure)", async () => {
    const fast = memoryFile();
    await (await writeMp4(fast.writable, 40)).finalize();
    const slow = memoryFile(true);
    await (await writeMp4(slow.writable, 40)).finalize();
    expect(Buffer.from(slow.bytes()).equals(Buffer.from(fast.bytes()))).toBe(
      true,
    );
    expect(slow.events).toEqual(["close"]);
  });

  it("closes the stream when the output is canceled", async () => {
    const file = memoryFile();
    const output = await writeMp4(file.writable, 5);
    await output.cancel();
    expect(file.events).toEqual(["close"]);
  });

  it("rejects finalize when the sink fails", async () => {
    const error = new Error("disk full");
    const writable = new WritableStream<Chunk>({
      write: () => {
        throw error;
      },
    });
    const output = await writeMp4(writable, 40);
    await expect(output.finalize()).rejects.toBe(error);
  });
});

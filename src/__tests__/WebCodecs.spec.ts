/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// The RNWebGPU global and the GPUDevice extensions the device code uses.
import type {} from "react-native-webgpu";

import { client } from "./setup";

// Video export and import with react-native-webcodecs (WebCodecs on
// VideoToolbox, AudioToolbox and MediaCodec) and Mediabunny (containers, in
// plain TypeScript). WebGPU draws into surfaces from a pool, a VideoFrame
// takes each one with the GPU fence of the draw, and Mediabunny drives the
// encoders and writes the file as it goes; decoded frames come back to
// WebGPU as native buffers. These cover what react-native-webgpu#641's createVideoWriter did.
//
// The functions passed to client.eval run on the device as source: chained
// rather than async, and without spreads, for-of or other syntax Babel would
// compile to helpers the device does not have. `mediabunny` and `webcodecs`
// come through the eval context (example/src/Tests.tsx).

interface Export {
  kind: "ok" | "skip" | "fail" | "cancelled";
  reason?: string;
  path?: string;
  bytes?: number;
  ms?: number;
  maxPending?: number;
  maxFrameDelay?: number;
  fences?: number;
  hardwareAccelerated?: boolean;
  // The app's state when finalize() resolved.
  appState?: string;
  code?: string;
}

interface ExportOptions {
  width: number;
  height: number;
  count: number;
  frameRate: number;
  // A file under the app's cache directory, written as it goes; "" keeps the
  // whole output in memory (BufferTarget) and writes it at the end.
  file: string;
  // A sound file on the device, copied (AAC) or transcoded to AAC.
  audio: string;
  audioMode: "copy" | "transcode" | "";
  // Cancels the output after that many frames.
  cancelAt: number;
  // Once every frame is in: holds a background task, waits for the app to
  // go to the background (writing "webcodecs-e2e-ready" in the cache
  // directory first), then finalizes there.
  backgroundFinalize: boolean;
  // The frames' times in seconds, when not 1 / frameRate apart (each still
  // lasts 1 / frameRate); `count` is then their number.
  times: number[];
}

const hasTool = (tool: string) => {
  try {
    execFileSync(tool, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const probes = () => hasTool("ffprobe") && hasTool("ffmpeg");

const pixel = (file: string, time: number, x = 64, y = 64) => {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-loglevel",
      "error",
      "-ss",
      String(time),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `format=rgb24,crop=1:1:${x}:${y}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 1024 },
  );
  return [raw[0], raw[1], raw[2]];
};

interface Stream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  duration: string;
  nb_read_frames?: string;
  has_b_frames?: number;
  color_primaries?: string;
  color_space?: string;
}

const streamOf = (file: string, type: string): Stream => {
  const { streams } = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,duration,nb_read_frames,has_b_frames,color_primaries,color_space",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8" },
    ),
  );
  const stream = streams.find((s: Stream) => s.codec_type === type);
  if (!stream) {
    throw new Error(`${file} has no ${type} stream`);
  }
  return stream;
};

// The mean volume of the sound, in dB: about -3 dB for the test sine, below
// -90 dB for silence.
// The test sines' level over their first 2 s, as ffmpeg measures it.
const SOURCE_VOLUME = -24.3;
const meanVolumeOf = (file: string) => {
  const report = execFileSync(
    "sh",
    [
      "-c",
      `ffmpeg -hide_banner -i "${file}" -vn -af volumedetect -f null - 2>&1`,
    ],
    { encoding: "utf8" },
  );
  const m = /mean_volume: (-?[\d.]+) dB/.exec(report);
  return m ? Number(m[1]) : -Infinity;
};

// The app's cache directory: the iOS Simulator's files are this machine's
// (Android's are read through adb).
let cacheDirectory: Promise<string> | undefined;
const appCache = () =>
  (cacheDirectory ??= client
    .eval(({ webcodecs: wc }) => {
      const p = wc.resolvePath("probe") as string;
      return p.slice(0, p.lastIndexOf("/"));
    })
    .then((dir) => String(dir)));

// On Android the app's files are reached through adb (run-as: debug build).
const ANDROID_PACKAGE = "com.reactnativewebcodecs.example";
const adb = (args: string[], input?: Buffer) =>
  execFileSync(
    "adb",
    [
      ...(process.env.ANDROID_SERIAL ? ["-s", process.env.ANDROID_SERIAL] : []),
      ...args,
    ],
    { input, maxBuffer: 256 * 1024 * 1024 },
  );

const pushAsset = (name: string) =>
  appCache().then((dir) => {
    const destination = `${dir}/e2e-${name}`;
    const source = path.join(__dirname, "assets", name);
    if (client.OS === "android") {
      // Written aside, then renamed: the app never sees a partial file. The
      // rename is its own command: `adb exec-in` can end the shell as soon
      // as its input is consumed, before a `&& mv` after the `cat` runs.
      const { size } = fs.statSync(source);
      const sizeOf = (file: string) =>
        Number(
          adb([
            "shell",
            `run-as ${ANDROID_PACKAGE} stat -c %s ${file} 2>/dev/null || echo -1`,
          ])
            .toString()
            .trim(),
        );
      adb(
        [
          "exec-in",
          "run-as",
          ANDROID_PACKAGE,
          "sh",
          "-c",
          `cat > ${destination}.part`,
        ],
        fs.readFileSync(source),
      );
      for (let i = 0; i < 50 && sizeOf(`${destination}.part`) !== size; i++) {
        execFileSync("sleep", ["0.1"]);
      }
      adb([
        "shell",
        `run-as ${ANDROID_PACKAGE} mv ${destination}.part ${destination}`,
      ]);
      if (sizeOf(destination) !== size) {
        throw new Error(`Could not copy ${name} to the device`);
      }
    } else {
      fs.copyFileSync(source, destination);
    }
    return destination;
  });

const copyLocal = (file: string) => {
  const local = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "rnwc-e2e-")),
    path.basename(file),
  );
  if (client.OS === "android") {
    fs.writeFileSync(
      local,
      adb(["exec-out", "run-as", ANDROID_PACKAGE, "cat", file]),
    );
  } else {
    fs.copyFileSync(file, local);
  }
  return local;
};

const existsOnDevice = (file: string) => {
  if (client.OS !== "android") {
    return fs.existsSync(file);
  }
  return (
    adb([
      "shell",
      `run-as ${ANDROID_PACKAGE} ls ${file} >/dev/null 2>&1 && echo yes || echo no`,
    ])
      .toString()
      .trim() === "yes"
  );
};

// Runs on the device: draws `count` frames (red for the first half, green
// for the rest) into pooled surfaces, and exports them with Mediabunny.
const deviceExport = (
  device: GPUDevice,
  mb: any,
  wc: any,
  o: ExportOptions,
  appState?: any,
): Promise<Export> => {
  if (!wc.installWebCodecs()) {
    return Promise.resolve({
      kind: "fail",
      reason: "another WebCodecs implementation is installed",
    });
  }
  const start = Date.now();
  wc._stats.maxPending = 0;
  let fences = 0;
  const file = o.file ? wc.createFileWritable(o.file) : null;
  const output = new mb.Output({
    format: new mb.Mp4OutputFormat(file ? {} : { fastStart: "in-memory" }),
    target: file
      ? new mb.StreamTarget(file.writable, { chunked: true })
      : new mb.BufferTarget(),
  });
  const video = new mb.VideoSampleSource({
    codec: "avc",
    bitrate: 4e6,
    keyFrameInterval: 1,
  });
  output.addVideoTrack(video, { frameRate: o.frameRate });
  const timeOf = (i: number) =>
    o.times.length > 0 ? o.times[i] : i / o.frameRate;
  const duration = timeOf(o.count - 1) + 1 / o.frameRate;

  let input: any = null;
  let audio: any = null;
  if (o.audio) {
    input = new mb.Input({
      source: new mb.CustomSource(wc.fileSourceOptions(o.audio)),
      formats: mb.ALL_FORMATS,
    });
    audio =
      o.audioMode === "copy"
        ? new mb.EncodedAudioPacketSource("aac")
        : new mb.AudioSampleSource({ codec: "aac", bitrate: 128e3 });
    output.addAudioTrack(audio);
  }

  // Iterates an async iterator without for-await.
  const each = (it: any, fn: (v: any) => Promise<boolean>): Promise<void> =>
    it
      .next()
      .then((r: any) =>
        r.done
          ? undefined
          : fn(r.value).then((more) =>
              more
                ? each(it, fn)
                : Promise.resolve(it.return && it.return()).then(
                    () => undefined,
                  ),
            ),
      );

  const writeAudio = (): Promise<void> => {
    if (!input) {
      return Promise.resolve();
    }
    return input
      .getPrimaryAudioTrack()
      .then((track: any) => {
        if (o.audioMode === "copy") {
          return track.getDecoderConfig().then((config: any) => {
            let first = true;
            const sink = new mb.EncodedPacketSink(track);
            return each(sink.packets(), (packet: any) => {
              if (packet.timestamp >= duration) {
                return Promise.resolve(false);
              }
              const meta = first ? { decoderConfig: config } : undefined;
              first = false;
              return audio.add(packet, meta).then(() => true);
            });
          });
        }
        const sink = new mb.AudioSampleSink(track);
        return each(sink.samples(0, duration), (sample: any) =>
          audio.add(sample).then(
            () => {
              sample.close();
              return true;
            },
            (e: unknown) => {
              sample.close();
              throw e;
            },
          ),
        );
      })
      .then(() => audio.close());
  };

  const pool = wc.createSurfacePool(o.width, o.height);
  const drawFrame = (i: number): Promise<void> => {
    const surface = pool.acquire();
    const buffer = RNWebGPU.createNativeBufferFromPointer(surface.pixelBuffer);
    const memory = device.importSharedTextureMemory({ source: buffer });
    const texture = memory.createTexture();
    memory.beginAccess(texture, false);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          clearValue: i < o.count / 2 ? [1, 0, 0, 1] : [0, 1, 0, 1],
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
    const end = (memory as any).endAccess(texture);
    texture.destroy();
    memory.destroy();
    buffer.release();
    const fence = end && end.fences && end.fences[0];
    // The encoder waits for the draw natively when there is a fence.
    const ready = fence
      ? Promise.resolve()
      : device.queue.onSubmittedWorkDone();
    if (fence) {
      fences++;
    }
    return ready.then(() => {
      const frame = new wc.VideoFrame(surface, {
        timestamp: Math.round(timeOf(i) * 1e6),
        duration: Math.round(1e6 / o.frameRate),
        fence,
      });
      const sample = new mb.VideoSample(frame);
      // Closed either way: a cancelled or failed add() still owns it.
      return video.add(sample).then(
        () => sample.close(),
        (e: unknown) => {
          sample.close();
          throw e;
        },
      );
    });
  };

  const loop = (i: number): Promise<boolean> => {
    if (o.cancelAt > 0 && i === o.cancelAt) {
      return output
        .cancel()
        .then(() => file && file.remove())
        .then(() => false);
    }
    return i === o.count
      ? Promise.resolve(true)
      : drawFrame(i).then(() => loop(i + 1));
  };

  return output
    .start()
    .then(() => writeAudio())
    .then(() => loop(0))
    .then((finished: boolean) => {
      if (!finished) {
        return { kind: "cancelled" as const, path: file ? file.path : "" };
      }
      const finalize = () => {
        video.close();
        return output.finalize();
      };
      const waitForBackground = (): Promise<void> =>
        new Promise((resolve) => {
          wc.writeFile("webcodecs-e2e-ready", new Uint8Array([1]));
          const check = () =>
            appState.currentState === "background"
              ? resolve()
              : setTimeout(check, 50);
          check();
        });
      const finalized = o.backgroundFinalize
        ? wc.withBackgroundTask(() => waitForBackground().then(finalize))
        : finalize();
      return finalized.then(() => {
        let filePath = file ? file.path : "";
        let bytes = 0;
        if (!file) {
          const buffer = output.target.buffer as ArrayBuffer;
          bytes = buffer.byteLength;
          filePath = wc.writeFile("webcodecs-e2e.mp4", buffer);
        }
        return {
          kind: "ok" as const,
          path: filePath,
          bytes,
          ms: Date.now() - start,
          maxPending: wc._stats.maxPending,
          maxFrameDelay: wc._stats.maxFrameDelay,
          fences,
          hardwareAccelerated: wc._stats.hardwareAccelerated,
          appState: appState ? appState.currentState : undefined,
        };
      });
    })
    .catch((e: any) => ({
      kind: "fail" as const,
      reason: `${e && e.name}: ${e && e.message}\n${(e && e.stack) || ""}`,
      code: e && e.code,
    }));
};

const DEFAULTS: ExportOptions = {
  width: 128,
  height: 128,
  count: 60,
  frameRate: 30,
  times: [],
  backgroundFinalize: false,
  file: "",
  audio: "",
  audioMode: "",
  cancelAt: 0,
};

const exportOnDevice = (options: Partial<ExportOptions>) =>
  client.eval(
    ({ device, ctx, mediabunny, webcodecs }) => {
      const run = eval(`(${ctx.deviceExport})`);
      return run(device, mediabunny, webcodecs, ctx.options);
    },
    {
      ctx: {
        deviceExport: deviceExport.toString(),
        options: { ...DEFAULTS, ...options },
      },
    },
  ) as unknown as Promise<Export>;

const expectOk = (result: Export) => {
  if (result.kind === "fail") {
    throw new Error(result.reason);
  }
  expect(result.kind).toBe("ok");
  return result as Required<Export>;
};

const ios = () => client.OS === "ios";
const supported = () => client.OS === "ios" || client.OS === "android";

describe("react-native-webcodecs + Mediabunny", () => {
  it("exports WebGPU frames to an H.264 MP4 in memory", async () => {
    if (!supported()) {
      return;
    }
    const result = expectOk(await exportOnDevice({}));
    console.log(
      `in memory: ${result.bytes} bytes in ${result.ms} ms, ${result.fences} fences, hardware encoder: ${result.hardwareAccelerated}`,
    );
    if (!probes()) {
      return;
    }
    const local = copyLocal(result.path);
    const video = streamOf(local, "video");
    expect(video.codec_name).toBe("h264");
    expect(video.width).toBe(128);
    expect(video.height).toBe(128);
    expect(Number(video.nb_read_frames)).toBe(60);
    expect(Number(video.duration)).toBeCloseTo(2, 1);
    expect(video.has_b_frames).toBe(0);
    expect(video.color_primaries).toBe("bt709");
    expect(video.color_space).toBe("bt709");
    // Tight on purpose: a YCbCr matrix that disagrees with the BT.709 tags
    // gives (233, 0, 2) for red instead.
    const red = pixel(local, 0.5);
    const green = pixel(local, 1.5);
    expect(red[0]).toBeGreaterThan(245);
    expect(red[1]).toBeLessThan(8);
    expect(red[2]).toBeLessThan(8);
    expect(green[1]).toBeGreaterThan(245);
    expect(green[0]).toBeLessThan(8);
    expect(green[2]).toBeLessThan(8);
  }, 120000);

  // The case of react-native-webgpu#641: a 7 s vertical video at 30 fps, streamed to a file.
  it("streams 210 frames at 1080x1920 to a file with a bounded backlog", async () => {
    if (!supported()) {
      return;
    }
    const result = expectOk(
      await exportOnDevice({
        width: 1080,
        height: 1920,
        count: 210,
        file: "webcodecs-e2e-1080.mp4",
      }),
    );
    console.log(
      `1080x1920: ${result.ms} ms, at most ${result.maxPending} frames in the encoder (frame delay ${result.maxFrameDelay}), ${result.fences} fences`,
    );
    // With MaxFrameDelayCount (hardware encoders): the lookahead (3) +
    // MAX_IN_FLIGHT (4) + the 4 Mediabunny queues before it waits for
    // dequeue. Without it (the Simulator's software encoder refuses it),
    // the lookahead is taken as 18 frames: 18 + 4 + 4.
    expect(result.maxPending).toBeLessThanOrEqual(
      result.maxFrameDelay >= 0 ? 11 : 26,
    );
    if (!probes()) {
      return;
    }
    const local = copyLocal(result.path);
    const video = streamOf(local, "video");
    expect(video.width).toBe(1080);
    expect(video.height).toBe(1920);
    expect(Number(video.nb_read_frames)).toBe(210);
    expect(Number(video.duration)).toBeCloseTo(7, 1);
    const red = pixel(local, 1, 540, 960);
    const green = pixel(local, 6, 540, 960);
    expect(red[0]).toBeGreaterThan(245);
    expect(green[1]).toBeGreaterThan(245);
  }, 120000);

  it("copies an AAC sound, cut where the video ends", async () => {
    if (!supported()) {
      return;
    }
    const sound = await pushAsset("sine-8s.m4a");
    const result = expectOk(
      await exportOnDevice({
        file: "webcodecs-e2e-aac.mp4",
        audio: sound,
        audioMode: "copy",
      }),
    );
    if (!probes()) {
      return;
    }
    const local = copyLocal(result.path);
    const audio = streamOf(local, "audio");
    expect(audio.codec_name).toBe("aac");
    // Cut at a whole AAC frame: within one frame (23 ms at 44.1 kHz).
    expect(Math.abs(Number(audio.duration) - 2)).toBeLessThan(0.05);
    // As loud as the source (-24.1 dB over its first 2 s).
    expect(Math.abs(meanVolumeOf(local) - SOURCE_VOLUME)).toBeLessThan(1);
    expect(Number(streamOf(local, "video").nb_read_frames)).toBe(60);
  }, 120000);

  it("transcodes an MP3 sound to AAC (AudioDecoder + AudioEncoder)", async () => {
    if (!supported()) {
      return;
    }
    const sound = await pushAsset("sine-8s.mp3");
    const result = expectOk(
      await exportOnDevice({
        file: "webcodecs-e2e-mp3.mp4",
        audio: sound,
        audioMode: "transcode",
      }),
    );
    if (!probes()) {
      return;
    }
    const local = copyLocal(result.path);
    const audio = streamOf(local, "audio");
    expect(audio.codec_name).toBe("aac");
    expect(Math.abs(Number(audio.duration) - 2)).toBeLessThan(0.1);
    // The sine survives the round trip at its level (silence would be
    // below -90 dB).
    expect(Math.abs(meanVolumeOf(local) - SOURCE_VOLUME)).toBeLessThan(1.5);
  }, 120000);

  // Frames far apart, as a slideshow gives them: each lasts its own
  // duration (not the gap after it), and the sound keeps up with frames that
  // lead it by seconds. From react-native-webgpu#641's writer tests.
  it("ends the video one frame after the last of frames far apart", async () => {
    if (!supported()) {
      return;
    }
    const sound = await pushAsset("sine-8s.m4a");
    const result = expectOk(
      await exportOnDevice({
        file: "webcodecs-e2e-slideshow.mp4",
        times: [0, 2, 4, 6],
        count: 4,
        audio: sound,
        audioMode: "copy",
      }),
    );
    if (!probes()) {
      return;
    }
    const local = copyLocal(result.path);
    const video = streamOf(local, "video");
    const audio = streamOf(local, "audio");
    const end = 6 + 1 / 30;
    expect(Number(video.nb_read_frames)).toBe(4);
    expect(Math.abs(Number(video.duration) - end)).toBeLessThan(0.002);
    expect(Math.abs(Number(audio.duration) - end)).toBeLessThan(0.05);
    expect(pixel(local, 1)[0]).toBeGreaterThan(245);
    expect(pixel(local, 5)[1]).toBeGreaterThan(245);
  }, 120000);

  // react-native-webgpu#641's writer was checked by hand with 4200-frame exports: long enough
  // for leaks, stalls or a growing backlog to show. Slow, so opt-in.
  it("streams 4200 frames at 1080x1920 (E2E_LONG=1)", async () => {
    if (!supported() || !process.env.E2E_LONG) {
      return;
    }
    // Longer than one eval may take: started here, polled below.
    await client.eval(
      ({ device, ctx, mediabunny, webcodecs }) => {
        const run = eval(`(${ctx.deviceExport})`);
        const g = globalThis as any;
        g.__webcodecsLong = null;
        run(device, mediabunny, webcodecs, ctx.options).then(
          (r: any) => (g.__webcodecsLong = r),
          (e: any) => (g.__webcodecsLong = { kind: "fail", reason: String(e) }),
        );
        return true;
      },
      {
        ctx: {
          deviceExport: deviceExport.toString(),
          options: {
            ...DEFAULTS,
            width: 1080,
            height: 1920,
            count: 4200,
            file: "webcodecs-e2e-long.mp4",
          },
        },
      },
    );
    let polled: Export | null = null;
    for (let i = 0; i < 100 && !polled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      polled = (await client.eval(
        () => (globalThis as any).__webcodecsLong,
      )) as Export | null;
    }
    const result = expectOk(polled ?? { kind: "fail", reason: "timed out" });
    console.log(
      `4200 frames: ${result.ms} ms, at most ${result.maxPending} frames in the encoder`,
    );
    expect(result.maxPending).toBeLessThanOrEqual(
      result.maxFrameDelay >= 0 ? 11 : 26,
    );
    if (!probes()) {
      return;
    }
    const local = copyLocal(result.path);
    const video = streamOf(local, "video");
    expect(Number(video.nb_read_frames)).toBe(4200);
    expect(Number(video.duration)).toBeCloseTo(140, 1);
  }, 600000);

  it("cancel() deletes the partial file", async () => {
    if (!supported()) {
      return;
    }
    const result = await exportOnDevice({
      file: "webcodecs-e2e-cancel.mp4",
      count: 120,
      cancelAt: 30,
    });
    if (result.kind === "fail") {
      throw new Error(result.reason);
    }
    expect(result.kind).toBe("cancelled");
    expect(existsOnDevice(result.path!)).toBe(false);
  }, 120000);

  it("decodes the export and samples a frame with WebGPU", async () => {
    if (!supported()) {
      return;
    }
    const exported = expectOk(
      await exportOnDevice({ file: "webcodecs-e2e-decode.mp4" }),
    );
    const result = (await client.eval(
      ({ device, ctx, mediabunny: mb, webcodecs: wc }) => {
        wc.installWebCodecs();
        const input = new mb.Input({
          source: new mb.CustomSource(wc.fileSourceOptions(ctx.file)),
          formats: mb.ALL_FORMATS,
        });
        const at = (t: number) =>
          input
            .getPrimaryVideoTrack()
            .then((track: any) => new mb.VideoSampleSink(track).getSample(t))
            .then((sample: any) => {
              const frame = sample.toVideoFrame();
              sample.close();
              // react-native-webgpu takes the decoder's buffer as is (iOS:
              // a CVPixelBuffer; Android: the ImageReader's AHardwareBuffer,
              // whose color space comes from the frame).
              const buffer = RNWebGPU.createNativeBufferFromPointer(
                frame.pixelBuffer,
                { colorSpace: frame.colorSpace.toJSON() },
              );
              const { format, timestamp } = frame;
              const size = 128;
              const texture = device.createTexture({
                size: [size, size],
                format: "rgba8unorm",
                usage:
                  GPUTextureUsage.RENDER_ATTACHMENT |
                  GPUTextureUsage.COPY_SRC |
                  GPUTextureUsage.TEXTURE_BINDING,
              });
              device.queue.copyExternalImageToTexture(
                { source: buffer },
                { texture },
                [size, size],
              );
              buffer.release();
              frame.close();
              const bytesPerRow = 512;
              const readback = device.createBuffer({
                size: bytesPerRow * size,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
              });
              const encoder = device.createCommandEncoder();
              encoder.copyTextureToBuffer(
                { texture },
                { buffer: readback, bytesPerRow },
                [size, size],
              );
              device.queue.submit([encoder.finish()]);
              return readback.mapAsync(GPUMapMode.READ).then(() => {
                const data = new Uint8Array(readback.getMappedRange());
                const o = 64 * bytesPerRow + 64 * 4;
                const px = [data[o], data[o + 1], data[o + 2]];
                readback.unmap();
                readback.destroy();
                texture.destroy();
                return { format, timestamp, px };
              });
            });
        return at(0.5)
          .then((red: any) =>
            at(1.5).then((green: any) => ({ kind: "ok", red, green })),
          )
          .catch((e: any) => ({
            kind: "fail",
            reason: `${e && e.name}: ${e && e.message}\n${e && e.stack}`,
          }));
      },
      { ctx: { file: exported.path } },
    )) as any;
    if (result.kind === "fail") {
      throw new Error(result.reason);
    }
    console.log(`decoded: ${JSON.stringify(result)}`);
    expect(result.red.px[0]).toBeGreaterThan(240);
    expect(result.red.px[1]).toBeLessThan(15);
    expect(result.green.px[1]).toBeGreaterThan(240);
    expect(result.green.px[0]).toBeLessThan(15);
  }, 120000);

  it("reports errors as WebCodecs DOMExceptions", async () => {
    if (!supported()) {
      return;
    }
    const result = (await client.eval(({ webcodecs: wc }) => {
      const errors: string[] = [];
      const encoder = new wc.VideoEncoder({
        output: () => undefined,
        error: (e: any) => errors.push(`${e.name}`),
      });
      encoder.configure({ codec: "vp09.00.10.08", width: 64, height: 64 });
      let thrown = "";
      try {
        encoder.encode({});
      } catch (e: any) {
        thrown = e.name;
      }
      let missing = "";
      try {
        wc.fileSourceOptions("does-not-exist.mp4");
      } catch (e: any) {
        missing = `${e.name}|${e.message}`;
      }
      return wc.VideoEncoder.isConfigSupported({
        codec: "avc1.640028",
        width: 1080,
        height: 1920,
      }).then((support: any) => ({
        errors,
        state: encoder.state,
        thrown,
        missing,
        avc: support.supported,
      }));
    })) as any;
    expect(result.errors).toEqual(["NotSupportedError"]);
    expect(result.state).toBe("closed");
    expect(result.thrown).toBe("InvalidStateError");
    expect(result.missing.split("|")[0]).toBe("NotFoundError");
    expect(result.avc).toBe(true);
  }, 60000);

  it("answers isConfigSupported from the platform's encoders", async () => {
    if (!supported()) {
      return;
    }
    const result = (await client.eval(({ webcodecs: wc }) => {
      const ask = (config: any) => wc.VideoEncoder.isConfigSupported(config);
      return Promise.all([
        ask({
          codec: "avc1.640028",
          width: 1080,
          height: 1920,
          framerate: 30,
          bitrate: 8_000_000,
          madeUp: true,
        }),
        ask({ codec: "avc1.640028", width: 16384, height: 16384 }),
      ]).then(([fits, huge]: any[]) => ({
        fits: fits.supported,
        keys: Object.keys(fits.config).sort(),
        huge: huge.supported,
      }));
    })) as any;
    expect(result.fits).toBe(true);
    expect(result.keys).toEqual([
      "bitrate",
      "codec",
      "framerate",
      "height",
      "width",
    ]);
    expect(result.huge).toBe(false);
  }, 60000);

  // iOS takes the hardware codecs away from a backgrounded app. Two exports,
  // one after the other, each sent to the background by opening Settings on
  // the Simulator and then brought back:
  // - one still taking frames reports `interrupted` instead of failing on a
  //   later frame;
  // - one whose frames are all in, finalizing inside withBackgroundTask()
  //   (as react-native-webgpu#641's writer runs finish() in a background task), completes in
  //   the background.
  // One eval for both, and last: the app does not reconnect to the test
  // server after going to the background.
  it("handles the app going to the background", async () => {
    const udid = process.env.SIMULATOR_UDID;
    if (!ios() || !udid) {
      return;
    }
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const launch = (bundle: string) =>
      execFileSync("xcrun", ["simctl", "launch", udid, bundle]);
    const toBackgroundAndBack = async () => {
      launch("com.apple.Preferences");
      await sleep(3000);
      launch("com.reactnativewebcodecs.example");
    };
    // The socket drops in the background: the exports write their results
    // to files this machine reads (the Simulator's files are this machine's).
    const cache = await appCache();
    const report = `${cache}/webcodecs-e2e-background.json`;
    const ready = `${cache}/webcodecs-e2e-ready`;
    fs.rmSync(report, { force: true });
    fs.rmSync(ready, { force: true });
    await client.eval(
      ({ device, ctx, mediabunny, webcodecs, AppState }) => {
        const run = eval(`(${ctx.deviceExport})`);
        const foreground = (): Promise<void> =>
          new Promise((resolve) => {
            const check = () =>
              AppState.currentState === "active"
                ? resolve()
                : setTimeout(check, 50);
            check();
          });
        run(device, mediabunny, webcodecs, ctx.taking).then(
          (interrupted: any) =>
            foreground()
              .then(() =>
                run(device, mediabunny, webcodecs, ctx.finishing, AppState),
              )
              .then((finished: any) =>
                webcodecs.writeFile(
                  "webcodecs-e2e-background.json",
                  new TextEncoder().encode(
                    JSON.stringify({ interrupted, finished }),
                  ),
                ),
              ),
        );
        return true;
      },
      {
        ctx: {
          deviceExport: deviceExport.toString(),
          taking: {
            ...DEFAULTS,
            width: 1080,
            height: 1920,
            count: 3000,
            file: "webcodecs-e2e-background.mp4",
          },
          finishing: {
            ...DEFAULTS,
            width: 1080,
            height: 1920,
            count: 60,
            file: "webcodecs-e2e-background-finish.mp4",
            backgroundFinalize: true,
          },
        },
      },
    );
    await sleep(1000);
    await toBackgroundAndBack();
    // The second export has all its frames in once it says it is ready.
    for (let i = 0; i < 120 && !fs.existsSync(ready); i++) {
      await sleep(500);
    }
    expect(fs.existsSync(ready)).toBe(true);
    await toBackgroundAndBack();
    let result: any = null;
    for (let i = 0; i < 60 && !result; i++) {
      await sleep(500);
      if (fs.existsSync(report)) {
        result = JSON.parse(fs.readFileSync(report, "utf8"));
      }
    }
    expect(result).not.toBeNull();
    const { interrupted, finished } = result;
    expect(interrupted.kind).toBe("fail");
    expect(interrupted.reason).toMatch(
      /^EncodingError: the app went to the background/,
    );
    expect(interrupted.code).toBe("interrupted");
    if (finished.kind === "fail") {
      throw new Error(finished.reason);
    }
    expect(finished.kind).toBe("ok");
    // Finalized while the app was in the background.
    expect(finished.appState).toBe("background");
    if (!probes()) {
      return;
    }
    const video = streamOf(copyLocal(finished.path), "video");
    expect(Number(video.nb_read_frames)).toBe(60);
  }, 180000);
});

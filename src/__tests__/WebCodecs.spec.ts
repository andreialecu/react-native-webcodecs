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
  pushFile(path.join(__dirname, "assets", name));

// Copies a file of this machine into the app's cache directory, as
// e2e-<its name>.
const pushFile = (source: string) =>
  appCache().then((dir) => {
    const name = path.basename(source);
    const destination = `${dir}/e2e-${name}`;
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

// Runs `fn` on the device with the eval context, for longer than one call
// to the app may take: started in one call, then polled until it settles.
const runOnDevice = async <R>(
  fn: (context: {
    example: any;
    mediabunny: any;
    webcodecs: any;
    ctx: any;
  }) => Promise<R>,
  ctx: object,
  limitMs: number,
): Promise<R> => {
  const key = `__e2e_${Math.random().toString(36).slice(2)}`;
  await client.eval(
    ({ example, mediabunny, webcodecs, ctx: c }) => {
      const g = globalThis as any;
      const run = eval(`(${c.fn})`);
      g[c.key] = null;
      Promise.resolve()
        .then(() => run({ example, mediabunny, webcodecs, ctx: c.args }))
        .then(
          (value: any) => (g[c.key] = { value }),
          (e: any) => (g[c.key] = { error: String((e && e.stack) || e) }),
        );
      return true;
    },
    { ctx: { fn: fn.toString(), key, args: ctx } },
  );
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const settled = (await client.eval(
      ({ ctx: c }) => {
        const g = globalThis as any;
        const r = g[c.key];
        if (r) {
          delete g[c.key];
        }
        return r;
      },
      { ctx: { key } },
    )) as { value?: R; error?: string } | null;
    if (settled) {
      if (settled.error !== undefined) {
        throw new Error(settled.error);
      }
      return settled.value as R;
    }
  }
  throw new Error(`timed out after ${limitMs} ms`);
};

interface CardExport {
  path: string;
  frames: number;
  duration: number;
  ms: number;
}

// The Video Export screen's export (example/src/VideoExport), on the device.
const exportCard = async (o: { hdr: boolean; sound: boolean }) => {
  const result = await runOnDevice<CardExport | null>(
    ({ example, ctx }) =>
      example.loadCardAssets().then((assets: any) => {
        const animation = example.makeCard(assets, ctx.hdr);
        const done = () => animation.dispose && animation.dispose();
        return (ctx.sound ? example.loadSound() : Promise.resolve(null))
          .then((sound: any) =>
            example.exportVideo(
              animation,
              sound,
              ctx.hdr,
              new AbortController().signal,
              () => {},
            ),
          )
          .then(
            (r: any) => {
              done();
              return r;
            },
            (e: any) => {
              done();
              throw e;
            },
          );
      }),
    o,
    // AV1 in software on the Android emulator is slow.
    o.hdr && client.OS === "android" ? 1440000 : 540000,
  );
  if (!result) {
    throw new Error("the export was cancelled");
  }
  console.log(
    `card ${o.hdr ? "HDR" : "SDR"}${o.sound ? " + sound" : ""}: ${result.frames} frames in ${Math.round(result.ms)} ms`,
  );
  return result;
};

interface Compressed {
  skipped?: boolean;
  supported?: string[];
  source: { width: number; height: number; rotation: number };
  target: { width: number; height: number };
  result: {
    path: string;
    size: number;
    width: number;
    height: number;
    ms: number;
  };
}

// The Compress screen's compression (example/src/Compress) of a file in
// the app's cache, at 480p and medium quality unless told otherwise; with
// a `codec` the device's supportedCodecs does not list, `skipped`.
const compressOnDevice = (
  file: string,
  options: { codec?: string; audio?: boolean; frameRate?: number },
) =>
  runOnDevice<Compressed>(
    ({ example, ctx }) =>
      example
        .openSource({ name: "source.mp4", path: ctx.file, size: 0 })
        .then((source: any) =>
          example
            .supportedCodecs(source.width, source.height)
            .then((supported: string[]) => {
              if (supported.indexOf(ctx.codec) < 0) {
                return { skipped: true, supported };
              }
              const s = example.settings;
              const settings = {
                resolution: "480",
                quality: "medium",
                codec: ctx.codec,
                frameRate: ctx.frameRate,
                audio: ctx.audio,
                videoBitrate: s.videoBitrate(
                  source,
                  "480",
                  "medium",
                  ctx.codec,
                  ctx.frameRate,
                ),
              };
              return example
                .compress(
                  source,
                  settings,
                  new AbortController().signal,
                  () => {},
                )
                .then((result: any) => ({
                  source,
                  target: s.targetSize(source, "480"),
                  result,
                }));
            }),
        ),
    {
      file,
      codec: options.codec ?? "avc",
      audio: options.audio ?? true,
      frameRate: options.frameRate ?? null,
    },
    540000,
  );

// The clips to compress, made with ffmpeg once (kept in the temporary
// directory) and pushed to the app's cache once per run.
const clipDirectory = path.join(os.tmpdir(), "rnwc-e2e-clips");
const clips = new Map<boolean, Promise<string>>();
const sourceClip = (rotated: boolean) => {
  let clip = clips.get(rotated);
  if (!clip) {
    const plain = path.join(clipDirectory, "clip.mp4");
    fs.mkdirSync(clipDirectory, { recursive: true });
    if (!fs.existsSync(plain)) {
      execFileSync("ffmpeg", [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=30:duration=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=3",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        plain,
      ]);
    }
    let file = plain;
    if (rotated) {
      file = path.join(clipDirectory, "clip-portrait.mp4");
      // ffmpeg counts counterclockwise: -90 is 90° clockwise, the tag of
      // a phone held upright, which stores its frames landscape.
      execFileSync("ffmpeg", [
        "-loglevel",
        "error",
        "-y",
        "-display_rotation:v:0",
        "-90",
        "-i",
        plain,
        "-c",
        "copy",
        file,
      ]);
    }
    clip = pushFile(file);
    clips.set(rotated, clip);
  }
  return clip;
};

interface Probed extends Stream {
  profile?: string;
  pix_fmt?: string;
  color_transfer?: string;
  nb_read_packets?: string;
  side_data_list?: { rotation?: number }[];
}

const probe = (file: string): { streams: Probed[] } =>
  JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-count_packets", "-show_streams", "-of", "json", file],
      { encoding: "utf8" },
    ),
  );

const rotationOf = (stream: Probed) =>
  Math.abs(
    stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0,
  );

// The video packets' presentation times, in the order they are stored.
const videoPacketTimes = (file: string) =>
  execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time",
      "-of",
      "csv=p=0",
      file,
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .map(Number);

// The MP4's top-level boxes, in order.
const topLevelBoxes = (file: string) => {
  const bytes = fs.readFileSync(file);
  const boxes: string[] = [];
  let at = 0;
  while (at + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(at);
    boxes.push(bytes.toString("latin1", at + 4, at + 8));
    if (size === 1) {
      size = Number(bytes.readBigUInt64BE(at + 8));
    } else if (size === 0) {
      size = bytes.length - at;
    }
    if (size < 8) {
      break;
    }
    at += size;
  }
  return boxes;
};

interface Decoded {
  frames: number;
  errors: string[];
  // The first frame's.
  first: {
    codedWidth: number;
    codedHeight: number;
    visibleRect: { x: number; y: number; width: number; height: number };
    displayWidth: number;
    displayHeight: number;
    format: string | null;
  } | null;
}

// Decodes a file of the app's on the device with the track's decoder config
// and `ctx.config` on top (e.g. hardwareAcceleration), without the members
// named in `drop`.
const decodeOnDevice = (file: string, config: object, drop: string[] = []) =>
  runOnDevice<Decoded>(
    ({ mediabunny: mb, webcodecs: wc, ctx }) => {
      const input = new mb.Input({
        source: new mb.CustomSource(wc.fileSourceOptions(ctx.file)),
        formats: mb.ALL_FORMATS,
      });
      return input.getPrimaryVideoTrack().then((track: any) =>
        track.getDecoderConfig().then((trackConfig: any) => {
          const result: Decoded = { frames: 0, errors: [], first: null };
          const decoder = new wc.VideoDecoder({
            output: (frame: any) => {
              if (!result.first) {
                const r = frame.visibleRect;
                result.first = {
                  codedWidth: frame.codedWidth,
                  codedHeight: frame.codedHeight,
                  visibleRect: {
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    height: r.height,
                  },
                  displayWidth: frame.displayWidth,
                  displayHeight: frame.displayHeight,
                  format: frame.format,
                };
              }
              result.frames++;
              frame.close();
            },
            error: (e: any) => result.errors.push(String(e)),
          });
          const merged = Object.assign({}, trackConfig, ctx.config);
          for (const name of ctx.drop) {
            delete merged[name];
          }
          decoder.configure(merged);
          const packets = new mb.EncodedPacketSink(track).packets();
          // Stops at an error: the decoder is closed then.
          const step = (): Promise<void> =>
            packets.next().then((r: any) => {
              if (r.done || decoder.state === "closed") {
                return undefined;
              }
              decoder.decode(r.value.toEncodedVideoChunk());
              return step();
            });
          return step()
            .then(() =>
              decoder.state === "closed" ? undefined : decoder.flush(),
            )
            .catch((e: any) => {
              result.errors.push(`flush: ${e}`);
            })
            .then(() => {
              if (decoder.state !== "closed") {
                decoder.close();
              }
              input.dispose();
              return result;
            });
        }),
      );
    },
    { file, config, drop },
    120000,
  );

// The codecs the app allocated since `logcatClear()` (Android).
const logcatClear = () => adb(["logcat", "-c"]);
const allocatedCodecs = () =>
  adb(["logcat", "-d", "-s", "CCodec:D"])
    .toString()
    .split("\n")
    .map((line) => /allocate\(([^)]+)\)/.exec(line)?.[1])
    .filter((name): name is string => !!name);

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
    // AAC-LC, as configured ("mp4a.40.2").
    expect(
      probe(local).streams.find((s) => s.codec_type === "audio")?.profile,
    ).toBe("LC");
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

  // Android: an odd size is not read aligned up (the encoder would be given
  // the odd size, which encoders aligned to 2 refuse at configure time).
  it("answers isConfigSupported false for odd sizes on Android", async () => {
    if (client.OS !== "android") {
      return;
    }
    const result = (await client.eval(({ webcodecs: wc }) =>
      Promise.all(
        [
          [1279, 720],
          [641, 481],
          [1280, 720],
        ].map(([width, height]) =>
          wc.VideoEncoder.isConfigSupported({
            codec: "avc1.42001f",
            width,
            height,
          }).then((support: any) => support.supported),
        ),
      ),
    )) as any;
    expect(result).toEqual([false, false, true]);
  }, 60000);

  // The frame rate and bitrate are hints, as in Media3: an encoder is not
  // refused for them (the emulator's c2.android.avc.encoder lists at most
  // 12 Mbps, and about 30 fps at 1080x1920). The bitrate is clamped into the
  // encoder's range, the frame rate floored, and below 1 ignored.
  it("treats framerate and bitrate as hints", async () => {
    if (!supported()) {
      return;
    }
    const result = (await client.eval(({ webcodecs: wc }) => {
      const configs = [
        { codec: "avc1.42001f", width: 1280, height: 720, bitrate: 100e6 },
        { codec: "avc1.42001f", width: 1080, height: 1920, framerate: 120 },
        { codec: "avc1.42001f", width: 640, height: 480, framerate: 0.5 },
      ];
      const run = (config: any) =>
        wc.VideoEncoder.isConfigSupported(config).then((support: any) => {
          const chunks: number[] = [];
          const errors: string[] = [];
          const encoder = new wc.VideoEncoder({
            output: (chunk: any) => chunks.push(chunk.byteLength),
            error: (e: any) => errors.push(`${e.name}: ${e.message}`),
          });
          encoder.configure(config);
          const pool = wc.createSurfacePool(config.width, config.height);
          [0, 33333, 66666].forEach((timestamp) => {
            const frame = new wc.VideoFrame(pool.acquire(), { timestamp });
            encoder.encode(frame, { keyFrame: timestamp === 0 });
            frame.close();
          });
          return encoder
            .flush()
            .catch((e: any) => errors.push(`flush: ${e.name}: ${e.message}`))
            .then(() => {
              if (encoder.state !== "closed") {
                encoder.close();
              }
              return {
                supported: support.supported,
                chunks: chunks.filter((n) => n > 0).length,
                errors,
              };
            });
        });
      // One at a time: a 1080x1920 software encode next to another one is
      // slow on the emulator.
      return configs.reduce(
        (done: Promise<any[]>, config) =>
          done.then((all) => run(config).then((r: any) => [...all, r])),
        Promise.resolve([]),
      );
    })) as any[];
    expect(result).toEqual([
      { supported: true, chunks: 3, errors: [] },
      { supported: true, chunks: 3, errors: [] },
      { supported: true, chunks: 3, errors: [] },
    ]);
  }, 120000);

  // AudioEncoder alone, fed a 440 Hz sine in 1000-frame AudioData (not
  // multiples of an AAC frame): `segments` runs, each from its own start
  // time and followed by a flush. Returns each chunk's timestamp and
  // duration, in µs, per run.
  const encodeAac = (segments: { start: number; seconds: number }[]) =>
    client.eval(
      ({ webcodecs: wc, ctx }) => {
        const rate = 48000;
        const runs: (number | string)[][][] = [];
        let run: (number | string)[][] = [];
        const encoder = new wc.AudioEncoder({
          output: (chunk: any) => run.push([chunk.timestamp, chunk.duration]),
          error: (e: any) => run.push([-1, String(e)]),
        });
        encoder.configure({
          codec: "mp4a.40.2",
          sampleRate: rate,
          numberOfChannels: 1,
          bitrate: 128000,
        });
        const segment = (i: number): Promise<void> => {
          if (i >= ctx.segments.length) {
            return Promise.resolve();
          }
          const { start, seconds } = ctx.segments[i];
          const total = Math.round(seconds * rate);
          for (let at = 0; at < total; at += 1000) {
            const frames = Math.min(1000, total - at);
            const data = new Float32Array(frames);
            for (let f = 0; f < frames; f++) {
              data[f] = 0.5 * Math.sin((2 * Math.PI * 440 * (at + f)) / rate);
            }
            const audio = new wc.AudioData({
              format: "f32",
              sampleRate: rate,
              numberOfFrames: frames,
              numberOfChannels: 1,
              timestamp: start + Math.round((at * 1e6) / rate),
              data,
            });
            encoder.encode(audio);
            audio.close();
          }
          return encoder.flush().then(() => {
            runs.push(run);
            run = [];
            return segment(i + 1);
          });
        };
        return segment(0).then(() => {
          encoder.close();
          return runs;
        });
      },
      { ctx: { segments } },
    ) as Promise<number[][][]>;

  const FRAME_US = (1024 * 1e6) / 48000;

  it("encodes 1 s of sound to 1 s of AAC, in steps of one frame", async () => {
    if (!supported()) {
      return;
    }
    const [chunks] = await encodeAac([{ start: 0, seconds: 1 }]);
    expect(chunks.filter(([t]) => t < 0)).toEqual([]);
    const [first] = chunks;
    const last = chunks[chunks.length - 1];
    // Every sample is in (the last frame padded), plus the encoder's
    // priming, which is not trimmed.
    expect(last[0] + last[1] - first[0]).toBeGreaterThanOrEqual(1e6);
    expect(first[0]).toBe(0);
    for (let i = 1; i < chunks.length; i++) {
      expect(
        Math.abs(chunks[i][0] - chunks[i - 1][0] - FRAME_US),
      ).toBeLessThanOrEqual(1);
    }
  }, 60000);

  it("starts the AAC timeline over after a flush", async () => {
    if (!supported()) {
      return;
    }
    const [, second] = await encodeAac([
      { start: 0, seconds: 0.5 },
      { start: 5e6, seconds: 0.5 },
    ]);
    expect(second.length).toBeGreaterThan(0);
    expect(second[0][0]).toBe(5e6);
  }, 60000);

  // WebCodecs: flush() outputs what was encoded, so nothing when nothing was
  // (no padding of silence), before the first encode() or right after
  // another flush().
  it("outputs no AAC from a flush with nothing encoded", async () => {
    if (!supported()) {
      return;
    }
    const [before, sound, after] = await encodeAac([
      { start: 0, seconds: 0 },
      { start: 0, seconds: 0.5 },
      { start: 1e6, seconds: 0 },
    ]);
    expect(before).toEqual([]);
    expect(sound.filter(([t]) => t < 0)).toEqual([]);
    expect(sound.length).toBeGreaterThan(0);
    expect(sound[0][0]).toBe(0);
    expect(after).toEqual([]);
  }, 60000);

  // AudioDecoder.flush() with nothing queued (first thing after configure,
  // and right after another flush) settles at once and outputs nothing; the
  // decoder then decodes the whole sound, twice over, with flushes between.
  // (On Android an end of stream queued as the first input, or a codec
  // flushed before any output format, can lose the AAC config: b/141097367.)
  it("flushes an AudioDecoder with nothing queued, then decodes after flushes", async () => {
    if (!supported()) {
      return;
    }
    const sound = await pushAsset("sine-8s.m4a");
    const result = await runOnDevice<any>(
      ({ mediabunny: mb, webcodecs: wc, ctx }) => {
        const input = new mb.Input({
          source: new mb.CustomSource(wc.fileSourceOptions(ctx.file)),
          formats: mb.ALL_FORMATS,
        });
        return input.getPrimaryAudioTrack().then((track: any) =>
          track.getDecoderConfig().then((config: any) => {
            const errors: string[] = [];
            let frames = 0;
            let sum = 0;
            let count = 0;
            const decoder = new wc.AudioDecoder({
              output: (data: any) => {
                frames += data.numberOfFrames;
                const samples = new Float32Array(
                  data.numberOfFrames * data.numberOfChannels,
                );
                data.copyTo(samples, { planeIndex: 0, format: "f32" });
                for (let i = 0; i < samples.length; i++) {
                  sum += samples[i] * samples[i];
                }
                count += samples.length;
                data.close();
              },
              error: (e: any) => errors.push(String(e)),
            });
            decoder.configure(config);
            const timedFlush = () => {
              const before = frames;
              const t0 = Date.now();
              return decoder
                .flush()
                .then(() => ({ ms: Date.now() - t0, frames: frames - before }));
            };
            const pass = () => {
              const before = frames;
              let packetCount = 0;
              const packets = new mb.EncodedPacketSink(track).packets();
              const step = (): Promise<void> =>
                packets.next().then((r: any) => {
                  if (r.done) {
                    return undefined;
                  }
                  packetCount++;
                  decoder.decode(r.value.toEncodedAudioChunk());
                  return step();
                });
              sum = 0;
              count = 0;
              return step()
                .then(() => decoder.flush())
                .then(() => ({
                  packets: packetCount,
                  frames: frames - before,
                  rms: Math.sqrt(sum / Math.max(1, count)),
                }));
            };
            const out: any = { errors };
            return timedFlush()
              .then((first: any) => {
                out.first = first;
                return pass();
              })
              .then((one: any) => {
                out.one = one;
                return timedFlush();
              })
              .then((again: any) => {
                out.again = again;
                return pass();
              })
              .then((two: any) => {
                out.two = two;
                decoder.close();
                input.dispose();
                return out;
              });
          }),
        );
      },
      { file: sound },
      120000,
    );
    expect(result.errors).toEqual([]);
    expect(result.first.frames).toBe(0);
    expect(result.first.ms).toBeLessThan(1000);
    expect(result.again.frames).toBe(0);
    expect(result.again.ms).toBeLessThan(1000);
    for (const run of [result.one, result.two]) {
      // One AAC frame per packet, give or take the decoder's priming and
      // tail (out of scope here).
      expect(run.frames).toBeGreaterThan((run.packets - 4) * 1024);
      expect(run.frames).toBeLessThanOrEqual((run.packets + 1) * 1024);
      // The sine, not silence.
      expect(run.rms).toBeGreaterThan(0.01);
    }
    expect(Math.abs(result.two.frames - result.one.frames)).toBeLessThanOrEqual(
      2048,
    );
  }, 180000);

  it("flushes a VideoEncoder given two frames with one timestamp", async () => {
    if (!supported()) {
      return;
    }
    const result = (await client.eval(({ webcodecs: wc }) => {
      const chunks: number[] = [];
      const errors: string[] = [];
      const encoder = new wc.VideoEncoder({
        output: (chunk: any) => chunks.push(chunk.timestamp),
        error: (e: any) => errors.push(String(e)),
      });
      encoder.configure({ codec: "avc1.42001f", width: 64, height: 64 });
      const pool = wc.createSurfacePool(64, 64);
      [0, 0, 33333, 66666].forEach((timestamp) => {
        const frame = new wc.VideoFrame(pool.acquire(), { timestamp });
        encoder.encode(frame, { keyFrame: timestamp === 0 });
        frame.close();
      });
      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve("timeout"), 15000),
      );
      return Promise.race([
        encoder.flush().then(
          () => "flushed",
          (e: any) => `${e.name}: ${e.message}`,
        ),
        timeout,
      ]).then((flushed: any) => {
        const queue = encoder.encodeQueueSize;
        encoder.close();
        return { flushed, chunks, errors, queue };
      });
    })) as any;
    expect(result.errors).toEqual([]);
    expect(result.flushed).toBe("flushed");
    expect(result.queue).toBe(0);
    expect(result.chunks.length).toBeGreaterThanOrEqual(3);
  }, 60000);

  it("writes into missing directories and reads percent-encoded file:// URLs", async () => {
    if (!supported()) {
      return;
    }
    const result = (await client.eval(({ webcodecs: wc }) => {
      const written = wc.writeFile(
        "e2e dir/nested/data.bin",
        new Uint8Array([1, 2, 3, 4, 5]),
      ) as string;
      const url = `file://${written.split("/").map(encodeURIComponent).join("/")}`;
      const source = wc.fileSourceOptions(url);
      return Promise.resolve(source.read(0, 5)).then((bytes: Uint8Array) => {
        const size = source.getSize();
        source.dispose();
        const writable = wc.createFileWritable("e2e dir/other/stream.bin");
        const writer = writable.writable.getWriter();
        return writer
          .write({ type: "write", data: new Uint8Array([9, 9]), position: 0 })
          .then(() => writer.close())
          .then(() => {
            wc.removeFile(writable.path);
            wc.removeFile(written);
            return { size, bytes: Array.from(bytes), url };
          });
      });
    })) as any;
    expect(result.size).toBe(5);
    expect(result.bytes).toEqual([1, 2, 3, 4, 5]);
  }, 60000);

  // x264's High profile reorders frames (B-frames): the decoder must still
  // output them in presentation order, as WebCodecs does, whatever order
  // the platform's decoder returns them in.
  it("decodes a video with B-frames into frames in presentation order", async () => {
    if (!supported() || !probes()) {
      return;
    }
    const file = await sourceClip(false);
    const out = await runOnDevice<(number | string)[]>(
      ({ mediabunny: mb, webcodecs: wc, ctx }) => {
        const input = new mb.Input({
          source: new mb.CustomSource(wc.fileSourceOptions(ctx.file)),
          formats: mb.ALL_FORMATS,
        });
        return input.getPrimaryVideoTrack().then((track: any) =>
          track.getDecoderConfig().then((config: any) => {
            const times: (number | string)[] = [];
            const decoder = new wc.VideoDecoder({
              output: (frame: any) => {
                times.push(frame.timestamp);
                frame.close();
              },
              error: (e: any) => times.push(String(e)),
            });
            decoder.configure(config);
            const packets = new mb.EncodedPacketSink(track).packets();
            const step = (): Promise<void> =>
              packets.next().then((r: any) => {
                if (r.done) {
                  return undefined;
                }
                decoder.decode(r.value.toEncodedVideoChunk());
                return step();
              });
            return step()
              .then(() => decoder.flush())
              .then(() => {
                decoder.close();
                input.dispose();
                return times;
              });
          }),
        );
      },
      { file },
      120000,
    );
    // The source does reorder: its packets are not stored in time order.
    const local = path.join(os.tmpdir(), "rnwc-e2e-clips", "clip.mp4");
    const stored = videoPacketTimes(local);
    expect(stored.some((t, i) => i > 0 && t < stored[i - 1])).toBe(true);
    expect(out.filter((t) => typeof t === "string")).toEqual([]);
    expect(out).toHaveLength(90);
    const times = out as number[];
    expect(times.filter((t, i) => i > 0 && t <= times[i - 1])).toEqual([]);
  }, 180000);

  // A flush with nothing decoded since configure() or the last flush has
  // nothing to wait for: it resolves at once, outputs nothing, and the
  // decoder decodes the whole clip after it, on either decoder.
  it("flushes a VideoDecoder with nothing queued, then decodes after flushes", async () => {
    if (!supported() || !probes()) {
      return;
    }
    const file = await sourceClip(false);
    const run = (hardwareAcceleration?: string) =>
      runOnDevice<any>(
        ({ mediabunny: mb, webcodecs: wc, ctx }) => {
          const input = new mb.Input({
            source: new mb.CustomSource(wc.fileSourceOptions(ctx.file)),
            formats: mb.ALL_FORMATS,
          });
          return input.getPrimaryVideoTrack().then((track: any) =>
            track.getDecoderConfig().then((config: any) => {
              const errors: string[] = [];
              let times: number[] = [];
              const decoder = new wc.VideoDecoder({
                output: (frame: any) => {
                  times.push(frame.timestamp);
                  frame.close();
                },
                error: (e: any) => errors.push(String(e)),
              });
              decoder.configure(
                ctx.hardwareAcceleration
                  ? Object.assign({}, config, {
                      hardwareAcceleration: ctx.hardwareAcceleration,
                    })
                  : config,
              );
              const timedFlush = () => {
                const before = times.length;
                const t0 = Date.now();
                return decoder.flush().then(() => ({
                  ms: Date.now() - t0,
                  frames: times.length - before,
                }));
              };
              const pass = () => {
                times = [];
                const packets = new mb.EncodedPacketSink(track).packets();
                const step = (): Promise<void> =>
                  packets.next().then((r: any) => {
                    if (r.done) {
                      return undefined;
                    }
                    decoder.decode(r.value.toEncodedVideoChunk());
                    return step();
                  });
                return step()
                  .then(() => decoder.flush())
                  .then(() => ({
                    frames: times.length,
                    unordered: times.filter(
                      (t, i) => i > 0 && t <= times[i - 1]!,
                    ).length,
                  }));
              };
              const out: any = { errors };
              return timedFlush()
                .then((r: any) => {
                  out.first = r;
                  return timedFlush();
                })
                .then((r: any) => {
                  out.second = r;
                  return pass();
                })
                .then((r: any) => {
                  out.one = r;
                  return timedFlush();
                })
                .then((r: any) => {
                  out.again = r;
                  return pass();
                })
                .then((r: any) => {
                  out.two = r;
                  decoder.close();
                  input.dispose();
                  return out;
                });
            }),
          );
        },
        { file, hardwareAcceleration },
        180000,
      );
    const plain = await run();
    const software = await run("prefer-software");
    console.log(`empty flush: ${JSON.stringify({ plain, software })}`);
    for (const result of [plain, software]) {
      const empty = { frames: 0, fast: true };
      const flushed = (r: { ms: number; frames: number }) => ({
        frames: r.frames,
        fast: r.ms < 200,
      });
      expect({
        errors: result.errors,
        first: flushed(result.first),
        second: flushed(result.second),
        again: flushed(result.again),
        one: result.one,
        two: result.two,
      }).toEqual({
        errors: [],
        first: empty,
        second: empty,
        again: empty,
        one: { frames: 90, unordered: 0 },
        two: { frames: 90, unordered: 0 },
      });
    }
  }, 400000);

  // JS holds every picture the decoder's ImageReader has (Android: 16) for
  // longer than the decoder's 5 s waits for a picture or an input buffer:
  // the decoder must wait for JS rather than drop, lose or fail any (our
  // drain renders one picture at a time, so the surface has nothing to
  // drop). iOS has no such limit and does not wait.
  it("loses no frame while JS holds every decoded picture for 12 s", async () => {
    if (!supported() || !probes()) {
      return;
    }
    const file = await sourceClip(false);
    const android = client.OS === "android";
    if (android) {
      logcatClear();
    }
    const result = await runOnDevice<any>(
      ({ mediabunny: mb, webcodecs: wc, ctx }) => {
        const input = new mb.Input({
          source: new mb.CustomSource(wc.fileSourceOptions(ctx.file)),
          formats: mb.ALL_FORMATS,
        });
        return input.getPrimaryVideoTrack().then((track: any) =>
          track.getDecoderConfig().then((config: any) => {
            const errors: string[] = [];
            const times: number[] = [];
            let held: any[] | null = [];
            let maxHeld = 0;
            const decoder = new wc.VideoDecoder({
              output: (frame: any) => {
                times.push(frame.timestamp);
                if (held) {
                  held.push(frame);
                  maxHeld = Math.max(maxHeld, held.length);
                  if (held.length === 1) {
                    setTimeout(() => {
                      for (const f of held!) {
                        f.close();
                      }
                      held = null;
                    }, ctx.holdMs);
                  }
                } else {
                  frame.close();
                }
              },
              error: (e: any) => errors.push(String(e)),
            });
            decoder.configure(config);
            const packets = new mb.EncodedPacketSink(track).packets();
            const step = (): Promise<void> =>
              packets.next().then((r: any) => {
                if (r.done || decoder.state === "closed") {
                  return undefined;
                }
                decoder.decode(r.value.toEncodedVideoChunk());
                return step();
              });
            const t0 = Date.now();
            return step()
              .then(() =>
                decoder.state === "closed" ? undefined : decoder.flush(),
              )
              .catch((e: any) => {
                errors.push(`flush: ${e}`);
              })
              .then(() => {
                if (decoder.state !== "closed") {
                  decoder.close();
                }
                input.dispose();
                return {
                  errors,
                  frames: times.length,
                  unordered: times.filter((t, i) => i > 0 && t <= times[i - 1]!)
                    .length,
                  maxHeld,
                  ms: Date.now() - t0,
                };
              });
          }),
        );
      },
      { file, holdMs: 12000 },
      180000,
    );
    const lost = android
      ? adb(["logcat", "-d"])
          .toString()
          .split("\n")
          .filter((line) => /did not reach the ImageReader/.test(line))
      : [];
    console.log(`held: ${JSON.stringify({ result, lost })}`);
    expect({
      errors: result.errors,
      frames: result.frames,
      unordered: result.unordered,
      lost,
      waited: android ? result.ms > 12000 : true,
    }).toEqual({
      errors: [],
      frames: 90,
      unordered: 0,
      lost: [],
      waited: true,
    });
  }, 300000);

  // close() while JS holds every picture and the decoder waits for it
  // (input and drain both blocked on Android) returns at once.
  it("closes a VideoDecoder at once while JS holds every decoded picture", async () => {
    if (!supported() || !probes()) {
      return;
    }
    const file = await sourceClip(false);
    const result = await runOnDevice<any>(
      ({ mediabunny: mb, webcodecs: wc, ctx }) => {
        const input = new mb.Input({
          source: new mb.CustomSource(wc.fileSourceOptions(ctx.file)),
          formats: mb.ALL_FORMATS,
        });
        return input.getPrimaryVideoTrack().then((track: any) =>
          track.getDecoderConfig().then((config: any) => {
            const errors: string[] = [];
            const held: any[] = [];
            const decoder = new wc.VideoDecoder({
              output: (frame: any) => held.push(frame),
              error: (e: any) => errors.push(String(e)),
            });
            decoder.configure(config);
            const packets = new mb.EncodedPacketSink(track).packets();
            const step = (): Promise<void> =>
              packets.next().then((r: any) => {
                if (r.done) {
                  return undefined;
                }
                decoder.decode(r.value.toEncodedVideoChunk());
                return step();
              });
            return step()
              .then(
                () => new Promise((resolve) => setTimeout(resolve, ctx.holdMs)),
              )
              .then(() => {
                const t0 = Date.now();
                decoder.close();
                const ms = Date.now() - t0;
                const frames = held.length;
                for (const f of held) {
                  f.close();
                }
                input.dispose();
                return { errors, frames, ms, state: decoder.state };
              });
          }),
        );
      },
      { file, holdMs: 7000 },
      120000,
    );
    console.log(`close held: ${JSON.stringify(result)}`);
    expect(result.errors).toEqual([]);
    expect(result.state).toBe("closed");
    expect(result.ms).toBeLessThan(1000);
    if (client.OS === "android") {
      expect(result.frames).toBe(16);
    }
  }, 180000);

  // hardwareAcceleration picks the decoder: "prefer-software" a software
  // one (on the emulator c2.android.avc.decoder rather than goldfish's),
  // "prefer-hardware" none of those. iOS takes the preference as a hint.
  it("decodes on a software decoder with hardwareAcceleration: prefer-software", async () => {
    if (!supported() || !probes()) {
      return;
    }
    const file = await sourceClip(false);
    const android = client.OS === "android";
    const run = async (hardwareAcceleration?: string) => {
      if (android) {
        logcatClear();
      }
      const decoded = await decodeOnDevice(
        file,
        hardwareAcceleration ? { hardwareAcceleration } : {},
      );
      const codecs = android
        ? allocatedCodecs().filter((name) => /decoder/.test(name))
        : [];
      return {
        frames: decoded.frames,
        errors: decoded.errors,
        format: decoded.first?.format,
        codecs,
      };
    };
    const software = await run("prefer-software");
    const hardware = await run("prefer-hardware");
    const plain = await run();
    console.log(`decoders: ${JSON.stringify({ software, hardware, plain })}`);
    const isSoftware = (name: string) =>
      /^(c2\.android\.|OMX\.google\.)/.test(name);
    expect({
      software: software.frames,
      hardware: hardware.frames,
      plain: plain.frames,
      errors: [...software.errors, ...hardware.errors, ...plain.errors],
      softwareDecoders: software.codecs.every(isSoftware),
      hardwareDecoders: hardware.codecs.some(isSoftware),
      formats: [software.format, hardware.format, plain.format],
    }).toEqual({
      software: 90,
      hardware: 90,
      plain: 90,
      errors: [],
      softwareDecoders: true,
      hardwareDecoders: false,
      // The decoder's own picture on Android, whatever its layout.
      formats: Array(3).fill(ios() ? "BGRA" : "NV12"),
    });
    if (android) {
      expect(software.codecs.length).toBeGreaterThan(0);
    }
  }, 300000);

  // A width that is not a multiple of 128 (360): Android's software decoder
  // pads its pictures to 384, and only the crop says where the picture is.
  // The frames must have the visible size, and an encoder given them must
  // take that region only: the red stripe on the right edge stays there,
  // and no padding comes in.
  it("decodes a 360x640 video to frames without the decoder's padding", async () => {
    if (!supported() || !probes()) {
      return;
    }
    const clip = path.join(clipDirectory, "clip-360x640.mp4");
    fs.mkdirSync(clipDirectory, { recursive: true });
    if (!fs.existsSync(clip)) {
      execFileSync("ffmpeg", [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=360x640:r=30:d=1",
        "-vf",
        "drawbox=x=344:y=0:w=16:h=640:color=red:t=fill,drawbox=x=0:y=624:w=360:h=16:color=yellow:t=fill",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        clip,
      ]);
    }
    const file = await pushFile(clip);
    const decoded = await runOnDevice<Decoded & { path: string }>(
      ({ mediabunny: mb, webcodecs: wc, ctx }) => {
        const input = new mb.Input({
          source: new mb.CustomSource(wc.fileSourceOptions(ctx.file)),
          formats: mb.ALL_FORMATS,
        });
        const target = new mb.BufferTarget();
        const output = new mb.Output({
          format: new mb.Mp4OutputFormat(),
          target,
        });
        const source = new mb.EncodedVideoPacketSource("avc");
        output.addVideoTrack(source, { frameRate: 30 });
        const result: any = { frames: 0, errors: [], first: null, path: "" };
        let written = Promise.resolve();
        const encoder = new wc.VideoEncoder({
          output: (chunk: any, meta: any) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            const packet = new mb.EncodedPacket(
              data,
              chunk.type,
              chunk.timestamp / 1e6,
              (chunk.duration || 0) / 1e6,
            );
            written = written.then(() => source.add(packet, meta));
          },
          error: (e: any) => result.errors.push(`encoder: ${e}`),
        });
        encoder.configure({
          codec: "avc1.42001f",
          width: 360,
          height: 640,
          framerate: 30,
        });
        return output.start().then(() =>
          input.getPrimaryVideoTrack().then((track: any) =>
            track.getDecoderConfig().then((trackConfig: any) => {
              const decoder = new wc.VideoDecoder({
                output: (frame: any) => {
                  if (!result.first) {
                    const r = frame.visibleRect;
                    result.first = {
                      codedWidth: frame.codedWidth,
                      codedHeight: frame.codedHeight,
                      visibleRect: {
                        x: r.x,
                        y: r.y,
                        width: r.width,
                        height: r.height,
                      },
                      displayWidth: frame.displayWidth,
                      displayHeight: frame.displayHeight,
                      format: frame.format,
                    };
                  }
                  encoder.encode(frame, { keyFrame: result.frames === 0 });
                  result.frames++;
                  frame.close();
                },
                error: (e: any) => result.errors.push(`decoder: ${e}`),
              });
              decoder.configure(
                Object.assign({}, trackConfig, {
                  hardwareAcceleration: "prefer-software",
                }),
              );
              const packets = new mb.EncodedPacketSink(track).packets();
              const step = (): Promise<void> =>
                packets.next().then((r: any) => {
                  if (r.done) {
                    return undefined;
                  }
                  decoder.decode(r.value.toEncodedVideoChunk());
                  return step();
                });
              return step()
                .then(() => decoder.flush())
                .then(() => encoder.flush())
                .then(() => written)
                .then(() => output.finalize())
                .then(() => {
                  decoder.close();
                  encoder.close();
                  input.dispose();
                  result.path = wc.writeFile("e2e-crop-out.mp4", target.buffer);
                  return result;
                });
            }),
          ),
        );
      },
      { file },
      120000,
    );
    const local = copyLocal(decoded.path);
    const px = {
      redEdge: pixel(local, 0, 355, 320),
      blue: pixel(local, 0, 300, 320),
      yellowBottom: pixel(local, 0, 180, 633),
    };
    console.log(`crop: ${JSON.stringify({ ...decoded, px })}`);
    const is = (p: number[], rgb: boolean[]) =>
      p.every((v, i) => (rgb[i] ? v > 170 : v < 90));
    expect({
      frames: decoded.frames,
      errors: decoded.errors,
      visibleRect: decoded.first?.visibleRect,
      codedWidth: decoded.first?.codedWidth,
      codedHeight: decoded.first?.codedHeight,
      displayWidth: decoded.first?.displayWidth,
      displayHeight: decoded.first?.displayHeight,
      format: decoded.first?.format,
      redEdge: is(px.redEdge, [true, false, false]),
      blue: is(px.blue, [false, false, true]),
      yellowBottom: is(px.yellowBottom, [true, true, false]),
    }).toEqual({
      frames: 30,
      errors: [],
      visibleRect: { x: 0, y: 0, width: 360, height: 640 },
      codedWidth: 360,
      codedHeight: 640,
      displayWidth: 360,
      displayHeight: 640,
      format: ios() ? "BGRA" : "NV12",
      redEdge: true,
      blue: true,
      yellowBottom: true,
    });
  }, 300000);

  // A config without codedWidth/codedHeight (allowed: the avcC has the
  // size): the decoder must still take a 4K key frame. Sized for 1920x1080,
  // Android's software decoder has 2 MiB input buffers, and this key frame
  // is about 3.4 MB.
  it("decodes 4K key frames from a config without a coded size", async () => {
    if (!supported() || !probes()) {
      return;
    }
    const clip = path.join(clipDirectory, "clip-4k-noise.mp4");
    fs.mkdirSync(clipDirectory, { recursive: true });
    if (!fs.existsSync(clip)) {
      execFileSync("ffmpeg", [
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "nullsrc=s=3840x2160:r=30:d=0.2,geq=lum='random(1)*255':cb=128:cr=128",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-qp",
        "38",
        "-g",
        "1",
        clip,
      ]);
    }
    const sizes = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=size",
        "-of",
        "csv=p=0",
        clip,
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .map(Number);
    // Larger than 2 MiB, smaller than 4K's own 0.75 byte per pixel.
    expect(sizes[0]).toBeGreaterThan(2.2e6);
    expect(sizes[0]).toBeLessThan(5.5e6);
    const file = await pushFile(clip);
    const android = client.OS === "android";
    const run = async (config: object) => {
      if (android) {
        logcatClear();
      }
      const decoded = await decodeOnDevice(file, config, [
        "codedWidth",
        "codedHeight",
        "displayAspectWidth",
        "displayAspectHeight",
      ]);
      const codecs = android
        ? allocatedCodecs().filter((name) => /decoder/.test(name))
        : [];
      return {
        frames: decoded.frames,
        errors: decoded.errors,
        width: decoded.first?.visibleRect.width,
        height: decoded.first?.visibleRect.height,
        codecs,
      };
    };
    const software = await run({ hardwareAcceleration: "prefer-software" });
    const plain = await run({});
    console.log(`4k: ${JSON.stringify({ sizes, software, plain })}`);
    const frames = {
      frames: sizes.length,
      errors: [],
      width: 3840,
      height: 2160,
    };
    expect({
      software: { ...software, codecs: undefined },
      plain: { ...plain, codecs: undefined },
    }).toEqual({
      software: { ...frames, codecs: undefined },
      plain: { ...frames, codecs: undefined },
    });
    if (android) {
      expect(software.codecs.length).toBeGreaterThan(0);
      expect(
        software.codecs.every((name) =>
          /^(c2\.android\.|OMX\.google\.)/.test(name),
        ),
      ).toBe(true);
    }
  }, 300000);

  // The example app's screens, through its own code (example/src/Tests.tsx
  // hands it over): the Lottie share card exported as the Video Export
  // screens do, and videos compressed as the Compress screen does.
  describe("the example app", () => {
    // The card: 7 s at 30 fps, 1080x1920.
    const CARD_FRAMES = 210;
    const CARD_SECONDS = 7;

    it("exports the Lottie card to H.264, silent", async () => {
      if (!supported()) {
        return;
      }
      const result = await exportCard({ hdr: false, sound: false });
      const local = copyLocal(result.path);
      if (!probes()) {
        return;
      }
      const { streams } = probe(local);
      expectCardVideo(streams, "h264");
      expect(streams.some((s) => s.codec_type === "audio")).toBe(false);
    }, 600000);

    it("exports the Lottie card to H.264 with its sound", async () => {
      if (!supported()) {
        return;
      }
      const result = await exportCard({ hdr: false, sound: true });
      if (!probes()) {
        return;
      }
      const { streams } = probe(copyLocal(result.path));
      const video = expectCardVideo(streams, "h264");
      const audio = streams.find((s) => s.codec_type === "audio")!;
      expect(audio.codec_name).toBe("aac");
      // Cut where the video ends: the last AAC frame (21 ms at 48 kHz)
      // starts before it.
      expect(
        Math.abs(Number(audio.duration) - Number(video.duration)),
      ).toBeLessThan(0.05);
    }, 600000);

    // HEVC Main 10 on iOS, AV1 Main 10 on Android, where a device without
    // a 10-bit AV1 encoder (the emulator) skips it.
    it("exports the Lottie card to 10-bit HLG", async () => {
      if (!supported()) {
        return;
      }
      let result: CardExport;
      try {
        result = await exportCard({ hdr: true, sound: false });
      } catch (e) {
        // The app's own check (isConfigSupported): the Android emulator's
        // software AV1 encoder has no 10-bit profile.
        if (/has no .* Main 10 encoder/.test(String(e))) {
          console.log(`HDR skipped: ${String(e)}`);
          return;
        }
        throw e;
      }
      if (!probes()) {
        return;
      }
      const { streams } = probe(copyLocal(result.path));
      const video = expectCardVideo(streams, ios() ? "hevc" : "av1");
      expect(video.profile).toBe(ios() ? "Main 10" : "Main");
      expect(video.pix_fmt).toBe("yuv420p10le");
      expect(video.color_transfer).toBe("arib-std-b67");
      expect(video.color_primaries).toBe("bt2020");
      expect(video.color_space).toBe("bt2020nc");
    }, 1500000);

    // 3 s of 1280x720 H.264 at 30 fps with an AAC sine, made here with
    // ffmpeg (no video files in the repository); the second is tagged to
    // play turned 90° clockwise, as a phone's portrait recording is.
    const SOURCE_SECONDS = 3;

    it.each(["avc", "hevc", "av1"])(
      "compresses a video to %s, if the device encodes it",
      async (codec) => {
        if (!supported() || !probes()) {
          return;
        }
        const run = await compressOnDevice(await sourceClip(false), {
          codec,
        });
        if (run.skipped) {
          console.log(`${codec}: not in supportedCodecs (${run.supported})`);
          return;
        }
        expectCompressed(run, {
          codec: { avc: "h264", hevc: "hevc", av1: "av1" }[codec]!,
          width: 854,
          height: 480,
          frameRate: 30,
          audio: true,
        });
      },
      600000,
    );

    it("compresses a video without its sound", async () => {
      if (!supported() || !probes()) {
        return;
      }
      const run = await compressOnDevice(await sourceClip(false), {
        audio: false,
      });
      expectCompressed(run, {
        codec: "h264",
        width: 854,
        height: 480,
        frameRate: 30,
        audio: false,
      });
    }, 600000);

    it("compresses a video to another frame rate", async () => {
      if (!supported() || !probes()) {
        return;
      }
      const run = await compressOnDevice(await sourceClip(false), {
        frameRate: 15,
      });
      expectCompressed(run, {
        codec: "h264",
        width: 854,
        height: 480,
        frameRate: 15,
        audio: true,
      });
    }, 600000);

    it("compresses a phone's portrait video upright", async () => {
      if (!supported() || !probes()) {
        return;
      }
      const run = await compressOnDevice(await sourceClip(true), {});
      expect(run.source.rotation).toBe(90);
      expect([run.source.width, run.source.height]).toEqual([720, 1280]);
      expectCompressed(run, {
        codec: "h264",
        width: 480,
        height: 854,
        frameRate: 30,
        audio: true,
      });
    }, 600000);

    const expectCardVideo = (streams: Probed[], codec: string) => {
      const video = streams.find((s) => s.codec_type === "video")!;
      expect(video.codec_name).toBe(codec);
      expect(video.width).toBe(1080);
      expect(video.height).toBe(1920);
      expect(Number(video.nb_read_packets)).toBe(CARD_FRAMES);
      expect(Number(video.duration)).toBeCloseTo(CARD_SECONDS, 2);
      return video;
    };

    const expectCompressed = (
      run: Compressed,
      want: {
        codec: string;
        width: number;
        height: number;
        frameRate: number;
        audio: boolean;
      },
    ) => {
      expect([run.result.width, run.result.height]).toEqual([
        want.width,
        want.height,
      ]);
      expect([run.target.width, run.target.height]).toEqual([
        want.width,
        want.height,
      ]);
      const local = copyLocal(run.result.path);
      const { streams } = probe(local);
      const video = streams.find((s) => s.codec_type === "video")!;
      expect(video.codec_name).toBe(want.codec);
      expect([video.width, video.height]).toEqual([want.width, want.height]);
      // No rotation tag left: the frames are upright.
      expect(rotationOf(video)).toBe(0);
      expect(
        Math.abs(Number(video.duration) - SOURCE_SECONDS),
      ).toBeLessThanOrEqual(1 / want.frameRate + 1e-3);
      expect(Number(video.nb_read_packets)).toBe(
        SOURCE_SECONDS * want.frameRate,
      );
      expect(streams.some((s) => s.codec_type === "audio")).toBe(want.audio);
      // In order: the encoders make no B-frames, so each frame is later than
      // the one before it (frames decoded out of order would not be).
      const times = videoPacketTimes(local);
      expect(times.filter((t, i) => i > 0 && t <= times[i - 1]).length).toBe(0);
      // Fast start: the index ahead of the media.
      const boxes = topLevelBoxes(local);
      expect(boxes.indexOf("moov")).toBeGreaterThanOrEqual(0);
      expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));
      console.log(
        `compressed to ${want.codec} ${want.width}x${want.height}@${want.frameRate}${want.audio ? " + AAC" : ""}: ${run.result.size} bytes in ${Math.round(run.result.ms)} ms`,
      );
    };
  });

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

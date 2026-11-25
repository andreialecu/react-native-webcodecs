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

// Android debug builds: a fault the video encoder acts out from its next
// codec on (see EncoderFault in VideoEncoder.hpp); "" for none. The property
// outlives the app: reset it in a finally.
const setFault = (value: string) =>
  adb([
    "shell",
    "setprop",
    "debug.webcodecs.fault",
    value === "" ? '""' : value,
  ]);

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
    device: GPUDevice;
    ctx: any;
  }) => Promise<R>,
  ctx: object,
  limitMs: number,
): Promise<R> => {
  const key = `__e2e_${Math.random().toString(36).slice(2)}`;
  await client.eval(
    ({ example, mediabunny, webcodecs, device, ctx: c }) => {
      const g = globalThis as any;
      const run = eval(`(${c.fn})`);
      g[c.key] = null;
      Promise.resolve()
        .then(() =>
          run({ example, mediabunny, webcodecs, device, ctx: c.args }),
        )
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

  // Android: createSurfacePool asks AHardwareBuffer_isSupported whether
  // RGBA16F buffers the CPU can read (the HDR encoder converts them to P010)
  // can be made, and refuses the pool up front when not. The emulator can:
  // its pool is made, and its buffers allocated.
  it("creates an RGBA16F surface pool where the device can read one (Android)", async () => {
    if (client.OS !== "android") {
      return;
    }
    const result = (await client.eval(({ webcodecs: wc }) => {
      try {
        const pool = wc.createSurfacePool(64, 32, "RGBA16F");
        const surface = pool.acquire();
        const out = {
          format: surface.format,
          width: surface.width,
          height: surface.height,
        };
        surface.release();
        return out;
      } catch (e: any) {
        return { error: `${e.name}: ${e.message}` };
      }
    })) as any;
    expect(result).toEqual({ format: "RGBA16F", width: 64, height: 32 });
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

  // The SPS (avcC) of the output: the codec string's profile, and a level no
  // higher than its own when the size fits in it (raised when it does not).
  // Android configures the encoder with the level along with the profile
  // (OMX encoders refuse a profile alone), the codec string's rather than
  // the encoder's highest; iOS picks the lowest that fits. An encoder
  // without the profile gets the next one down that it lists: the emulator's
  // c2.android.avc.encoder (libavc) has no High, and gives Main for
  // avc1.640028 (it gave its default, Baseline, before).
  it("encodes H.264 in the codec string's profile and level", async () => {
    if (!supported()) {
      return;
    }
    if (client.OS === "android") {
      logcatClear();
    }
    const result = (await client.eval(({ webcodecs: wc }) => {
      const configs = [
        { codec: "avc1.640028", width: 1280, height: 720 },
        { codec: "avc1.4d0028", width: 1280, height: 720 },
        { codec: "avc1.42001f", width: 640, height: 480 },
        { codec: "avc1.42001f", width: 1920, height: 1080 },
      ];
      const run = (config: any) => {
        let avcC: number[] = [];
        const errors: string[] = [];
        let chunks = 0;
        const encoder = new wc.VideoEncoder({
          output: (chunk: any, meta: any) => {
            chunks += chunk.byteLength > 0 ? 1 : 0;
            const d = meta?.decoderConfig?.description;
            if (d && avcC.length === 0) {
              const bytes = ArrayBuffer.isView(d)
                ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
                : new Uint8Array(d);
              avcC = [bytes[1], bytes[3]];
            }
          },
          error: (e: any) => errors.push(`${e.name}: ${e.message}`),
        });
        encoder.configure(config);
        const pool = wc.createSurfacePool(config.width, config.height);
        [0, 33333, 66666, 100000, 133333].forEach((timestamp) => {
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
            return { codec: config.codec, avcC, chunks, errors };
          });
      };
      return configs.reduce(
        (done: Promise<any[]>, config) =>
          done.then((all) => run(config).then((r: any) => [...all, r])),
        Promise.resolve([]),
      );
    })) as any[];
    for (const run of result) {
      expect(run.errors).toEqual([]);
      expect(run.chunks).toBe(5);
    }
    const [high, main, baseline, baseline1080] = result.map((r) => r.avcC);
    if (ios()) {
      expect(high[0]).toBe(100);
    } else {
      expect([100, 77]).toContain(high[0]);
    }
    expect(main[0]).toBe(77);
    expect(baseline[0]).toBe(66);
    expect(baseline1080[0]).toBe(66);
    // Within the codec string's level, or raised to 4.0 for 1080p.
    expect(high[1]).toBeLessThanOrEqual(40);
    expect(main[1]).toBeLessThanOrEqual(40);
    expect(baseline[1]).toBeLessThanOrEqual(31);
    expect(baseline1080[1]).toBeGreaterThanOrEqual(40);
    if (client.OS === "android") {
      expect([high[1], main[1], baseline[1], baseline1080[1]]).toEqual([
        40, 40, 31, 40,
      ]);
      // The first attempt took each config.
      const attempts = adb(["logcat", "-d", "-s", "WebCodecs:I"])
        .toString()
        .split("\n")
        .map((line) => /video encoder: .*: attempt (\d+)/.exec(line)?.[1])
        .filter((n): n is string => !!n);
      expect(attempts).toEqual(["0", "0", "0", "0"]);
    }
  }, 120000);

  // A config no encoder takes: NotSupportedError, and on Android a message
  // naming each encoder tried and the status of each configure attempt
  // (MediaCodec's own, e.g. NO_MEMORY -12 on a device out of codec memory).
  it("says which encoders refused a config and why", async () => {
    if (!supported()) {
      return;
    }
    const result = (await client.eval(({ webcodecs: wc }) => {
      const errors: string[] = [];
      const encoder = new wc.VideoEncoder({
        output: () => undefined,
        error: (e: any) => errors.push(`${e.name}: ${e.message}`),
      });
      encoder.configure({ codec: "avc1.42001f", width: 16384, height: 16384 });
      return new Promise((resolve) => setTimeout(resolve, 100)).then(() => ({
        errors,
        state: encoder.state,
      }));
    })) as any;
    expect(result.state).toBe("closed");
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/^NotSupportedError: /);
    if (client.OS === "android") {
      const [message] = result.errors as string[];
      expect(message).toContain("c2.android.avc.encoder");
      // Every attempt, with the status by name: three with Baseline and its
      // level, three without.
      expect(message.match(/-10000 AMEDIA_ERROR_UNKNOWN/g)?.length).toBe(6);
    }
  }, 60000);

  // bitrateMode: VideoToolbox takes no per-frame quantizer outside its
  // low-latency H.264 mode, so iOS refuses "quantizer" (Android takes the
  // config and encodes at its default bitrate). "constant" (CBR where the
  // encoder has it, else the average bitrate) and "variable" (the average
  // bitrate, capped at 1.5x over each second on iOS) encode on both.
  it("refuses bitrateMode quantizer on iOS, and encodes constant and variable", async () => {
    if (!supported()) {
      return;
    }
    const result = (await client.eval(({ webcodecs: wc }) => {
      const base = { codec: "avc1.42001f", width: 640, height: 480 };
      const run = (bitrateMode: string) => {
        const config = Object.assign({}, base, {
          bitrateMode,
          bitrate: bitrateMode === "quantizer" ? undefined : 1_000_000,
        });
        return wc.VideoEncoder.isConfigSupported(config).then(
          (support: any) => {
            if (bitrateMode === "quantizer") {
              return { bitrateMode, supported: support.supported };
            }
            const chunks: number[] = [];
            const errors: string[] = [];
            const encoder = new wc.VideoEncoder({
              output: (chunk: any) => chunks.push(chunk.byteLength),
              error: (e: any) => errors.push(`${e.name}: ${e.message}`),
            });
            encoder.configure(config);
            const pool = wc.createSurfacePool(base.width, base.height);
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
                  bitrateMode,
                  supported: support.supported,
                  chunks: chunks.filter((n) => n > 0).length,
                  errors,
                };
              });
          },
        );
      };
      return ["quantizer", "constant", "variable"].reduce(
        (done: Promise<any[]>, mode) =>
          done.then((all) => run(mode).then((r: any) => all.concat([r]))),
        Promise.resolve([]),
      );
    })) as any[];
    expect(result).toEqual([
      { bitrateMode: "quantizer", supported: !ios() },
      { bitrateMode: "constant", supported: true, chunks: 3, errors: [] },
      { bitrateMode: "variable", supported: true, chunks: 3, errors: [] },
    ]);
  }, 120000);

  // A Mediabunny Quality without a bitrate (QUALITY_HIGH) tries a quantizer
  // config first, then a bitrate one. iOS refuses the quantizer, so the
  // encoder gets a bitrate rather than running at VideoToolbox's default
  // rate; Android takes the quantizer config, as before.
  it("configures a bitrate for a Mediabunny Quality preset on iOS", async () => {
    if (!supported()) {
      return;
    }
    const result = (await client.eval(({ mediabunny: mb, webcodecs: wc }) => {
      wc.installWebCodecs();
      const configs: any[] = [];
      const proto = wc.VideoEncoder.prototype;
      const { configure } = proto;
      proto.configure = function (this: any, config: any) {
        configs.push({
          bitrate: config.bitrate,
          bitrateMode: config.bitrateMode,
        });
        return configure.call(this, config);
      };
      const output = new mb.Output({
        format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }),
        target: new mb.BufferTarget(),
      });
      const video = new mb.VideoSampleSource({
        codec: "avc",
        quality: mb.QUALITY_HIGH,
      });
      output.addVideoTrack(video, { frameRate: 30 });
      const pool = wc.createSurfacePool(128, 128);
      const add = (i: number): Promise<void> => {
        if (i === 10) {
          return Promise.resolve();
        }
        const frame = new wc.VideoFrame(pool.acquire(), {
          timestamp: Math.round((i * 1e6) / 30),
          duration: Math.round(1e6 / 30),
        });
        const sample = new mb.VideoSample(frame);
        return video.add(sample).then(
          () => {
            sample.close();
            return add(i + 1);
          },
          (e: unknown) => {
            sample.close();
            throw e;
          },
        );
      };
      return output
        .start()
        .then(() => add(0))
        .then(() => {
          video.close();
          return output.finalize();
        })
        .then(
          () => ({ configs, bytes: output.target.buffer.byteLength }),
          (e: any) => ({ configs, error: `${e && e.name}: ${e && e.message}` }),
        )
        .then((r: any) => {
          // The app outlives this test.
          proto.configure = configure;
          return r;
        });
    })) as any;
    expect(result.error).toBeUndefined();
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.configs.length).toBe(1);
    if (ios()) {
      expect(result.configs[0].bitrateMode).not.toBe("quantizer");
      expect(result.configs[0].bitrate).toBeGreaterThan(0);
    }
  }, 120000);

  // The encoders write limited range whatever the frames say (VideoToolbox
  // converts to video range, MediaCodec is set to color-range 2), so the
  // decoder config says so too: a full-range frame must not make Mediabunny
  // write a colr box with full_range_flag over a video-range SPS. And a
  // decoder's RGB (BGRA) frames are full range, whatever the stream's range.
  it("tags the stream's range, not the frames', in the decoder config and colr box", async () => {
    if (!supported()) {
      return;
    }
    const result = (await client.eval(({ mediabunny: mb, webcodecs: wc }) => {
      const errors: string[] = [];
      const chunks: any[] = [];
      let decoderConfig: any = null;
      const target = new mb.BufferTarget();
      const output = new mb.Output({
        format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }),
        target,
      });
      const source = new mb.EncodedVideoPacketSource("avc");
      output.addVideoTrack(source, { frameRate: 30 });
      let written = Promise.resolve();
      const encoder = new wc.VideoEncoder({
        output: (chunk: any, meta: any) => {
          chunks.push(chunk);
          if (meta && meta.decoderConfig && !decoderConfig) {
            ({ decoderConfig } = meta);
          }
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
        error: (e: any) => errors.push(`encoder: ${e}`),
      });
      encoder.configure({ codec: "avc1.42001f", width: 128, height: 128 });
      const pool = wc.createSurfacePool(128, 128);
      [0, 33333, 66666].forEach((timestamp) => {
        const frame = new wc.VideoFrame(pool.acquire(), {
          timestamp,
          duration: 33333,
          colorSpace: {
            primaries: "bt709",
            transfer: "bt709",
            matrix: "bt709",
            fullRange: true,
          },
        });
        encoder.encode(frame, { keyFrame: timestamp === 0 });
        frame.close();
      });
      let decoded: any = null;
      return output
        .start()
        .then(() => encoder.flush())
        .then(() => written)
        .then(() => output.finalize())
        .then(() => {
          encoder.close();
          const decoder = new wc.VideoDecoder({
            output: (frame: any) => {
              if (!decoded) {
                decoded = {
                  format: frame.format,
                  fullRange: frame.colorSpace.fullRange,
                };
              }
              frame.close();
            },
            error: (e: any) => errors.push(`decoder: ${e}`),
          });
          // Said limited explicitly, so that RGB frames show their own tag.
          decoder.configure(
            Object.assign({}, decoderConfig, {
              colorSpace: Object.assign({}, decoderConfig.colorSpace, {
                fullRange: false,
              }),
            }),
          );
          chunks.forEach((chunk) => decoder.decode(chunk));
          return decoder.flush().then(() => decoder.close());
        })
        .then(() => ({
          errors,
          configRange: decoderConfig && decoderConfig.colorSpace.fullRange,
          decoded,
          path: wc.writeFile("e2e-range.mp4", target.buffer),
        }));
    })) as any;
    expect(result.errors).toEqual([]);
    expect(result.configRange).toBe(false);
    // NV12 keeps the stream's tags; RGB is full range.
    expect(result.decoded.fullRange).toBe(result.decoded.format !== "NV12");
    if (!probes()) {
      return;
    }
    const local = copyLocal(result.path);
    const bytes = fs.readFileSync(local);
    const colr = bytes.indexOf("colr");
    expect(colr).toBeGreaterThan(0);
    expect(bytes.toString("latin1", colr + 4, colr + 8)).toBe("nclx");
    // nclx: primaries, transfer and matrix (2 bytes each), then the flag.
    const colrFullRange = bytes[colr + 14] >> 7;
    // The SPS's VUI video_full_range_flag (0 when the VUI does not say).
    const trace = execFileSync(
      "sh",
      [
        "-c",
        'ffmpeg -hide_banner -i "$0" -c:v copy -bsf:v trace_headers -f null - 2>&1',
        local,
      ],
      { encoding: "utf8" },
    );
    const spsFullRange = Number(
      /video_full_range_flag\s+[01]+\s*=\s*(\d+)/.exec(trace)?.[1] ?? 0,
    );
    expect({ colr: colrFullRange, sps: spsFullRange }).toEqual({
      colr: 0,
      sps: 0,
    });
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

  // A sound made with ffmpeg here (a 440 Hz sine, at ffmpeg's level of 1/8),
  // pushed to the app once.
  const soundClip = (name: string, args: string[]) => {
    const clip = path.join(clipDirectory, name);
    fs.mkdirSync(clipDirectory, { recursive: true });
    if (!fs.existsSync(clip)) {
      execFileSync("ffmpeg", ["-loglevel", "error", "-y"].concat(args, [clip]));
    }
    return pushFile(clip);
  };
  const hasEncoder = (name: string) =>
    execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
      encoding: "utf8",
    })
      .split("\n")
      .some((line) => line.trim().split(/\s+/)[1] === name);

  // Decodes a file's sound track with AudioDecoder (Mediabunny demuxes), and
  // measures it: frames, format, level and pitch (from channel 0's upward
  // swings through zero, between the first and the last, so priming and
  // padding do not count).
  const decodeSoundOnDevice = (file: string) =>
    runOnDevice<any>(
      ({ mediabunny: mb, webcodecs: wc, ctx }) => {
        const input = new mb.Input({
          source: new mb.CustomSource(wc.fileSourceOptions(ctx.file)),
          formats: mb.ALL_FORMATS,
        });
        return input.getPrimaryAudioTrack().then((track: any) =>
          track.getDecoderConfig().then((config: any) =>
            wc.AudioDecoder.isConfigSupported(config).then((support: any) => {
              const out: any = {
                errors: [],
                supported: support.supported,
                config: {
                  codec: config.codec,
                  sampleRate: config.sampleRate,
                  numberOfChannels: config.numberOfChannels,
                  description: !!config.description,
                },
                packets: 0,
                frames: 0,
                sampleRates: [],
                channels: [],
              };
              let sum = 0;
              let count = 0;
              let crossings = 0;
              let below = false;
              let first = -1;
              let lastCrossing = -1;
              let index = 0;
              const decoder = new wc.AudioDecoder({
                output: (data: any) => {
                  out.frames += data.numberOfFrames;
                  if (out.sampleRates.indexOf(data.sampleRate) < 0) {
                    out.sampleRates.push(data.sampleRate);
                  }
                  if (out.channels.indexOf(data.numberOfChannels) < 0) {
                    out.channels.push(data.numberOfChannels);
                  }
                  const n = data.numberOfChannels;
                  const samples = new Float32Array(data.numberOfFrames * n);
                  data.copyTo(samples, { planeIndex: 0, format: "f32" });
                  for (let i = 0; i < samples.length; i++) {
                    sum += samples[i] * samples[i];
                  }
                  for (let i = 0; i < samples.length; i += n, index++) {
                    if (samples[i] < -0.01) {
                      below = true;
                    } else if (below && samples[i] > 0.01) {
                      below = false;
                      crossings++;
                      if (first < 0) {
                        first = index;
                      }
                      lastCrossing = index;
                    }
                  }
                  count += samples.length;
                  data.close();
                },
                error: (e: any) => out.errors.push(String(e)),
              });
              decoder.configure(config);
              const packets = new mb.EncodedPacketSink(track).packets();
              const step = (): Promise<void> =>
                packets.next().then((r: any) => {
                  if (r.done) {
                    return undefined;
                  }
                  out.packets++;
                  decoder.decode(r.value.toEncodedAudioChunk());
                  return step();
                });
              return step()
                .then(() => decoder.flush())
                .then(
                  () => undefined,
                  (e: any) => out.errors.push(String(e)),
                )
                .then(() => {
                  const rate = out.sampleRates[0] || 1;
                  out.rms = Math.sqrt(sum / Math.max(1, count));
                  out.seconds = out.frames / rate;
                  out.hz =
                    ((crossings - 1) * rate) /
                    Math.max(1, lastCrossing - first);
                  if (decoder.state !== "closed") {
                    decoder.close();
                  }
                  input.dispose();
                  return out;
                });
            }),
          ),
        );
      },
      { file },
      120000,
    );

  // The decoded sound is ffmpeg's: as long, at its rate, as loud, at its
  // pitch (garbage, or a decode at the wrong rate, is not).
  const expectSine = (sound: any, o: { rate: number; channels: number }) => {
    expect(sound.errors).toEqual([]);
    expect(sound.sampleRates).toEqual([o.rate]);
    expect(sound.channels).toEqual([o.channels]);
    // 3 s, give or take the priming and the last frame's padding.
    expect(sound.seconds).toBeGreaterThan(2.9);
    expect(sound.seconds).toBeLessThan(3.3);
    // 1/8 (0.088), or 3 dB below for a mono sine made stereo.
    expect(sound.rms).toBeGreaterThan(0.04);
    expect(sound.rms).toBeLessThan(0.12);
    expect(Math.abs(sound.hz - 440)).toBeLessThan(15);
  };

  // WebCodecs: AAC without a description is ADTS, a header on every frame,
  // as Mediabunny's .aac and MPEG-TS demuxers give it.
  it("decodes ADTS AAC (no description)", async () => {
    if (!supported() || !probes()) {
      return;
    }
    const file = await soundClip("sine-48k.aac", [
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=3",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-f",
      "adts",
    ]);
    const sound = await decodeSoundOnDevice(file);
    expect(sound.config.description).toBe(false);
    expect(sound.supported).toBe(true);
    expectSine(sound, { rate: 48000, channels: 1 });
    // One frame of 1024 samples per packet.
    expect(sound.frames).toBeGreaterThan((sound.packets - 4) * 1024);
    expect(sound.frames).toBeLessThanOrEqual((sound.packets + 1) * 1024);
  }, 180000);

  // HE-AAC (SBR) and HE-AAC v2 (SBR and PS) as AudioToolbox's encoder writes
  // them: an AudioSpecificConfig of AAC-LC at half the rate (mono for v2),
  // with the SBR and PS layers in its extension, and 2048 samples a packet.
  // (macOS hosts: ffmpeg's aac_at encoder.)
  for (const [name, profile, bitrate] of [
    ["HE-AAC", "4", "48k"],
    ["HE-AACv2", "28", "32k"],
  ]) {
    it(`decodes ${name} at its full rate and channels`, async () => {
      if (!supported() || !probes() || !hasEncoder("aac_at")) {
        return;
      }
      const file = await soundClip(`sine-${name}.m4a`, [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=3",
        "-ac",
        "2",
        "-c:a",
        "aac_at",
        "-profile:a",
        profile,
        "-b:a",
        bitrate,
      ]);
      const sound = await decodeSoundOnDevice(file);
      expect(sound.supported).toBe(true);
      expectSine(sound, { rate: 44100, channels: 2 });
      expect(sound.frames).toBeGreaterThan((sound.packets - 4) * 2048);
      expect(sound.frames).toBeLessThanOrEqual((sound.packets + 1) * 2048);
    }, 180000);
  }

  // flush() ends the stream and starts a new one: what is decoded after it
  // does not overlap the sound before it. A tone, then digital silence:
  // decoding the tone, a flush, then the silence must give silence. (iOS:
  // Android's MediaCodec flush is its own, and out of scope here.)
  it("starts an AudioDecoder over after a flush (iOS)", async () => {
    if (!ios() || !probes()) {
      return;
    }
    const file = await soundClip("tone-then-silence.m4a", [
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=4",
      "-af",
      "volume=volume=0:enable='gte(t,2)'",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
    ]);
    const result = await runOnDevice<any>(
      ({ mediabunny: mb, webcodecs: wc, ctx }) => {
        const input = new mb.Input({
          source: new mb.CustomSource(wc.fileSourceOptions(ctx.file)),
          formats: mb.ALL_FORMATS,
        });
        return input.getPrimaryAudioTrack().then((track: any) =>
          track.getDecoderConfig().then((config: any) => {
            const all: any[] = [];
            const packets = new mb.EncodedPacketSink(track).packets();
            const read = (): Promise<void> =>
              packets.next().then((r: any) => {
                if (r.done) {
                  return undefined;
                }
                all.push(r.value);
                return read();
              });
            const errors: string[] = [];
            let samples: number[] = [];
            const decoder = new wc.AudioDecoder({
              output: (data: any) => {
                const n = data.numberOfFrames * data.numberOfChannels;
                const buffer = new Float32Array(n);
                data.copyTo(buffer, { planeIndex: 0, format: "f32" });
                for (let i = 0; i < n; i++) {
                  samples.push(buffer[i]);
                }
                data.close();
              },
              error: (e: any) => errors.push(String(e)),
            });
            decoder.configure(config);
            // The level of the first `count` samples.
            const rms = (from: number[], count: number) => {
              let sum = 0;
              const n = Math.min(from.length, count);
              for (let i = 0; i < n; i++) {
                sum += from[i] * from[i];
              }
              return Math.sqrt(sum / Math.max(1, n));
            };
            const decodeRange = (start: number, end: number) => {
              all
                .filter((p: any) => p.timestamp >= start && p.timestamp < end)
                .forEach((p: any) => decoder.decode(p.toEncodedAudioChunk()));
              return decoder.flush();
            };
            const out: any = { errors };
            return read()
              .then(() => decodeRange(-1, 1.5))
              .then(() => {
                out.tone = rms(samples, samples.length);
                samples = [];
                return decodeRange(3, 3.5);
              })
              .then(() => {
                out.samples = samples.length;
                out.after = rms(samples, 1024);
                decoder.close();
                input.dispose();
                return out;
              });
          }),
        );
      },
      { file },
      120000,
    );
    expect(result.errors).toEqual([]);
    expect(result.tone).toBeGreaterThan(0.05);
    expect(result.samples).toBeGreaterThan(0);
    // Not the tone's last frame overlapping the first of the silence.
    expect(result.after).toBeLessThan(0.001);
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
    if (client.OS === "android") {
      expect(result.chunks.length).toBe(4);
    } else {
      expect(result.chunks.length).toBeGreaterThanOrEqual(3);
    }
  }, 60000);

  it("puts key frames exactly where requested", async () => {
    if (!supported()) {
      return;
    }
    const keys = [0, 7, 20, 33, 50, 51, 77];
    const sizes = [
      [64, 64],
      [1280, 720],
    ];
    const result = (await client.eval(
      ({ webcodecs: wc, keys: wanted, sizes: all }) => {
        const encodeAt = (width: number, height: number) => {
          const types: Record<string, string> = {};
          const errors: string[] = [];
          const encoder = new wc.VideoEncoder({
            output: (chunk: any) => {
              types[String(chunk.timestamp)] = chunk.type;
            },
            error: (e: any) => errors.push(String(e)),
          });
          encoder.configure({ codec: "avc1.42001f", width, height });
          const pool = wc.createSurfacePool(width, height);
          // All queued at once, without waiting on the encoder.
          for (let i = 0; i < 90; i++) {
            const frame = new wc.VideoFrame(pool.acquire(), {
              timestamp: i * 33333,
            });
            encoder.encode(frame, { keyFrame: wanted.indexOf(i) >= 0 });
            frame.close();
          }
          return encoder.flush().then(
            () => {
              encoder.close();
              return { types, errors };
            },
            (e: any) => {
              encoder.close();
              return { types, errors: errors.concat([String(e)]) };
            },
          );
        };
        const runs: any[] = [];
        return all
          .reduce(
            (p: Promise<void>, size: number[]) =>
              p.then(() =>
                encodeAt(size[0], size[1]).then((r: any) => {
                  runs.push(r);
                }),
              ),
            Promise.resolve(),
          )
          .then(() => runs);
      },
      { keys, sizes },
    )) as any;
    result.forEach((run: any) => {
      expect(run.errors).toEqual([]);
      const keyAt = Array.from({ length: 90 }, (_, i) =>
        run.types[String(i * 33333)] === "key" ? i : -1,
      ).filter((i) => i >= 0);
      expect(keyAt).toEqual(keys);
      expect(Object.keys(run.types).length).toBe(90);
    });
  }, 120000);

  it("encodes every frame when timestamps repeat or go backwards", async () => {
    if (!supported()) {
      return;
    }
    const cases = {
      repeated: [0, 0, 33333, 66666],
      backwards: [0, 33333, 20000, 66666],
    };
    const result = (await client.eval(
      ({ webcodecs: wc, cases: input }) => {
        const encodeAll = (times: number[]) => {
          const chunks: { timestamp: number; duration: number }[] = [];
          const errors: string[] = [];
          const encoder = new wc.VideoEncoder({
            output: (chunk: any) =>
              chunks.push({
                timestamp: chunk.timestamp,
                duration: chunk.duration,
              }),
            error: (e: any) => errors.push(String(e)),
          });
          encoder.configure({ codec: "avc1.42001f", width: 64, height: 64 });
          const pool = wc.createSurfacePool(64, 64);
          times.forEach((timestamp: number, i: number) => {
            // A duration per frame: each chunk must keep its own.
            const frame = new wc.VideoFrame(pool.acquire(), {
              timestamp,
              duration: 1000 + i,
            });
            encoder.encode(frame, { keyFrame: i === 0 });
            frame.close();
          });
          return encoder.flush().then(
            () => {
              encoder.close();
              return { chunks, errors };
            },
            (e: any) => {
              encoder.close();
              return { chunks, errors: errors.concat([String(e)]) };
            },
          );
        };
        return encodeAll(input.repeated).then((repeated: any) =>
          encodeAll(input.backwards).then((backwards: any) => ({
            repeated,
            backwards,
          })),
        );
      },
      { cases },
    )) as any;
    for (const name of ["repeated", "backwards"] as const) {
      const run = result[name];
      expect(run.errors).toEqual([]);
      if (client.OS === "android") {
        // Every frame comes out, in input order, with its own timestamp and
        // duration (no B-frames: output order is input order).
        expect(run.chunks).toEqual(
          cases[name].map((timestamp, i) => ({
            timestamp,
            duration: 1000 + i,
          })),
        );
      } else {
        expect(run.chunks.length).toBeGreaterThanOrEqual(3);
      }
    }
  }, 60000);

  it("encodes 1, 2 and 3 frames to one chunk each, again and again", async () => {
    if (!supported()) {
      return;
    }
    const result = (await client.eval(({ webcodecs: wc }) => {
      const encodeFew = (count: number) => {
        const chunks: { timestamp: number; type: string; size: number }[] = [];
        const errors: string[] = [];
        const encoder = new wc.VideoEncoder({
          output: (chunk: any) =>
            chunks.push({
              timestamp: chunk.timestamp,
              type: chunk.type,
              size: chunk.byteLength,
            }),
          error: (e: any) => errors.push(String(e)),
        });
        encoder.configure({ codec: "avc1.42001f", width: 64, height: 64 });
        const pool = wc.createSurfacePool(64, 64);
        // Each round is a short stream of its own: flush() ends it right
        // after its last frame.
        const round = (r: number): Promise<void> => {
          for (let i = 0; i < count; i++) {
            const frame = new wc.VideoFrame(pool.acquire(), {
              timestamp: (r * count + i) * 33333,
            });
            encoder.encode(frame, { keyFrame: i === 0 });
            frame.close();
          }
          return encoder.flush();
        };
        return [0, 1, 2]
          .reduce(
            (p: Promise<void>, r: number) => p.then(() => round(r)),
            Promise.resolve(),
          )
          .then(
            () => {
              encoder.close();
              return { chunks, errors };
            },
            (e: any) => {
              encoder.close();
              return { chunks, errors: errors.concat([String(e)]) };
            },
          );
      };
      const runs: any[] = [];
      return [1, 2, 3]
        .reduce(
          (p: Promise<void>, count: number) =>
            p.then(() =>
              encodeFew(count).then((r: any) => {
                runs.push(r);
              }),
            ),
          Promise.resolve(),
        )
        .then(() => runs);
    })) as any;
    result.forEach((run: any, n: number) => {
      const count = n + 1;
      expect(run.errors).toEqual([]);
      expect(run.chunks.map((c: any) => c.timestamp)).toEqual(
        Array.from({ length: 3 * count }, (_, i) => i * 33333),
      );
      run.chunks.forEach((c: any, i: number) => {
        expect(c.size).toBeGreaterThan(0);
        // The first frame of each round starts a new stream: a key frame.
        if (i % count === 0) {
          expect(c.type).toBe("key");
        }
      });
    });
  }, 120000);

  it("flushes a VideoEncoder whose codec never ends the stream (Android fault)", async () => {
    if (client.OS !== "android") {
      return;
    }
    // Debug builds only: the codec's end of stream is never seen.
    setFault("venc-no-eos");
    try {
      const result = (await client.eval(({ webcodecs: wc }) => {
        const chunks: number[] = [];
        const errors: string[] = [];
        const encoder = new wc.VideoEncoder({
          output: (chunk: any) => {
            if (chunk.byteLength > 0) {
              chunks.push(chunk.timestamp);
            }
          },
          error: (e: any) => errors.push(String(e)),
        });
        encoder.configure({ codec: "avc1.42001f", width: 64, height: 64 });
        const pool = wc.createSurfacePool(64, 64);
        const flushes: { flushed: string; ms: number }[] = [];
        // Two streams: after a flush, the encoder starts a new codec.
        const round = (first: number, count: number) => {
          for (let i = first; i < first + count; i++) {
            const frame = new wc.VideoFrame(pool.acquire(), {
              timestamp: i * 33333,
            });
            encoder.encode(frame, { keyFrame: i === first });
            frame.close();
          }
          const start = Date.now();
          return Promise.race([
            encoder.flush().then(
              () => "flushed",
              (e: any) => `${e.name}: ${e.message}`,
            ),
            new Promise((resolve) =>
              setTimeout(() => resolve("timeout"), 15000),
            ),
          ]).then((flushed: any) => {
            flushes.push({ flushed, ms: Date.now() - start });
          });
        };
        return round(0, 5)
          .then(() => round(5, 3))
          .then(() => {
            const queue = encoder.encodeQueueSize;
            encoder.close();
            return { chunks, errors, flushes, queue };
          });
      })) as any;
      expect(result.errors).toEqual([]);
      expect(result.flushes.map((f: any) => f.flushed)).toEqual([
        "flushed",
        "flushed",
      ]);
      result.flushes.forEach((f: any) => expect(f.ms).toBeLessThan(5000));
      expect(result.chunks).toEqual(
        Array.from({ length: 8 }, (_, i) => i * 33333),
      );
      expect(result.queue).toBe(0);
    } finally {
      setFault("");
    }
  }, 120000);

  it("lets go of a VideoEncoder codec that hangs with frames queued (Android fault)", async () => {
    if (client.OS !== "android") {
      return;
    }
    // Debug builds only: the codec's output is never taken, so it stops
    // taking input with frames still to draw; 3 s later that is a stall.
    setFault("venc-stall-output:3");
    adb(["logcat", "-c"]);
    let stuck: any;
    try {
      stuck = (await client.eval(({ webcodecs: wc }) => {
        const errors: string[] = [];
        let failed: () => void = () => {};
        const failure = new Promise<void>((resolve) => {
          failed = resolve;
        });
        const encoder = new wc.VideoEncoder({
          output: () => {},
          error: (e: any) => {
            errors.push(`${e.name}: ${e.message}`);
            failed();
          },
        });
        encoder.configure({ codec: "avc1.42001f", width: 1280, height: 720 });
        const pool = wc.createSurfacePool(1280, 720);
        // All queued at once, without waiting on the encoder.
        for (let i = 0; i < 90; i++) {
          const frame = new wc.VideoFrame(pool.acquire(), {
            timestamp: i * 33333,
          });
          encoder.encode(frame, { keyFrame: i === 0 });
          frame.close();
        }
        const start = Date.now();
        const flushed = encoder.flush().then(
          () => "flushed",
          (e: any) => `${e.name}`,
        );
        return Promise.race([
          Promise.all([failure, flushed]).then(([, f]) => f),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 30000)),
        ]).then((outcome: any) => ({
          outcome,
          errors,
          ms: Date.now() - start,
          state: encoder.state,
        }));
      })) as any;
    } finally {
      setFault("");
    }
    expect(stuck.outcome).toBe("AbortError");
    expect(stuck.errors.length).toBe(1);
    expect(stuck.errors[0]).toMatch(/^EncodingError: /);
    expect(stuck.state).toBe("closed");
    // The codec is let go (on the encoder's GL thread, which must not stay
    // blocked drawing into a codec that takes nothing).
    let released = false;
    for (let i = 0; i < 50 && !released; i++) {
      released = /video encoder: released/.test(
        adb(["logcat", "-d", "-s", "WebCodecs"]).toString(),
      );
      if (!released) {
        execFileSync("sleep", ["0.2"]);
      }
    }
    expect(released).toBe(true);
    // And encoding goes on with a new encoder.
    const after = (await client.eval(({ webcodecs: wc }) => {
      const chunks: number[] = [];
      const errors: string[] = [];
      const encoder = new wc.VideoEncoder({
        output: (chunk: any) => chunks.push(chunk.timestamp),
        error: (e: any) => errors.push(String(e)),
      });
      encoder.configure({ codec: "avc1.42001f", width: 1280, height: 720 });
      const pool = wc.createSurfacePool(1280, 720);
      for (let i = 0; i < 3; i++) {
        const frame = new wc.VideoFrame(pool.acquire(), {
          timestamp: i * 33333,
        });
        encoder.encode(frame, { keyFrame: i === 0 });
        frame.close();
      }
      return encoder.flush().then(
        () => {
          encoder.close();
          return { chunks, errors };
        },
        (e: any) => {
          encoder.close();
          return { chunks, errors: errors.concat([String(e)]) };
        },
      );
    })) as any;
    expect(after.errors).toEqual([]);
    expect(after.chunks.length).toBe(3);
  }, 120000);

  it("closes a VideoEncoder whose codec hangs without failing, in bounded time (Android fault)", async () => {
    if (client.OS !== "android") {
      return;
    }
    // Debug builds only: the codec's output is never taken, and the stall
    // is not reported for 60 s, so nothing has failed when close() comes,
    // with the GL thread blocked drawing.
    setFault("venc-stall-output:60");
    adb(["logcat", "-c"]);
    let closed: any;
    try {
      closed = (await client.eval(({ webcodecs: wc }) => {
        const errors: string[] = [];
        const encoder = new wc.VideoEncoder({
          output: () => {},
          error: (e: any) => errors.push(String(e)),
        });
        encoder.configure({ codec: "avc1.42001f", width: 1280, height: 720 });
        const pool = wc.createSurfacePool(1280, 720);
        for (let i = 0; i < 90; i++) {
          const frame = new wc.VideoFrame(pool.acquire(), {
            timestamp: i * 33333,
          });
          encoder.encode(frame, { keyFrame: i === 0 });
          frame.close();
        }
        return new Promise((resolve) => setTimeout(resolve, 1500)).then(() => {
          const start = Date.now();
          encoder.close();
          return { ms: Date.now() - start, errors };
        });
      })) as any;
    } finally {
      setFault("");
    }
    // Closed by the user: no error. close() waits for the GL thread, then
    // stops the codec itself and the draw returns.
    expect(closed.errors).toEqual([]);
    expect(closed.ms).toBeLessThan(5000);
    expect(
      /video encoder: released/.test(
        adb(["logcat", "-d", "-s", "WebCodecs"]).toString(),
      ),
    ).toBe(true);
    const after = (await client.eval(({ webcodecs: wc }) => {
      const chunks: number[] = [];
      const errors: string[] = [];
      const encoder = new wc.VideoEncoder({
        output: (chunk: any) => chunks.push(chunk.timestamp),
        error: (e: any) => errors.push(String(e)),
      });
      encoder.configure({ codec: "avc1.42001f", width: 64, height: 64 });
      const pool = wc.createSurfacePool(64, 64);
      const frame = new wc.VideoFrame(pool.acquire(), { timestamp: 0 });
      encoder.encode(frame, { keyFrame: true });
      frame.close();
      return encoder.flush().then(
        () => {
          encoder.close();
          return { chunks, errors };
        },
        (e: any) => {
          encoder.close();
          return { chunks, errors: errors.concat([String(e)]) };
        },
      );
    })) as any;
    expect(after.errors).toEqual([]);
    expect(after.chunks).toEqual([0]);
  }, 120000);

  it("does not stop a VideoEncoder codec from the GL thread when a draw fails (Android fault)", async () => {
    if (client.OS !== "android") {
      return;
    }
    // Debug builds only: the 10th draw fails on the GL thread while the
    // drain thread is taking the codec's output. The GL thread is not
    // blocked, so the codec must not be stopped under the drain thread
    // (which may be copying from one of its buffers): only the GL thread's
    // stop(), at close(), lets it go.
    setFault("venc-draw-fail:10");
    adb(["logcat", "-c"]);
    let failed: any;
    try {
      failed = (await client.eval(({ webcodecs: wc }) => {
        const errors: string[] = [];
        let chunks = 0;
        let reported: () => void = () => {};
        const failure = new Promise<void>((resolve) => {
          reported = resolve;
        });
        const encoder = new wc.VideoEncoder({
          output: () => {
            chunks++;
          },
          error: (e: any) => {
            errors.push(`${e.name}: ${e.message}`);
            reported();
          },
        });
        encoder.configure({ codec: "avc1.42001f", width: 640, height: 480 });
        const pool = wc.createSurfacePool(640, 480);
        for (let i = 0; i < 30; i++) {
          const frame = new wc.VideoFrame(pool.acquire(), {
            timestamp: i * 33333,
          });
          encoder.encode(frame, { keyFrame: i === 0 });
          frame.close();
        }
        return Promise.race([
          failure.then(() => "failed"),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 20000)),
        ]).then((outcome: any) => {
          const { state } = encoder;
          if (state !== "closed") {
            encoder.close();
          }
          return { outcome, errors, chunks, state };
        });
      })) as any;
    } finally {
      setFault("");
    }
    expect(failed.outcome).toBe("failed");
    expect(failed.errors.length).toBe(1);
    expect(failed.errors[0]).toMatch(/^EncodingError: .*the draw failed/);
    expect(failed.state).toBe("closed");
    let log = "";
    for (let i = 0; i < 50; i++) {
      log = adb(["logcat", "-d", "-s", "WebCodecs"]).toString();
      if (/video encoder: released/.test(log)) {
        break;
      }
      execFileSync("sleep", ["0.2"]);
    }
    expect(log).toMatch(/video encoder: released/);
    expect(log).not.toMatch(/stopping .* from another thread/);
  }, 120000);

  it("fails a VideoEncoder whose frame's GPU fence never signals (Android fault)", async () => {
    if (client.OS !== "android") {
      return;
    }
    // Debug builds only: every frame's fence is a pipe nothing is written
    // to, as a hung GPU's would be. The wait is bounded: the frame fails
    // with an EncodingError instead of being drawn unfinished or blocking
    // the GL thread for ever.
    setFault("venc-fence-hang");
    let run: any;
    try {
      run = (await client.eval(({ webcodecs: wc }) => {
        const errors: string[] = [];
        let chunks = 0;
        const encoder = new wc.VideoEncoder({
          output: () => {
            chunks++;
          },
          error: (e: any) => {
            errors.push(`${e.name}: ${e.message}`);
          },
        });
        encoder.configure({ codec: "avc1.42001f", width: 320, height: 240 });
        const pool = wc.createSurfacePool(320, 240);
        for (let i = 0; i < 5; i++) {
          const frame = new wc.VideoFrame(pool.acquire(), {
            timestamp: i * 33333,
          });
          encoder.encode(frame, { keyFrame: i === 0 });
          frame.close();
        }
        const started = Date.now();
        return Promise.race([
          encoder.flush().then(
            () => "flushed",
            () => "failed",
          ),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 30000)),
        ]).then((outcome: any) => {
          const { state } = encoder;
          if (state !== "closed") {
            encoder.close();
          }
          return { outcome, errors, chunks, state, ms: Date.now() - started };
        });
      })) as any;
    } finally {
      setFault("");
    }
    console.log(`fence hang: ${JSON.stringify(run)}`);
    expect(run.outcome).toBe("failed");
    expect(run.errors.length).toBe(1);
    expect(run.errors[0]).toMatch(/^EncodingError: .*fence did not signal/);
    expect(run.chunks).toBe(0);
    expect(run.state).toBe("closed");
  }, 120000);

  // A VideoFrame made from a foreign handle (a camera's AHardwareBuffer)
  // only references the buffer: its producer may write the next picture
  // into it as soon as encode() returns. Each frame must be read as it was
  // at encode(), even when the encoder is behind. A surface pool stands in
  // for the producer: a released buffer is the next one acquire() hands
  // out. Debug builds only: every draw waits 300 ms first, as behind a
  // backlog.
  it("encodes a wrapped surface as it was at encode(), though its producer reuses the buffer (Android fault)", async () => {
    if (client.OS !== "android" || !probes()) {
      return;
    }
    setFault("venc-slow-draw:300");
    let run: any;
    try {
      run = (await client.eval(({ device, mediabunny: mb, webcodecs: wc }) => {
        const fill = (surface: any, rgba: number[]) => {
          const buffer = RNWebGPU.createNativeBufferFromPointer(
            surface.pixelBuffer,
          );
          const memory = device.importSharedTextureMemory({ source: buffer });
          const texture = memory.createTexture();
          memory.beginAccess(texture, false);
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: texture.createView(),
                clearValue: rgba,
                loadOp: "clear",
                storeOp: "store",
              },
            ],
          });
          pass.end();
          device.queue.submit([encoder.finish()]);
          (memory as any).endAccess(texture);
          texture.destroy();
          memory.destroy();
          buffer.release();
          return device.queue.onSubmittedWorkDone();
        };
        const target = new mb.BufferTarget();
        const output = new mb.Output({
          format: new mb.Mp4OutputFormat(),
          target,
        });
        const source = new mb.EncodedVideoPacketSource("avc");
        output.addVideoTrack(source, { frameRate: 10 });
        const errors: string[] = [];
        const sameBuffer: boolean[] = [];
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
          error: (e: any) => errors.push(`${e.name}: ${e.message}`),
        });
        encoder.configure({ codec: "avc1.42001f", width: 128, height: 128 });
        const pool = wc.createSurfacePool(128, 128);
        const frameAt = (i: number): Promise<void> => {
          const surface = pool.acquire();
          const { handle } = surface;
          return fill(surface, [1, 0, 0, 1]).then(() => {
            const frame = new wc.VideoFrame(
              { handle },
              { timestamp: i * 100000, duration: 100000 },
            );
            // The producer has the buffer back...
            surface.release();
            encoder.encode(frame, { keyFrame: i === 0 });
            frame.close();
            // ...and writes its next picture into it.
            const next = pool.acquire();
            sameBuffer.push(next.handle === handle);
            return fill(next, [0, 1, 0, 1]).then(() => next.release());
          });
        };
        const frames = (i: number): Promise<void> =>
          i === 3 ? Promise.resolve() : frameAt(i).then(() => frames(i + 1));
        return output
          .start()
          .then(() => frames(0))
          .then(() => encoder.flush())
          .then(() => written)
          .then(() => output.finalize())
          .then(() => {
            encoder.close();
            return {
              errors,
              sameBuffer,
              path: wc.writeFile("e2e-wrapped.mp4", target.buffer),
            };
          })
          .catch((e: any) => ({
            errors: errors.concat([`${e && e.name}: ${e && e.message}`]),
            sameBuffer,
            path: "",
          }));
      })) as any;
    } finally {
      setFault("");
    }
    console.log(`wrapped: ${JSON.stringify(run)}`);
    expect(run.errors).toEqual([]);
    // Otherwise the producer did not reuse the buffer, and this shows nothing.
    expect(run.sameBuffer).toEqual([true, true, true]);
    const local = copyLocal(run.path);
    const pixels = [0, 0.1, 0.2].map((t) => pixel(local, t));
    console.log(`wrapped pixels: ${JSON.stringify(pixels)}`);
    pixels.forEach((p) => {
      expect(p[0]).toBeGreaterThan(240);
      expect(p[1]).toBeLessThan(15);
      expect(p[2]).toBeLessThan(15);
    });
  }, 120000);

  // encode() of a wrapped surface waits until its buffer has been read. A
  // frame that is never drawn (the draw fails, or the encoder has already
  // failed) is never read either: encode() must return at once then, not
  // block the JS thread until the read times out. Debug builds only: the
  // second draw fails.
  it("does not block encode() of a wrapped surface whose frame is not drawn (Android fault)", async () => {
    if (client.OS !== "android") {
      return;
    }
    setFault("venc-draw-fail:2");
    let run: any;
    try {
      run = (await client.eval(({ webcodecs: wc }) => {
        const errors: string[] = [];
        const thrown: string[] = [];
        const ms: number[] = [];
        let reported: () => void = () => {};
        const failure = new Promise<void>((resolve) => {
          reported = resolve;
        });
        const encoder = new wc.VideoEncoder({
          output: () => {},
          error: (e: any) => {
            errors.push(`${e.name}: ${e.message}`);
            reported();
          },
        });
        encoder.configure({ codec: "avc1.42001f", width: 128, height: 128 });
        const pool = wc.createSurfacePool(128, 128);
        const surfaces: any[] = [];
        // Frame 0 is drawn, frame 1's draw fails, frame 2 comes to an
        // encoder that has failed.
        for (let i = 0; i < 3; i++) {
          const surface = pool.acquire();
          surfaces.push(surface);
          const frame = new wc.VideoFrame(
            { handle: surface.handle },
            { timestamp: i * 100000, duration: 100000 },
          );
          const started = Date.now();
          try {
            encoder.encode(frame, { keyFrame: i === 0 });
          } catch (e: any) {
            thrown.push(`${e && e.name}: ${e && e.message}`);
          }
          ms.push(Date.now() - started);
          frame.close();
        }
        return Promise.race([
          failure.then(() => "failed"),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 20000)),
        ]).then((outcome: any) => {
          const { state } = encoder;
          if (state !== "closed") {
            encoder.close();
          }
          surfaces.forEach((s) => s.release());
          return { outcome, errors, thrown, ms, state };
        });
      })) as any;
    } finally {
      setFault("");
    }
    console.log(`wrapped, not drawn: ${JSON.stringify(run)}`);
    expect(run.thrown).toEqual([]);
    expect(Math.max(...run.ms)).toBeLessThan(3000);
    expect(run.outcome).toBe("failed");
    expect(run.errors.length).toBe(1);
    expect(run.errors[0]).toMatch(/^EncodingError: .*the draw failed/);
    expect(run.state).toBe("closed");
  }, 120000);

  it("releases the old VideoEncoder codec before configure() makes a new one (Android fault)", async () => {
    if (client.OS !== "android") {
      return;
    }
    // Debug builds only: stopping a codec takes 800 ms longer. Devices
    // with few codec instances need the old one gone before the new one.
    setFault("venc-slow-stop:800");
    adb(["logcat", "-c"]);
    let result: any;
    try {
      result = (await client.eval(({ webcodecs: wc }) => {
        const chunks: number[] = [];
        const errors: string[] = [];
        const encoder = new wc.VideoEncoder({
          output: (chunk: any) => chunks.push(chunk.timestamp),
          error: (e: any) => errors.push(String(e)),
        });
        const config = { codec: "avc1.42001f", width: 64, height: 64 };
        const pool = wc.createSurfacePool(64, 64);
        const encodeSome = (first: number) => {
          for (let i = first; i < first + 3; i++) {
            const frame = new wc.VideoFrame(pool.acquire(), {
              timestamp: i * 33333,
            });
            encoder.encode(frame, { keyFrame: i === first });
            frame.close();
          }
        };
        encoder.configure(config);
        encodeSome(0);
        // A new config: the native codec is replaced.
        encoder.configure(config);
        encodeSome(3);
        return encoder.flush().then(
          () => {
            encoder.close();
            return { chunks, errors };
          },
          (e: any) => {
            encoder.close();
            return { chunks, errors: errors.concat([String(e)]) };
          },
        );
      })) as any;
    } finally {
      setFault("");
    }
    expect(result.errors).toEqual([]);
    expect(result.chunks).toEqual([3, 4, 5].map((i) => i * 33333));
    const log = adb(["logcat", "-d", "-s", "WebCodecs"])
      .toString()
      .split("\n")
      .filter((line) => /video encoder: (c2\.|OMX\.|released)/.test(line))
      .map((line) => (/released/.test(line) ? "released" : "made"));
    // Made, released, made: never two at once.
    expect(log.slice(0, 3)).toEqual(["made", "released", "made"]);
  }, 120000);

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

  // Decoding from a key frame that is not the first: after a seek
  // (flush() then a later key frame), or a GOP that goes back in time.
  describe("decoding from a later key frame", () => {
    interface Runs {
      supported: boolean;
      // Every packet, in decoding order (microseconds).
      packets: { timestamp: number; key: boolean }[];
      // Each run's output timestamps, in output order.
      runs: number[][];
      // With `grids`: each output frame's mean luma (0-255) over a 16x16
      // grid, by timestamp, per run.
      grids: Record<string, number[]>[];
      errors: string[];
    }

    const hasLibx265 = () => {
      try {
        return /libx265/.test(
          execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
            encoding: "utf8",
          }),
        );
      } catch {
        return false;
      }
    };

    // Two GOPs of 30 frames at 30 fps, made with ffmpeg once.
    const gopClip = (name: string, codec: string[]) => {
      const clip = path.join(clipDirectory, name);
      fs.mkdirSync(clipDirectory, { recursive: true });
      if (!fs.existsSync(clip)) {
        execFileSync(
          "ffmpeg",
          [
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30:duration=2",
            "-pix_fmt",
            "yuv420p",
          ].concat(codec, [clip]),
        );
      }
      return pushFile(clip);
    };

    // Decodes `runs` of GOPs (each a list of [first, end) GOP ranges, in
    // that order, without a flush between them), each run followed by a
    // flush, with one decoder.
    const decodeRuns = (file: string, runs: number[][][], grids = false) =>
      runOnDevice<Runs>(
        ({ mediabunny: mb, webcodecs: wc, device, ctx }) => {
          const input = new mb.Input({
            source: new mb.CustomSource(wc.fileSourceOptions(ctx.file)),
            formats: mb.ALL_FORMATS,
          });
          const result: any = {
            supported: false,
            packets: [],
            runs: [],
            grids: [],
            errors: [],
          };
          // The frame (through WebGPU, as an app draws it), as the mean
          // luma of each cell of a 16x16 grid.
          const grid = (frame: any): Promise<number[]> => {
            const width = frame.displayWidth;
            const height = frame.displayHeight;
            const buffer = RNWebGPU.createNativeBufferFromPointer(
              frame.pixelBuffer,
              { colorSpace: frame.colorSpace.toJSON() },
            );
            const texture = device.createTexture({
              size: [width, height],
              format: "rgba8unorm",
              usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.COPY_SRC |
                GPUTextureUsage.TEXTURE_BINDING,
            });
            device.queue.copyExternalImageToTexture(
              { source: buffer },
              { texture },
              [width, height],
            );
            const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
            const readback = device.createBuffer({
              size: bytesPerRow * height,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer(
              { texture },
              { buffer: readback, bytesPerRow },
              [width, height],
            );
            device.queue.submit([encoder.finish()]);
            return readback.mapAsync(GPUMapMode.READ).then(() => {
              buffer.release();
              frame.close();
              const data = new Uint8Array(readback.getMappedRange());
              const sums = new Array(256).fill(0);
              const counts = new Array(256).fill(0);
              for (let y = 0; y < height; y += 2) {
                for (let x = 0; x < width; x += 2) {
                  const o = y * bytesPerRow + x * 4;
                  const cell =
                    Math.floor((y * 16) / height) * 16 +
                    Math.floor((x * 16) / width);
                  sums[cell] +=
                    0.299 * data[o]! +
                    0.587 * data[o + 1]! +
                    0.114 * data[o + 2]!;
                  counts[cell]++;
                }
              }
              readback.unmap();
              readback.destroy();
              texture.destroy();
              return sums.map((v, i) => Math.round(v / counts[i]));
            });
          };
          return input.getPrimaryVideoTrack().then((track: any) =>
            track.getDecoderConfig().then((config: any) =>
              wc.VideoDecoder.isConfigSupported(config).then((s: any) => {
                result.supported = s.supported;
                if (!s.supported) {
                  input.dispose();
                  return result;
                }
                const chunks: any[] = [];
                const keys: number[] = [];
                const iterator = new mb.EncodedPacketSink(track).packets();
                const read = (): Promise<void> =>
                  iterator.next().then((r: any) => {
                    if (r.done) {
                      return undefined;
                    }
                    const chunk = r.value.toEncodedVideoChunk();
                    if (chunk.type === "key") {
                      keys.push(chunks.length);
                    }
                    chunks.push(chunk);
                    result.packets.push({
                      timestamp: chunk.timestamp,
                      key: chunk.type === "key",
                    });
                    return read();
                  });
                let current: number[] = [];
                let currentGrids: Record<string, number[]> = {};
                let sampling: Promise<void> = Promise.resolve();
                const decoder = new wc.VideoDecoder({
                  output: (frame: any) => {
                    current.push(frame.timestamp);
                    if (!ctx.grids) {
                      frame.close();
                      return;
                    }
                    if (!(frame.duration > 0)) {
                      result.errors.push(`no duration at ${frame.timestamp}`);
                    }
                    const into = currentGrids;
                    sampling = sampling
                      .then(() => grid(frame))
                      .then(
                        (g) => {
                          into[String(frame.timestamp)] = g;
                        },
                        (e: any) => {
                          result.errors.push(`grid: ${e}`);
                        },
                      );
                  },
                  error: (e: any) => result.errors.push(String(e)),
                });
                decoder.configure(config);
                const order: number[][] = [];
                const decodeFrom = (i: number): Promise<void> => {
                  if (i >= order.length || decoder.state === "closed") {
                    return Promise.resolve();
                  }
                  decoder.decode(chunks[order[i][0]]);
                  return new Promise((resolve) => setTimeout(resolve, 0)).then(
                    () => decodeFrom(i + 1),
                  );
                };
                const run = (n: number): Promise<void> => {
                  if (n >= ctx.runs.length || decoder.state === "closed") {
                    return Promise.resolve();
                  }
                  current = [];
                  result.runs.push(current);
                  currentGrids = {};
                  result.grids.push(currentGrids);
                  order.length = 0;
                  ctx.runs[n].forEach((range: number[]) => {
                    const end =
                      range[1] < keys.length ? keys[range[1]] : chunks.length;
                    for (let p = keys[range[0]]; p < end; p++) {
                      order.push([p]);
                    }
                  });
                  return decodeFrom(0)
                    .then(() =>
                      decoder.state === "closed" ? undefined : decoder.flush(),
                    )
                    .catch((e: any) => {
                      result.errors.push(`flush: ${e}`);
                    })
                    .then(() => sampling)
                    .then(() => run(n + 1));
                };
                return read()
                  .then(() => run(0))
                  .then(() => {
                    if (decoder.state !== "closed") {
                      decoder.close();
                    }
                    input.dispose();
                    return result;
                  });
              }),
            ),
          );
        },
        { file, runs, grids },
        120000,
      );

    const sorted = (values: number[]) => values.slice().sort((a, b) => a - b);
    // The packets of GOP `gop` (0-based), in decoding order.
    const gopOf = (packets: Runs["packets"], gop: number) => {
      const keys = packets
        .map((p, i) => (p.key ? i : -1))
        .filter((i) => i >= 0);
      return packets.slice(keys[gop], keys[gop + 1] ?? packets.length);
    };

    // x265's open GOPs: the second key frame is a CRA, and the 4 frames
    // after it in decoding order (RASL, shown before it) reference the
    // first GOP. Decoded from that CRA after a flush, as a seek does, they
    // cannot be decoded: VideoToolbox fails them with
    // kVTVideoDecoderReferenceMissingErr (-17694) or bad data, which closed
    // the decoder. They are left out, as Chromium does (Android's decoders
    // may output them).
    it("decodes HEVC from an open-GOP key frame (CRA) after a flush", async () => {
      if (!supported() || !probes() || !hasLibx265()) {
        return;
      }
      const file = await gopClip("clip-hevc-open-gop.mp4", [
        "-c:v",
        "libx265",
        "-tag:v",
        "hvc1",
        "-x265-params",
        "open-gop=1:keyint=30:min-keyint=30:scenecut=0:log-level=error",
      ]);
      const decoded = await decodeRuns(file, [[[0, 2]], [[1, 2]]]);
      console.log(`open GOP: ${JSON.stringify(decoded)}`);
      if (!decoded.supported) {
        return;
      }
      const all = decoded.packets.map((p) => p.timestamp);
      const second = gopOf(decoded.packets, 1).map((p) => p.timestamp);
      const cra = second[0]!;
      const fromCra = sorted(second.filter((t) => t >= cra));
      expect(second.length - fromCra.length).toBe(4);
      expect({
        errors: decoded.errors,
        first: decoded.runs[0],
      }).toEqual({ errors: [], first: sorted(all) });
      if (ios()) {
        expect(decoded.runs[1]).toEqual(fromCra);
      } else {
        expect([fromCra, sorted(second)]).toContainEqual(decoded.runs[1]);
      }
    }, 300000);

    // x264's open GOPs (open-gop=1, with B-frames): the second key frame is
    // not an IDR but an I picture (nal_unit_type 1, slice_type 7) behind a
    // recovery point SEI (payload type 6, recovery_frame_cnt 0), which the
    // MP4 lists as a sync sample (stss). The B pictures after it in
    // decoding order (shown before it, 2 with this host's x264) belong to
    // the open GOP: they reference pictures of the first GOP. Decoded from
    // there after a flush, as a seek does, they cannot be decoded. They are
    // left out, as FFmpeg's decoder does (`ffmpeg -ss 0.99 -noaccurate_seek`
    // on this clip outputs the 30 frames from the I picture on) and as
    // Chromium, WebKit and VLC do on VideoToolbox (issue #2); the pictures
    // from the I picture on are whole (exact_match_flag 1), so they all come
    // out, as they look in the whole clip. Android's decoders may output the
    // leading ones too.
    // On the iOS Simulator (26.5 and 27.2), VideoToolbox fails the first
    // leading B picture with -8969 (codecBadDataErr) rather than
    // kVTVideoDecoderReferenceMissingErr (-17694), the only status the
    // decoder drops a frame for, so the decoder closes with
    // "decoder-failed" and this test fails there. On the Android emulator
    // (API 35, c2.goldfish.h264.decoder), it fails too: the decoder gives
    // no input buffer after the seek ("no input buffer").
    it("decodes H.264 from a recovery point (non-IDR key frame) after a flush", async () => {
      if (!supported() || !probes()) {
        return;
      }
      const name = "clip-h264-open-gop.mp4";
      const file = await gopClip(name, [
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-bf",
        "3",
        "-x264-params",
        "open-gop=1:keyint=30:min-keyint=30:scenecut=0:b-pyramid=none:log-level=error",
      ]);
      // The second key frame, in the bitstream: a recovery point, not an
      // IDR.
      const trace = execFileSync(
        "sh",
        [
          "-c",
          'ffmpeg -hide_banner -i "$0" -c:v copy -bsf:v trace_headers -f null - 2>&1',
          path.join(clipDirectory, name),
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      const keyPackets = trace
        .split(/^.*Packet: /m)
        .filter((p) => /^\d+ bytes, key frame/.test(p));
      const values = (packet: string, field: string) =>
        Array.from(
          packet.matchAll(
            new RegExp(`\\s${field}\\s+[01]+\\s*=\\s*(\\d+)`, "g"),
          ),
          (m) => Number(m[1]),
        );
      const recovery = keyPackets[1] ?? "";
      expect({
        first: values(keyPackets[0] ?? "", "nal_unit_type").includes(5),
        idr: values(recovery, "nal_unit_type").includes(5),
        slice: values(recovery, "nal_unit_type").includes(1),
        sei: values(recovery, "last_payload_type_byte").includes(6),
        // I slices only (slice_type 7: I, as are all the picture's).
        slices: values(recovery, "slice_type"),
        recoveryFrameCount: values(recovery, "recovery_frame_cnt"),
      }).toEqual({
        first: true,
        idr: false,
        slice: true,
        sei: true,
        slices: [7],
        recoveryFrameCount: [0],
      });

      // The whole clip, then (after a flush) from the second key frame.
      const decoded = await decodeRuns(file, [[[0, 2]], [[1, 2]]], true);
      console.log(
        `recovery point: ${JSON.stringify({ ...decoded, grids: undefined })}`,
      );
      if (!decoded.supported) {
        return;
      }
      const all = decoded.packets.map((p) => p.timestamp);
      const second = gopOf(decoded.packets, 1).map((p) => p.timestamp);
      const key = second[0]!;
      const fromKey = sorted(second.filter((t) => t >= key));
      expect(second.length - fromKey.length).toBeGreaterThan(0);
      expect({
        errors: decoded.errors,
        first: decoded.runs[0],
      }).toEqual({ errors: [], first: sorted(all) });
      if (ios()) {
        expect(decoded.runs[1]).toEqual(fromKey);
      } else {
        expect([fromKey, sorted(second)]).toContainEqual(decoded.runs[1]);
      }
      // From the key frame on, each picture is the one its timestamp says:
      // closest to the frame of that timestamp in the whole clip's decode.
      const reference = decoded.grids[0]!;
      const distance = (a: number[], b: number[]) =>
        a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0);
      const pictures = fromKey.map((t) => {
        const got = decoded.grids[1]![String(t)]!;
        let best = "";
        Object.entries(reference).forEach(([at, want]) => {
          if (!best || distance(got, want) < distance(got, reference[best]!)) {
            best = at;
          }
        });
        return best;
      });
      expect(pictures).toEqual(fromKey.map(String));
    }, 300000);

    // A key frame earlier than the frames before it, without a flush: the
    // second GOP, then the first. Each GOP's frames come out in order, all
    // of the second's before the first's: frames held for reordering go
    // out at that key frame instead of being sorted in with the first
    // GOP's.
    it("outputs a GOP that goes back in time after the one before it", async () => {
      if (!supported() || !probes()) {
        return;
      }
      const file = await gopClip("clip-h264-two-gops.mp4", [
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-g",
        "30",
        "-keyint_min",
        "30",
        "-sc_threshold",
        "0",
      ]);
      // The second GOP then the first without a flush; then each GOP on
      // its own (from a flushed decoder), for what each frame looks like.
      const decoded = await decodeRuns(
        file,
        [
          [
            [1, 2],
            [0, 1],
          ],
          [[0, 1]],
          [[1, 2]],
        ],
        true,
      );
      console.log(
        `back in time: ${JSON.stringify({ ...decoded, grids: undefined })}`,
      );
      if (!decoded.supported) {
        return;
      }
      const times = (gop: number) =>
        sorted(gopOf(decoded.packets, gop).map((p) => p.timestamp));
      expect({ errors: decoded.errors, frames: decoded.runs[0] }).toEqual({
        errors: [],
        frames: times(1).concat(times(0)),
      });
      // Each picture is the one its timestamp says: closest to the frame of
      // that timestamp decoded on its own.
      const reference = { ...decoded.grids[1], ...decoded.grids[2] };
      const distance = (a: number[], b: number[]) =>
        a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0);
      const pictures = decoded.runs[0]!.map((t) => {
        const got = decoded.grids[0]![String(t)]!;
        let best = "";
        Object.entries(reference).forEach(([key, want]) => {
          if (!best || distance(got, want) < distance(got, reference[best]!)) {
            best = key;
          }
        });
        return best;
      });
      expect(pictures).toEqual(decoded.runs[0]!.map(String));
    }, 300000);
  });

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

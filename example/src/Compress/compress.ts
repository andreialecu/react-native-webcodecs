import {
  ALL_FORMATS,
  Conversion,
  CustomSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  VideoSample,
} from "mediabunny";
import type { Rotation, VideoCodec } from "mediabunny";
import {
  createFileWritable,
  createSurfacePool,
  fileSourceOptions,
  VideoFrame,
  withBackgroundTask,
} from "react-native-webcodecs";

import { shareVideo, skiaDevice } from "../VideoExport/export";

import type { Picked } from "./pick";
import type { Settings, Source, Result } from "./settings";
import { targetSize, uprightSize } from "./settings";

// Compresses a video the way a messaging app does before sending it: decode,
// scale down on the GPU, encode at a lower bitrate, and copy the sound as it
// is. Mediabunny's Conversion drives it (demuxing, decoding, timing,
// the audio copy); its `process` hook does the scaling with WebGPU, since
// its own resizer needs a canvas, which React Native has not. The scaler
// also turns a phone's portrait video upright, as Mediabunny's resizer
// would: the output has no rotation tag.

export const openSource = async (picked: Picked): Promise<Source> => {
  const input = new Input({
    source: new CustomSource(fileSourceOptions(picked.path)),
    formats: ALL_FORMATS,
  });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) {
      throw new Error("This file has no video track");
    }
    const audio = await input.getPrimaryAudioTrack();
    const rotation = await video.getRotation();
    const duration = await input.computeDuration();
    const stats = await video.computePacketStats(100);
    return {
      name: picked.name,
      path: picked.path,
      size: picked.size,
      ...uprightSize(
        await video.getCodedWidth(),
        await video.getCodedHeight(),
        rotation,
      ),
      rotation,
      codec: (await video.getCodec()) ?? "unknown",
      duration,
      bitrate: stats.averageBitrate,
      frameRate: stats.averagePacketRate,
      audio: audio
        ? {
            codec: (await audio.getCodec()) ?? "unknown",
            channels: await audio.getNumberOfChannels(),
          }
        : null,
    };
  } finally {
    input.dispose();
  }
};

// Draws a decoded frame, scaled, into a pool surface: the frame is copied to
// a texture at its own size (react-native-webgpu converts the decoder's YUV
// or BGRA there), then drawn with a linear sampler into the surface.
const VERTEX = /* wgsl */ `
struct Out {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> Out {
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: Out;
  out.position = vec4f(p[i], 0.0, 1.0);
  out.uv = vec2f((p[i].x + 1.0) / 2.0, (1.0 - p[i].y) / 2.0);
  return out;
}
`;

// Where an upright output pixel comes from in the stored frame, for the
// frame's clockwise rotation.
const TURNS: Record<number, string> = {
  0: "in.uv",
  90: "vec2f(in.uv.y, 1.0 - in.uv.x)",
  180: "vec2f(1.0 - in.uv.x, 1.0 - in.uv.y)",
  270: "vec2f(1.0 - in.uv.y, in.uv.x)",
};

const fragment = (rotation: number) => /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;

struct Out {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  return vec4f(textureSample(src, smp, ${TURNS[rotation] ?? TURNS[0]}).rgb, 1.0);
}
`;

const makeScaler = (width: number, height: number, rotation: number) => {
  const device = skiaDevice();
  const pool = createSurfacePool(width, height);
  const vertex = device.createShaderModule({ code: VERTEX });
  const module = device.createShaderModule({ code: fragment(rotation) });
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  const pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  const pipeline = (format: GPUTextureFormat) => {
    let found = pipelines.get(format);
    if (!found) {
      found = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: vertex, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format }] },
      });
      pipelines.set(format, found);
    }
    return found;
  };
  // The decoded frame at its own size, reused while the size stays.
  let source: GPUTexture | null = null;

  const scale = (sample: VideoSample): VideoSample => {
    const frame = sample.toVideoFrame() as unknown as VideoFrame;
    try {
      const w = frame.codedWidth;
      const h = frame.codedHeight;
      if (!source || source.width !== w || source.height !== h) {
        source?.destroy();
        source = device.createTexture({
          size: [w, h],
          format: "rgba8unorm",
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }
      const decoded = RNWebGPU.createNativeBufferFromPointer(
        frame.pixelBuffer!,
        { colorSpace: frame.nativeBufferColorSpace },
      );
      device.queue.copyExternalImageToTexture(
        { source: decoded },
        { texture: source },
        [w, h],
      );
      decoded.release();

      const surface = pool.acquire();
      const buffer = RNWebGPU.createNativeBufferFromPointer(
        surface.pixelBuffer,
      );
      const memory = device.importSharedTextureMemory({ source: buffer });
      const target = memory.createTexture();
      memory.beginAccess(target, false);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: target.createView(), loadOp: "clear", storeOp: "store" },
        ],
      });
      const p = pipeline(target.format);
      pass.setPipeline(p);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: p.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: source.createView() },
            { binding: 1, resource: sampler },
          ],
        }),
      );
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      const { fences } = memory.endAccess(target);
      target.destroy();
      memory.destroy();
      buffer.release();
      return new VideoSample(
        new VideoFrame(surface, {
          timestamp: frame.timestamp,
          duration: frame.duration ?? undefined,
          fence: fences[0],
        }) as never,
      );
    } finally {
      frame.close();
    }
  };
  return {
    scale,
    dispose: () => {
      source?.destroy();
    },
  };
};

export const compress = async (
  source: Source,
  settings: Settings,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<Result | null> => {
  const started = performance.now();
  const input = new Input({
    source: new CustomSource(fileSourceOptions(source.path)),
    formats: ALL_FORMATS,
  });
  const file = createFileWritable("compressed.mp4");
  const output = new Output({
    // The index goes first ("reserve" leaves room for it), so the file can
    // play while it downloads, as a sent video should.
    format: new Mp4OutputFormat({ fastStart: "reserve" }),
    target: new StreamTarget(file.writable),
  });
  const { width, height } = targetSize(source, settings.resolution);
  const scaler = makeScaler(width, height, source.rotation);
  try {
    const conversion = await Conversion.init({
      input,
      output,
      video: {
        codec: settings.codec as VideoCodec,
        quality: new Quality({ bitrate: settings.videoBitrate }),
        frameRate: settings.frameRate ?? undefined,
        forceTranscode: true,
        // Undoes the rotation tag, so Mediabunny hands over the frames as
        // stored and leaves the turning to the scaler.
        rotate: ((360 - source.rotation) % 360) as Rotation,
        processedWidth: width,
        processedHeight: height,
        process: scaler.scale,
      },
      audio: settings.audio ? undefined : { discard: true },
    });
    if (!conversion.isValid) {
      throw new Error(
        conversion.discardedTracks
          .map((t) => `${t.track.type}: ${t.reason}`)
          .join(", "),
      );
    }
    conversion.onProgress = (progress) => onProgress(progress);
    const abort = () => conversion.cancel();
    signal.addEventListener("abort", abort);
    try {
      await withBackgroundTask(() => conversion.execute());
    } finally {
      signal.removeEventListener("abort", abort);
    }
    if (signal.aborted) {
      file.remove();
      return null;
    }
    const written = fileSourceOptions(file.path);
    const size = written.getSize();
    written.dispose();
    return {
      path: file.path,
      size,
      width,
      height,
      ms: performance.now() - started,
    };
  } catch (e) {
    if (signal.aborted) {
      file.remove();
      return null;
    }
    throw e;
  } finally {
    scaler.dispose();
    input.dispose();
  }
};

export const shareResult = (result: Result, _name: string) =>
  shareVideo(result.path);

import type { SkSkottieAnimation } from "react-native-skia";
import { AlphaType, ColorType, Skia } from "react-native-skia";
import {
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSource,
} from "mediabunny";
import { getAssetByID } from "react-native-web/dist/modules/AssetRegistry";

import { makeHalfFloatSurface } from "./halfFloat";
import { HLG_COLOR_SPACE, HLG_WGSL } from "./hdr";

// The export on the web: React Native Skia draws each frame of the animation
// with CanvasKit, the frame's pixels become a VideoFrame, the browser's
// WebCodecs encodes it, and Mediabunny writes the MP4 into memory. The file
// is then a blob URL to download. The native version is export.ts.
//
// HDR: browsers offer no HEVC Main 10 encoder (Chromium has none), but
// Chromium encodes VP9 Profile 2 (10-bit) in software. CanvasKit draws on a
// half-float target, a WebGPU compute pass turns the pixels into HLG in
// BT.2020 (the same math as the native HlgRenderer) and then into 10-bit
// 4:2:0 YUV, which becomes an I420P10 VideoFrame tagged HLG.

export const WIDTH = 1080;
export const HEIGHT = 1920;
// Bits per second: 8 Mbps for H.264, 12 Mbps for 10-bit HDR.
const SDR_BITRATE = 8_000_000;
const HDR_BITRATE = 12_000_000;
// WebCodecs timestamps and durations are in microseconds.
const MICROSECONDS_PER_SECOND = 1_000_000;

export interface Result {
  path: string;
  frames: number;
  duration: number;
  ms: number;
}

// Only the native HDR preview uses Skia's WebGPU device.
export const skiaDevice = (): GPUDevice => {
  throw new Error("Skia has no WebGPU device on the web");
};

export const assetBytes = async (asset: number) => {
  const { httpServerLocation, name, type } = getAssetByID(asset);
  const response = await fetch(`${httpServerLocation}/${name}.${type}`);
  return new Uint8Array(await response.arrayBuffer());
};

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

// VP9 Profile 2, 10 bits, level 1.0 as Chromium names it.
const VP9_PROFILE2 = "vp09.02.10.10";

interface Frames {
  // The VideoFrame of frame `index`, which the caller closes.
  frame(
    index: number,
    timestamp: number,
    duration: number,
  ): Promise<VideoFrame>;
  dispose(): void;
}

// SDR: a WebGL surface of React Native Skia, read back as RGBA.
const sdrFrames = (animation: SkSkottieAnimation): Frames => {
  const surface = Skia.Surface.MakeOffscreen(WIDTH, HEIGHT);
  if (!surface) {
    throw new Error("Skia could not make a surface");
  }
  const bounds = Skia.XYWHRect(0, 0, WIDTH, HEIGHT);
  return {
    async frame(index, timestamp, duration) {
      const canvas = surface.getCanvas();
      canvas.clear(Skia.Color("black"));
      animation.seekFrame(index);
      animation.render(canvas, bounds);
      surface.flush();
      const image = surface.makeImageSnapshot();
      const pixels = await image.readPixels(0, 0, {
        width: WIDTH,
        height: HEIGHT,
        colorType: ColorType.RGBA_8888,
        alphaType: AlphaType.Unpremul,
      });
      image.dispose();
      if (!(pixels instanceof Uint8Array)) {
        throw new Error("Skia could not read the frame's pixels");
      }
      return new VideoFrame(pixels, {
        format: "RGBA",
        codedWidth: WIDTH,
        codedHeight: HEIGHT,
        timestamp,
        duration,
      });
    },
    dispose() {
      surface.dispose();
    },
  };
};

// Each invocation converts a 4×2 block: four pairs of luma samples and two
// of each chroma sample (4:2:0), packed two 16-bit samples per u32, little
// endian, in the I420P10 layout (Y, then U, then V planes). Limited range:
// Y from 64 to 940, Cb and Cr around 512.
const YUV_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> yuv: array<u32>;
const W = ${WIDTH}u;
const H = ${HEIGHT}u;
${HLG_WGSL}
fn code(v: f32, offset: f32, range: f32) -> u32 {
  return u32(clamp(round(offset + range * v), 0.0, 1023.0));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= W / 4u || id.y >= H / 2u) {
    return;
  }
  var cb = array<f32, 2>();
  var cr = array<f32, 2>();
  for (var half = 0u; half < 2u; half++) {
    let x = id.x * 4u + half * 2u;
    var sumB = 0.0;
    var sumR = 0.0;
    for (var dy = 0u; dy < 2u; dy++) {
      let y = id.y * 2u + dy;
      var luma = array<u32, 2>();
      for (var dx = 0u; dx < 2u; dx++) {
        let e = toHlg(textureLoad(src, vec2u(x + dx, y), 0).rgb);
        // BT.2020 non-constant luminance.
        let l = dot(e, vec3f(0.2627, 0.6780, 0.0593));
        luma[dx] = code(l, 64.0, 876.0);
        sumB += (e.b - l) / 1.8814;
        sumR += (e.r - l) / 1.4746;
      }
      yuv[(y * W + x) / 2u] = luma[0] | (luma[1] << 16u);
    }
    cb[half] = sumB / 4.0;
    cr[half] = sumR / 4.0;
  }
  let c = (id.y * (W / 2u) + id.x * 2u) / 2u;
  let u = W * H / 2u;
  let v = u + W * H / 8u;
  yuv[u + c] = code(cb[0], 512.0, 896.0) | (code(cb[1], 512.0, 896.0) << 16u);
  yuv[v + c] = code(cr[0], 512.0, 896.0) | (code(cr[1], 512.0, 896.0) << 16u);
}
`;

// HDR: CanvasKit's half-float target, converted to 10-bit HLG YUV on the GPU.
const hdrFrames = async (animation: SkSkottieAnimation): Promise<Frames> => {
  const adapter = await navigator.gpu?.requestAdapter();
  const device = await adapter?.requestDevice();
  if (!device) {
    throw new Error("HDR export needs WebGPU.");
  }
  const half = makeHalfFloatSurface(WIDTH, HEIGHT);
  const texture = device.createTexture({
    size: [WIDTH, HEIGHT],
    format: "rgba16float",
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  const size = WIDTH * HEIGHT * 3; // 1.5 samples a pixel, 2 bytes each
  const yuv = device.createBuffer({
    size,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: {
      module: device.createShaderModule({ code: YUV_SHADER }),
      entryPoint: "main",
    },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: { buffer: yuv } },
    ],
  });
  const bounds = Skia.XYWHRect(0, 0, WIDTH, HEIGHT);
  return {
    async frame(index, timestamp, duration) {
      animation.seekFrame(index);
      half.draw(1, (canvas) => animation.render(canvas, bounds));
      const pixels = half.read();
      if (!pixels) {
        throw new Error("CanvasKit could not read the frame's pixels");
      }
      device.queue.writeTexture(
        { texture },
        pixels,
        { bytesPerRow: WIDTH * 8 },
        [WIDTH, HEIGHT],
      );
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(WIDTH / 4 / 8),
        Math.ceil(HEIGHT / 2 / 8),
      );
      pass.end();
      encoder.copyBufferToBuffer(yuv, 0, readback, 0, size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(readback.getMappedRange().slice(0));
      readback.unmap();
      return new VideoFrame(data, {
        // 10-bit formats are missing from the DOM typings.
        format: "I420P10" as VideoPixelFormat,
        codedWidth: WIDTH,
        codedHeight: HEIGHT,
        timestamp,
        duration,
        colorSpace: HLG_COLOR_SPACE as VideoColorSpaceInit,
      });
    },
    dispose() {
      half.dispose();
      texture.destroy();
      yuv.destroy();
      readback.destroy();
      device.destroy();
    },
  };
};

export const exportVideo = async (
  animation: SkSkottieAnimation,
  sound: Uint8Array | null,
  hdr: boolean,
  signal: AbortSignal,
  onProgress: (frames: number, totalFrames: number) => void,
): Promise<Result | null> => {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("This browser has no WebCodecs VideoEncoder.");
  }
  if (hdr) {
    const { supported } = await VideoEncoder.isConfigSupported({
      codec: VP9_PROFILE2,
      width: WIDTH,
      height: HEIGHT,
    });
    if (!supported) {
      throw new Error("This browser has no 10-bit VP9 encoder for HDR.");
    }
  }
  const start = performance.now();
  const fps = animation.fps();
  const totalFrames = Math.round(animation.duration() * fps);
  const duration = totalFrames / fps;

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const video = new VideoSampleSource(
    hdr
      ? {
          codec: "vp9",
          fullCodecString: VP9_PROFILE2,
          quality: new Quality({ bitrate: HDR_BITRATE }),
        }
      : { codec: "avc", quality: new Quality({ bitrate: SDR_BITRATE }) },
  );
  output.addVideoTrack(video, { frameRate: fps });
  const audio = sound ? new EncodedAudioPacketSource("aac") : null;
  if (audio) {
    output.addAudioTrack(audio);
  }
  await output.start();

  const frames = hdr ? await hdrFrames(animation) : sdrFrames(animation);
  try {
    // The sound, copied without re-encoding and cut where the video ends.
    if (sound && audio) {
      const input = new Input({
        source: new BufferSource(sound),
        formats: [MP4],
      });
      const track = await input.getPrimaryAudioTrack();
      if (track) {
        const decoderConfig = await track.getDecoderConfig();
        let first = true;
        for await (const packet of new EncodedPacketSink(track).packets()) {
          if (packet.timestamp >= duration) {
            break;
          }
          await audio.add(
            packet,
            first && decoderConfig ? { decoderConfig } : undefined,
          );
          first = false;
        }
      }
      audio.close();
    }

    let slice = performance.now();
    for (let i = 0; i < totalFrames; i++) {
      if (performance.now() - slice > 8) {
        await yieldToEventLoop();
        slice = performance.now();
      }
      if (signal.aborted) {
        await output.cancel();
        return null;
      }
      const frame = await frames.frame(
        i,
        Math.round((i * MICROSECONDS_PER_SECOND) / fps),
        Math.round(MICROSECONDS_PER_SECOND / fps),
      );
      const sample = new VideoSample(frame);
      try {
        await video.add(sample);
      } finally {
        sample.close();
        frame.close();
      }
      if (i % 5 === 4 || i === totalFrames - 1) {
        onProgress(i + 1, totalFrames);
      }
    }
    video.close();
    await output.finalize();
  } catch (e) {
    if (output.state !== "canceled" && output.state !== "finalized") {
      await output.cancel().catch(() => {});
    }
    throw e;
  } finally {
    frames.dispose();
  }
  const blob = new Blob([target.buffer!], { type: "video/mp4" });
  return {
    path: URL.createObjectURL(blob),
    frames: totalFrames,
    duration,
    ms: performance.now() - start,
  };
};

// Downloads the exported file.
export const shareVideo = (url: string) => {
  const link = document.createElement("a");
  link.href = url;
  link.download = "video-export.mp4";
  link.click();
};

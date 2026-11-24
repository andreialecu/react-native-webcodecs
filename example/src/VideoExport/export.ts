import { Image, Platform, Share } from "react-native";
import type { SkCanvas, SkSkottieAnimation } from "react-native-skia";
import { Skia } from "react-native-skia";
import type {
  GPUSharedFenceState,
  GPUSharedTextureMemory,
} from "react-native-webgpu";
import { importDevice } from "react-native-webgpu";
import {
  createFileWritable,
  createSurfacePool,
  installWebCodecs,
  VideoEncoder,
  VideoFrame,
  withBackgroundTask,
} from "react-native-webcodecs";
import {
  BufferSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
} from "mediabunny";

import { AV1_MAIN10, HEVC_MAIN10, HLG_COLOR_SPACE, HlgRenderer } from "./hdr";

// The export on iOS and Android: Skia draws each frame of the animation into
// a pooled native surface through WebGPU, VideoToolbox or MediaCodec encodes
// it, and Mediabunny writes the MP4 (with the sound copied as is). The web
// version is export.web.ts.

export const WIDTH = 1080;
export const HEIGHT = 1920;
// Bits per second: 8 Mbps for H.264, 12 Mbps for 10-bit HDR.
const SDR_BITRATE = 8_000_000;
const HDR_BITRATE = 12_000_000;
// WebCodecs timestamps and durations are in microseconds.
const MICROSECONDS_PER_SECOND = 1_000_000;

installWebCodecs();

export interface Result {
  path: string;
  frames: number;
  duration: number;
  ms: number;
}

let sharedDevice: GPUDevice | null = null;
// Skia's own device: textures it renders into must belong to it.
export const skiaDevice = () => {
  if (!sharedDevice) {
    sharedDevice = importDevice(Skia.getNativeDevice());
  }
  return sharedDevice;
};

export const assetBytes = async (asset: number) => {
  const source = Image.resolveAssetSource(asset);
  if (!source) {
    throw new Error("Asset not found");
  }
  const response = await fetch(source.uri);
  return new Uint8Array(await response.arrayBuffer());
};

type Pool = ReturnType<typeof createSurfacePool>;
type Drawn = {
  surface: ReturnType<Pool["acquire"]>;
  fence?: GPUSharedFenceState;
};

const drawSkottie = (
  canvas: SkCanvas,
  animation: SkSkottieAnimation,
  index: number,
) => {
  canvas.clear(Skia.Color("black"));
  animation.seekFrame(index);
  animation.render(canvas, Skia.XYWHRect(0, 0, WIDTH, HEIGHT));
};

// Skia draws frame `index` straight into a pool surface, on its own device:
// no copy, no readback. The encoder waits for Skia's GPU work through the
// fence. (On the Android emulator this needs react-native-skia#4510, applied
// here as a patch.)
const drawFrame = (
  animation: SkSkottieAnimation,
  pool: Pool,
  index: number,
): Drawn => {
  const device = skiaDevice();
  const surface = pool.acquire();
  const buffer = RNWebGPU.createNativeBufferFromPointer(surface.pixelBuffer);
  let memory: GPUSharedTextureMemory | null = null;
  let texture: GPUTexture | null = null;
  let accessing = false;
  try {
    memory = device.importSharedTextureMemory({ source: buffer });
    const target = memory.createTexture();
    texture = target;
    memory.beginAccess(target, false);
    accessing = true;
    const skSurface = Skia.Surface.MakeFromGPUTexture(target);
    if (!skSurface) {
      throw new Error("Skia.Surface.MakeFromGPUTexture returned null");
    }
    drawSkottie(skSurface.getCanvas(), animation, index);
    skSurface.flush();
    const { fences } = memory.endAccess(target);
    accessing = false;
    skSurface.dispose();
    return { surface, fence: fences[0] };
  } catch (e) {
    surface.release();
    throw e;
  } finally {
    if (accessing && memory && texture) {
      memory.endAccess(texture);
    }
    texture?.destroy();
    memory?.destroy();
    buffer.release();
  }
};

// Lets the JS thread handle touches and renders between frames: the export
// loop otherwise runs for its whole length without giving it back.
const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export const exportVideo = async (
  animation: SkSkottieAnimation,
  sound: Uint8Array | null,
  hdr: boolean,
  signal: AbortSignal,
  onProgress: (frames: number, totalFrames: number) => void,
): Promise<Result | null> => {
  const start = performance.now();
  // HDR: HEVC Main 10 on iOS, AV1 Main 10 on Android.
  const hdrCodec =
    Platform.OS === "android"
      ? { codec: "av1" as const, fullCodecString: AV1_MAIN10 }
      : { codec: "hevc" as const, fullCodecString: HEVC_MAIN10 };
  if (hdr) {
    const { supported } = await VideoEncoder.isConfigSupported({
      codec: hdrCodec.fullCodecString,
      width: WIDTH,
      height: HEIGHT,
    });
    if (!supported) {
      throw new Error(
        `This device has no ${
          hdrCodec.codec === "av1" ? "AV1" : "HEVC"
        } Main 10 encoder for HDR.`,
      );
    }
  }
  const fps = animation.fps();
  const totalFrames = Math.round(animation.duration() * fps);
  const duration = totalFrames / fps;

  const file = createFileWritable(
    hdr ? "video-export-hdr.mp4" : "video-export.mp4",
  );
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new StreamTarget(file.writable, { chunked: true }),
  });
  const video = new VideoSampleSource(
    hdr
      ? { ...hdrCodec, quality: new Quality({ bitrate: HDR_BITRATE }) }
      : { codec: "avc", quality: new Quality({ bitrate: SDR_BITRATE }) },
  );
  output.addVideoTrack(video, { frameRate: fps });
  const audio = sound ? new EncodedAudioPacketSource("aac") : null;
  if (audio) {
    output.addAudioTrack(audio);
  }
  await output.start();

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

    const pool = createSurfacePool(WIDTH, HEIGHT, hdr ? "RGBA16F" : "BGRA");
    const hlg = hdr ? new HlgRenderer(skiaDevice(), WIDTH, HEIGHT) : null;
    let slice = performance.now();
    try {
      for (let i = 0; i < totalFrames; i++) {
        if (performance.now() - slice > 8) {
          await yieldToEventLoop();
          slice = performance.now();
        }
        if (signal.aborted) {
          await output.cancel();
          file.remove();
          return null;
        }
        const { surface, fence } = hlg
          ? hlg.draw(animation, pool, i)
          : drawFrame(animation, pool, i);
        if (!fence) {
          await skiaDevice().queue.onSubmittedWorkDone();
        }
        // Mediabunny is typed against the DOM's VideoFrame, which ours
        // implements (it is installed on globalThis as that class).
        const frame = new VideoFrame(surface, {
          timestamp: Math.round((i * MICROSECONDS_PER_SECOND) / fps),
          duration: Math.round(MICROSECONDS_PER_SECOND / fps),
          fence,
          colorSpace: hdr ? HLG_COLOR_SPACE : undefined,
        });
        const sample = new VideoSample(
          frame as unknown as globalThis.VideoFrame,
        );
        try {
          // Resolves once the encoder can take more: no await per GPU frame.
          await video.add(sample);
        } finally {
          sample.close();
        }
        if (i % 5 === 4 || i === totalFrames - 1) {
          onProgress(i + 1, totalFrames);
        }
      }
    } finally {
      hlg?.dispose();
    }
    video.close();
    // Completes even if the user leaves the app meanwhile (iOS).
    await withBackgroundTask(() => output.finalize());
  } catch (e) {
    if (output.state !== "canceled" && output.state !== "finalized") {
      await output.cancel().catch(() => {});
    }
    file.remove();
    throw e;
  }
  return {
    path: file.path,
    frames: totalFrames,
    duration,
    ms: performance.now() - start,
  };
};

// Opens the share sheet with the exported file.
export const shareVideo = (path: string) => {
  if (Platform.OS === "ios") {
    Share.share({ url: `file://${path}` });
  } else {
    Share.share({ message: path });
  }
};

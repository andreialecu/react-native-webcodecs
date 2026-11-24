import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
} from "mediabunny";
import type { VideoCodec } from "mediabunny";

import type { Picked } from "./pick";
import type { Result, Settings, Source } from "./settings";
import { targetSize, uprightSize } from "./settings";

// The web side of compress.ts: the browser's WebCodecs, and Mediabunny's own
// resizer (a canvas), on the picked File. The size is the upright one:
// Mediabunny turns the frames while it resizes them.

export const openSource = async (picked: Picked): Promise<Source> => {
  const input = new Input({
    source: new BlobSource(picked.file!),
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
      file: picked.file,
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

export const compress = async (
  source: Source,
  settings: Settings,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<Result | null> => {
  const started = performance.now();
  const input = new Input({
    source: new BlobSource(source.file!),
    formats: ALL_FORMATS,
  });
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target,
  });
  const { width, height } = targetSize(source, settings.resolution);
  try {
    const conversion = await Conversion.init({
      input,
      output,
      video: {
        codec: settings.codec as VideoCodec,
        quality: new Quality({ bitrate: settings.videoBitrate }),
        frameRate: settings.frameRate ?? undefined,
        forceTranscode: true,
        width,
        height,
        fit: "fill",
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
      await conversion.execute();
    } finally {
      signal.removeEventListener("abort", abort);
    }
    if (signal.aborted || !target.buffer) {
      return null;
    }
    const blob = new Blob([target.buffer], { type: "video/mp4" });
    return {
      path: URL.createObjectURL(blob),
      size: blob.size,
      width,
      height,
      ms: performance.now() - started,
    };
  } catch (e) {
    if (signal.aborted) {
      return null;
    }
    throw e;
  } finally {
    input.dispose();
  }
};

export const shareResult = (result: Result, name: string) => {
  const link = document.createElement("a");
  link.href = result.path;
  link.download = name.replace(/\.[^.]+$/, "") + "-compressed.mp4";
  link.click();
};

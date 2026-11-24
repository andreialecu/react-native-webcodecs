// What the Compress screen asks for, and the numbers derived from it.

export interface Source {
  name: string;
  // A native path, or the picked File on the web.
  path: string;
  file?: File;
  size: number;
  // As it plays, upright: a phone's portrait video is taller than wide even
  // when its frames are stored landscape with a rotation tag.
  width: number;
  height: number;
  // Degrees clockwise from the stored frames to the upright picture.
  rotation: number;
  codec: string;
  duration: number;
  // Bits per second, from the packets.
  bitrate: number;
  frameRate: number;
  audio: { codec: string; channels: number } | null;
}

export interface Result {
  // A native path, or an object URL on the web.
  path: string;
  size: number;
  width: number;
  height: number;
  ms: number;
}

// The shorter side of the output, in pixels; "original" keeps the size.
export type Resolution = "original" | "1080" | "720" | "480";
export type QualityLevel = "low" | "medium" | "high";
export type Codec = "avc" | "hevc" | "av1" | "vp9";

export interface Settings {
  resolution: Resolution;
  quality: QualityLevel;
  codec: Codec;
  // null: the source's frame rate.
  frameRate: number | null;
  audio: boolean;
  videoBitrate: number;
}

export const CODEC_NAMES: Record<Codec, string> = {
  avc: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
};

// Codec strings to ask isConfigSupported about, in order of preference
// for sending: H.264 plays everywhere.
export const CODEC_STRINGS: Record<Codec, string> = {
  avc: "avc1.640028",
  hevc: "hvc1.1.6.L120.B0",
  av1: "av01.0.08M.08",
  vp9: "vp09.00.40.08",
};

// Bits per pixel per frame, for H.264; newer codecs need fewer for the
// same picture.
const BITS_PER_PIXEL: Record<QualityLevel, number> = {
  low: 0.04,
  medium: 0.07,
  high: 0.11,
};
const CODEC_EFFICIENCY: Record<Codec, number> = {
  avc: 1,
  hevc: 0.65,
  av1: 0.55,
  vp9: 0.7,
};

// AAC as most phones record it, for the estimate.
export const AUDIO_BITRATE = 128_000;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

// The upright size of frames stored at `width`×`height` and turned by
// `rotation`.
export const uprightSize = (width: number, height: number, rotation: number) =>
  rotation % 180 === 0 ? { width, height } : { width: height, height: width };

export const targetSize = (
  source: Pick<Source, "width" | "height">,
  resolution: Resolution,
) => {
  const shorter = Math.min(source.width, source.height);
  const scale =
    resolution === "original" ? 1 : Math.min(1, Number(resolution) / shorter);
  return {
    width: even(source.width * scale),
    height: even(source.height * scale),
  };
};

export const videoBitrate = (
  source: Source,
  resolution: Resolution,
  quality: QualityLevel,
  codec: Codec,
  frameRate: number | null,
) => {
  const { width, height } = targetSize(source, resolution);
  const fps = frameRate ?? (source.frameRate || 30);
  const bitrate =
    width * height * fps * BITS_PER_PIXEL[quality] * CODEC_EFFICIENCY[codec];
  // Never more than the source had: that would only grow the file.
  const ceiling = source.bitrate > 0 ? source.bitrate : bitrate;
  return Math.round(Math.min(bitrate, ceiling) / 10_000) * 10_000;
};

export const estimatedSize = (source: Source, settings: Settings) =>
  ((settings.videoBitrate +
    (settings.audio && source.audio ? AUDIO_BITRATE : 0)) *
    source.duration) /
  8;

export const formatBytes = (bytes: number) => {
  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(2)} GB`;
  }
  if (bytes >= 1e6) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
};

export const formatBitrate = (bps: number) =>
  bps >= 1e6
    ? `${(bps / 1e6).toFixed(1)} Mbps`
    : `${Math.round(bps / 1e3)} kbps`;

export const formatDuration = (seconds: number) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

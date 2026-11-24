// On the web, the browser has WebCodecs of its own: the classes are the
// browser's, and installWebCodecs() leaves them in place. The additions that
// rest on native surfaces and files (surface pools, VideoFrame from a native
// handle and fence, native file streams) have no web counterpart and throw
// NotSupportedError; use a canvas as the VideoFrame source, and Mediabunny's
// BufferTarget and BlobSource for files.

const g = globalThis as unknown as Record<string, unknown>;

const notSupported = (what: string) => () => {
  throw new DOMException(
    `${what} is not available on the web: it rests on native surfaces and files.`,
    "NotSupportedError",
  );
};

/** On the web, the browser's classes stay: returns false. */
export const installWebCodecs = () => false;

export const VideoFrame = g.VideoFrame as typeof globalThis.VideoFrame;
export const VideoColorSpace =
  g.VideoColorSpace as typeof globalThis.VideoColorSpace;
export const EncodedVideoChunk =
  g.EncodedVideoChunk as typeof globalThis.EncodedVideoChunk;
export const EncodedAudioChunk =
  g.EncodedAudioChunk as typeof globalThis.EncodedAudioChunk;
export const VideoEncoder = g.VideoEncoder as typeof globalThis.VideoEncoder;
export const VideoDecoder = g.VideoDecoder as typeof globalThis.VideoDecoder;
export const AudioData = g.AudioData as typeof globalThis.AudioData;
export const AudioEncoder = g.AudioEncoder as typeof globalThis.AudioEncoder;
export const AudioDecoder = g.AudioDecoder as typeof globalThis.AudioDecoder;

/** Nothing keeps a web page alive in the background: runs `fn`. */
export const withBackgroundTask = <T>(fn: () => Promise<T>) => fn();

export const createSurfacePool = notSupported("createSurfacePool") as (
  width: number,
  height: number,
  format?: "BGRA" | "NV12" | "RGBA16F",
) => never;
export const createFileWritable = notSupported("createFileWritable") as (
  path: string,
) => never;
export const fileSourceOptions = notSupported("fileSourceOptions") as (
  path: string,
) => never;
export const writeFile = notSupported("writeFile") as (
  path: string,
  data: ArrayBuffer | ArrayBufferView,
) => never;
export const removeFile = notSupported("removeFile") as (path: string) => never;
export const resolvePath = notSupported("resolvePath") as (
  path: string,
) => never;

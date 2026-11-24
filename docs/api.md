# API

[README](../README.md) · [Guides](guides.md) · [HDR](hdr.md) · [Web](web.md) · [API](api.md) · [How it works](how-it-works.md)

- [Checking support](#checking-support)
- [What is implemented](#what-is-implemented)
- [Additions](#additions)
- [Errors](#errors)
- [Backgrounding](#backgrounding)

## Checking support

WebCodecs has no call that lists codecs, on purpose (it would help
fingerprinting). Ask about the config you want instead:

```ts
const { supported } = await VideoEncoder.isConfigSupported({
  codec: "hvc1.2.4.L153.B0", // HEVC Main 10
  width: 1080,
  height: 1920,
});
```

To see what a device has, ask about each candidate in turn:

```ts
const CANDIDATES = {
  "H.264": "avc1.640028",
  "HEVC Main": "hvc1.1.6.L120.B0",
  "HEVC Main 10": "hvc1.2.4.L153.B0",
  "AV1 Main 10": "av01.0.08M.10",
};
for (const [name, codec] of Object.entries(CANDIDATES)) {
  const { supported } = await VideoEncoder.isConfigSupported({
    codec,
    width: 1920,
    height: 1080,
  });
  console.log(name, supported);
}
```

How each platform answers:

- **iOS** opens a VideoToolbox session with the config, sets its profile,
  prepares it to encode (which allocates what it needs), and closes it. Sizes
  above the codec's highest level are refused before that, since
  VideoToolbox would only fail at the first frame.
- **Android** asks `MediaCodecList` for an encoder that takes the size and
  profile, with the input the encoder will use (a surface, or P010 buffers
  for Main 10, which HDR needs), a hardware one before a software one. As in
  Media3, sizes are read leniently (even sizes also aligned up to the encoder's
  alignment, swapped, and 1920x1080 or 3840x2160 when the device's camera records
  them), and the frame rate and bitrate are hints: the bitrate, or the
  default of width × height × fps × 0.1, is clamped into the encoder's
  range, and the frame rate is floored, and ignored below 1. The encoder that
  answered is the one `configure` creates. An H.264 profile no encoder lists
  is a preference rather than a requirement: the encoder's default is used,
  and the output's `description` says which. Android 10 (API 29) or later.

`isConfigSupported` returns a copy of the config with only the members the
specification defines (plus `outputFormat` for `VideoDecoder`), as browsers
do.

## What is implemented

| Interface | Implemented | Not implemented |
| :-- | :-- | :-- |
| `VideoEncoder` | `configure`, `encode` (with `keyFrame`), `flush`, `reset`, `close`, `state`, `encodeQueueSize`, `dequeue` and `ondequeue`, `isConfigSupported`. Config: `codec`, `width`, `height`, `bitrate`, `framerate`, `latencyMode`. Output metadata: `decoderConfig` with `description` and `colorSpace`. | `hardwareAcceleration`, `bitrateMode`, `scalabilityMode` (SVC), `alpha`, `contentHint`, `displayWidth`/`displayHeight`; per-frame encode options other than `keyFrame`; Annex B output (`avc.format`/`hevc.format: "annexb"` is reported unsupported). |
| `VideoDecoder` | `configure`, `decode`, `flush`, `reset`, `close`, `state`, `decodeQueueSize`, `dequeue`, `isConfigSupported`. Config: `codec`, `description`, `codedWidth`, `codedHeight`, `colorSpace`. | Streams without a `description` (Annex B), `hardwareAcceleration`, `optimizeForLatency`, `rotation`, `flip`, `displayAspectWidth`/`Height`. |
| `AudioEncoder` | The same members as `VideoEncoder`. Config: `codec`, `sampleRate`, `numberOfChannels`, `bitrate`. | Codec-specific options (`aac.format`, Opus, FLAC). AAC-LC only, in 1 or 2 channels; iOS also only at the standard AAC sample rates (8 to 96 kHz). |
| `AudioDecoder` | The same members as `VideoDecoder`. Output: `f32` interleaved. | Other output formats (convert with `AudioData.copyTo`). |
| `VideoFrame` | From another `VideoFrame` or a native surface; `format`, `codedWidth`/`Height`, `codedRect`, `visibleRect`, `displayWidth`/`Height`, `timestamp`, `duration`, `colorSpace`, `clone`, `close`. | Frames from pixels in memory (`BufferSource`), `ImageBitmap`, a canvas or an image; `copyTo`, `allocationSize`, `metadata()`; cropping (`visibleRect` is the whole frame); `rotation` is always 0 and `flip` false. |
| `AudioData` | From samples in memory; `u8`, `s16`, `s32`, `f32`, interleaved and planar; `copyTo` (with format conversion), `allocationSize`, `clone`, `close`. | `transfer`. |
| `EncodedVideoChunk`, `EncodedAudioChunk` | As specified. | `transfer`. |
| `VideoColorSpace` | As specified. | |
| `ImageDecoder` | | Not implemented. |

## Additions

| | |
| --- | --- |
| `VideoFrame` | `new VideoFrame(surface, init)` from a pool surface or `{ handle }` (any native surface, such as a camera frame). `init.fence`: a React Native WebGPU `endAccess()` fence, or `{ handle, value }`. `pixelBuffer` and `nativeHandle` give the native buffer back. |
| `VideoDecoder` | `outputFormat: "BGRA" \| "NV12"` in the config (iOS: both, default BGRA; Android: NV12). |
| `createSurfacePool(width, height, format?)` | Recycled GPU surfaces to draw frames into: `"BGRA"` (default), `"NV12"`, or `"RGBA16F"` (half float, for HDR). On Android, `"BGRA"` gives RGBA surfaces (the frames' `format` says `"RGBA"`), and `"NV12"` is not supported. |
| `createFileWritable(path)` | `{ writable, path, remove() }`: a `WritableStream` for Mediabunny's `StreamTarget`, written natively at the positions it asks for. |
| `fileSourceOptions(path)` | Options for Mediabunny's `CustomSource`, read natively. |
| `withBackgroundTask(fn)` | Runs `fn` with the app kept alive in the background (an iOS background task). |
| `writeFile`, `removeFile`, `resolvePath` | A relative path is in the app's cache directory; `file://` URLs are paths. Writing creates the missing directories. |
| `installWebCodecs()` | Installs the classes, `DOMException` and `WritableStream` on `globalThis` where missing. |

## Errors

Errors are `DOMException`s with the WebCodecs names (`NotSupportedError`,
`InvalidStateError`, `EncodingError`, `NotFoundError`, `NotReadableError`,
`DataError`, `AbortError` for a `flush()` that `reset()` or `close()` cut
short), and a
string `code` where there is more to say:

- `interrupted`: the app went to the background while a codec was in use
  (iOS takes the hardware codecs away), or Android reclaimed the codec.
- `encoder-failed`, `decoder-failed`: the platform codec failed or stopped
  producing output.

## Backgrounding

iOS takes the hardware codecs away from an app in the background
(VideoToolbox then fails with `kVTInvalidSessionErr`). A configured video
encoder or decoder therefore fails with `interrupted` as soon as the app
goes to the background, rather than on a later frame, unless a
`withBackgroundTask()` is running. Configure codecs when you need them,
and close them when done. In that case, the app keeps running for as long as iOS grants, and
the codecs keep going. Wrap `finalize()` in it so that an export the user
leaves near the end still completes.

Android keeps a backgrounded app running. A codec the system reclaims for
another app reports `interrupted`.

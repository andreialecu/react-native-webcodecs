# How it works

[README](../README.md) · [Guides](guides.md) · [HDR](hdr.md) · [Web](web.md) · [API](api.md) · [How it works](how-it-works.md)

## Layers

The WebCodecs classes are TypeScript (`src/lib`). Each one drives a native
object through [Nitro Modules](https://nitro.margelo.com): Swift on iOS, C++
on Android. The native interface is one file,
[`src/specs/WebCodecs.nitro.ts`](../src/specs/WebCodecs.nitro.ts), and
`nitrogen/` is generated from it.

The TypeScript side keeps the WebCodecs state machine (`unconfigured`,
`configured`, `closed`), the queue counters and the `dequeue` events, turns
native errors into `DOMException`s, and converts configs. The native side
owns the codec sessions, the surfaces and the files.

## Surfaces and pools

A `NativeSurface` is one reference to a GPU-shareable image: an IOSurface
(with the `CVPixelBuffer` around it) on iOS, an `AHardwareBuffer` on
Android. It exposes:

- `handle`: the IOSurface or `AHardwareBuffer` pointer, as a BigInt;
- `pixelBuffer`: what react-native-webgpu's `createNativeBufferFromPointer`
  takes (the `CVPixelBuffer` on iOS, the `AHardwareBuffer` on Android).

Every holder (JavaScript's `VideoFrame`, the encoder, a clone) takes its own
reference. A pool's surface returns to the pool once the last reference is
gone, so a long export reuses a handful of surfaces instead of allocating
one per frame. Pools come in three formats: `BGRA` (8 bits), `NV12` (YUV)
and `RGBA16F` (half float, for HDR). Android has no `NV12` pools, and its
8-bit ones are RGBA.

`new VideoFrame({ handle }, init)` wraps any surface the app already has,
such as a camera frame, by its handle.

## Fences

A `VideoFrame` built with `init.fence` carries the GPU fence its writer
signals once the surface is drawn. The fence is waited on natively, where
the surface is read:

- **iOS**: an `MTLSharedEvent` and the value to wait for, which
  react-native-webgpu's `endAccess()` returns. The encoder's queue waits
  for the event before handing the surface to VideoToolbox. After a second
  it gives up and encodes the surface as it is, so a draw that is never
  submitted shows up as a stall and a wrong frame, not an error.
- **Android**: a sync file descriptor. The encoder turns it into an EGL sync
  and waits on the GPU (`eglWaitSyncKHR`), then copies the surface into the
  codec's input and waits for that copy on its own thread. HDR frames are
  read on the CPU, after waiting for the fence there.

Either way the JavaScript thread never waits for the GPU: drawing frame
*n+1* overlaps with encoding frame *n*.

## Encoding

- **iOS**: a `VTCompressionSession` per encoder, fed the surface's
  `CVPixelBuffer` directly. Frame reordering is off (no B-frames), key
  frames come from `encode(frame, { keyFrame: true })` as on the web, and
  the lookahead is limited with `MaxFrameDelayCount` where VideoToolbox
  allows it. The color primaries, transfer function and YCbCr matrix are
  set from the frames' color space.
- **Android**: a `MediaCodec` encoder in surface-input mode. An EGL context
  samples each `AHardwareBuffer` as an external texture and draws it into
  the codec's input surface (one GPU copy per frame). `max-bframes` is 0.
  When an encoder refuses a setting (operating rate, profile, frame rate),
  `configure` retries without it, as Media3 does. Each codec runs on its own
  worker thread. HDR is different: the encoder runs in buffer mode, and each
  half-float surface is read on the CPU and converted to P010 (10-bit
  BT.2020 YCbCr) into an input buffer, as an EGL window has no 10-bit format
  on every device.

Output chunks are length-prefixed (AVCC/HVCC), or AV1 OBUs as they come
(the decoder config, without a description, goes with the first chunk). The `avcC`/`hvcC` record goes
out in the chunk metadata's `decoderConfig.description`, with the first
chunk and whenever it changes, which is what Mediabunny writes into the MP4.

## Backpressure

Every frame inside an encoder is a whole surface (8 MB at 1080×1920), so the
number of frames in flight decides the memory an export uses.
Two limits bound them. Mediabunny waits for a `dequeue` event while
`encodeQueueSize` is 4 or more. The encoder dispatches `dequeue` only while
the codec holds fewer than its own lookahead plus 4 frames that it has not
output yet. So `video.add()` stops resolving once the codec holds its
lookahead plus 4 frames and 4 more wait in the queue: lookahead plus 8 in
all. The codec reports its lookahead (`MaxFrameDelayCount` on VideoToolbox).
Where it cannot be limited, the encoder assumes 18 frames, what
VideoToolbox's software encoder was seen holding before its first output;
fewer would deadlock it. See [Platform notes](how-it-works.md#platform-notes) for the
numbers.

## Decoding

- **iOS**: a `VTDecompressionSession` for H.264 or HEVC, configured from
  the `avcC`/`hvcC` description. It outputs `CVPixelBuffer`s in BGRA, or NV12 with
  `outputFormat: "NV12"`.
- **Android**: an H.264 `MediaCodec` decoder writing into an `AImageReader`. Each output
  image's `AHardwareBuffer` becomes the frame's surface, with no copy, and
  stays with the decoder until JavaScript closes the frame. The reader has
  16 images, so a decoder stalls if JavaScript keeps all of them. The
  frame's size is the image's crop, which can be smaller than the buffer
  (padding on the right or bottom); the encoder samples only that part.
  `hardwareAcceleration` picks the decoder: `"prefer-software"` a
  software one, `"prefer-hardware"` another, falling back to the rest when
  the preferred ones fail to start.

A config needs a `description`. The output frames carry the config's
`colorSpace` (BT.709 for what it leaves out).

## Audio

PCM crosses between JavaScript and native code as interleaved float32.
`AudioData` converts from and to the other sample formats (`u8`, `s16`,
`s32`, `f32`, interleaved and planar) in TypeScript.

- **iOS**: `AudioConverter` (AudioToolbox), PCM to AAC-LC and AAC or MP3 to
  PCM.
- **Android**: `MediaCodec` in buffer mode, fed and drained on one worker
  thread.

## Files and streams

`createFileWritable` and `fileSourceOptions` open a native file and read or
write it at given positions, off the JavaScript thread. Mediabunny writes
the MP4 out of order (it seeks back to fill in sizes), and reads only the
ranges it needs, so large files never sit in JavaScript memory.

Hermes has no `WritableStream`. `installWebCodecs()` installs a small one
(`src/lib/streams.ts`), enough for `StreamTarget`: a writer, a controller,
backpressure through `desiredSize` and `ready`, and `close`/`abort`.

## Errors

Native code reports errors as `"Name: message"` or `"Name: code: message"`
strings, and the TypeScript side turns them into `DOMException`s with the
WebCodecs names and a `code` property (see [Errors](api.md#errors)). A codec error
moves the codec to `closed` and calls its `error` callback, as on the web.

## Platform notes

**Memory.** An export holds at most the codec's lookahead plus 8 frames
(see [Backpressure](how-it-works.md#backpressure)):

| Platform | Lookahead | Frames held at most |
| :-- | :-- | :-- |
| iOS device (VideoToolbox) | Limited: `MaxFrameDelayCount` = 3 | 11 |
| iOS Simulator | Cannot be limited: 18 assumed | 26 |
| Android (MediaCodec) | Cannot be limited: 18 assumed | 26 |

**Android encoding** copies each frame once on the GPU (EGL) into
MediaCodec's input surface. `flush()` on Android's encoder ends the stream;
encoding after it starts a new stream, from a key frame. Frame timestamps
must grow: MediaCodec drops a frame whose timestamp does not move forward
(it then counts as dropped, with no output).

**AAC priming.** AAC encoders put about 1600 (Android) to 2112 (iOS)
samples of silence ahead of the sound, and nothing in the output says so
yet: the sound of an export starts that much (33 to 44 ms at 48 kHz) after
the video.

**Android decoding** stalls while JavaScript holds all 16 output frames, as
a web decoder does until frames are closed.

**Simulators and emulators** run software codecs: the Simulator's
VideoToolbox reports `UsingHardwareAcceleratedVideoEncoder` false, and the
emulator uses `c2.android.avc.encoder`. Export times there say little about
devices.

**Android before 10.** Encoders there ignore `max-bframes` and some reorder
frames, so `VideoEncoder.isConfigSupported` reports H.264 as unsupported
below API 29.

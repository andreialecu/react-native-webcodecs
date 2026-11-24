# Export in HDR

[README](../README.md) · [Guides](guides.md) · [HDR](hdr.md) · [Web](web.md) · [API](api.md) · [How it works](how-it-works.md)

An export can be HDR, tagged HLG in BT.2020: HEVC Main 10 on iOS, AV1 Main
10 on Android (see below). Draw
into half-float surfaces (`createSurfacePool(width, height, "RGBA16F")`),
with values already encoded in HLG, and give each frame its color space:

```ts
const pool = createSurfacePool(WIDTH, HEIGHT, "RGBA16F"); // half float
const video = new VideoSampleSource({
  codec: "hevc",
  fullCodecString: "hvc1.2.4.L153.B0", // Main 10
  quality: new Quality({ bitrate: 12_000_000 }), // bits per second (12 Mbps)
});
// ... draw frame i into pool.acquire() in HLG, then:
const frame = new VideoFrame(surface, {
  timestamp,
  fence,
  colorSpace: {
    primaries: "bt2020",
    transfer: "hlg",
    matrix: "bt2020-ncl",
    fullRange: false,
  },
});
```

The encoder takes the color space of the frames it is given, says how to
read the surfaces from it, and tags the stream with it.

The example app's HDR screen
([`hdr.ts`](../example/src/VideoExport/hdr.ts)) shows one way to get
there. Skia draws into an `rgba16float` texture, where the lights go above
SDR white (1.0), and a WebGPU pass converts each frame to HLG, writing into
the pool surface: BT.709 to BT.2020 primaries, SDR white at 203 nits
(BT.2408), HLG's inverse OOTF (system gamma 1.2), then the HLG OETF. In the
file it wrote on an iPhone, SDR white measures 203 nits and the lights reach
about 1000 nits, HLG's peak.

The same screen previews the animation in HDR before export, on a WebGPU
canvas with `toneMapping: { mode: "extended" }`
([`HdrPreview.tsx`](../example/src/VideoExport/HdrPreview.tsx)). On
iOS 26 and later that needs
[wcandillon/react-native-webgpu#643](https://github.com/wcandillon/react-native-webgpu/pull/643).
The iOS build also runs on an Apple silicon Mac as a "Designed for iPad" app,
and the preview shows in HDR there too, on the MacBook's XDR display (checked
by eye; the Mac export has not been measured).

On Android, HDR exports as AV1 Main 10 (`av01.0.08M.10`), tagged HLG in
BT.2020, from the same `"RGBA16F"` pool; the example app picks AV1 there.
The encoder takes such frames in buffer mode: it reads each half-float
surface on the CPU and converts it to P010 (10-bit BT.2020 YCbCr, limited
range), since an EGL window has no 10-bit format on every device. HEVC Main
10 is not done on Android yet. On the Android emulator (its software AV1
encoder), the example's 7 s card exports in about 23 s, and the file
measures like the iPhone's: SDR white at about 200 nits, the lights at 1000.
The iOS Simulator has no HEVC hardware encoder, so HDR
exports there run in software: 36 s for the example's 7 s animation,
against 1.6 s on an iPhone with an A20 Pro.

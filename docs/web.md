# On the web

[README](../README.md) · [Guides](guides.md) · [HDR](hdr.md) · [Web](web.md) · [API](api.md) · [How it works](how-it-works.md)

Browsers have WebCodecs, and Mediabunny and WebGPU run there as they are.
The package's web entry (`src/index.web.ts`) exports the browser's classes,
`withBackgroundTask(fn)` just runs `fn`, and what rests on native surfaces
and files throws `NotSupportedError`: `createSurfacePool`,
`createFileWritable`, `fileSourceOptions`, `writeFile`, `removeFile`,
`resolvePath`. On the web, make frames from a canvas or from pixels, write
with Mediabunny's `BufferTarget`, and read with its `BlobSource` or
`UrlSource`.

The example app runs on the web too, as the
[live demo](https://andreialecu.github.io/react-native-webcodecs/) (or locally: `yarn web` in `example`, then
open http://localhost:8095/index.html), through
[React Native Web](https://necolas.github.io/react-native-web/). In a browser
it is a single page: the export screen next to a short explanation, with a
switch between SDR and HDR. React
Native Skia runs there on
[CanvasKit](https://skia.org/docs/user/modules/canvaskit/) (WebAssembly), and the Video Export
screen uses
[`export.web.ts`](../example/src/VideoExport/export.web.ts) in
place of the native export: Skia draws each frame on a WebGL surface, its
pixels become a `VideoFrame`, the browser encodes it, and the MP4 is
downloaded. In a Chromium browser on a Mac, the 7 s card with sound exports in about
9 s. The HDR preview works there too
([`HdrPreview.web.tsx`](../example/src/VideoExport/HdrPreview.web.tsx)):
React Native Skia's web surfaces are 8-bit, so the card is drawn with
CanvasKit on a half-float render target, read back, and shown on a WebGPU
canvas with `toneMapping: { mode: "extended" }`.

HDR export works in Chromium too, as VP9 Profile 2 (10-bit) rather than
HEVC Main 10, which Chromium does not encode. CanvasKit draws each frame on
the half-float target, and a WebGPU compute pass converts it to HLG in
BT.2020 (the same math as the native export) and then to 10-bit 4:2:0 YUV,
which becomes an `I420P10` `VideoFrame` tagged HLG. In the file, SDR white
measures 203 nits and the lights reach 1000 nits, as on iOS. VP9 is encoded
in software: about 39 s for the 7 s card, against 9 s for SDR. The MP4
plays in HDR in Chrome, but not in QuickTime, which has no VP9.

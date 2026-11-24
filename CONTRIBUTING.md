# Contributing

## The example app

[`example`](example) has these screens:

- **Video Export**: a 1080×1920 Lottie share card, drawn by Skia through
  WebGPU, exported to MP4 with a sound track copied from an M4A file (synthesized
  to the animation's cues by
  [`scripts/make-sound.py`](example/scripts/make-sound.py)), with
  progress, cancellation and sharing.
- **HDR Video Export**: the same card with its lights above SDR white,
  previewed on an EDR canvas (iOS, browser) and exported as HLG: HEVC Main
  10 on iOS, AV1 Main 10 on Android, VP9 Profile 2 in a browser.
- **Compress a video**: picks a video from the library, then scales and
  re-encodes it with the size, quality, codec, frame rate and sound you
  choose. The picker is the app's own, in
  [`example/video-picker`](example/video-picker) (PHPicker on iOS,
  `ACTION_GET_CONTENT` on Android), so the app needs no picker library.
- **E2E Tests**: the app side of the e2e tests.

Run it from `example` with `yarn start`, then `yarn ios` or
`yarn android`; or in a browser with `yarn web` (see [On the web](docs/web.md)). For a release build on an iPhone, `yarn bundle:ios` writes
the JavaScript bundle the app loads.

`yarn build:web` (in `example`) writes the web page as static files to
`example/web-build`; `.github/workflows/deploy-demo.yml` publishes them to
GitHub Pages on every push to `main`.

To run it on an Apple silicon Mac, build the iOS scheme for the "Designed for
iPad" destination, from `example/ios`:

```bash
xcodebuild -workspace Example.xcworkspace -scheme Example -configuration Release -destination 'platform=macOS,arch=arm64,variant=Designed for iPad' -derivedDataPath build/mac -allowProvisioningUpdates build
```

or pick "My Mac (Designed for iPad)" in Xcode and run it from there.

## Testing

**Unit tests** (`yarn test:unit`, `src/__tests__/unit`) cover the
`WritableStream` and Mediabunny writing through it, in Node. `yarn test:jvm`
runs the JVM tests of the Android encoder rules (`EncoderRules.java`, under
`android/src/test/java`) through the example app's Gradle. `yarn test:cpp`
builds the host tests of the Android C++ helpers that need no NDK
(`android/src/test/cpp/*_test.cpp`) with clang, under AddressSanitizer and
UndefinedBehaviorSanitizer, and runs them.

**End-to-end tests** (`src/__tests__/WebCodecs.spec.ts`) run on a simulator
or emulator with the example app, and check the files with ffprobe and
ffmpeg on the host:

1. In `example`, start Metro with `CI=true yarn start`. The app opens
   on its Tests screen.
2. Launch the app on a simulator or emulator.
3. At the repository root, run `yarn test`.

To share the machine with other projects, start Metro on another port
(`yarn start --port 8102`) and give Metro and `yarn test` the same
`E2E_PORT` (for example `E2E_PORT=4300`, with Metro's `--reset-cache`).
The app reaches the test server on `localhost`, through `adb reverse` on
Android; where that does not work, start Metro with
`E2E_ANDROID_HOST=10.0.2.2` (the emulator's address for this machine). With
several Android devices attached, set `ANDROID_SERIAL` for `yarn test`.

They cover:

- 60 frames at 128×128 in memory: H.264, no B-frames, BT.709 tags, colors
  within 8 of the drawn ones;
- 210 frames at 1080×1920 streamed to a file, with a bounded encoder
  backlog;
- an AAC sound copied, and an MP3 sound transcoded to AAC, cut where the
  video ends, at the source's level;
- frames far apart in time (a slideshow), ending one frame after the last;
- 4200 frames at 1080×1920 (with `E2E_LONG=1`);
- `cancel()`, and the file removed;
- decoding with Mediabunny and sampling the frame in WebGPU;
- DOMException names;
- `isConfigSupported` answering from the platform (a frame too large for the
  codec is refused) and returning the config with only its known members;
- backgrounding (iOS): `interrupted` while taking frames, and `finalize()`
  completing in the background inside `withBackgroundTask()`.

They pass on the iOS Simulator and on an Android emulator (API 35); the
backgrounding test is iOS-only. HDR export was checked by hand on an iPhone
(A20 Pro), measuring the file it wrote; the HDR preview was checked by eye on
an iPhone, on a Mac (as a "Designed for iPad" app) and in Chrome.

Not covered by tests: hardware codecs on devices, HEVC decoding (iOS),
HDR export, and the Android paths that only a faulty or busy codec triggers
(configure fallbacks, a reclaimed codec, a stalled codec).

## Releasing

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):
a `fix:` makes a patch release, a `feat:` a minor one, and a `!` or a
`BREAKING CHANGE:` footer a major one.

To release, run the "Create a release" workflow from the Actions tab.
semantic-release picks the version from the commits since the last tag,
adds their notes to [CHANGELOG.md](CHANGELOG.md), commits it, tags the
release and creates the GitHub release with the tarball. It publishes to npm
as a staged version (`npm stage publish`, through trusted publishing with
provenance): the version is not public until a maintainer approves it with
2FA on npmjs.com or with

```bash
npm stage list react-native-webcodecs
```

```bash
npm stage approve <stage-id>
```

(npm 12 or newer).

## Layout

The repository is the package, with the example app in `example/` (a Yarn
workspace that links the package from the root).

- `src/specs/WebCodecs.nitro.ts`: the native interface. `yarn specs`
  regenerates `nitrogen/`.
- `src/lib/`: the WebCodecs classes (`video.ts`, `audio.ts`), files,
  streams, background tasks, and the bridge to native errors (`native.ts`).
  `src/index.ts` exports them and `installWebCodecs()`.
- `ios/`: VideoToolbox (`VideoEncoder.swift`, `VideoDecoder.swift`),
  AudioToolbox (`Audio.swift`), surfaces and fences (`Surface.swift`),
  files and background tasks (`HybridWebCodecs.swift`).
- `android/src/main/cpp/`: MediaCodec (`VideoEncoder.hpp`,
  `VideoDecoder.hpp`, `Audio.hpp`), the EGL blitter (`Gl.hpp`), surfaces
  (`Surface.hpp`), files (`Files.hpp`), and the worker thread and errors
  (`Common.hpp`).
- `src/__tests__/`: the e2e tests and their harness (a WebSocket server the
  example app connects to, see `example/src/Tests.tsx`), and the unit
  tests in `unit/`.

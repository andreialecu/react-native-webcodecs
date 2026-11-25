# Changelog

## [0.1.3](https://github.com/andreialecu/react-native-webcodecs/compare/v0.1.2...v0.1.3) (2026-11-25)


### Bug Fixes

* **android:** put out a GOP that goes back in time after the one before it ([e0eb929](https://github.com/andreialecu/react-native-webcodecs/commit/e0eb9290f611e765d1503a78ee03c7f8cdf6cdb6))
* **example:** load the export's sound in Android release builds ([0cd1af8](https://github.com/andreialecu/react-native-webcodecs/commit/0cd1af834a0b9ab56ef73847e2c4db264908d83d))
* **ios:** decode AAC from its AudioSpecificConfig, ADTS, and restart the AudioDecoder on flush ([b78c863](https://github.com/andreialecu/react-native-webcodecs/commit/b78c8636d3a98a79ca2cd298872e8a89dd30649f)), closes [#3](https://github.com/andreialecu/react-native-webcodecs/issues/3) [#2](https://github.com/andreialecu/react-native-webcodecs/issues/2) [#10](https://github.com/andreialecu/react-native-webcodecs/issues/10) [#2](https://github.com/andreialecu/react-native-webcodecs/issues/2)
* **ios:** decode from a CRA or recovery point, drain the reorder buffer when a key frame goes back in time ([5c3e02a](https://github.com/andreialecu/react-native-webcodecs/commit/5c3e02a1b5d586e8a3260075d0a1c47cc90dac45))
* **ios:** forward bitrateMode, refuse quantizer, and tag the range the encoder writes ([05e9063](https://github.com/andreialecu/react-native-webcodecs/commit/05e9063dc91bddbaf5f5418b3419225cd30c9090))
* **ios:** keep small AAC packets alive while the AudioConverter reads them ([d8f2742](https://github.com/andreialecu/react-native-webcodecs/commit/d8f27426660f069fbfb9a31dd4c00011c3a87704))
* **ios:** pin a wrapped surface's use count until the frame is closed ([99d3aa6](https://github.com/andreialecu/react-native-webcodecs/commit/99d3aa68a85169a96d091ff51240a8f965615ab5))
* **ios:** start an AudioDecoder over on flush with a new AudioConverter ([9cb6fd4](https://github.com/andreialecu/react-native-webcodecs/commit/9cb6fd48e02805cb70a99086322a87e818076ea7))

## [0.1.2](https://github.com/andreialecu/react-native-webcodecs/compare/v0.1.1...v0.1.2) (2026-11-24)


### Bug Fixes

* **android:** a video codec that fails is stopped, so the GL thread is not left blocked ([915842a](https://github.com/andreialecu/react-native-webcodecs/commit/915842aab1eba6c83ad57e034f7dac3dd8602f60))
* **android:** AAC encoder keeps its last frames and times them by frame count ([b7e89f0](https://github.com/andreialecu/react-native-webcodecs/commit/b7e89f0c1b5244b3de6d6ff65020dfd7dcff6672))
* **android:** an encoder that takes the size as asked beats hardware read leniently (review) ([ab31f00](https://github.com/andreialecu/react-native-webcodecs/commit/ab31f003924fbe644d6740e21589e195caf602ac))
* **android:** ask the AAC encoder for LC through "profile" too ([a2e5a2d](https://github.com/andreialecu/react-native-webcodecs/commit/a2e5a2d933f0db115f05f7a7518d5c6f8425868e))
* **android:** AudioDecoder.flush() queues no end of stream with nothing fed ([41d1f21](https://github.com/andreialecu/react-native-webcodecs/commit/41d1f21859e6aa26dcde0a5aa151915a1ed0f1e0))
* **android:** AudioEncoder.flush() with nothing encoded outputs nothing ([40889ab](https://github.com/andreialecu/react-native-webcodecs/commit/40889ab93f73a96a7bf99a6a58310c2aa62103c7)), closes [#1](https://github.com/andreialecu/react-native-webcodecs/issues/1)
* **android:** bound the wait on a frame's GPU fence, and fail the frame when it never signals ([f7a808f](https://github.com/andreialecu/react-native-webcodecs/commit/f7a808fabe45f09852b536655f6ea51f1827b88b))
* **android:** clear the encoder's window surface before drawing each frame ([9276b1e](https://github.com/andreialecu/react-native-webcodecs/commit/9276b1e20a1b612f3f788c2c0857bc0f20d24352))
* **android:** convert odd-width and odd-height HDR frames to P010 without overflowing ([8f1bb57](https://github.com/andreialecu/react-native-webcodecs/commit/8f1bb57fc05c6d2e597e64f6326df4aa868d5da5))
* **android:** decoded frames have the picture's size, and the encoder samples only that ([447571a](https://github.com/andreialecu/react-native-webcodecs/commit/447571a109438acaf129fd158d9f3b09a134f88c))
* **android:** decoded frames report "NV12" whatever the decoder's 4:2:0 layout ([e589d16](https://github.com/andreialecu/react-native-webcodecs/commit/e589d16afc179ae7d9314e3f49d101146fe585a8))
* **android:** encode every frame when timestamps repeat or go backwards ([df2c890](https://github.com/andreialecu/react-native-webcodecs/commit/df2c8906e3ecbe86aff8f7e3b2929e3f9b431978))
* **android:** encode() of a wrapped surface returns at once when its frame is not drawn (review) ([8cda813](https://github.com/andreialecu/react-native-webcodecs/commit/8cda813301ff70b76559016d79665065009792bc))
* **android:** encode() returns once a wrapped surface's frame has been read ([37cfb1f](https://github.com/andreialecu/react-native-webcodecs/commit/37cfb1fdc7cf852083fc7dbd46eb6497c9b24da4))
* **android:** fail an HDR frame whose GPU fence does not signal, before locking it ([fdea0b0](https://github.com/andreialecu/react-native-webcodecs/commit/fdea0b00d7f7efb918ca863ac04a8ffcd447320e))
* **android:** fall back to a window-only EGL config, and check the pbuffer ([47cd026](https://github.com/andreialecu/react-native-webcodecs/commit/47cd026ae1c74137cc81c79cb30acc0459ac39c8))
* **android:** files in the user's cache directory, decoded file:// URLs, parent directories created ([0624a00](https://github.com/andreialecu/react-native-webcodecs/commit/0624a0057d8b3e20be3ca2efca6ccc11ea49a27b))
* **android:** flush ends when every frame came out, with no fixed timeout ([ebdfecf](https://github.com/andreialecu/react-native-webcodecs/commit/ebdfecf32eb9917175cbda85e08a80140e685ac8))
* **android:** let the frames drawn come out before ending a short encode ([7dd9e2f](https://github.com/andreialecu/react-native-webcodecs/commit/7dd9e2f001f5a18213280a553820e863df01cc2d))
* **android:** odd sizes are not read aligned up by isConfigSupported (review) ([d5c3738](https://github.com/andreialecu/react-native-webcodecs/commit/d5c3738bdc38a14be97655038186d2be42cc170f))
* **android:** pick the video decoder by name, honouring hardwareAcceleration ([f4d8ed2](https://github.com/andreialecu/react-native-webcodecs/commit/f4d8ed2fa277afb3a9d94ea422f81f83da44fa20))
* **android:** prefer a hardware encoder that takes the config over a software one ([5f0035e](https://github.com/andreialecu/react-native-webcodecs/commit/5f0035e93b40cffa80bf82bef6a64039ad90266d))
* **android:** put requested key frames on the frame asked for ([9770b51](https://github.com/andreialecu/react-native-webcodecs/commit/9770b515a43181e3e91923da331b446dbfd5a34e))
* **android:** read encoder sizes leniently: aligned, swapped, and 1080p/2160p by CamcorderProfile ([130bd20](https://github.com/andreialecu/react-native-webcodecs/commit/130bd2064b59156ffdf3acd1dc3ff2dbe8196345)), closes [#6551](https://github.com/andreialecu/react-native-webcodecs/issues/6551)
* **android:** refuse an RGBA16F surface pool the device cannot make CPU-readable ([457e24d](https://github.com/andreialecu/react-native-webcodecs/commit/457e24d778e04c6f5011d64530496e125c927012))
* **android:** set the H.264 level with the profile, and drop the profile on its own ([18ec1b2](https://github.com/andreialecu/react-native-webcodecs/commit/18ec1b2bf7b502f38b77dcd729db2a05d0cda75a))
* **android:** size the video decoder from the SPS when the config has none ([6eadfdb](https://github.com/andreialecu/react-native-webcodecs/commit/6eadfdba7a95b553a90418bfafb62e3343edf9ec))
* **android:** stop a failed video codec only where no buffer is in use (review) ([c9d85ee](https://github.com/andreialecu/react-native-webcodecs/commit/c9d85ee40517923f9241fc49f9b677d22f76207f))
* **android:** take FDK's AAC encoder by name, and trim its delay only ([e2fcfc0](https://github.com/andreialecu/react-native-webcodecs/commit/e2fcfc0657142e93402f5446fe6557f7a4dfa93b))
* **android:** the default bitrate is clamped into the encoder's range ([a4e4587](https://github.com/andreialecu/react-native-webcodecs/commit/a4e4587caa84ad912b0194c25712237ada91f831)), closes [#2208](https://github.com/andreialecu/react-native-webcodecs/issues/2208)
* **android:** the frame rate and bitrate are hints, not encoder requirements ([f9d823a](https://github.com/andreialecu/react-native-webcodecs/commit/f9d823ac59abc16f6c8691af9c9b43096b96ae2c))
* **android:** the video decoder asks its surface not to drop pictures ([8e148c0](https://github.com/andreialecu/react-native-webcodecs/commit/8e148c01db2e19bc308f20ae41cc9240a9263a08))
* **android:** the video decoder waits for input while JS holds every frame ([3c44cd6](https://github.com/andreialecu/react-native-webcodecs/commit/3c44cd62c1cbf1896dc1e99c1f07ab99564689ee))
* **android:** try the next encoder when one refuses every configure, and say why ([32b96c7](https://github.com/andreialecu/react-native-webcodecs/commit/32b96c7e9db8289df29cddbdc3e0b45e6e246a9b))
* **android:** video encoder outputs every frame, and cleans up when it cannot start ([9ec348d](https://github.com/andreialecu/react-native-webcodecs/commit/9ec348df1c572d8bc7fc3ea0973b8a9a7dc81cf1))
* **android:** VideoDecoder.flush() with nothing queued queues no end of stream ([ff5fa41](https://github.com/andreialecu/react-native-webcodecs/commit/ff5fa41d6464fbdddfbd3fd53aecddba2876d658))
* **android:** VideoEncoder.close() lets go of the codec before it returns ([0f2519b](https://github.com/andreialecu/react-native-webcodecs/commit/0f2519bdb043bf2c9b2950641a12d82ef769aef9))
* **codecs:** no hung flush, stale outputs or open native codecs ([bc392b4](https://github.com/andreialecu/react-native-webcodecs/commit/bc392b4c461de79702d03e4c9134774da248c3b8))
* **ios:** AudioEncoder starts a new timeline after flush ([e11eef0](https://github.com/andreialecu/react-native-webcodecs/commit/e11eef00758c69940785e0c4c0ee5687fefbc200))
* **ios:** AudioEncoder.flush() with nothing encoded outputs nothing ([7799da4](https://github.com/andreialecu/react-native-webcodecs/commit/7799da432759c8c97c8b2203fce996933b6c21f4))
* **ios:** VideoDecoder outputs frames in presentation order ([1cb8e30](https://github.com/andreialecu/react-native-webcodecs/commit/1cb8e306d6d6df3f1c1ffec9d9a3d701dfdacd2e))

## [0.1.1](https://github.com/andreialecu/react-native-webcodecs/compare/v0.1.0...v0.1.1) (2026-11-24)


### Bug Fixes

* **android:** keep the library's minSdkVersion at 26 or above ([7e53567](https://github.com/andreialecu/react-native-webcodecs/commit/7e53567dc079337d9f914d8b164c248084cae44f))

# [0.1.0](https://github.com/andreialecu/react-native-webcodecs/compare/v0.0.0...v0.1.0) (2026-11-24)


### Features

* **🎬:** react-native-webcodecs, WebCodecs on VideoToolbox and MediaCodec ([15066cd](https://github.com/andreialecu/react-native-webcodecs/commit/15066cd3012ddd240ff43729268775be2a4bd58e))

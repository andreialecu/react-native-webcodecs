#pragma once

#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>

#include <android/api-level.h>
#include <android/hardware_buffer.h>
#include <dlfcn.h>
#include <poll.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <climits>
#include <cstring>
#include <future>
#include <map>
#include <optional>

#include "Capabilities.hpp"
#include "Gl.hpp"
#include "HybridNativeVideoEncoderSpec.hpp"
#include "NativeEncodedChunk.hpp"
#include "NativeVideoEncoderConfig.hpp"
#include "Surface.hpp"

namespace margelo::nitro::webcodecs {

constexpr int32_t kColorFormatSurface = 0x7F000789;
constexpr uint32_t kBufferFlagKeyFrame = 1;
constexpr uint32_t kBufferFlagCodecConfig = 2;
constexpr uint32_t kBufferFlagEndOfStream = 4;
// MediaCodec.CodecException codes, which dequeueOutputBuffer returns as
// positive values: not buffer indices.
constexpr ssize_t kErrorInsufficientResource = 1100;
constexpr ssize_t kErrorReclaimed = 1101;

inline bool isCodecError(ssize_t index) {
  return index == kErrorInsufficientResource || index == kErrorReclaimed ||
         (index < 0 && index != AMEDIACODEC_INFO_TRY_AGAIN_LATER && index != AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED &&
          index != AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED);
}

// Frames in the encoder with no output for this long: it is stuck.
constexpr auto kStallTimeout = std::chrono::seconds(20);

inline std::string describeCodecStatus(media_status_t status, const std::string& what, const std::string& prefix) {
  // The system takes a codec back from an app in the background when another
  // needs it (MediaCodec.CodecException.ERROR_RECLAIMED).
  if (status == static_cast<media_status_t>(kErrorReclaimed)) {
    return errorMessage("EncodingError", "interrupted", "the " + what + " was taken away (" + std::to_string(status) + ")");
  }
  return errorMessage("EncodingError", prefix + "-failed", "MediaCodec failed (" + std::to_string(status) + ")");
}

// Before API level 29, encoders ignore max-bframes and some reorder frames
// regardless (Media3's DefaultEncoderFactory forces Baseline on such API 27
// devices), so encoding starts at Android 10, as in #641's writer.
inline bool videoEncodingAvailable() {
  return android_get_device_api_level() >= 29;
}

// MediaCodecInfo.CodecProfileLevel: AVCProfileBaseline 1, AVCProfileMain 2,
// AVCProfileHigh 8; AV1ProfileMain8 1, AV1ProfileMain10 2 (HLG uses Main 10:
// AV1ProfileMain10HDR10 is for PQ with static metadata). 0: none asked for.
inline int32_t mediaCodecProfile(const NativeVideoEncoderConfig& config) {
  const std::string profile = config.profile.value_or("");
  if (config.codec == "av1") {
    return profile == "main10" ? 2 : 1;
  }
  if (config.codec == "avc" && config.profile.has_value()) {
    if (profile == "baseline") {
      return 1;
    }
    return profile == "main" ? 2 : 8;
  }
  return 0;
}

inline std::string videoMime(const std::string& codec) {
  if (codec == "avc") {
    return "video/avc";
  }
  if (codec == "av1") {
    return "video/av01";
  }
  throw domError("NotSupportedError", "codec " + codec);
}

// MediaFormat's color aspects (KEY_COLOR_STANDARD, _TRANSFER, _RANGE).
struct ColorAspects {
  int32_t standard = 1;  // BT.709
  int32_t transfer = 3;  // SDR video (BT.709 / BT.601)
  int32_t range = 2;     // limited
  bool hdr() const {
    return transfer == 6 || transfer == 7;
  }
  bool operator==(const ColorAspects& other) const {
    return standard == other.standard && transfer == other.transfer && range == other.range;
  }
};

constexpr int32_t kColorFormatYuvP010 = 0x36;

// The encoder MediaCodecList says takes this config (size, frame rate,
// bitrate, profile, and the input: a surface, or P010 buffers for 10-bit
// HDR), the first in the platform's order; none when no encoder does.
//
// An H.264 profile is a preference, as configure() treats it: when no encoder
// lists it (the emulator's software encoder has no High), any encoder that
// takes the rest will do, in its default profile, which the avcC description
// of the output says. AV1's Main 10 is required: HDR depends on it.
inline std::optional<std::string> findVideoEncoder(const NativeVideoEncoderConfig& config, bool hdr) {
  auto find = [&](int32_t profile) {
    return JCapabilities::findVideoEncoder(videoMime(config.codec), static_cast<int>(config.width), static_cast<int>(config.height),
                                           config.framerate.value_or(0), static_cast<int>(std::min(config.bitrate.value_or(0), 2e9)),
                                           profile, hdr ? kColorFormatYuvP010 : kColorFormatSurface);
  };
  int32_t profile = mediaCodecProfile(config);
  auto name = find(profile);
  if (!name.has_value() && config.codec == "avc" && profile > 0) {
    name = find(0);
  }
  return name;
}

// Waits on the CPU for a sync fd (taken over, closed either way).
inline void waitFenceCpu(int fd) {
  if (fd < 0) {
    return;
  }
  pollfd p{fd, POLLIN, 0};
  ::poll(&p, 1, 1000);
  ::close(fd);
}

// One half float (IEEE 754 binary16) to a float.
inline float halfToFloat(uint16_t h) {
  __fp16 value;
  std::memcpy(&value, &h, sizeof(value));
  return static_cast<float>(value);
}

// Converts an RGBA half-float picture holding BT.2020 R'G'B' (already
// encoded with the transfer function, 0 to 1) to P010: 10-bit BT.2020
// non-constant-luminance YCbCr, limited range, 4:2:0, each sample in the top
// 10 bits of 16, then Cb and Cr interleaved. `srcStride` is in half floats,
// `dstStride` in bytes.
inline void rgba16fToP010(const uint16_t* src, size_t srcStride, int width, int height, uint8_t* dst, size_t dstStride,
                          size_t sliceHeight) {
  auto code = [](float v, float offset, float range) {
    float c = offset + range * v + 0.5f;
    c = c < 0.0f ? 0.0f : (c > 1023.0f ? 1023.0f : c);
    return static_cast<uint16_t>(static_cast<uint16_t>(c) << 6);
  };
  uint8_t* uv = dst + dstStride * sliceHeight;
  std::vector<float> cb(width / 2);
  std::vector<float> cr(width / 2);
  for (int y = 0; y < height; y += 2) {
    std::fill(cb.begin(), cb.end(), 0.0f);
    std::fill(cr.begin(), cr.end(), 0.0f);
    for (int dy = 0; dy < 2 && y + dy < height; dy++) {
      const uint16_t* row = src + (y + dy) * srcStride;
      auto* out = reinterpret_cast<uint16_t*>(dst + (y + dy) * dstStride);
      for (int x = 0; x < width; x++) {
        float r = halfToFloat(row[x * 4]);
        float g = halfToFloat(row[x * 4 + 1]);
        float b = halfToFloat(row[x * 4 + 2]);
        float l = 0.2627f * r + 0.6780f * g + 0.0593f * b;
        out[x] = code(l, 64.0f, 876.0f);
        cb[x / 2] += (b - l) / 1.8814f;
        cr[x / 2] += (r - l) / 1.4746f;
      }
    }
    auto* out = reinterpret_cast<uint16_t*>(uv + (y / 2) * dstStride);
    for (int i = 0; i < width / 2; i++) {
      out[i * 2] = code(cb[i] / 4.0f, 512.0f, 896.0f);
      out[i * 2 + 1] = code(cr[i] / 4.0f, 512.0f, 896.0f);
    }
  }
}

// H.264, or AV1, through MediaCodec. Frames are copied (GPU, EGL) into the
// codec's input surface on one thread; a second one drains the encoded
// output. HDR (HLG or PQ in BT.2020, from half-float surfaces holding R'G'B'
// already encoded) goes to a Main 10 encoder in buffer mode instead: each
// frame is converted to P010 on the CPU (an EGL window has no 10-bit format
// on every device, the emulator's included). AV1 for now (the emulator's
// software encoder has Main 10); HEVC would also need an hvcC built from its
// parameter sets.
class HybridNativeVideoEncoder : public HybridNativeVideoEncoderSpec {
public:
  HybridNativeVideoEncoder(const NativeVideoEncoderConfig& config,
                           std::function<void(const NativeEncodedChunk&)> output,
                           std::function<void(const std::string&)> error)
      : HybridObject(TAG), _config(config), _output(std::move(output)), _error(std::move(error)) {
    videoMime(config.codec);
    if (!videoEncodingAvailable()) {
      throw domError("NotSupportedError", "video encoding needs Android 10 (API level 29) or later");
    }
    // Start the codec on the GL thread, and report its failure here.
    auto started = std::make_shared<std::promise<std::string>>();
    auto result = started->get_future();
    _gl.post([this, started] {
      try {
        _blitter.init();
        start();
        started->set_value("");
      } catch (const std::exception& e) {
        started->set_value(e.what());
      }
    });
    std::string message = result.get();
    if (!message.empty()) {
      throw domError("NotSupportedError", message);
    }
  }

  ~HybridNativeVideoEncoder() override {
    shutdown();
  }

  bool getHardwareAccelerated() override {
    return _hardware;
  }

  double getMaxFrameDelay() override {
    // MediaCodec does not say how many frames it holds.
    return -1;
  }

  void encode(const std::shared_ptr<HybridNativeSurfaceSpec>& surface, double timestamp, double duration, bool keyFrame) override {
    if (_closed) {
      throw domError("InvalidStateError", "the encoder is closed");
    }
    auto native = std::dynamic_pointer_cast<HybridNativeSurface>(surface);
    if (!native) {
      throw domError("TypeError", "not a native surface");
    }
    // Taken now: JS may close the frame right after encode().
    auto ref = native->ref();
    int fence = native->dupFence();
    int64_t ts = static_cast<int64_t>(timestamp);
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _durations[ts] = duration;
    }
    _gl.post([this, ref, fence, ts, keyFrame] {
      if (_failed) {
        if (fence >= 0) {
          ::close(fence);
        }
        return;
      }
      try {
        if (_ended) {
          // After flush() (end of stream), a new codec for what comes next.
          stop();
          start();
        }
        if (keyFrame && _framesIn > 0) {
          AMediaFormat* params = AMediaFormat_new();
          AMediaFormat_setInt32(params, "request-sync", 0);
          AMediaCodec_setParameters(_codec, params);
          AMediaFormat_delete(params);
        }
        if (_aspects.hdr()) {
          waitFenceCpu(fence);
          queueP010(ref->buffer, ts);
        } else {
          _blitter.waitFence(fence);
          _blitter.drawToWindow(_window, ref->buffer, static_cast<int>(_config.width), static_cast<int>(_config.height),
                                ts * 1000);
        }
        _framesIn++;
      } catch (const std::exception& e) {
        fail(errorMessage("EncodingError", "encoder-failed", e.what()));
      }
    });
  }

  std::shared_ptr<Promise<void>> flush() override {
    auto promise = Promise<void>::create();
    if (_closed) {
      promise->reject(std::make_exception_ptr(domError("InvalidStateError", "the encoder is closed")));
      return promise;
    }
    _gl.post([this, promise] {
      if (_failed) {
        promise->reject(std::make_exception_ptr(std::runtime_error(_failure)));
        return;
      }
      if (_ended || _framesIn == 0) {
        promise->resolve();
        return;
      }
      // MediaCodec has no flush for a surface input: end the stream (the
      // next encode() starts a new one).
      media_status_t status = _aspects.hdr() ? queueEndOfStream() : AMediaCodec_signalEndOfInputStream(_codec);
      if (status != AMEDIA_OK) {
        fail(describeCodecStatus(status, "encoder", "encoder"));
        promise->reject(std::make_exception_ptr(std::runtime_error(_failure)));
        return;
      }
      std::unique_lock<std::mutex> lock(_mutex);
      bool done = _cv.wait_for(lock, std::chrono::seconds(10), [this] { return _eos || _failed; });
      lock.unlock();
      _ended = true;
      if (_failed) {
        promise->reject(std::make_exception_ptr(std::runtime_error(_failure)));
      } else if (!done) {
        promise->reject(std::make_exception_ptr(std::runtime_error(errorMessage("EncodingError", "encoder-failed", "flush timed out"))));
      } else {
        promise->resolve();
      }
    });
    return promise;
  }

  // HDR (HLG, PQ) needs a Main 10 AV1 encoder: the codec starts over in
  // buffer mode (P010) with the BT.2020 color aspects, before any frame.
  void setColorSpace(const NativeColorSpace& colorSpace) override {
    const auto transfer = colorSpace.transfer.value_or("bt709");
    ColorAspects aspects;
    if (transfer == "hlg" || transfer == "pq") {
      if (_config.codec != "av1" || _config.profile.value_or("") != "main10") {
        throw domError("NotSupportedError", "HDR encoding on Android needs AV1 Main 10 (av01.0.*.10)");
      }
      aspects.standard = 6;  // BT.2020
      aspects.transfer = transfer == "hlg" ? 7 : 6;
      aspects.range = 2;
    }
    if (aspects == _aspects) {
      return;
    }
    auto restarted = std::make_shared<std::promise<std::string>>();
    auto result = restarted->get_future();
    _gl.post([this, aspects, restarted] {
      try {
        if (_framesIn > 0) {
          throw std::runtime_error("the color space changed after the first frame");
        }
        stop();
        _aspects = aspects;
        _encoderName.reset();  // HDR takes P010 buffers: maybe another encoder
        start();
        restarted->set_value("");
      } catch (const std::exception& e) {
        // No codec now (an encoder without Main 10 or P010): later frames
        // are dropped, and the caller gets the error.
        {
          std::lock_guard<std::mutex> lock(_mutex);
          _failure = errorMessage("NotSupportedError", "encoder-failed", e.what());
          _failed = true;
        }
        restarted->set_value(e.what());
      }
    });
    std::string message = result.get();
    if (!message.empty()) {
      throw domError("NotSupportedError", message);
    }
  }

  void close() override {
    _closed = true;
    _failed = true;
    _gl.post([this] { stop(); });
  }

private:
  // The encoder MediaCodecList says takes the config, as isConfigSupported
  // answered; the platform's default for the type when none says so.
  AMediaCodec* createCodec() {
    if (!_encoderName.has_value()) {
      _encoderName = findVideoEncoder(_config, _aspects.hdr()).value_or("");
    }
    if (!_encoderName->empty()) {
      if (AMediaCodec* codec = AMediaCodec_createCodecByName(_encoderName->c_str())) {
        return codec;
      }
    }
    return AMediaCodec_createEncoderByType(videoMime(_config.codec).c_str());
  }

  void start() {
    _codec = createCodec();
    if (!_codec) {
      throw std::runtime_error("no encoder for " + _config.codec);
    }
    int32_t width = static_cast<int32_t>(_config.width);
    int32_t height = static_cast<int32_t>(_config.height);
    double framerate = _config.framerate.value_or(30);
    if (framerate <= 0) {
      framerate = 30;
    }
    double bitrate = _config.bitrate.value_or(0);
    if (bitrate <= 0) {
      bitrate = width * height * framerate * 0.1;
    }
    // From the most to the least demanding: each attempt drops a setting some
    // encoders refuse at configure time (as #641's writer, after Media3 and
    // react-native-skia-video). A codec a configure failed on is in an error
    // state: each attempt makes a new one.
    auto configure = [&](int attempt) {
      AMediaFormat* format = AMediaFormat_new();
      AMediaFormat_setString(format, AMEDIAFORMAT_KEY_MIME, videoMime(_config.codec).c_str());
      AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_WIDTH, width);
      AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_HEIGHT, height);
      AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_COLOR_FORMAT, _aspects.hdr() ? kColorFormatYuvP010 : kColorFormatSurface);
      AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_BIT_RATE, static_cast<int32_t>(std::min(bitrate, 2e9)));
      // KEY_FRAME_RATE only budgets the bitrate (the timestamps time the
      // frames); some encoders refuse a high one even when they list it.
      AMediaFormat_setFloat(format, AMEDIAFORMAT_KEY_FRAME_RATE,
                            static_cast<float>(attempt >= 2 ? std::min(framerate, 30.0) : framerate));
      // Key frames come from encode({ keyFrame: true }), as on the web.
      AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_I_FRAME_INTERVAL, 3600);
      // WebCodecs outputs chunks in decode order: no B-frames.
      AMediaFormat_setInt32(format, "max-bframes", 0);
      // The chunks are tagged BT.709, limited range, or BT.2020 HLG / PQ.
      AMediaFormat_setInt32(format, "color-standard", _aspects.standard);
      AMediaFormat_setInt32(format, "color-range", _aspects.range);
      AMediaFormat_setInt32(format, "color-transfer", _aspects.transfer);
      if (_config.realtime) {
        AMediaFormat_setInt32(format, "priority", 0);
      } else {
        // Best effort, as fast as the encoder goes: without an operating rate
        // some encoders pace an offline export in real time. INT32_MAX throws
        // on some chipsets (Media3's
        // deviceNeedsLowerOperatingRateAvoidingOverflowWorkaround), which take
        // 1000; the last attempt asks for none.
        AMediaFormat_setInt32(format, "priority", 1);
        if (attempt == 0) {
          AMediaFormat_setInt32(format, "operating-rate", INT32_MAX);
        } else if (attempt == 1) {
          AMediaFormat_setInt32(format, "operating-rate", 1000);
        }
      }
      if (_config.codec == "av1") {
        // AV1ProfileMain8, or AV1ProfileMain10 (HDR: AV1ProfileMain10HDR10
        // is for PQ with static metadata, which HLG does not use). Always
        // set: without it the encoder makes 8-bit streams.
        AMediaFormat_setInt32(format, "profile", mediaCodecProfile(_config));
      } else if (attempt < 2 && _config.profile.has_value()) {
        AMediaFormat_setInt32(format, "profile", mediaCodecProfile(_config));
      }
      media_status_t status = AMediaCodec_configure(_codec, format, nullptr, nullptr, AMEDIACODEC_CONFIGURE_FLAG_ENCODE);
      AMediaFormat_delete(format);
      return status;
    };
    media_status_t configured = AMEDIA_ERROR_UNKNOWN;
    for (int attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        AMediaCodec_delete(_codec);
        _codec = createCodec();
        if (!_codec) {
          break;
        }
      }
      configured = configure(attempt);
      if (configured == AMEDIA_OK) {
        break;
      }
    }
    if (configured != AMEDIA_OK) {
      if (_codec) {
        AMediaCodec_delete(_codec);
        _codec = nullptr;
      }
      throw std::runtime_error("the " + _config.codec + " encoder does not take " + std::to_string(width) + "x" + std::to_string(height) +
                               " at " + std::to_string(static_cast<int64_t>(bitrate)) + " bps (" +
                               std::to_string(configured) + ")");
    }
    // Software codecs are Codec2's c2.android.* (and OMX.google.*).
    // AMediaCodec_getName is API 28, above this library's minimum (26).
    using GetName = media_status_t (*)(AMediaCodec*, char**);
    using ReleaseName = void (*)(AMediaCodec*, char*);
    static auto getName = reinterpret_cast<GetName>(dlsym(RTLD_DEFAULT, "AMediaCodec_getName"));
    static auto releaseName = reinterpret_cast<ReleaseName>(dlsym(RTLD_DEFAULT, "AMediaCodec_releaseName"));
    char* name = nullptr;
    if (getName && releaseName && getName(_codec, &name) == AMEDIA_OK && name) {
      std::string codecName(name);
      _hardware = codecName.rfind("c2.android.", 0) != 0 && codecName.rfind("OMX.google.", 0) != 0;
      WC_LOG("video encoder: %s", name);
      releaseName(_codec, name);
    }
    media_status_t status = AMEDIA_OK;
    if (!_aspects.hdr()) {
      ANativeWindow* window = nullptr;
      status = AMediaCodec_createInputSurface(_codec, &window);
      if (status != AMEDIA_OK || !window) {
        AMediaCodec_delete(_codec);
        _codec = nullptr;
        throw std::runtime_error("AMediaCodec_createInputSurface failed (" + std::to_string(status) + ")");
      }
      _nativeWindow = window;
      _window = _blitter.createWindowSurface(window);
    }
    status = AMediaCodec_start(_codec);
    if (status != AMEDIA_OK) {
      throw std::runtime_error("AMediaCodec_start failed (" + std::to_string(status) + ")");
    }
    if (_aspects.hdr()) {
      // The layout of the input buffers: rows `stride` bytes apart, the
      // chroma plane `slice-height` rows after the luma one.
      _stride = static_cast<size_t>(_config.width) * 2;
      _sliceHeight = static_cast<size_t>(_config.height);
      // API 28, above this library's minimum (26).
      using GetInputFormat = AMediaFormat* (*)(AMediaCodec*);
      static auto getInputFormat =
          reinterpret_cast<GetInputFormat>(dlsym(RTLD_DEFAULT, "AMediaCodec_getInputFormat"));
      AMediaFormat* input = getInputFormat ? getInputFormat(_codec) : nullptr;
      if (input) {
        int32_t value = 0;
        if (AMediaFormat_getInt32(input, "stride", &value) && value > 0) {
          _stride = static_cast<size_t>(value);
        }
        if (AMediaFormat_getInt32(input, "slice-height", &value) && value > 0) {
          _sliceHeight = static_cast<size_t>(value);
        }
        AMediaFormat_delete(input);
      }
      // A stride in pixels (some codecs) rather than bytes.
      if (_stride < static_cast<size_t>(_config.width) * 2) {
        _stride *= 2;
      }
      WC_LOG("video encoder: P010 input, stride %zu, slice height %zu", _stride, _sliceHeight);
    }
    _framesIn = 0;
    _ended = false;
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _eos = false;
      _draining = true;
    }
    _drain = std::thread([this, codec = _codec] { drainLoop(codec); });
  }

  // On the GL thread.
  void stop() {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _draining = false;
    }
    if (_drain.joinable()) {
      _drain.join();
    }
    if (_window != EGL_NO_SURFACE) {
      _blitter.destroySurface(_window);
      _window = EGL_NO_SURFACE;
    }
    if (_codec) {
      AMediaCodec_stop(_codec);
      AMediaCodec_delete(_codec);
      _codec = nullptr;
    }
    if (_nativeWindow) {
      ANativeWindow_release(_nativeWindow);
      _nativeWindow = nullptr;
    }
  }

  void shutdown() {
    _closed = true;
    _failed = true;
    auto done = std::make_shared<std::promise<void>>();
    auto future = done->get_future();
    _gl.post([this, done] {
      stop();
      _blitter.destroy();
      done->set_value();
    });
    future.wait();
  }

  bool draining() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _draining;
  }

  void drainLoop(AMediaCodec* codec) {
    pthread_setname_np(pthread_self(), "wc-venc-drain");
    auto lastOutput = std::chrono::steady_clock::now();
    while (draining()) {
      AMediaCodecBufferInfo info{};
      ssize_t index = AMediaCodec_dequeueOutputBuffer(codec, &info, 10000);
      if (index == AMEDIACODEC_INFO_TRY_AGAIN_LATER) {
        // Only frames that went in and never came out count against it.
        bool waiting = false;
        {
          std::lock_guard<std::mutex> lock(_mutex);
          waiting = !_durations.empty();
        }
        if (!waiting) {
          lastOutput = std::chrono::steady_clock::now();
        } else if (std::chrono::steady_clock::now() - lastOutput > kStallTimeout) {
          fail(errorMessage("EncodingError", "encoder-failed", "timed out waiting for the encoder"));
          return;
        }
        continue;
      }
      if (index == AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED) {
        continue;
      }
      lastOutput = std::chrono::steady_clock::now();
      if (index == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
        AMediaFormat* format = AMediaCodec_getOutputFormat(codec);
        void* sps = nullptr;
        void* pps = nullptr;
        size_t spsSize = 0;
        size_t ppsSize = 0;
        if (format && _config.codec == "avc" && AMediaFormat_getBuffer(format, "csd-0", &sps, &spsSize) &&
            AMediaFormat_getBuffer(format, "csd-1", &pps, &ppsSize)) {
          parameterSets(static_cast<uint8_t*>(sps), spsSize);
          parameterSets(static_cast<uint8_t*>(pps), ppsSize);
        }
        if (format) {
          AMediaFormat_delete(format);
        }
        continue;
      }
      if (isCodecError(index)) {
        fail(describeCodecStatus(static_cast<media_status_t>(index), "encoder", "encoder"));
        return;
      }
      size_t capacity = 0;
      uint8_t* data = AMediaCodec_getOutputBuffer(codec, index, &capacity);
      if (data && info.size > 0) {
        const uint8_t* bytes = data + info.offset;
        if (info.flags & kBufferFlagCodecConfig) {
          // AV1: the sequence header, also at the start of each key frame.
          if (_config.codec == "avc") {
            parameterSets(bytes, info.size);
          }
        } else if (_config.codec == "av1") {
          emitAv1(bytes, info.size, info.presentationTimeUs, (info.flags & kBufferFlagKeyFrame) != 0);
        } else {
          emit(bytes, info.size, info.presentationTimeUs, (info.flags & kBufferFlagKeyFrame) != 0);
        }
      }
      AMediaCodec_releaseOutputBuffer(codec, index, false);
      if (info.flags & kBufferFlagEndOfStream) {
        {
          std::lock_guard<std::mutex> lock(_mutex);
          _eos = true;
        }
        _cv.notify_all();
        return;
      }
    }
  }

  void parameterSets(const uint8_t* data, size_t size) {
    for (auto& [unit, length] : annexBUnits(data, size)) {
      int type = unit[0] & 0x1f;
      if (type == 7) {
        _sps.assign(unit, unit + length);
      } else if (type == 8) {
        _pps.assign(unit, unit + length);
      }
    }
  }

  // HDR: the next input buffer.
  ssize_t dequeueInput() {
    auto deadline = std::chrono::steady_clock::now() + kStallTimeout;
    while (!_failed) {
      ssize_t index = AMediaCodec_dequeueInputBuffer(_codec, 10000);
      if (index >= 0) {
        return index;
      }
      if (index != AMEDIACODEC_INFO_TRY_AGAIN_LATER) {
        throw std::runtime_error("dequeueInputBuffer failed (" + std::to_string(index) + ")");
      }
      if (std::chrono::steady_clock::now() > deadline) {
        throw std::runtime_error("timed out waiting for an input buffer");
      }
    }
    throw std::runtime_error("the encoder failed");
  }

  // HDR: a half-float surface, converted to P010 into an input buffer.
  void queueP010(AHardwareBuffer* buffer, int64_t ptsUs) {
    AHardwareBuffer_Desc desc{};
    AHardwareBuffer_describe(buffer, &desc);
    if (desc.format != AHARDWAREBUFFER_FORMAT_R16G16B16A16_FLOAT) {
      throw std::runtime_error("HDR frames must come from an RGBA16F surface pool");
    }
    int width = static_cast<int>(_config.width);
    int height = static_cast<int>(_config.height);
    if (static_cast<int>(desc.width) < width || static_cast<int>(desc.height) < height) {
      throw std::runtime_error("the frame is smaller than the encoder");
    }
    ssize_t index = dequeueInput();
    size_t capacity = 0;
    uint8_t* dst = AMediaCodec_getInputBuffer(_codec, static_cast<size_t>(index), &capacity);
    size_t size = _stride * _sliceHeight * 3 / 2;
    if (!dst || capacity < size) {
      throw std::runtime_error("the input buffer is too small for P010");
    }
    void* src = nullptr;
    int locked = AHardwareBuffer_lock(buffer, AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN, -1, nullptr, &src);
    if (locked != 0 || !src) {
      throw std::runtime_error("AHardwareBuffer_lock failed (" + std::to_string(locked) + ")");
    }
    rgba16fToP010(static_cast<const uint16_t*>(src), desc.stride * 4, width, height, dst, _stride, _sliceHeight);
    AHardwareBuffer_unlock(buffer, nullptr);
    media_status_t status = AMediaCodec_queueInputBuffer(_codec, static_cast<size_t>(index), 0, size, ptsUs, 0);
    if (status != AMEDIA_OK) {
      throw std::runtime_error("queueInputBuffer failed (" + std::to_string(status) + ")");
    }
  }

  media_status_t queueEndOfStream() {
    try {
      ssize_t index = dequeueInput();
      return AMediaCodec_queueInputBuffer(_codec, static_cast<size_t>(index), 0, 0, 0, kBufferFlagEndOfStream);
    } catch (const std::exception&) {
      return AMEDIA_ERROR_UNKNOWN;
    }
  }

  double takeDuration(int64_t ptsUs) {
    std::lock_guard<std::mutex> lock(_mutex);
    auto it = _durations.find(ptsUs);
    if (it == _durations.end()) {
      return 0;
    }
    double duration = it->second;
    _durations.erase(_durations.begin(), std::next(it));
    return duration;
  }

  // AV1 chunks are the OBUs as they come (low-overhead format, with sizes),
  // as WebCodecs has them. No description: the av1C record is optional, and
  // the sequence header is in the key frames.
  void emitAv1(const uint8_t* data, size_t size, int64_t ptsUs, bool key) {
    double duration = takeDuration(ptsUs);
    if (_failed) {
      return;
    }
    std::vector<uint8_t> chunk(data, data + size);
    _output(NativeEncodedChunk(ArrayBuffer::move(std::move(chunk)), static_cast<double>(ptsUs), duration, key, std::nullopt));
  }

  void emit(const uint8_t* data, size_t size, int64_t ptsUs, bool key) {
    std::vector<uint8_t> avcc;
    avcc.reserve(size + 16);
    for (auto& [unit, length] : annexBUnits(data, size)) {
      int type = unit[0] & 0x1f;
      if (type == 7 || type == 8) {
        // In-band parameter sets: the description carries them.
        (type == 7 ? _sps : _pps).assign(unit, unit + length);
        continue;
      }
      if (type == 9) {
        continue;  // access unit delimiter
      }
      avcc.push_back(static_cast<uint8_t>(length >> 24));
      avcc.push_back(static_cast<uint8_t>(length >> 16));
      avcc.push_back(static_cast<uint8_t>(length >> 8));
      avcc.push_back(static_cast<uint8_t>(length));
      avcc.insert(avcc.end(), unit, unit + length);
    }
    double duration = takeDuration(ptsUs);
    std::optional<std::shared_ptr<ArrayBuffer>> description;
    if (key) {
      auto record = makeAvcC(_sps, _pps);
      if (!record.empty() && record != _lastDescription) {
        _lastDescription = record;
        description = ArrayBuffer::copy(record);
      }
    }
    if (_failed) {
      return;
    }
    _output(NativeEncodedChunk(ArrayBuffer::move(std::move(avcc)), static_cast<double>(ptsUs), duration, key, description));
  }

  void fail(const std::string& message) {
    bool expected = false;
    if (!_reported.compare_exchange_strong(expected, true)) {
      return;
    }
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _failure = message;
      _failed = true;
    }
    _cv.notify_all();
    if (!_closed) {
      _error(message);
    }
  }

  NativeVideoEncoderConfig _config;
  std::function<void(const NativeEncodedChunk&)> _output;
  std::function<void(const std::string&)> _error;

  std::mutex _mutex;
  std::condition_variable _cv;
  std::map<int64_t, double> _durations;
  bool _eos = false;
  bool _draining = false;
  std::string _failure;
  std::atomic<bool> _failed{false};
  std::atomic<bool> _closed{false};
  std::atomic<bool> _reported{false};

  // GL thread only.
  AMediaCodec* _codec = nullptr;
  ANativeWindow* _nativeWindow = nullptr;
  EGLSurface _window = EGL_NO_SURFACE;
  GlBlitter _blitter;
  ColorAspects _aspects;
  // The encoder chosen for the config and color aspects (empty: the type's
  // default), looked up once.
  std::optional<std::string> _encoderName;
  size_t _stride = 0;
  size_t _sliceHeight = 0;
  int64_t _framesIn = 0;
  bool _ended = false;
  std::atomic<bool> _hardware{false};
  std::thread _drain;

  // Drain thread only.
  std::vector<uint8_t> _sps;
  std::vector<uint8_t> _pps;
  std::vector<uint8_t> _lastDescription;

  SerialQueue _gl{"wc-venc-gl"};
};

} // namespace margelo::nitro::webcodecs

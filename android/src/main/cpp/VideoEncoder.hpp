#pragma once

#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>

#include <android/api-level.h>
#include <android/hardware_buffer.h>
#include <dlfcn.h>
#include <poll.h>
#include <sys/system_properties.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <future>
#include <optional>

#include "Capabilities.hpp"
#include "EncoderAttempts.hpp"
#include "Gl.hpp"
#include "HybridNativeVideoEncoderSpec.hpp"
#include "NativeEncodedChunk.hpp"
#include "NativeVideoEncoderConfig.hpp"
#include "P010.hpp"
#include "Surface.hpp"
#include "Timestamps.hpp"

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

// How long a key frame request waits for the frames before it to come out.
constexpr auto kKeyFrameDrainTimeout = std::chrono::milliseconds(200);

// After the end of stream is asked for, with every frame drawn out: this long
// with no output is the end, for encoders that never say so.
constexpr auto kEndOfStreamQuietTimeout = std::chrono::seconds(1);

// How long shutdown() waits for the GL thread to stop the codec, before it
// stops it from its own thread (then as long again).
constexpr auto kShutdownTimeout = std::chrono::milliseconds(2000);

// How long flush() waits for the frames drawn to come out before it ends the
// stream (Media3 waits 100 ms).
constexpr auto kEndOfStreamDrainTimeout = std::chrono::milliseconds(200);

// Debug builds only: a fault the e2e tests make the encoder act out, from
// `adb shell setprop debug.webcodecs.fault <value>`, read when a codec starts:
//   venc-no-eos             the end of stream never comes out
//   venc-stall-output:<s>   no output is taken, and <s> s without it is a stall
//   venc-slow-stop:<ms>     stopping the codec takes <ms> ms longer
// Release builds (NDEBUG) never read it.
struct EncoderFault {
  bool noEndOfStream = false;
  int stallOutputSeconds = 0;
  int slowStopMs = 0;
  // The draw of this frame (1-based) fails on the GL thread.
  int drawFailAt = 0;

  static EncoderFault read() {
    EncoderFault fault;
#ifndef NDEBUG
    char value[PROP_VALUE_MAX] = {0};
    __system_property_get("debug.webcodecs.fault", value);
    const std::string text(value);
    auto argument = [&](const std::string& name) {
      return std::atoi(text.c_str() + name.size());
    };
    if (text == "venc-no-eos") {
      fault.noEndOfStream = true;
    } else if (text.rfind("venc-stall-output:", 0) == 0) {
      fault.stallOutputSeconds = std::max(1, argument("venc-stall-output:"));
    } else if (text.rfind("venc-slow-stop:", 0) == 0) {
      fault.slowStopMs = std::max(0, argument("venc-slow-stop:"));
    } else if (text.rfind("venc-draw-fail:", 0) == 0) {
      fault.drawFailAt = std::max(1, argument("venc-draw-fail:"));
    }
    if (!text.empty()) {
      WC_LOG("video encoder: fault %s", value);
    }
#endif
    return fault;
  }
};

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

// The encoder MediaCodecList says takes this config (size, profile, and the
// input: a surface, or P010 buffers for 10-bit HDR); none when no encoder
// does. Encoders that take the size as they say come first (start()
// configures the size asked for and falls back on no other encoder), then
// those the lenient reading lets through; in each, a hardware one before a
// software one (Capabilities.java). The frame rate and bitrate are hints, as
// in Media3: start() clamps the bitrate into the range of the encoder it made.
//
// An H.264 profile is a preference, as configure() treats it: when no encoder
// lists it (the emulator's software encoder has no High), any encoder that
// takes the rest will do, in its default profile, which the avcC description
// of the output says. AV1's Main 10 is required: HDR depends on it.
inline std::optional<std::string> findVideoEncoder(const NativeVideoEncoderConfig& config, bool hdr) {
  return JCapabilities::findVideoEncoder(videoMime(config.codec), static_cast<int>(config.width), static_cast<int>(config.height),
                                         mediaCodecProfile(config), config.codec == "avc", hdr ? kColorFormatYuvP010 : kColorFormatSurface);
}

// Every encoder that may take this config, best first (findVideoEncoder's
// answer first): start() tries the next when one does not start.
inline std::vector<std::string> findVideoEncoders(const NativeVideoEncoderConfig& config, bool hdr) {
  return JCapabilities::findVideoEncoders(videoMime(config.codec), static_cast<int>(config.width), static_cast<int>(config.height),
                                          mediaCodecProfile(config), config.codec == "avc", hdr ? kColorFormatYuvP010 : kColorFormatSurface);
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
        std::string message = e.what();
        // The destructor will not run: let go of the codec and the EGL
        // context here, on the thread that made them.
        try {
          stop();
          _blitter.destroy();
        } catch (...) {
        }
        started->set_value(message);
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
    uint32_t visibleWidth = native->visibleWidth();
    uint32_t visibleHeight = native->visibleHeight();
    int64_t ts = static_cast<int64_t>(timestamp);
    _gl.post([this, ref, fence, visibleWidth, visibleHeight, ts, duration, keyFrame] {
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
          try {
            start();
          } catch (...) {
            if (fence >= 0) {
              ::close(fence);
            }
            throw;
          }
        }
        if (keyFrame && _framesIn > 0) {
          // request-sync applies to the next frame the encoder takes, which
          // may be one already drawn and still queued: first let every frame
          // drawn come out. Bounded, for encoders that hold frames until
          // more come (the request then is best effort, as before).
          {
            std::unique_lock<std::mutex> lock(_mutex);
            bool drained = _cv.wait_for(lock, kKeyFrameDrainTimeout,
                                        [this] { return _framesOut + _framesSkipped >= _framesIn || _failed; });
            if (!drained) {
              WC_LOG("video encoder: %lld frame(s) still in the encoder at a key frame request",
                     static_cast<long long>(_framesIn - _framesOut - _framesSkipped));
            }
          }
          AMediaFormat* params = AMediaFormat_new();
          AMediaFormat_setInt32(params, "request-sync", 0);
          AMediaCodec_setParameters(_codec, params);
          AMediaFormat_delete(params);
        }
        // Recorded in draw order for this codec; the codec gets a pts that
        // moves forward (see Timestamps.hpp), the chunk the real one.
        int64_t pts = 0;
        {
          std::lock_guard<std::mutex> lock(_mutex);
          pts = _timestamps.push(ts, duration);
        }
        if (_fault.drawFailAt > 0 && _framesIn + 1 == _fault.drawFailAt) {
          if (fence >= 0) {
            ::close(fence);
          }
          throw std::runtime_error("fault: the draw failed");
        }
        if (_aspects.hdr()) {
          waitFenceCpu(fence);
          queueP010(ref->buffer, pts);
        } else {
          _blitter.waitFence(fence);
          _blitter.drawToWindow(_window, ref->buffer, visibleWidth, visibleHeight, static_cast<int>(_config.width),
                                static_cast<int>(_config.height), pts * 1000);
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
      if (!_aspects.hdr()) {
        // Some encoders lose the last frame when the end of stream follows
        // it at once (b/301603935): a short encode would then come out with
        // no frame. As Media3 does, first let what was drawn come out, for a
        // bounded time (encoders that hold frames until more come or the
        // stream ends wait it out).
        std::unique_lock<std::mutex> lock(_mutex);
        _cv.wait_for(lock, kEndOfStreamDrainTimeout,
                     [this] { return _framesOut + _framesSkipped >= _framesIn || _failed || _closed; });
      }
      // MediaCodec has no flush for a surface input: end the stream (the
      // next encode() starts a new one).
      media_status_t status = _aspects.hdr() ? queueEndOfStream() : AMediaCodec_signalEndOfInputStream(_codec);
      if (status != AMEDIA_OK) {
        fail(describeCodecStatus(status, "encoder", "encoder"));
        promise->reject(std::make_exception_ptr(std::runtime_error(_failure)));
        return;
      }
      // Done when the end of stream comes out. Some encoders never output
      // it (b/365484741): every frame drawn having come out, and nothing
      // more for a while, is the end too. Only an encoder that outputs
      // nothing for kStallTimeout with frames still in it has timed out:
      // a slow one still making progress has not.
      const auto signalled = std::chrono::steady_clock::now();
      bool quiet = false;
      bool stalled = false;
      std::unique_lock<std::mutex> lock(_mutex);
      while (!_cv.wait_for(lock, std::chrono::milliseconds(250), [this] { return _eos || _failed || _closed; })) {
        const auto now = std::chrono::steady_clock::now();
        const auto since = now - std::max(_lastOutputAt, signalled);
        if (_framesOut + _framesSkipped >= _framesIn && since >= kEndOfStreamQuietTimeout) {
          quiet = true;
          break;
        }
        if (since > kStallTimeout) {
          stalled = true;
          break;
        }
      }
      lock.unlock();
      if (quiet) {
        // No end of stream to end the drain thread: stop the codec, so no
        // output comes after the flush resolves. The next encode() starts a
        // new one.
        WC_LOG("video encoder: no end of stream after every frame came out; stopping the codec");
        stop();
        for (int64_t n = _framesIn - _framesOut; n > 0 && !_failed; n--) {
          _output(NativeEncodedChunk(ArrayBuffer::allocate(0), 0, 0, false, std::nullopt));
        }
      }
      _ended = true;
      if (_failed) {
        promise->reject(std::make_exception_ptr(std::runtime_error(_failure)));
      } else if (stalled) {
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
        _candidates.reset();  // HDR takes P010 buffers: maybe other encoders
        _firstAttempt = 0;
        start();
        restarted->set_value("");
      } catch (const std::exception& e) {
        // No codec now (an encoder without Main 10 or P010): the encoder
        // has failed, and says so through the error callback too, so that
        // JS closes it rather than queue frames that are dropped.
        fail(errorMessage("NotSupportedError", "encoder-failed", e.what()));
        restarted->set_value(e.what());
      }
    });
    std::string message = result.get();
    if (!message.empty()) {
      throw domError("NotSupportedError", message);
    }
  }

  // Synchronous, as the decoder's: the codec is let go before close()
  // returns, so that a configure() after it (a new native encoder) does not
  // make a second codec while this one is still there (devices with few
  // codec instances refuse it). Bounded: see shutdown().
  void close() override {
    shutdown();
  }

private:
  // The encoders MediaCodecList says may take the config, best first
  // (isConfigSupported's answer first), looked up once; "" (the platform's
  // default for the type) when none says so.
  const std::vector<std::string>& candidates() {
    if (!_candidates.has_value()) {
      _candidates = findVideoEncoders(_config, _aspects.hdr());
      if (_candidates->empty()) {
        _candidates->push_back("");
      }
    }
    return *_candidates;
  }

  // The encoder `name`, or the type's default for "".
  AMediaCodec* createCodec(const std::string& name) {
    if (name.empty()) {
      return AMediaCodec_createEncoderByType(videoMime(_config.codec).c_str());
    }
    return AMediaCodec_createCodecByName(name.c_str());
  }

  // The codec's name ("" when unknown). AMediaCodec_getName is API 28,
  // above this library's minimum (26).
  static std::string codecName(AMediaCodec* codec) {
    using GetName = media_status_t (*)(AMediaCodec*, char**);
    using ReleaseName = void (*)(AMediaCodec*, char*);
    static auto getName = reinterpret_cast<GetName>(dlsym(RTLD_DEFAULT, "AMediaCodec_getName"));
    static auto releaseName = reinterpret_cast<ReleaseName>(dlsym(RTLD_DEFAULT, "AMediaCodec_releaseName"));
    std::string result;
    char* name = nullptr;
    if (getName && releaseName && getName(codec, &name) == AMEDIA_OK && name) {
      result = name;
      releaseName(codec, name);
    }
    return result;
  }

  // Makes, configures and starts the encoder `name` ("" for the type's
  // default), from the configure attempt `firstAttempt` on. False, with the
  // codec let go and `failure` saying why (each attempt's status), when it
  // does not start.
  bool startEncoder(const std::string& name, size_t firstAttempt, std::string& failure) {
    const std::string label = name.empty() ? "the " + _config.codec + " default" : name;
    _codec = createCodec(name);
    if (!_codec) {
      failure = label + ": could not be made";
      return false;
    }
    int32_t width = static_cast<int32_t>(_config.width);
    int32_t height = static_cast<int32_t>(_config.height);
    // Hints: the frame rate floored, and below 1 the default; the bitrate
    // (or the default one) clamped into the range of the encoder made.
    double framerate = std::floor(_config.framerate.value_or(0));
    if (!(framerate >= 1)) {
      framerate = 30;
    }
    std::string encoderName = codecName(_codec);
    if (encoderName.empty()) {
      encoderName = name;
    }
    double bitrate = JCapabilities::videoBitrate(encoderName, videoMime(_config.codec), _config.bitrate.value_or(0), width, height,
                                                 _config.framerate.value_or(0));
    // H.264's profile goes with a level (OMX encoders refuse a profile
    // alone): the next profile down when the encoder does not list the one
    // asked for, and neither when it lists none that will do. AV1's profile
    // is always set: without it the encoder makes 8-bit streams.
    int32_t profile = mediaCodecProfile(_config);
    int32_t level = 0;
    if (_config.codec == "avc" && profile > 0) {
      auto chosen = JCapabilities::avcProfileLevel(encoderName, videoMime(_config.codec), profile,
                                                   static_cast<int>(_config.level.value_or(0)), width, height,
                                                   _config.framerate.value_or(0));
      profile = chosen.profile;
      level = chosen.level;
    }
    // See videoEncoderAttempts. A codec a configure failed on is in an error
    // state: each attempt makes a new one.
    const auto attempts = videoEncoderAttempts(level > 0, _config.realtime);
    auto configure = [&](const EncoderAttempt& attempt) {
      AMediaFormat* format = AMediaFormat_new();
      AMediaFormat_setString(format, AMEDIAFORMAT_KEY_MIME, videoMime(_config.codec).c_str());
      AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_WIDTH, width);
      AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_HEIGHT, height);
      AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_COLOR_FORMAT, _aspects.hdr() ? kColorFormatYuvP010 : kColorFormatSurface);
      AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_BIT_RATE, static_cast<int32_t>(std::min(bitrate, 2e9)));
      // KEY_FRAME_RATE only budgets the bitrate (the timestamps time the
      // frames); some encoders refuse a high one even when they list it.
      AMediaFormat_setFloat(format, AMEDIAFORMAT_KEY_FRAME_RATE,
                            static_cast<float>(attempt.capFrameRate ? std::min(framerate, 30.0) : framerate));
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
        // some encoders pace an offline export in real time.
        AMediaFormat_setInt32(format, "priority", 1);
        if (attempt.operatingRate != kOperatingRateNone) {
          AMediaFormat_setInt32(format, "operating-rate", attempt.operatingRate);
        }
      }
      if (_config.codec == "av1") {
        // AV1ProfileMain8, or AV1ProfileMain10 (HDR: AV1ProfileMain10HDR10
        // is for PQ with static metadata, which HLG does not use).
        AMediaFormat_setInt32(format, "profile", profile);
      } else if (attempt.profile && level > 0) {
        AMediaFormat_setInt32(format, "profile", profile);
        AMediaFormat_setInt32(format, "level", level);
      }
      media_status_t status = AMediaCodec_configure(_codec, format, nullptr, nullptr, AMEDIACODEC_CONFIGURE_FLAG_ENCODE);
      AMediaFormat_delete(format);
      return status;
    };
    media_status_t configured = AMEDIA_ERROR_UNKNOWN;
    std::string statuses;
    size_t attempt = std::min(firstAttempt, attempts.size() - 1);
    for (size_t first = attempt; attempt < attempts.size(); attempt++) {
      if (attempt > first) {
        AMediaCodec_delete(_codec);
        _codec = createCodec(name);
        if (!_codec) {
          statuses += ", then could not be made again";
          break;
        }
      }
      configured = configure(attempts[attempt]);
      if (configured == AMEDIA_OK) {
        break;
      }
      WC_LOG("video encoder: %s refused attempt %zu (%s): %d", encoderName.c_str(), attempt,
             describeAttempt(attempts[attempt]).c_str(), configured);
      statuses += (statuses.empty() ? "" : ", ") + describeMediaStatus(configured) + " (" + describeAttempt(attempts[attempt]) + ")";
    }
    if (configured != AMEDIA_OK) {
      if (_codec) {
        AMediaCodec_delete(_codec);
        _codec = nullptr;
      }
      failure = (encoderName.empty() ? label : encoderName) + " at " + std::to_string(static_cast<int64_t>(bitrate)) +
                " bps: configure " + statuses;
      return false;
    }
    _firstAttempt = attempt;
    _codecLabel = encoderName.empty() ? label : encoderName;
    // Software codecs are Codec2's c2.android.* (and OMX.google.*).
    if (!encoderName.empty()) {
      _hardware = encoderName.rfind("c2.android.", 0) != 0 && encoderName.rfind("OMX.google.", 0) != 0;
      WC_LOG("video encoder: %s, %dx%d at %lld bps, %g fps, profile %d level %d: attempt %zu (%s)", encoderName.c_str(), width, height,
             static_cast<long long>(bitrate), framerate, profile, level, attempt, describeAttempt(attempts[attempt]).c_str());
    }
    media_status_t status = AMEDIA_OK;
    if (!_aspects.hdr()) {
      ANativeWindow* window = nullptr;
      status = AMediaCodec_createInputSurface(_codec, &window);
      if (status != AMEDIA_OK || !window) {
        AMediaCodec_delete(_codec);
        _codec = nullptr;
        _firstAttempt = 0;
        failure = encoderName + ": createInputSurface " + describeMediaStatus(status);
        return false;
      }
      _nativeWindow = window;
      try {
        _window = _blitter.createWindowSurface(window);
      } catch (const std::exception& e) {
        stopQuietly();
        _firstAttempt = 0;
        failure = encoderName + ": " + e.what();
        return false;
      }
    }
    status = AMediaCodec_start(_codec);
    if (status != AMEDIA_OK) {
      stopQuietly();
      _firstAttempt = 0;
      failure = encoderName + ": start " + describeMediaStatus(status);
      return false;
    }
    return true;
  }

  // Makes and starts the codec: each candidate encoder in turn (software
  // ones included), each through the configure attempts, until one starts.
  // The encoder and attempt that did are tried first the next time (after a
  // flush, on a new color space).
  void start() {
    _fault = EncoderFault::read();
    const auto& names = candidates();
    std::string failures;
    bool started = false;
    for (size_t c = 0; c < names.size() && !started; c++) {
      std::string failure;
      started = startEncoder(names[c], c == 0 ? _firstAttempt : 0, failure);
      if (started && c > 0) {
        std::rotate(_candidates->begin(), _candidates->begin() + static_cast<std::ptrdiff_t>(c), _candidates->begin() + static_cast<std::ptrdiff_t>(c) + 1);
      }
      if (!started) {
        WC_LOG("video encoder: %s", failure.c_str());
        failures += (failures.empty() ? "" : "; ") + failure;
      }
    }
    if (!started) {
      throw std::runtime_error("no " + _config.codec + " encoder took " + std::to_string(static_cast<int64_t>(_config.width)) + "x" +
                               std::to_string(static_cast<int64_t>(_config.height)) + " (" + failures + ")");
    }
    if (_aspects.hdr()) {
      // The layout of the input buffers: rows `stride` bytes apart, the
      // chroma plane `slice-height` rows after the luma one.
      int32_t stride = 0;
      _sliceHeight = static_cast<size_t>(_config.height);
      // API 28, above this library's minimum (26).
      using GetInputFormat = AMediaFormat* (*)(AMediaCodec*);
      static auto getInputFormat =
          reinterpret_cast<GetInputFormat>(dlsym(RTLD_DEFAULT, "AMediaCodec_getInputFormat"));
      AMediaFormat* input = getInputFormat ? getInputFormat(_codec) : nullptr;
      if (input) {
        int32_t value = 0;
        if (AMediaFormat_getInt32(input, "stride", &value) && value > 0) {
          stride = value;
        }
        // Never fewer rows than the picture has, or its chroma would land on
        // its luma.
        if (AMediaFormat_getInt32(input, "slice-height", &value) && value >= static_cast<int32_t>(_config.height)) {
          _sliceHeight = static_cast<size_t>(value);
        }
        AMediaFormat_delete(input);
      }
      _stride = p010Stride(static_cast<int>(_config.width), stride);
      WC_LOG("video encoder: P010 input, stride %zu, slice height %zu", _stride, _sliceHeight);
    }
    _framesIn = 0;
    _framesOut = 0;
    _ended = false;
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _eos = false;
      _draining = true;
      _lastOutputAt = std::chrono::steady_clock::now();
      _timestamps.clear();
      _framesSkipped = 0;
    }
    {
      // Surface input only: that is where the GL thread can block (in
      // eglSwapBuffers). HDR takes buffers, with bounded waits that end on
      // _failed, and its codec is not stopped under a P010 copy.
      std::lock_guard<std::mutex> lock(_codecMutex);
      _liveCodec = _aspects.hdr() ? nullptr : _codec;
      _aborted = false;
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
    {
      std::lock_guard<std::mutex> lock(_codecMutex);
      _liveCodec = nullptr;
    }
    if (_window != EGL_NO_SURFACE) {
      _blitter.destroySurface(_window);
      _window = EGL_NO_SURFACE;
    }
    if (_codec) {
      if (_fault.slowStopMs > 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(_fault.slowStopMs));
      }
      AMediaCodec_stop(_codec);
      AMediaCodec_delete(_codec);
      _codec = nullptr;
      WC_LOG("video encoder: released %s", _codecLabel.c_str());
    }
    if (_nativeWindow) {
      ANativeWindow_release(_nativeWindow);
      _nativeWindow = nullptr;
    }
  }

  // stop() on a failure path, where the first error is the one to report.
  void stopQuietly() {
    try {
      stop();
    } catch (...) {
    }
  }

  // Stops the codec from another thread than the GL thread, once: its input
  // surface is let go, so a draw blocked waiting for the codec to take a
  // buffer (eglSwapBuffers in dequeueBuffer) returns, and the GL thread gets
  // to what comes next. The GL thread's stop() still deletes it. Under
  // _codecMutex, which the drain thread holds while it reads an output
  // buffer: stopping the codec takes its buffers back.
  void abortCodec() {
    std::lock_guard<std::mutex> lock(_codecMutex);
    if (!_liveCodec || _aborted) {
      return;
    }
    _aborted = true;
    WC_LOG("video encoder: stopping %s from another thread", _codecLabel.c_str());
    AMediaCodec_stop(_liveCodec);
  }

  void shutdown() {
    if (_shutdown.exchange(true)) {
      return;
    }
    _closed = true;
    _failed = true;
    _cv.notify_all();
    auto done = std::make_shared<std::promise<void>>();
    auto future = done->get_future();
    _gl.post([this, done] {
      stop();
      _blitter.destroy();
      done->set_value();
    });
    if (future.wait_for(kShutdownTimeout) == std::future_status::ready) {
      return;
    }
    // The GL thread is stuck (in a draw into a codec that takes nothing):
    // stopping the codec here lets it go on.
    WC_LOG("video encoder: not stopped after %lld ms", static_cast<long long>(kShutdownTimeout.count()));
    abortCodec();
    if (future.wait_for(kShutdownTimeout) != std::future_status::ready) {
      // Left to finish on the GL thread: the destructor's ~SerialQueue
      // waits for it, as it must while the task uses this object.
      WC_ERR("video encoder: the GL thread is still busy");
    }
  }

  bool draining() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _draining;
  }

  void drainLoop(AMediaCodec* codec) {
    pthread_setname_np(pthread_self(), "wc-venc-drain");
    auto lastOutput = std::chrono::steady_clock::now();
    while (draining()) {
      if (_fault.stallOutputSeconds > 0) {
        // Fault: the codec's output is never taken, as if it hung.
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        bool waiting = false;
        {
          std::lock_guard<std::mutex> lock(_mutex);
          waiting = !_timestamps.empty();
        }
        if (!waiting) {
          lastOutput = std::chrono::steady_clock::now();
        } else if (std::chrono::steady_clock::now() - lastOutput > std::chrono::seconds(_fault.stallOutputSeconds)) {
          fail(errorMessage("EncodingError", "encoder-failed", "timed out waiting for the encoder"), true);
          return;
        }
        continue;
      }
      AMediaCodecBufferInfo info{};
      ssize_t index = AMediaCodec_dequeueOutputBuffer(codec, &info, 10000);
      if (index == AMEDIACODEC_INFO_TRY_AGAIN_LATER) {
        // Only frames that went in and never came out count against it.
        bool waiting = false;
        {
          std::lock_guard<std::mutex> lock(_mutex);
          waiting = !_timestamps.empty();
        }
        if (!waiting) {
          lastOutput = std::chrono::steady_clock::now();
        } else if (std::chrono::steady_clock::now() - lastOutput > kStallTimeout) {
          fail(errorMessage("EncodingError", "encoder-failed", "timed out waiting for the encoder"), true);
          return;
        }
        continue;
      }
      if (index == AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED) {
        continue;
      }
      lastOutput = std::chrono::steady_clock::now();
      {
        std::lock_guard<std::mutex> lock(_mutex);
        _lastOutputAt = lastOutput;
      }
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
        fail(describeCodecStatus(static_cast<media_status_t>(index), "encoder", "encoder"), true);
        return;
      }
      // From the buffer to its release, the codec is not stopped from another
      // thread (abortCodec), which would take the buffer back mid-copy. No
      // fail() in here: abortCodec() takes this mutex.
      std::unique_lock<std::mutex> codecLock(_codecMutex);
      if (_aborted) {
        // Stopped meanwhile: the index is no longer the codec's.
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
      codecLock.unlock();
      if ((info.flags & kBufferFlagEndOfStream) && !_fault.noEndOfStream) {
        // Frames the codec took and never output (dropped): an empty chunk
        // each, as VideoToolbox reports a dropped frame, so JS stops
        // counting them.
        // (flush() waits on the GL thread meanwhile: _framesIn is still.)
        for (int64_t n = _framesIn - _framesOut; n > 0 && !_failed; n--) {
          _output(NativeEncodedChunk(ArrayBuffer::allocate(0), 0, 0, false, std::nullopt));
        }
        {
          std::lock_guard<std::mutex> lock(_mutex);
          _timestamps.clear();
        }
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
    size_t size = p010Size(_stride, _sliceHeight);
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

  // The real timestamp and duration of the frame an output is (the codec's
  // pts when no frame is waiting).
  PendingFrame takeFrame(int64_t ptsUs) {
    std::lock_guard<std::mutex> lock(_mutex);
    size_t skipped = 0;
    auto frame = _timestamps.take(ptsUs, skipped);
    _framesSkipped += static_cast<int64_t>(skipped);
    if (!frame.has_value()) {
      return {ptsUs, ptsUs, 0};
    }
    return *frame;
  }

  // AV1 chunks are the OBUs as they come (low-overhead format, with sizes),
  // as WebCodecs has them. No description: the av1C record is optional, and
  // the sequence header is in the key frames.
  void emitAv1(const uint8_t* data, size_t size, int64_t ptsUs, bool key) {
    PendingFrame frame = takeFrame(ptsUs);
    if (_failed) {
      return;
    }
    std::vector<uint8_t> chunk(data, data + size);
    frameOut();
    _output(NativeEncodedChunk(ArrayBuffer::move(std::move(chunk)), static_cast<double>(frame.realTs), frame.duration, key,
                               std::nullopt));
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
    PendingFrame frame = takeFrame(ptsUs);
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
    frameOut();
    _output(NativeEncodedChunk(ArrayBuffer::move(std::move(avcc)), static_cast<double>(frame.realTs), frame.duration, key, description));
  }

  // Counts an output, and wakes a key frame request waiting for it.
  void frameOut() {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _framesOut++;
    }
    _cv.notify_all();
  }

  // stopCodec: from the drain thread (holding no output buffer), whose
  // failure may leave the GL thread blocked drawing into the codec. Not from
  // the GL thread, which is not blocked, while the drain thread may be
  // copying from an output buffer.
  void fail(const std::string& message, bool stopCodec = false) {
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
    // A failed codec takes nothing more: stop it now, so that the GL thread
    // is not left blocked drawing into it.
    if (stopCodec) {
      abortCodec();
    }
    if (!_closed) {
      _error(message);
    }
  }

  NativeVideoEncoderConfig _config;
  std::function<void(const NativeEncodedChunk&)> _output;
  std::function<void(const std::string&)> _error;

  std::mutex _mutex;
  std::condition_variable _cv;
  // Frames drawn and not yet output, in draw order.
  TimestampQueue _timestamps;
  // Frames the codec dropped (found when a later one came out).
  int64_t _framesSkipped = 0;
  bool _eos = false;
  bool _draining = false;
  // When the codec last output anything (flush() reads it for progress).
  std::chrono::steady_clock::time_point _lastOutputAt;
  std::string _failure;
  std::atomic<bool> _failed{false};
  std::atomic<bool> _closed{false};
  std::atomic<bool> _reported{false};
  std::atomic<bool> _shutdown{false};
  // The codec between start() and stop(), for abortCodec() from any thread.
  std::mutex _codecMutex;
  AMediaCodec* _liveCodec = nullptr;
  bool _aborted = false;

  // GL thread only.
  AMediaCodec* _codec = nullptr;
  ANativeWindow* _nativeWindow = nullptr;
  EGLSurface _window = EGL_NO_SURFACE;
  GlBlitter _blitter;
  ColorAspects _aspects;
  // The encoders that may take the config and color aspects, best first
  // ("": the type's default), looked up once; the one that started first.
  std::optional<std::vector<std::string>> _candidates;
  // The configure attempt the encoder that started took.
  size_t _firstAttempt = 0;
  size_t _stride = 0;
  size_t _sliceHeight = 0;
  // Frames drawn into the current codec (GL thread), and output by it
  // (drain thread).
  std::atomic<int64_t> _framesIn{0};
  std::atomic<int64_t> _framesOut{0};
  bool _ended = false;
  std::atomic<bool> _hardware{false};
  // Set in start(), before the drain thread starts (which reads it).
  EncoderFault _fault;
  // The codec's name, for the log.
  std::string _codecLabel;
  std::thread _drain;

  // Drain thread only.
  std::vector<uint8_t> _sps;
  std::vector<uint8_t> _pps;
  std::vector<uint8_t> _lastDescription;

  SerialQueue _gl{"wc-venc-gl"};
};

} // namespace margelo::nitro::webcodecs

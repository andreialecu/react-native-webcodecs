#pragma once

#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <initializer_list>
#include <optional>

#include "AudioRules.hpp"
#include "Common.hpp"
#include "HybridNativeAudioDecoderSpec.hpp"
#include "HybridNativeAudioEncoderSpec.hpp"
#include "NativeAudioDecoderConfig.hpp"
#include "NativeAudioEncoderConfig.hpp"
#include "NativeDecodedAudio.hpp"
#include "NativeEncodedChunk.hpp"
#include "VideoEncoder.hpp"

namespace margelo::nitro::webcodecs {

// MediaCodec in buffer mode, fed and drained on one worker thread.
class AudioCodec {
public:
  ~AudioCodec() {
    stop();
  }

  // Starts the first of `names` that exists and takes `format`, else the
  // platform's default for `mime`. Returns the codec's name ("" when the
  // platform does not tell it).
  std::string start(AMediaFormat* format, bool encoder, const std::string& mime,
                    std::initializer_list<const char*> names = {}) {
    for (const char* name : names) {
      if ((_codec = AMediaCodec_createCodecByName(name)) && configureAndStart(format, encoder) == AMEDIA_OK) {
        return name;
      }
    }
    _codec = encoder ? AMediaCodec_createEncoderByType(mime.c_str()) : AMediaCodec_createDecoderByType(mime.c_str());
    if (!_codec) {
      throw domError("NotSupportedError", "no MediaCodec for " + mime);
    }
    media_status_t status = configureAndStart(format, encoder);
    if (status != AMEDIA_OK) {
      throw domError("NotSupportedError", "MediaCodec " + mime + " failed to start (" + std::to_string(status) + ")");
    }
    return codecName(_codec).value_or("");
  }

  void stop() {
    if (_codec) {
      AMediaCodec_stop(_codec);
      AMediaCodec_delete(_codec);
      _codec = nullptr;
    }
  }

  AMediaCodec* get() const {
    return _codec;
  }

  // Queues `size` bytes (possibly across several input buffers), draining
  // output whenever the codec has no room. `drain` gets every output.
  template <typename Drain>
  media_status_t feed(const uint8_t* data, size_t size, int64_t ptsUs, int64_t usPerByte_num, int64_t usPerByte_den,
                      uint32_t flags, Drain&& drain) {
    size_t offset = 0;
    do {
      ssize_t index = AMediaCodec_dequeueInputBuffer(_codec, 0);
      int tries = 0;
      while (index == AMEDIACODEC_INFO_TRY_AGAIN_LATER && tries++ < 1000) {
        media_status_t status = drain(5000);
        if (status != AMEDIA_OK) {
          return status;
        }
        index = AMediaCodec_dequeueInputBuffer(_codec, 0);
      }
      if (index < 0 || index == kErrorInsufficientResource || index == kErrorReclaimed) {
        return index == AMEDIACODEC_INFO_TRY_AGAIN_LATER ? AMEDIA_ERROR_WOULD_BLOCK : static_cast<media_status_t>(index);
      }
      size_t capacity = 0;
      uint8_t* buffer = AMediaCodec_getInputBuffer(_codec, index, &capacity);
      if (!buffer) {
        return AMEDIA_ERROR_UNKNOWN;
      }
      size_t n = std::min(capacity, size - offset);
      if (n > 0) {
        memcpy(buffer, data + offset, n);
      }
      int64_t pts = ptsUs + (usPerByte_den > 0 ? static_cast<int64_t>(offset) * usPerByte_num / usPerByte_den : 0);
      bool last = offset + n >= size;
      media_status_t status = AMediaCodec_queueInputBuffer(_codec, index, 0, n, pts, last ? flags : 0);
      if (status != AMEDIA_OK) {
        return status;
      }
      offset += n;
    } while (offset < size);
    return AMEDIA_OK;
  }

private:
  // Configures and starts _codec; on failure, deletes it.
  media_status_t configureAndStart(AMediaFormat* format, bool encoder) {
    media_status_t status = AMediaCodec_configure(_codec, format, nullptr, nullptr, encoder ? AMEDIACODEC_CONFIGURE_FLAG_ENCODE : 0);
    if (status == AMEDIA_OK) {
      status = AMediaCodec_start(_codec);
    }
    if (status != AMEDIA_OK) {
      AMediaCodec_delete(_codec);
      _codec = nullptr;
    }
    return status;
  }

  AMediaCodec* _codec = nullptr;
};

// flush() pads with kAacPaddingFrames frames of silence, enough to push out
// the encoder's delay (aacEncoderDelay) and a partial last frame.
constexpr int64_t kAacPaddingFrames = 3;

// AAC-LC from f32 interleaved PCM.
class HybridNativeAudioEncoder : public HybridNativeAudioEncoderSpec {
public:
  HybridNativeAudioEncoder(const NativeAudioEncoderConfig& config,
                           std::function<void(const NativeEncodedChunk&)> output,
                           std::function<void(const std::string&)> error)
      : HybridObject(TAG), _config(config), _output(std::move(output)), _error(std::move(error)) {
    if (config.codec != "aac") {
      throw domError("NotSupportedError", "codec " + config.codec);
    }
    _sampleRate = static_cast<int32_t>(config.sampleRate);
    _channels = static_cast<int32_t>(config.numberOfChannels);
    start();
  }

  ~HybridNativeAudioEncoder() override {
    _closed = true;
    sync();
  }

  void encode(const std::shared_ptr<ArrayBuffer>& pcm, double frames, double timestamp) override {
    if (_closed) {
      throw domError("InvalidStateError", "the encoder is closed");
    }
    // f32 → s16, copied before leaving the JS thread.
    size_t samples = static_cast<size_t>(frames) * _channels;
    samples = std::min(samples, pcm->size() / sizeof(float));
    const float* in = reinterpret_cast<const float*>(pcm->data());
    std::vector<int16_t> s16(samples);
    for (size_t i = 0; i < samples; i++) {
      float v = std::max(-1.0f, std::min(1.0f, in[i]));
      s16[i] = static_cast<int16_t>(std::lround(v * 32767.0f));
    }
    int64_t ts = static_cast<int64_t>(timestamp);
    _queue.post([this, s16 = std::move(s16), ts] {
      if (_failed) {
        return;
      }
      if (_ended) {
        _codec.stop();
        start();
      }
      if (!_firstPts.has_value()) {
        _firstPts = ts;
      }
      _framesIn += static_cast<int64_t>(s16.size()) / _channels;
      const auto* bytes = reinterpret_cast<const uint8_t*>(s16.data());
      size_t size = s16.size() * sizeof(int16_t);
      // pts of a byte offset: offset / (2 * channels) / sampleRate seconds.
      media_status_t status = _codec.feed(bytes, size, ts, 1000000, int64_t(2) * _channels * _sampleRate, 0,
                                          [this](int64_t timeout) { return drain(timeout); });
      if (status == AMEDIA_OK) {
        status = drain(0);
      }
      if (status != AMEDIA_OK) {
        fail(describeCodecStatus(status, "encoder", "encoder"));
      }
    });
  }

  std::shared_ptr<Promise<void>> flush() override {
    auto promise = Promise<void>::create();
    if (_closed) {
      promise->reject(std::make_exception_ptr(domError("InvalidStateError", "the encoder is closed")));
      return promise;
    }
    _queue.post([this, promise] {
      // Nothing fed since start() (or since the last flush): nothing to
      // output, so no padding and no end of stream; the codec stays as is.
      if (!_failed && !_ended && _framesIn > 0) {
        // What the encoder still holds (its delay, and the last partial
        // frame) must come out before the end of stream: Codec2's AAC
        // encoder flushes it at EOS, but MediaCodec then discards those
        // late outputs. Silence pushes them out as ordinary frames; drain()
        // keeps only the frames that carry input.
        std::vector<int16_t> silence(static_cast<size_t>(kAacPaddingFrames) * 1024 * _channels, 0);
        int64_t end = inputEndPts();
        media_status_t status =
            _codec.feed(reinterpret_cast<const uint8_t*>(silence.data()), silence.size() * sizeof(int16_t), end, 1000000,
                        int64_t(2) * _channels * _sampleRate, 0, [this](int64_t timeout) { return drain(timeout); });
        if (status == AMEDIA_OK) {
          status = _codec.feed(nullptr, 0, end + kAacPaddingFrames * 1024 * 1000000LL / _sampleRate, 0, 0,
                               kBufferFlagEndOfStream, [this](int64_t timeout) { return drain(timeout); });
        }
        for (int i = 0; status == AMEDIA_OK && !_eos && i < 2000; i++) {
          status = drain(5000);
        }
        if (status != AMEDIA_OK) {
          fail(describeCodecStatus(status, "encoder", "encoder"));
        }
        // A new codec for what comes after.
        _ended = true;
      }
      if (_failed) {
        promise->reject(std::make_exception_ptr(std::runtime_error(_failure)));
      } else {
        promise->resolve();
      }
    });
    return promise;
  }

  void close() override {
    _closed = true;
    _failed = true;
    _queue.post([this] { _codec.stop(); });
  }

private:
  void start() {
    AMediaFormat* format = AMediaFormat_new();
    AMediaFormat_setString(format, AMEDIAFORMAT_KEY_MIME, "audio/mp4a-latm");
    AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_SAMPLE_RATE, _sampleRate);
    AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_CHANNEL_COUNT, _channels);
    AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_AAC_PROFILE, 2);  // LC
    // The same, for encoders that read only "profile" (AACObjectLC). The
    // literal: AMEDIAFORMAT_KEY_PROFILE is API 28, above our minimum (26).
    AMediaFormat_setInt32(format, "profile", 2);
    double bitrate = _config.bitrate.value_or(0);
    AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_BIT_RATE, bitrate > 0 ? static_cast<int32_t>(bitrate) : 128000);
    AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_MAX_INPUT_SIZE, 64 * 1024);
    std::string name;
    try {
      // FDK by name when there, whose delay is known; then the default.
      name = _codec.start(format, true, "audio/mp4a-latm", {kAacEncoderNames[0], kAacEncoderNames[1]});
    } catch (...) {
      AMediaFormat_delete(format);
      throw;
    }
    AMediaFormat_delete(format);
    _delay = aacEncoderDelay(name);
    WC_LOG("audio encoder: %s (delay %lld)", name.empty() ? "?" : name.c_str(),
           static_cast<long long>(_delay.value_or(-1)));
    _ended = false;
    _eos = false;
    // A new stream: timed from its own first input.
    _firstPts.reset();
    _framesIn = 0;
    _framesOut = 0;
  }

  // The end of the input fed since start(), in µs.
  int64_t inputEndPts() const {
    return _firstPts.value_or(0) + _framesIn * 1000000LL / _sampleRate;
  }

  void sync() {
    auto done = std::make_shared<std::promise<void>>();
    auto future = done->get_future();
    _queue.post([this, done] {
      _codec.stop();
      done->set_value();
    });
    future.wait();
  }

  media_status_t drain(int64_t timeoutUs) {
    while (true) {
      AMediaCodecBufferInfo info{};
      ssize_t index = AMediaCodec_dequeueOutputBuffer(_codec.get(), &info, timeoutUs);
      if (index == AMEDIACODEC_INFO_TRY_AGAIN_LATER) {
        return AMEDIA_OK;
      }
      if (index == AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED || index == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
        continue;
      }
      if (isCodecError(index)) {
        return static_cast<media_status_t>(index);
      }
      timeoutUs = 0;
      size_t capacity = 0;
      uint8_t* data = AMediaCodec_getOutputBuffer(_codec.get(), index, &capacity);
      if (data && info.size > 0) {
        const uint8_t* bytes = data + info.offset;
        if (info.flags & kBufferFlagCodecConfig) {
          _config_bytes.assign(bytes, bytes + info.size);
        } else if (!_closed && aacKeepFrame(_framesOut, _framesIn, _delay)) {
          // (Past that, a frame holds only the silence flush() added.)
          std::optional<std::shared_ptr<ArrayBuffer>> description;
          if (!_config_bytes.empty() && _config_bytes != _sentDescription) {
            _sentDescription = _config_bytes;
            description = ArrayBuffer::copy(_config_bytes);
          }
          double duration = 1024.0 * 1e6 / _sampleRate;
          // Timed by frame count from the first input, as on iOS: the
          // codec's own timestamps follow the input buffers' boundaries
          // and jump at the end of stream.
          double pts = static_cast<double>(_firstPts.value_or(0)) +
                       std::round(static_cast<double>(_framesOut) * 1024.0 * 1e6 / _sampleRate);
          _framesOut++;
          _output(NativeEncodedChunk(ArrayBuffer::copy(bytes, info.size), pts, duration, true, description));
        }
      }
      AMediaCodec_releaseOutputBuffer(_codec.get(), index, false);
      if (info.flags & kBufferFlagEndOfStream) {
        _eos = true;
        return AMEDIA_OK;
      }
    }
  }

  void fail(const std::string& message) {
    if (_failed.exchange(true)) {
      return;
    }
    _failure = message;
    if (!_closed) {
      _error(message);
    }
  }

  NativeAudioEncoderConfig _config;
  std::function<void(const NativeEncodedChunk&)> _output;
  std::function<void(const std::string&)> _error;
  int32_t _sampleRate = 48000;
  int32_t _channels = 2;
  std::atomic<bool> _failed{false};
  std::atomic<bool> _closed{false};
  std::string _failure;

  // Worker thread only.
  AudioCodec _codec;
  std::vector<uint8_t> _config_bytes;
  std::vector<uint8_t> _sentDescription;
  // Timing of the current stream: the first input's timestamp, the sample
  // frames fed, and the AAC frames output.
  std::optional<int64_t> _firstPts;
  int64_t _framesIn = 0;
  int64_t _framesOut = 0;
  // The encoder's delay in sample frames, when known (FDK's).
  std::optional<int64_t> _delay;
  bool _ended = false;
  bool _eos = false;

  SerialQueue _queue{"wc-aenc"};
};

// AAC or MP3 to f32 interleaved PCM.
class HybridNativeAudioDecoder : public HybridNativeAudioDecoderSpec {
public:
  HybridNativeAudioDecoder(const NativeAudioDecoderConfig& config,
                           std::function<void(const NativeDecodedAudio&)> output,
                           std::function<void(const std::string&)> error)
      : HybridObject(TAG), _output(std::move(output)), _error(std::move(error)) {
    _sampleRate = static_cast<int32_t>(config.sampleRate);
    _channels = static_cast<int32_t>(config.numberOfChannels);
    std::string mime;
    if (config.codec == "aac") {
      mime = "audio/mp4a-latm";
    } else if (config.codec == "mp3") {
      mime = "audio/mpeg";
    } else {
      throw domError("NotSupportedError", "codec " + config.codec);
    }
    AMediaFormat* format = AMediaFormat_new();
    AMediaFormat_setString(format, AMEDIAFORMAT_KEY_MIME, mime.c_str());
    AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_SAMPLE_RATE, _sampleRate);
    AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_CHANNEL_COUNT, _channels);
    if (config.codec == "aac") {
      AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_IS_ADTS, 0);
      if (config.description.has_value() && config.description.value()) {
        auto& d = config.description.value();
        AMediaFormat_setBuffer(format, "csd-0", d->data(), d->size());
      }
    }
    try {
      _codec.start(format, false, mime);
    } catch (...) {
      AMediaFormat_delete(format);
      throw;
    }
    AMediaFormat_delete(format);
  }

  ~HybridNativeAudioDecoder() override {
    _closed = true;
    auto done = std::make_shared<std::promise<void>>();
    auto future = done->get_future();
    _queue.post([this, done] {
      _codec.stop();
      done->set_value();
    });
    future.wait();
  }

  void decode(const std::shared_ptr<ArrayBuffer>& data, double timestamp, double /* duration */) override {
    if (_closed) {
      throw domError("InvalidStateError", "the decoder is closed");
    }
    std::vector<uint8_t> bytes(data->data(), data->data() + data->size());
    int64_t ts = static_cast<int64_t>(timestamp);
    _queue.post([this, bytes = std::move(bytes), ts] {
      if (_failed) {
        return;
      }
      media_status_t status = _codec.feed(bytes.data(), bytes.size(), ts, 0, 0, 0, [this](int64_t t) { return drain(t); });
      if (status == AMEDIA_OK) {
        status = drain(0);
      }
      if (status != AMEDIA_OK) {
        fail(describeCodecStatus(status, "decoder", "decoder"));
      }
    });
  }

  std::shared_ptr<Promise<void>> flush() override {
    auto promise = Promise<void>::create();
    if (_closed) {
      promise->reject(std::make_exception_ptr(domError("InvalidStateError", "the decoder is closed")));
      return promise;
    }
    _queue.post([this, promise] {
      if (!_failed) {
        _eos = false;
        media_status_t status = _codec.feed(nullptr, 0, 0, 0, 0, kBufferFlagEndOfStream, [this](int64_t t) { return drain(t); });
        for (int i = 0; status == AMEDIA_OK && !_eos && i < 2000; i++) {
          status = drain(5000);
        }
        if (status != AMEDIA_OK) {
          fail(describeCodecStatus(status, "decoder", "decoder"));
        } else {
          AMediaCodec_flush(_codec.get());
        }
      }
      if (_failed) {
        promise->reject(std::make_exception_ptr(std::runtime_error(_failure)));
      } else {
        promise->resolve();
      }
    });
    return promise;
  }

  void close() override {
    _closed = true;
    _failed = true;
    _queue.post([this] { _codec.stop(); });
  }

private:
  media_status_t drain(int64_t timeoutUs) {
    while (true) {
      AMediaCodecBufferInfo info{};
      ssize_t index = AMediaCodec_dequeueOutputBuffer(_codec.get(), &info, timeoutUs);
      if (index == AMEDIACODEC_INFO_TRY_AGAIN_LATER) {
        return AMEDIA_OK;
      }
      if (index == AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED) {
        continue;
      }
      if (index == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
        AMediaFormat* format = AMediaCodec_getOutputFormat(_codec.get());
        int32_t value = 0;
        if (AMediaFormat_getInt32(format, AMEDIAFORMAT_KEY_SAMPLE_RATE, &value) && value > 0) {
          _sampleRate = value;
        }
        if (AMediaFormat_getInt32(format, AMEDIAFORMAT_KEY_CHANNEL_COUNT, &value) && value > 0) {
          _channels = value;
        }
        AMediaFormat_delete(format);
        continue;
      }
      if (isCodecError(index)) {
        return static_cast<media_status_t>(index);
      }
      timeoutUs = 0;
      size_t capacity = 0;
      uint8_t* data = AMediaCodec_getOutputBuffer(_codec.get(), index, &capacity);
      if (data && info.size > 0 && !_closed) {
        // s16 interleaved → f32 interleaved.
        size_t samples = info.size / sizeof(int16_t);
        const int16_t* in = reinterpret_cast<const int16_t*>(data + info.offset);
        auto out = ArrayBuffer::allocate(samples * sizeof(float));
        float* f = reinterpret_cast<float*>(out->data());
        for (size_t i = 0; i < samples; i++) {
          f[i] = in[i] / 32768.0f;
        }
        double frames = static_cast<double>(samples / std::max(1, _channels));
        _output(NativeDecodedAudio(out, frames, _sampleRate, _channels, static_cast<double>(info.presentationTimeUs)));
      }
      AMediaCodec_releaseOutputBuffer(_codec.get(), index, false);
      if (info.flags & kBufferFlagEndOfStream) {
        _eos = true;
        return AMEDIA_OK;
      }
    }
  }

  void fail(const std::string& message) {
    if (_failed.exchange(true)) {
      return;
    }
    _failure = message;
    if (!_closed) {
      _error(message);
    }
  }

  std::function<void(const NativeDecodedAudio&)> _output;
  std::function<void(const std::string&)> _error;
  std::atomic<bool> _failed{false};
  std::atomic<bool> _closed{false};
  std::string _failure;

  // Worker thread only.
  AudioCodec _codec;
  int32_t _sampleRate = 44100;
  int32_t _channels = 2;
  bool _eos = false;

  SerialQueue _queue{"wc-adec"};
};

} // namespace margelo::nitro::webcodecs

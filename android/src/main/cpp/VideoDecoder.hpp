#pragma once

#include <media/NdkImage.h>
#include <media/NdkImageReader.h>
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>

#include <algorithm>
#include <atomic>
#include <future>
#include <map>

#include "HybridNativeVideoDecoderSpec.hpp"
#include "NativeDecodedFrame.hpp"
#include "Capabilities.hpp"
#include "NativeVideoDecoderConfig.hpp"
#include "Surface.hpp"
#include "VideoEncoder.hpp"

namespace margelo::nitro::webcodecs {

struct ReaderOwner {
  AImageReader* reader;
  explicit ReaderOwner(AImageReader* reader) : reader(reader) {}
  ~ReaderOwner() {
    AImageReader_delete(reader);
  }
};

// H.264 through MediaCodec into an AImageReader; each picture is copied (GPU)
// into an RGBA AHardwareBuffer, which react-native-webgpu imports as is.
class HybridNativeVideoDecoder : public HybridNativeVideoDecoderSpec {
public:
  HybridNativeVideoDecoder(const NativeVideoDecoderConfig& config,
                           std::function<void(const NativeDecodedFrame&)> output,
                           std::function<void(const std::string&)> error)
      : HybridObject(TAG), _output(std::move(output)), _error(std::move(error)) {
    std::string mime = videoMime(config.codec);
    // The decoder's own (YUV) buffers, held until JS lets go of the frame.
    // A GL copy into RGBA came out black through react-native-webgpu on the
    // emulator, so only "NV12" for now.
    std::string pixelFormat = config.pixelFormat.value_or("NV12");
    if (pixelFormat != "NV12") {
      throw domError("NotSupportedError", "pixel format " + pixelFormat + " (Android decodes to NV12)");
    }
    if (!config.description.has_value() || !config.description.value()) {
      throw domError("NotSupportedError", "Annex B streams (no description) are not supported");
    }
    auto& description = config.description.value();
    if (!parseAvcC(description->data(), description->size(), _sets)) {
      throw domError("NotSupportedError", "invalid avcC description");
    }
    int32_t width = static_cast<int32_t>(config.codedWidth.value_or(1920));
    int32_t height = static_cast<int32_t>(config.codedHeight.value_or(1080));

    // JS holds images: room for Mediabunny's queue too.
    media_status_t status = AImageReader_newWithUsage(width, height, AIMAGE_FORMAT_PRIVATE,
                                                      AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE, 16, &_reader);
    if (status != AMEDIA_OK || !_reader) {
      throw domError("NotSupportedError", "AImageReader_newWithUsage failed (" + std::to_string(status) + ")");
    }
    _readerOwner = std::make_shared<ReaderOwner>(_reader);
    AImageReader_ImageListener listener{this, [](void* context, AImageReader* reader) {
                                          static_cast<HybridNativeVideoDecoder*>(context)->onImage(reader);
                                        }};
    AImageReader_setImageListener(_reader, &listener);
    ANativeWindow* window = nullptr;
    AImageReader_getWindow(_reader, &window);

    AMediaFormat* format = AMediaFormat_new();
    AMediaFormat_setString(format, AMEDIAFORMAT_KEY_MIME, mime.c_str());
    AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_WIDTH, width);
    AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_HEIGHT, height);
    auto csd = [](const std::vector<uint8_t>& unit) {
      std::vector<uint8_t> out = {0, 0, 0, 1};
      out.insert(out.end(), unit.begin(), unit.end());
      return out;
    };
    auto csd0 = csd(_sets.sps[0]);
    auto csd1 = csd(_sets.pps[0]);
    AMediaFormat_setBuffer(format, "csd-0", csd0.data(), csd0.size());
    AMediaFormat_setBuffer(format, "csd-1", csd1.data(), csd1.size());

    // The decoders to try, by name: those hardwareAcceleration prefers
    // first, then the others, each in the platform's order. One that fails
    // to configure or start (out of instances, a level it refuses) gives way
    // to the next; with no list, the platform's choice.
    std::vector<std::string> names;
    std::string preference = config.hardwareAcceleration.value_or("");
    try {
      names = JCapabilities::findVideoDecoders(mime, width, height, preference);
      if (!preference.empty()) {
        for (auto& name : JCapabilities::findVideoDecoders(mime, width, height, "")) {
          if (std::find(names.begin(), names.end(), name) == names.end()) {
            names.push_back(name);
          }
        }
      }
    } catch (const std::exception& e) {
      WC_ERR("video decoder: MediaCodecList failed (%s); using the platform's decoder", e.what());
      names.clear();
    }
    if (names.empty()) {
      names.push_back("");
    }
    status = AMEDIA_ERROR_UNKNOWN;
    std::string tried;
    for (auto& name : names) {
      AMediaCodec* codec = name.empty() ? AMediaCodec_createDecoderByType(mime.c_str()) : AMediaCodec_createCodecByName(name.c_str());
      std::string label = name.empty() ? "the default decoder" : name;
      tried += (tried.empty() ? "" : ", ") + label;
      if (!codec) {
        WC_ERR("video decoder: could not create %s", label.c_str());
        continue;
      }
      status = AMediaCodec_configure(codec, format, window, nullptr, 0);
      if (status == AMEDIA_OK) {
        status = AMediaCodec_start(codec);
      }
      if (status == AMEDIA_OK) {
        _codec = codec;
        WC_LOG("video decoder: %s", label.c_str());
        break;
      }
      WC_ERR("video decoder: %s failed to start (%d)", label.c_str(), status);
      AMediaCodec_delete(codec);
    }
    AMediaFormat_delete(format);
    if (!_codec) {
      _readerOwner.reset();
      _reader = nullptr;
      throw domError("NotSupportedError", "no decoder for " + config.codec + " started (" + std::to_string(status) + "; tried " + tried + ")");
    }

    startDrain();
  }

  ~HybridNativeVideoDecoder() override {
    shutdown();
  }

  void decode(const std::shared_ptr<ArrayBuffer>& data, double timestamp, double duration, bool key) override {
    if (_closed) {
      throw domError("InvalidStateError", "the decoder is closed");
    }
    // AVCC (length-prefixed) → Annex B, copied before leaving the JS thread.
    std::vector<uint8_t> annexB;
    const uint8_t* bytes = data->data();
    size_t size = data->size();
    annexB.reserve(size + 16);
    size_t i = 0;
    int n = _sets.nalLengthSize;
    while (i + n <= size) {
      size_t length = 0;
      for (int k = 0; k < n; k++) {
        length = (length << 8) | bytes[i + k];
      }
      i += n;
      if (length == 0 || i + length > size) {
        break;
      }
      annexB.insert(annexB.end(), {0, 0, 0, 1});
      annexB.insert(annexB.end(), bytes + i, bytes + i + length);
      i += length;
    }
    int64_t ts = static_cast<int64_t>(timestamp);
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _durations[ts] = duration;
    }
    _input.post([this, annexB = std::move(annexB), ts, key] {
      queueInput(annexB.data(), annexB.size(), ts, key ? kBufferFlagKeyFrame : 0);
    });
  }

  std::shared_ptr<Promise<void>> flush() override {
    auto promise = Promise<void>::create();
    if (_closed) {
      promise->reject(std::make_exception_ptr(domError("InvalidStateError", "the decoder is closed")));
      return promise;
    }
    _input.post([this, promise] {
      if (!_failed) {
        queueInput(nullptr, 0, 0, kBufferFlagEndOfStream);
      }
      // Every rendered picture is taken before the next one (waitAcquired),
      // so all of them come; a second without any is a lost one.
      // Stuck once nothing came for 10 s (from the flush or the last picture).
      std::unique_lock<std::mutex> lock(_mutex);
      auto flushStart = std::chrono::steady_clock::now();
      bool ended = false;
      while (!_failed) {
        auto now = std::chrono::steady_clock::now();
        if (_eos && (_delivered >= _rendered || now - _lastImage > std::chrono::seconds(1))) {
          ended = true;
          break;
        }
        if (now - std::max(flushStart, _lastImage) > std::chrono::seconds(10)) {
          break;
        }
        _cv.wait_for(lock, std::chrono::milliseconds(20));
      }
      lock.unlock();
      if (!ended && !_failed) {
        fail(errorMessage("EncodingError", "decoder-failed", "timed out waiting for the decoder to flush"));
      }
      if (_failed) {
        promise->reject(std::make_exception_ptr(std::runtime_error(_failure)));
        return;
      }
      {
        // Stops the drain thread if the stream did not end in time.
        std::lock_guard<std::mutex> l(_mutex);
        _draining = false;
      }
      if (_drain.joinable()) {
        _drain.join();
      }
      // Ready for more input (from a key frame).
      AMediaCodec_flush(_codec);
      {
        std::lock_guard<std::mutex> l(_mutex);
        _eos = false;
        _rendered = 0;
        _delivered = 0;
        _acquired = 0;
        _durations.clear();
      }
      startDrain();
      promise->resolve();
    });
    return promise;
  }

  void close() override {
    shutdown();
  }

private:
  void startDrain() {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _draining = true;
    }
    _drain = std::thread([this] { drainLoop(); });
  }

  void queueInput(const uint8_t* data, size_t size, int64_t ts, uint32_t flags) {
    if (_failed) {
      return;
    }
    ssize_t index = -1;
    for (int tries = 0; tries < 500 && !_failed; tries++) {
      index = AMediaCodec_dequeueInputBuffer(_codec, 10000);
      if (index >= 0 || index != AMEDIACODEC_INFO_TRY_AGAIN_LATER) {
        break;
      }
    }
    if (index < 0 || index == kErrorInsufficientResource || index == kErrorReclaimed) {
      fail(index == AMEDIACODEC_INFO_TRY_AGAIN_LATER
               ? errorMessage("EncodingError", "decoder-failed", "no input buffer")
               : describeCodecStatus(static_cast<media_status_t>(index), "decoder", "decoder"));
      return;
    }
    size_t capacity = 0;
    uint8_t* buffer = AMediaCodec_getInputBuffer(_codec, index, &capacity);
    if (!buffer || size > capacity) {
      fail(errorMessage("EncodingError", "decoder-failed", "chunk larger than the input buffer"));
      return;
    }
    if (size > 0) {
      memcpy(buffer, data, size);
    }
    media_status_t status = AMediaCodec_queueInputBuffer(_codec, index, 0, size, ts, flags);
    if (status != AMEDIA_OK) {
      fail(describeCodecStatus(status, "decoder", "decoder"));
    }
  }

  bool draining() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _draining;
  }

  void drainLoop() {
    pthread_setname_np(pthread_self(), "wc-vdec-drain");
    while (draining()) {
      AMediaCodecBufferInfo info{};
      ssize_t index = AMediaCodec_dequeueOutputBuffer(_codec, &info, 10000);
      if (index == AMEDIACODEC_INFO_TRY_AGAIN_LATER || index == AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED ||
          index == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
        continue;
      }
      if (isCodecError(index)) {
        fail(describeCodecStatus(static_cast<media_status_t>(index), "decoder", "decoder"));
        return;
      }
      bool eos = (info.flags & kBufferFlagEndOfStream) != 0;
      if (info.size > 0 || !eos) {
        {
          std::lock_guard<std::mutex> lock(_mutex);
          _rendered++;
          _lastImage = std::chrono::steady_clock::now();
        }
        // Rendered without a time: the image's timestamp is the chunk's (ns).
        AMediaCodec_releaseOutputBuffer(_codec, index, true);
        // One picture at a time: the ImageReader replaces a picture nobody
        // took yet, so wait until this one is taken (or the reader is full
        // of frames JS still holds, until it lets go of one).
        waitAcquired();
      } else {
        AMediaCodec_releaseOutputBuffer(_codec, index, false);
      }
      if (eos) {
        {
          std::lock_guard<std::mutex> lock(_mutex);
          _eos = true;
        }
        _cv.notify_all();
        return;
      }
    }
  }

  // On the ImageReader's thread.
  void onImage(AImageReader* /* reader */) {
    tryAcquire();
  }

  media_status_t tryAcquire() {
    std::lock_guard<std::mutex> acquiring(_acquireMutex);
    while (_reader) {
      AImage* image = nullptr;
      media_status_t status = AImageReader_acquireNextImage(_reader, &image);
      if (status != AMEDIA_OK || !image) {
        return status;
      }
      {
        std::lock_guard<std::mutex> lock(_mutex);
        _acquired++;
      }
      _cv.notify_all();
      _deliver.post([this, image] { deliver(image); });
    }
    return AMEDIA_OK;
  }

  // On the drain thread.
  void waitAcquired() {
    auto start = std::chrono::steady_clock::now();
    while (draining() && !_failed) {
      if (tryAcquire() == AMEDIA_IMGREADER_MAX_IMAGES_ACQUIRED) {
        // JS holds every picture: wait for it to close one, as a web
        // decoder stalls until frames are closed.
        start = std::chrono::steady_clock::now();
      }
      {
        std::unique_lock<std::mutex> lock(_mutex);
        if (_acquired >= _rendered) {
          return;
        }
        _cv.wait_for(lock, std::chrono::milliseconds(2));
      }
      if (std::chrono::steady_clock::now() - start > std::chrono::seconds(5)) {
        // Not coming (dropped by the surface): do not wait for it again.
        WC_ERR("video decoder: a picture did not reach the ImageReader; continuing without it");
        std::lock_guard<std::mutex> lock(_mutex);
        _acquired = _rendered;
        return;
      }
    }
  }

  // On the delivery thread.
  void deliver(AImage* image) {
    if (_closed || _failed) {
      AImage_delete(image);
      countDelivered();
      return;
    }
    AHardwareBuffer* source = nullptr;
    int64_t timestampNs = 0;
    if (AImage_getHardwareBuffer(image, &source) != AMEDIA_OK || !source) {
      AImage_delete(image);
      fail(errorMessage("EncodingError", "decoder-failed", "the picture has no AHardwareBuffer"));
      countDelivered();
      return;
    }
    AImage_getTimestamp(image, &timestampNs);
    // The picture's size: the buffer can be larger (c2.android's decoders
    // pad the width to 128), the image is its crop.
    int32_t visibleWidth = 0;
    int32_t visibleHeight = 0;
    AImage_getWidth(image, &visibleWidth);
    AImage_getHeight(image, &visibleHeight);
    int64_t pts = (timestampNs + 500) / 1000;
    double duration = takeDuration(pts);
    // The image goes back to the reader (kept alive meanwhile) when the last
    // reference dies.
    auto owner = _readerOwner;
    auto ref = std::make_shared<HardwareBufferRef>(source, [owner, image](AHardwareBuffer*) { AImage_delete(image); });
    auto surface = std::make_shared<HybridNativeSurface>(ref, -1, static_cast<uint32_t>(std::max(visibleWidth, 0)),
                                                         static_cast<uint32_t>(std::max(visibleHeight, 0)));
    _output(NativeDecodedFrame(surface, static_cast<double>(pts), duration));
    countDelivered();
  }

  double takeDuration(int64_t ts) {
    std::lock_guard<std::mutex> lock(_mutex);
    auto it = _durations.find(ts);
    if (it == _durations.end()) {
      return 0;
    }
    double duration = it->second;
    _durations.erase(_durations.begin(), std::next(it));
    return duration;
  }

  void countDelivered() {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _delivered++;
      _lastImage = std::chrono::steady_clock::now();
    }
    _cv.notify_all();
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

  void shutdown() {
    if (_shutdown.exchange(true)) {
      return;
    }
    _closed = true;
    _failed = true;
    _cv.notify_all();
    // Let pending input tasks see `_failed` and finish.
    auto inputDone = std::make_shared<std::promise<void>>();
    auto inputFuture = inputDone->get_future();
    _input.post([inputDone] { inputDone->set_value(); });
    inputFuture.wait();
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _draining = false;
    }
    if (_drain.joinable()) {
      _drain.join();
    }
    if (_codec) {
      AMediaCodec_stop(_codec);
      AMediaCodec_delete(_codec);
      _codec = nullptr;
    }
    if (_reader) {
      AImageReader_setImageListener(_reader, nullptr);
    }
    // Pictures already queued for delivery go back first.
    auto deliverDone = std::make_shared<std::promise<void>>();
    auto deliverFuture = deliverDone->get_future();
    _deliver.post([deliverDone] { deliverDone->set_value(); });
    deliverFuture.wait();
    {
      std::lock_guard<std::mutex> acquiring(_acquireMutex);
      _reader = nullptr;
    }
    // The reader goes when the last frame JS holds does.
    _readerOwner.reset();
  }

  std::function<void(const NativeDecodedFrame&)> _output;
  std::function<void(const std::string&)> _error;
  AvcParameterSets _sets;
  AMediaCodec* _codec = nullptr;
  AImageReader* _reader = nullptr;
  std::shared_ptr<ReaderOwner> _readerOwner;

  std::mutex _mutex;
  std::condition_variable _cv;
  std::map<int64_t, double> _durations;
  int64_t _rendered = 0;
  int64_t _delivered = 0;
  int64_t _acquired = 0;
  std::mutex _acquireMutex;
  std::chrono::steady_clock::time_point _lastImage = std::chrono::steady_clock::now();
  bool _eos = false;
  bool _draining = false;
  std::string _failure;
  std::atomic<bool> _failed{false};
  std::atomic<bool> _closed{false};
  std::atomic<bool> _reported{false};
  std::atomic<bool> _shutdown{false};
  std::thread _drain;

  SerialQueue _input{"wc-vdec-input"};
  SerialQueue _deliver{"wc-vdec-out"};
};

} // namespace margelo::nitro::webcodecs

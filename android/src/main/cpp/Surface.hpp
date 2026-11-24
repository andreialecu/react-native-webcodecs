#pragma once

#include <android/hardware_buffer.h>
#include <fcntl.h>
#include <unistd.h>

#include "Common.hpp"
#include "HybridNativeSurfacePoolSpec.hpp"
#include "HybridNativeSurfaceSpec.hpp"

namespace margelo::nitro::webcodecs {

// One reference to an AHardwareBuffer. A pool's buffers go back to the pool
// when the last reference to them dies.
struct HardwareBufferRef {
  AHardwareBuffer* buffer;
  std::function<void(AHardwareBuffer*)> recycle;

  HardwareBufferRef(AHardwareBuffer* buffer, std::function<void(AHardwareBuffer*)> recycle)
      : buffer(buffer), recycle(std::move(recycle)) {}
  HardwareBufferRef(const HardwareBufferRef&) = delete;
  HardwareBufferRef& operator=(const HardwareBufferRef&) = delete;
  ~HardwareBufferRef() {
    if (recycle) {
      recycle(buffer);
    } else {
      AHardwareBuffer_release(buffer);
    }
  }
};

inline std::string formatName(uint32_t format) {
  switch (format) {
    case AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM:
    case AHARDWAREBUFFER_FORMAT_R8G8B8X8_UNORM:
      return "RGBA";
    case AHARDWAREBUFFER_FORMAT_Y8Cb8Cr8_420:
      return "NV12";
    case AHARDWAREBUFFER_FORMAT_R16G16B16A16_FLOAT:
      return "RGBA16F";
    default:
      return "unknown";
  }
}

class HybridNativeSurface : public HybridNativeSurfaceSpec {
public:
  // `visibleWidth` x `visibleHeight`: the picture in the buffer's top left
  // when the buffer is larger (a decoder's crop; 0: all of it).
  // `formatFallback`: the format to report when the buffer's has no name
  // here (a decoder's YV12 or vendor-private 4:2:0 layout is its "NV12").
  explicit HybridNativeSurface(std::shared_ptr<HardwareBufferRef> ref, int fence = -1, uint32_t visibleWidth = 0,
                               uint32_t visibleHeight = 0, std::string formatFallback = "")
      : HybridObject(TAG), _ref(std::move(ref)), _formatFallback(std::move(formatFallback)), _fence(fence) {
    AHardwareBuffer_describe(_ref->buffer, &_desc);
    _visibleWidth = visibleWidth > 0 && visibleWidth < _desc.width ? visibleWidth : _desc.width;
    _visibleHeight = visibleHeight > 0 && visibleHeight < _desc.height ? visibleHeight : _desc.height;
  }

  ~HybridNativeSurface() override {
    closeFence();
  }

  uint64_t getHandle() override {
    return reinterpret_cast<uint64_t>(buffer());
  }
  // On Android both name the AHardwareBuffer (react-native-webgpu's
  // createNativeBufferFromPointer takes one).
  uint64_t getPixelBuffer() override {
    return getHandle();
  }
  // The picture's size: the buffer may be larger (padding past the crop).
  double getWidth() override {
    return _visibleWidth;
  }
  double getHeight() override {
    return _visibleHeight;
  }
  std::string getFormat() override {
    std::string name = formatName(_desc.format);
    return name == "unknown" && !_formatFallback.empty() ? _formatFallback : name;
  }

  // `handle` is a sync_fd the surface now owns (react-native-webgpu's
  // GPUSharedFence.export() hands out a duplicate).
  void setFence(uint64_t handle, uint64_t /* value */) override {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_fence >= 0) {
      ::close(_fence);
    }
    _fence = static_cast<int>(static_cast<int32_t>(handle));
  }

  std::shared_ptr<HybridNativeSurfaceSpec> clone() override {
    return std::make_shared<HybridNativeSurface>(ref(), dupFence(), _visibleWidth, _visibleHeight, _formatFallback);
  }

  void release() override {
    std::lock_guard<std::mutex> lock(_mutex);
    _ref.reset();
    if (_fence >= 0) {
      ::close(_fence);
      _fence = -1;
    }
  }

  size_t getExternalMemorySize() noexcept override {
    return static_cast<size_t>(_desc.width) * _desc.height * 4;
  }

  std::shared_ptr<HardwareBufferRef> ref() {
    std::lock_guard<std::mutex> lock(_mutex);
    if (!_ref) {
      throw domError("InvalidStateError", "the surface was released");
    }
    return _ref;
  }

  AHardwareBuffer* buffer() {
    return ref()->buffer;
  }

  uint32_t visibleWidth() const {
    return _visibleWidth;
  }
  uint32_t visibleHeight() const {
    return _visibleHeight;
  }

  // A copy of the fence for a consumer to wait on and close (-1: none).
  int dupFence() {
    std::lock_guard<std::mutex> lock(_mutex);
    return _fence >= 0 ? ::fcntl(_fence, F_DUPFD_CLOEXEC, 0) : -1;
  }

private:
  void closeFence() {
    if (_fence >= 0) {
      ::close(_fence);
      _fence = -1;
    }
  }

  std::mutex _mutex;
  std::shared_ptr<HardwareBufferRef> _ref;
  AHardwareBuffer_Desc _desc{};
  uint32_t _visibleWidth = 0;
  uint32_t _visibleHeight = 0;
  std::string _formatFallback;
  int _fence;
};

// Recycles same-sized GPU buffers: frames go back to the pool once every
// reference (JS VideoFrame, encoder) is gone.
class SurfacePoolState : public std::enable_shared_from_this<SurfacePoolState> {
public:
  SurfacePoolState(uint32_t width, uint32_t height, uint32_t format, uint64_t usage) {
    _desc.width = width;
    _desc.height = height;
    _desc.layers = 1;
    _desc.format = format;
    _desc.usage = usage;
  }

  ~SurfacePoolState() {
    for (auto* buffer : _free) {
      AHardwareBuffer_release(buffer);
    }
  }

  std::shared_ptr<HardwareBufferRef> acquire() {
    AHardwareBuffer* buffer = nullptr;
    {
      std::lock_guard<std::mutex> lock(_mutex);
      if (!_free.empty()) {
        buffer = _free.back();
        _free.pop_back();
      }
    }
    if (!buffer) {
      if (AHardwareBuffer_allocate(&_desc, &buffer) != 0 || !buffer) {
        throw domError("EncodingError", "AHardwareBuffer_allocate failed");
      }
    }
    std::weak_ptr<SurfacePoolState> weak = shared_from_this();
    return std::make_shared<HardwareBufferRef>(buffer, [weak](AHardwareBuffer* b) {
      if (auto pool = weak.lock()) {
        pool->give(b);
      } else {
        AHardwareBuffer_release(b);
      }
    });
  }

  uint32_t width() const {
    return _desc.width;
  }
  uint32_t height() const {
    return _desc.height;
  }

private:
  void give(AHardwareBuffer* buffer) {
    std::lock_guard<std::mutex> lock(_mutex);
    if (_free.size() < 8) {
      _free.push_back(buffer);
    } else {
      AHardwareBuffer_release(buffer);
    }
  }

  std::mutex _mutex;
  AHardwareBuffer_Desc _desc{};
  std::vector<AHardwareBuffer*> _free;
};

inline constexpr uint64_t kSurfaceUsage = AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE | AHARDWAREBUFFER_USAGE_GPU_COLOR_OUTPUT;

class HybridNativeSurfacePool : public HybridNativeSurfacePoolSpec {
public:
  // RGBA 8-bit, or half floats (AHARDWAREBUFFER_FORMAT_R16G16B16A16_FLOAT)
  // for HDR, which react-native-webgpu imports as rgba16float and the HDR
  // encoder reads on the CPU (it converts them to P010).
  HybridNativeSurfacePool(uint32_t width, uint32_t height, uint32_t format = AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM)
      : HybridObject(TAG),
        _state(std::make_shared<SurfacePoolState>(
            width, height, format,
            format == AHARDWAREBUFFER_FORMAT_R16G16B16A16_FLOAT ? kSurfaceUsage | AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN
                                                                 : kSurfaceUsage)) {}

  double getWidth() override {
    return _state->width();
  }
  double getHeight() override {
    return _state->height();
  }
  std::shared_ptr<HybridNativeSurfaceSpec> acquire() override {
    return std::make_shared<HybridNativeSurface>(_state->acquire());
  }

private:
  std::shared_ptr<SurfacePoolState> _state;
};

} // namespace margelo::nitro::webcodecs

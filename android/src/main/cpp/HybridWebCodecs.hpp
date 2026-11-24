#pragma once

#include "Audio.hpp"
#include "Files.hpp"
#include "HybridWebCodecsSpec.hpp"
#include "Surface.hpp"
#include "VideoDecoder.hpp"
#include "VideoEncoder.hpp"

namespace margelo::nitro::webcodecs {

class HybridWebCodecs : public HybridWebCodecsSpec {
public:
  HybridWebCodecs() : HybridObject(TAG) {}

  // `handle`: an AHardwareBuffer* (e.g. a camera frame's), referenced here.
  std::shared_ptr<HybridNativeSurfaceSpec> wrapSurface(uint64_t handle) override {
    auto* buffer = reinterpret_cast<AHardwareBuffer*>(handle);
    if (!buffer) {
      throw domError("TypeError", "the handle is null");
    }
    AHardwareBuffer_acquire(buffer);
    return std::make_shared<HybridNativeSurface>(std::make_shared<HardwareBufferRef>(buffer, nullptr));
  }

  std::shared_ptr<HybridNativeSurfacePoolSpec> createSurfacePool(double width, double height, const std::string& format) override {
    if (format != "BGRA" && format != "RGBA" && format != "RGBA16F") {
      throw domError("NotSupportedError", "surface format " + format);
    }
    if (width <= 0 || height <= 0) {
      throw domError("TypeError", "invalid size");
    }
    return std::make_shared<HybridNativeSurfacePool>(
        static_cast<uint32_t>(width), static_cast<uint32_t>(height),
        format == "RGBA16F" ? AHARDWAREBUFFER_FORMAT_R16G16B16A16_FLOAT : AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM);
  }

  bool isVideoEncoderConfigSupported(const NativeVideoEncoderConfig& config) override {
    if (config.width <= 0 || config.height <= 0 || !videoEncodingAvailable()) {
      return false;
    }
    // MediaCodecList: an encoder that takes this size, frame rate, bitrate
    // and profile, from a surface (8-bit) or P010 buffers (Main 10, which
    // HDR export uses), as the encoder will be created.
    if (config.codec == "avc" || config.codec == "av1") {
      bool tenBit = config.profile.value_or("") == "main10";
      return findVideoEncoder(config, tenBit).has_value();
    }
    return false;
  }

  std::shared_ptr<HybridNativeVideoEncoderSpec> createVideoEncoder(const NativeVideoEncoderConfig& config,
                                                                   const std::function<void(const NativeEncodedChunk&)>& output,
                                                                   const std::function<void(const std::string&)>& error) override {
    return std::make_shared<HybridNativeVideoEncoder>(config, output, error);
  }

  bool isVideoDecoderConfigSupported(const NativeVideoDecoderConfig& config) override {
    // Android outputs the decoder's own YUV buffers (NV12).
    return config.codec == "avc" && config.description.has_value() &&
           (!config.pixelFormat.has_value() || config.pixelFormat.value() == "NV12");
  }

  std::shared_ptr<HybridNativeVideoDecoderSpec> createVideoDecoder(const NativeVideoDecoderConfig& config,
                                                                   const std::function<void(const NativeDecodedFrame&)>& output,
                                                                   const std::function<void(const std::string&)>& error) override {
    return std::make_shared<HybridNativeVideoDecoder>(config, output, error);
  }

  bool isAudioEncoderConfigSupported(const NativeAudioEncoderConfig& config) override {
    return config.codec == "aac" && config.sampleRate > 0 && config.numberOfChannels > 0 && config.numberOfChannels <= 2;
  }

  std::shared_ptr<HybridNativeAudioEncoderSpec> createAudioEncoder(const NativeAudioEncoderConfig& config,
                                                                   const std::function<void(const NativeEncodedChunk&)>& output,
                                                                   const std::function<void(const std::string&)>& error) override {
    return std::make_shared<HybridNativeAudioEncoder>(config, output, error);
  }

  bool isAudioDecoderConfigSupported(const NativeAudioDecoderConfig& config) override {
    return config.codec == "aac" || config.codec == "mp3";
  }

  std::shared_ptr<HybridNativeAudioDecoderSpec> createAudioDecoder(const NativeAudioDecoderConfig& config,
                                                                   const std::function<void(const NativeDecodedAudio&)>& output,
                                                                   const std::function<void(const std::string&)>& error) override {
    return std::make_shared<HybridNativeAudioDecoder>(config, output, error);
  }

  std::string resolvePath(const std::string& path) override {
    return resolveFilePath(path);
  }

  std::shared_ptr<HybridNativeFileSpec> openFile(const std::string& path, bool write) override {
    return std::make_shared<HybridNativeFile>(resolveFilePath(path), write);
  }

  // Android keeps running a backgrounded app's JS: nothing to hold.
  double beginBackgroundTask(const std::string& /* name */) override {
    return 0;
  }
  void endBackgroundTask(double /* id */) override {}

  bool removeFile(const std::string& path) override {
    return ::unlink(resolveFilePath(path).c_str()) == 0;
  }

  std::string writeFile(const std::string& path, const std::shared_ptr<ArrayBuffer>& data) override {
    std::string resolved = resolveFilePath(path);
    int fd = ::open(resolved.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd < 0) {
      throw domError("NotFoundError", "cannot write " + resolved + " (" + std::to_string(errno) + ")");
    }
    size_t done = 0;
    while (done < data->size()) {
      ssize_t n = ::write(fd, data->data() + done, data->size() - done);
      if (n < 0 && errno == EINTR) {
        continue;
      }
      if (n <= 0) {
        ::close(fd);
        throw domError("EncodingError", "write failed (" + std::to_string(errno) + ")");
      }
      done += static_cast<size_t>(n);
    }
    ::close(fd);
    return resolved;
  }
};

} // namespace margelo::nitro::webcodecs

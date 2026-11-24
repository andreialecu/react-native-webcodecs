#pragma once

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <fstream>

#include "Common.hpp"
#include "HybridNativeFileSpec.hpp"

namespace margelo::nitro::webcodecs {

// The app's cache directory, from its package name.
inline std::string cacheDirectory() {
  static std::string directory = [] {
    std::ifstream cmdline("/proc/self/cmdline");
    std::string name;
    std::getline(cmdline, name, '\0');
    auto colon = name.find(':');  // a ":process" suffix
    if (colon != std::string::npos) {
      name = name.substr(0, colon);
    }
    return "/data/data/" + name + "/cache";
  }();
  return directory;
}

// Relative paths are in the cache directory; "file://" URLs are paths.
inline std::string resolveFilePath(const std::string& path) {
  std::string p = path;
  if (p.rfind("file://", 0) == 0) {
    p = p.substr(7);
  }
  if (!p.empty() && p[0] == '/') {
    return p;
  }
  return cacheDirectory() + "/" + p;
}

class HybridNativeFile : public HybridNativeFileSpec {
public:
  HybridNativeFile(std::string path, bool write) : HybridObject(TAG), _path(std::move(path)) {
    _fd = ::open(_path.c_str(), write ? (O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC) : (O_RDONLY | O_CLOEXEC), 0644);
    if (_fd < 0) {
      if (errno == ENOENT) {
        throw domError("NotFoundError", "no file at " + _path);
      }
      throw domError("NotReadableError", "cannot open " + _path + " (" + std::to_string(errno) + ")");
    }
  }

  ~HybridNativeFile() override {
    if (_fd >= 0) {
      ::close(_fd);
    }
  }

  std::string getPath() override {
    return _path;
  }

  double getSize() override {
    struct stat st {};
    if (_fd < 0 || fstat(_fd, &st) != 0) {
      return 0;
    }
    return static_cast<double>(st.st_size);
  }

  std::shared_ptr<Promise<void>> write(double position, const std::shared_ptr<ArrayBuffer>& data) override {
    auto promise = Promise<void>::create();
    auto bytes = std::make_shared<std::vector<uint8_t>>(data->data(), data->data() + data->size());
    off_t offset = static_cast<off_t>(position);
    _queue.post([this, promise, bytes, offset] {
      size_t done = 0;
      while (done < bytes->size()) {
        ssize_t n = ::pwrite(_fd, bytes->data() + done, bytes->size() - done, offset + static_cast<off_t>(done));
        if (n < 0) {
          if (errno == EINTR) {
            continue;
          }
          promise->reject(std::make_exception_ptr(domError("EncodingError", "write failed (" + std::to_string(errno) + ")")));
          return;
        }
        done += static_cast<size_t>(n);
      }
      promise->resolve();
    });
    return promise;
  }

  std::shared_ptr<Promise<std::shared_ptr<ArrayBuffer>>> read(double start, double end) override {
    auto promise = Promise<std::shared_ptr<ArrayBuffer>>::create();
    off_t from = static_cast<off_t>(start);
    size_t length = end > start ? static_cast<size_t>(end - start) : 0;
    _queue.post([this, promise, from, length] {
      auto buffer = ArrayBuffer::allocate(length);
      size_t done = 0;
      while (done < length) {
        ssize_t n = ::pread(_fd, buffer->data() + done, length - done, from + static_cast<off_t>(done));
        if (n < 0 && errno == EINTR) {
          continue;
        }
        if (n < 0) {
          promise->reject(std::make_exception_ptr(domError("NotReadableError", "read failed (" + std::to_string(errno) + ")")));
          return;
        }
        if (n == 0) {
          break;
        }
        done += static_cast<size_t>(n);
      }
      promise->resolve(done == length ? buffer : ArrayBuffer::copy(buffer->data(), done));
    });
    return promise;
  }

  std::shared_ptr<Promise<void>> close() override {
    auto promise = Promise<void>::create();
    _queue.post([this, promise] {
      if (_fd >= 0) {
        ::fsync(_fd);
        ::close(_fd);
        _fd = -1;
      }
      promise->resolve();
    });
    return promise;
  }

private:
  std::string _path;
  int _fd = -1;
  SerialQueue _queue{"wc-file"};
};

} // namespace margelo::nitro::webcodecs

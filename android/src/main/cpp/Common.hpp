#pragma once

#include <android/log.h>
#include <dlfcn.h>
#include <media/NdkMediaCodec.h>

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#define WC_LOG(...) __android_log_print(ANDROID_LOG_INFO, "WebCodecs", __VA_ARGS__)
#define WC_ERR(...) __android_log_print(ANDROID_LOG_ERROR, "WebCodecs", __VA_ARGS__)

namespace margelo::nitro::webcodecs {

// Errors cross to JS as "Name: message" (or "Name: code: message"), which
// the JS side turns into the matching DOMException.
inline std::runtime_error domError(const std::string& name, const std::string& message) {
  return std::runtime_error(name + ": " + message);
}

inline std::string errorMessage(const std::string& name, const std::string& code, const std::string& message) {
  return name + ": " + code + ": " + message;
}

// A codec's name, when the platform tells it: AMediaCodec_getName is
// API 28, above this library's minimum (26).
inline std::optional<std::string> codecName(AMediaCodec* codec) {
  using GetName = media_status_t (*)(AMediaCodec*, char**);
  using ReleaseName = void (*)(AMediaCodec*, char*);
  static auto getName = reinterpret_cast<GetName>(dlsym(RTLD_DEFAULT, "AMediaCodec_getName"));
  static auto releaseName = reinterpret_cast<ReleaseName>(dlsym(RTLD_DEFAULT, "AMediaCodec_releaseName"));
  char* name = nullptr;
  if (!codec || !getName || !releaseName || getName(codec, &name) != AMEDIA_OK || !name) {
    return std::nullopt;
  }
  std::string result(name);
  releaseName(codec, name);
  return result;
}

// One worker thread running tasks in order. Declare it as the last member of
// its owner: it is then destroyed first, after running what is left.
class SerialQueue {
public:
  explicit SerialQueue(std::string name) : _name(std::move(name)) {
    _thread = std::thread([this] { loop(); });
  }

  ~SerialQueue() {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _stopped = true;
    }
    _cv.notify_all();
    if (_thread.joinable()) {
      if (_thread.get_id() == std::this_thread::get_id()) {
        _thread.detach();
      } else {
        _thread.join();
      }
    }
  }

  void post(std::function<void()> task) {
    {
      std::lock_guard<std::mutex> lock(_mutex);
      _tasks.push_back(std::move(task));
    }
    _cv.notify_one();
  }

private:
  void loop() {
    pthread_setname_np(pthread_self(), _name.substr(0, 15).c_str());
    while (true) {
      std::function<void()> task;
      {
        std::unique_lock<std::mutex> lock(_mutex);
        _cv.wait(lock, [this] { return _stopped || !_tasks.empty(); });
        if (_tasks.empty()) {
          return;
        }
        task = std::move(_tasks.front());
        _tasks.pop_front();
      }
      try {
        task();
      } catch (const std::exception& e) {
        WC_ERR("%s: task threw %s", _name.c_str(), e.what());
      }
    }
  }

  std::string _name;
  std::mutex _mutex;
  std::condition_variable _cv;
  std::deque<std::function<void()>> _tasks;
  bool _stopped = false;
  std::thread _thread;
};

// --- H.264 bitstream helpers ---

// The NAL units of an Annex B stream (without start codes).
inline std::vector<std::pair<const uint8_t*, size_t>> annexBUnits(const uint8_t* data, size_t size) {
  std::vector<std::pair<const uint8_t*, size_t>> units;
  size_t i = 0;
  auto startCode = [&](size_t at, size_t& length) {
    if (at + 3 <= size && data[at] == 0 && data[at + 1] == 0 && data[at + 2] == 1) {
      length = 3;
      return true;
    }
    if (at + 4 <= size && data[at] == 0 && data[at + 1] == 0 && data[at + 2] == 0 && data[at + 3] == 1) {
      length = 4;
      return true;
    }
    return false;
  };
  size_t length = 0;
  while (i < size && !startCode(i, length)) {
    i++;
  }
  while (i < size) {
    i += length;
    size_t begin = i;
    while (i < size && !startCode(i, length)) {
      i++;
    }
    size_t end = i;
    // Trailing zero bytes belong to the next start code.
    while (end > begin && data[end - 1] == 0 && i < size) {
      end--;
    }
    if (end > begin) {
      units.emplace_back(data + begin, end - begin);
    }
  }
  return units;
}

// AVCDecoderConfigurationRecord from one SPS and one PPS.
inline std::vector<uint8_t> makeAvcC(const std::vector<uint8_t>& sps, const std::vector<uint8_t>& pps) {
  std::vector<uint8_t> out;
  if (sps.size() < 4 || pps.empty()) {
    return out;
  }
  out = {1, sps[1], sps[2], sps[3], 0xFF, 0xE1};
  out.push_back(static_cast<uint8_t>(sps.size() >> 8));
  out.push_back(static_cast<uint8_t>(sps.size()));
  out.insert(out.end(), sps.begin(), sps.end());
  out.push_back(1);
  out.push_back(static_cast<uint8_t>(pps.size() >> 8));
  out.push_back(static_cast<uint8_t>(pps.size()));
  out.insert(out.end(), pps.begin(), pps.end());
  uint8_t profile = sps[1];
  if (profile == 100 || profile == 110 || profile == 122 || profile == 144) {
    // 4:2:0, 8 bits, no SPS extensions: what the encoders here produce.
    out.insert(out.end(), {0xFD, 0xF8, 0xF8, 0x00});
  }
  return out;
}

struct AvcParameterSets {
  std::vector<std::vector<uint8_t>> sps;
  std::vector<std::vector<uint8_t>> pps;
  int nalLengthSize = 4;
};

inline bool parseAvcC(const uint8_t* b, size_t size, AvcParameterSets& out) {
  if (size < 7 || b[0] != 1) {
    return false;
  }
  out.nalLengthSize = (b[4] & 0x3) + 1;
  size_t i = 5;
  for (int group = 0; group < 2; group++) {
    if (i >= size) {
      return false;
    }
    int count = group == 0 ? (b[i] & 0x1f) : b[i];
    i++;
    for (int n = 0; n < count; n++) {
      if (i + 2 > size) {
        return false;
      }
      size_t length = (static_cast<size_t>(b[i]) << 8) | b[i + 1];
      i += 2;
      if (i + length > size) {
        return false;
      }
      (group == 0 ? out.sps : out.pps).emplace_back(b + i, b + i + length);
      i += length;
    }
  }
  return !out.sps.empty() && !out.pps.empty();
}

} // namespace margelo::nitro::webcodecs

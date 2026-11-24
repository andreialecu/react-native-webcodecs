#pragma once

// The video encoder's frames between the draw and the output, with no NDK in
// them, so that a host test (android/src/test/cpp, `yarn test:cpp`) can check
// them.
//
// MediaCodec's input surface drops a frame whose timestamp does not move
// forward, and some encoders output the second-to-last frame with a pts of 0
// (b/235045165). So the codec gets a timestamp nudged 1 us past the last one
// when it does not increase, and each output gets back the real timestamp
// and duration of its frame: the codec outputs frames in input order (no
// B-frames), so the frame is the oldest one waiting, or a later one when the
// codec dropped some.
//
// Not done (issue #1 leaves this open): Chromium and WebRTC also respace the
// timestamps evenly before the codec, because some rate control (WebRTC's
// frame-rate bitrate adjuster for Exynos) assumes a fixed frame rate. Here
// the codec still gets the real timestamps, nudged only when they do not
// increase, so uneven input can still throw such rate control off. The
// emulator's c2/goldfish encoders don't show it, so nothing here tests it.

#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>

namespace margelo::nitro::webcodecs {

struct PendingFrame {
  int64_t codecPts;  // what the codec was given (us)
  int64_t realTs;    // the frame's timestamp (us)
  double duration;
};

// Not thread-safe: the encoder's mutex guards it.
class TimestampQueue {
public:
  // Records a drawn frame; returns the pts to give the codec.
  int64_t push(int64_t realTs, double duration) {
    int64_t pts = realTs;
    if (_last.has_value() && pts <= *_last) {
      pts = *_last + 1;
    }
    _last = pts;
    _frames.push_back({pts, realTs, duration});
    return pts;
  }

  // The frame an output with this pts is: the one given that pts, the frames
  // before it dropped (counted in `skipped`); when none was (a pts of 0, or
  // garbage), the oldest one. None when no frame is waiting.
  std::optional<PendingFrame> take(int64_t outPts, size_t& skipped) {
    skipped = 0;
    if (_frames.empty()) {
      return std::nullopt;
    }
    for (size_t i = 0; i < _frames.size(); i++) {
      if (_frames[i].codecPts == outPts) {
        PendingFrame frame = _frames[i];
        _frames.erase(_frames.begin(), _frames.begin() + static_cast<std::ptrdiff_t>(i) + 1);
        skipped = i;
        return frame;
      }
    }
    PendingFrame frame = _frames.front();
    _frames.pop_front();
    return frame;
  }

  bool empty() const {
    return _frames.empty();
  }

  // A new codec: the timeline starts over.
  void clear() {
    _frames.clear();
    _last.reset();
  }

private:
  std::deque<PendingFrame> _frames;
  std::optional<int64_t> _last;
};

} // namespace margelo::nitro::webcodecs

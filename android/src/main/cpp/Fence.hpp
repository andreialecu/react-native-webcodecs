#pragma once

// Bounded CPU waits on a frame's GPU fence (a sync fd), with no NDK in them,
// so that a host test (android/src/test/cpp, `yarn test:cpp`) can check them
// with pipes standing in for fences.
//
// A fence that never signals (a hung GPU: MediaTek Mali drivers block in
// their sync wait for ever) must fail the frame, not block the GL thread,
// and with it flush(), close() and shutdown(), which queue behind it. Media3
// waits 500 ms; heavy WebGPU frames can take longer, so 5 s, well inside the
// encoder's 20 s stall timeout.

#include <poll.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <stdexcept>
#include <string>

namespace margelo::nitro::webcodecs {

constexpr int kFenceTimeoutMs = 5000;

enum class FenceWait { Signaled, TimedOut, Failed };

// Waits up to `timeoutMs` for `fd` to signal (readable). Does not close it.
// No fence (fd < 0) has nothing to wait for.
inline FenceWait waitSyncFd(int fd, int timeoutMs) {
  if (fd < 0) {
    return FenceWait::Signaled;
  }
  using Clock = std::chrono::steady_clock;
  const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
  for (;;) {
    auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
    pollfd p{fd, POLLIN, 0};
    int ready = ::poll(&p, 1, left > 0 ? static_cast<int>(left) : 0);
    if (ready < 0) {
      if (errno == EINTR) {
        // A signal: wait again, for what is left.
        continue;
      }
      return FenceWait::Failed;
    }
    if (ready == 0) {
      return FenceWait::TimedOut;
    }
    if (p.revents & (POLLERR | POLLNVAL)) {
      return FenceWait::Failed;
    }
    if (p.revents & POLLIN) {
      return FenceWait::Signaled;
    }
    // POLLHUP alone: nothing will ever signal it.
    return FenceWait::Failed;
  }
}

inline std::string describeFenceWait(FenceWait wait, int timeoutMs) {
  if (wait == FenceWait::TimedOut) {
    return "the frame's GPU fence did not signal within " + std::to_string(timeoutMs) + " ms";
  }
  return "waiting for the frame's GPU fence failed";
}

// Waits for a fence taken over (closed either way); throws when it does not
// signal within `timeoutMs`.
inline void awaitFence(int fd, int timeoutMs = kFenceTimeoutMs) {
  if (fd < 0) {
    return;
  }
  FenceWait wait = waitSyncFd(fd, timeoutMs);
  ::close(fd);
  if (wait != FenceWait::Signaled) {
    throw std::runtime_error(describeFenceWait(wait, timeoutMs));
  }
}

} // namespace margelo::nitro::webcodecs

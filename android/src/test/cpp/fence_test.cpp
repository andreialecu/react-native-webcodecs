// Host test of android/src/main/cpp/Fence.hpp: `yarn test:cpp`. A pipe's
// read end stands in for a sync fd: unsignalled while nothing is written to
// it, signalled once a byte is.

#include "Fence.hpp"

#include <fcntl.h>
#include <signal.h>
#include <sys/time.h>

#include <cstdio>
#include <cstdlib>
#include <thread>

using namespace margelo::nitro::webcodecs;

static int failures = 0;

#define CHECK(cond)                                                   \
  do {                                                                \
    if (!(cond)) {                                                    \
      std::fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                     \
    }                                                                 \
  } while (0)

using Clock = std::chrono::steady_clock;

static long long msSince(Clock::time_point start) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - start).count();
}

static bool isOpen(int fd) {
  return ::fcntl(fd, F_GETFD) != -1;
}

static void noFence() {
  CHECK(waitSyncFd(-1, 10) == FenceWait::Signaled);
  awaitFence(-1, 10);
}

static void signaled() {
  int ends[2];
  CHECK(::pipe(ends) == 0);
  CHECK(::write(ends[1], "x", 1) == 1);
  auto start = Clock::now();
  CHECK(waitSyncFd(ends[0], 1000) == FenceWait::Signaled);
  CHECK(msSince(start) < 100);
  // Not closed by the wait.
  CHECK(isOpen(ends[0]));
  ::close(ends[0]);
  ::close(ends[1]);
}

// Signalled while waiting: the wait ends then, not at the timeout.
static void signaledLater() {
  int ends[2];
  CHECK(::pipe(ends) == 0);
  std::thread writer([&] {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    CHECK(::write(ends[1], "x", 1) == 1);
  });
  auto start = Clock::now();
  CHECK(waitSyncFd(ends[0], 2000) == FenceWait::Signaled);
  long long ms = msSince(start);
  CHECK(ms >= 40 && ms < 1000);
  writer.join();
  ::close(ends[0]);
  ::close(ends[1]);
}

// Never signalled: the wait ends at the timeout.
static void timedOut() {
  int ends[2];
  CHECK(::pipe(ends) == 0);
  auto start = Clock::now();
  CHECK(waitSyncFd(ends[0], 100) == FenceWait::TimedOut);
  long long ms = msSince(start);
  CHECK(ms >= 95 && ms < 1000);
  ::close(ends[0]);
  ::close(ends[1]);
}

static void onAlarm(int) {}

// A signal in the middle (EINTR) neither ends the wait early nor makes it
// longer than its timeout.
static void interrupted() {
  struct sigaction action {};
  action.sa_handler = onAlarm;
  sigemptyset(&action.sa_mask);
  action.sa_flags = 0; // no SA_RESTART: poll() returns EINTR
  struct sigaction previous {};
  sigaction(SIGALRM, &action, &previous);
  itimerval timer{};
  timer.it_value.tv_usec = 20 * 1000;
  timer.it_interval.tv_usec = 20 * 1000;
  setitimer(ITIMER_REAL, &timer, nullptr);

  int ends[2];
  CHECK(::pipe(ends) == 0);
  auto start = Clock::now();
  CHECK(waitSyncFd(ends[0], 200) == FenceWait::TimedOut);
  long long ms = msSince(start);
  CHECK(ms >= 190 && ms < 1000);

  itimerval off{};
  setitimer(ITIMER_REAL, &off, nullptr);
  sigaction(SIGALRM, &previous, nullptr);
  ::close(ends[0]);
  ::close(ends[1]);
}

// Not a file descriptor (POLLNVAL): failed, at once.
static void invalid() {
  int ends[2];
  CHECK(::pipe(ends) == 0);
  ::close(ends[0]);
  ::close(ends[1]);
  auto start = Clock::now();
  CHECK(waitSyncFd(ends[0], 1000) == FenceWait::Failed);
  CHECK(msSince(start) < 100);
}

// awaitFence closes the fence either way, and throws unless it signalled.
static void await() {
  int ends[2];
  CHECK(::pipe(ends) == 0);
  CHECK(::write(ends[1], "x", 1) == 1);
  awaitFence(ends[0], 100);
  CHECK(!isOpen(ends[0]));
  ::close(ends[1]);

  CHECK(::pipe(ends) == 0);
  bool threw = false;
  try {
    awaitFence(ends[0], 50);
  } catch (const std::runtime_error& e) {
    threw = std::string(e.what()).find("did not signal within 50 ms") != std::string::npos;
  }
  CHECK(threw);
  CHECK(!isOpen(ends[0]));
  ::close(ends[1]);
}

int main() {
  noFence();
  signaled();
  signaledLater();
  timedOut();
  interrupted();
  invalid();
  await();
  if (failures > 0) {
    std::fprintf(stderr, "fence: %d check(s) failed\n", failures);
    return 1;
  }
  std::printf("fence: ok\n");
  return 0;
}

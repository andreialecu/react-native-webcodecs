// Host test of android/src/main/cpp/Timestamps.hpp: `yarn test:cpp`.

#include "Timestamps.hpp"

#include <cstdio>
#include <cstdlib>

using namespace margelo::nitro::webcodecs;

static int failures = 0;

#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                \
    }                                                            \
  } while (0)

static bool is(const std::optional<PendingFrame>& f, int64_t realTs, double duration) {
  return f.has_value() && f->realTs == realTs && f->duration == duration;
}

// Increasing timestamps go to the codec as they are, and come back with
// their durations.
static void inOrder() {
  TimestampQueue q;
  CHECK(q.push(0, 10) == 0);
  CHECK(q.push(33333, 11) == 33333);
  CHECK(q.push(66666, 12) == 66666);
  size_t skipped = 9;
  CHECK(is(q.take(0, skipped), 0, 10));
  CHECK(skipped == 0);
  CHECK(is(q.take(33333, skipped), 33333, 11));
  CHECK(is(q.take(66666, skipped), 66666, 12));
  CHECK(q.empty());
}

// A first frame at 0 is not moved: there is nothing before it.
static void firstAtZero() {
  TimestampQueue q;
  CHECK(q.push(0, 1) == 0);
  q.clear();
  CHECK(q.empty());
  // After clear() (a new codec) the timeline starts over.
  CHECK(q.push(0, 1) == 0);
}

// A repeated timestamp goes to the codec 1 us later; the chunk has the real
// one.
static void repeated() {
  TimestampQueue q;
  CHECK(q.push(0, 10) == 0);
  CHECK(q.push(0, 11) == 1);
  CHECK(q.push(33333, 12) == 33333);
  size_t skipped = 0;
  CHECK(is(q.take(0, skipped), 0, 10));
  CHECK(is(q.take(1, skipped), 0, 11));
  CHECK(is(q.take(33333, skipped), 33333, 12));
  CHECK(skipped == 0);
}

// A timestamp going backwards goes to the codec 1 us after the last one,
// and so does the next one if still not past it.
static void backwards() {
  TimestampQueue q;
  CHECK(q.push(0, 10) == 0);
  CHECK(q.push(33333, 11) == 33333);
  CHECK(q.push(20000, 12) == 33334);
  CHECK(q.push(33334, 13) == 33335);
  CHECK(q.push(66666, 14) == 66666);
  size_t skipped = 0;
  q.take(0, skipped);
  q.take(33333, skipped);
  CHECK(is(q.take(33334, skipped), 20000, 12));
  CHECK(is(q.take(33335, skipped), 33334, 13));
  CHECK(is(q.take(66666, skipped), 66666, 14));
}

// A frame the codec dropped is skipped (and counted); the later ones keep
// their own timestamps.
static void droppedMiddle() {
  TimestampQueue q;
  q.push(0, 10);
  q.push(33333, 11);
  q.push(66666, 12);
  q.push(99999, 13);
  size_t skipped = 0;
  CHECK(is(q.take(0, skipped), 0, 10));
  CHECK(skipped == 0);
  CHECK(is(q.take(66666, skipped), 66666, 12));
  CHECK(skipped == 1);
  CHECK(is(q.take(99999, skipped), 99999, 13));
  CHECK(skipped == 0);
  CHECK(q.empty());
}

// b/235045165: some encoders output the second-to-last frame with a pts of
// 0. It takes the oldest frame's timestamp, and the last one still matches.
static void zeroPtsSecondToLast() {
  TimestampQueue q;
  q.push(100000, 10);
  q.push(133333, 11);
  q.push(166666, 12);
  q.push(199999, 13);
  size_t skipped = 0;
  CHECK(is(q.take(100000, skipped), 100000, 10));
  CHECK(is(q.take(133333, skipped), 133333, 11));
  CHECK(is(q.take(0, skipped), 166666, 12));
  CHECK(skipped == 0);
  CHECK(is(q.take(199999, skipped), 199999, 13));
  CHECK(q.empty());
}

// A pts matching no frame (garbage) takes the oldest one.
static void garbagePts() {
  TimestampQueue q;
  q.push(0, 10);
  q.push(33333, 11);
  size_t skipped = 0;
  CHECK(is(q.take(0, skipped), 0, 10));
  CHECK(is(q.take(123456789, skipped), 33333, 11));
  CHECK(skipped == 0);
  CHECK(!q.take(5, skipped).has_value());
}

int main() {
  inOrder();
  firstAtZero();
  repeated();
  backwards();
  droppedMiddle();
  zeroPtsSecondToLast();
  garbagePts();
  if (failures > 0) {
    std::fprintf(stderr, "timestamps: %d failure(s)\n", failures);
    return EXIT_FAILURE;
  }
  std::printf("timestamps: ok\n");
  return EXIT_SUCCESS;
}

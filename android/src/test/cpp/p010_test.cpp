// Host test of android/src/main/cpp/P010.hpp: `yarn test:cpp` (ASan finds
// writes past the buffers).

#include "P010.hpp"

#include <cstdio>
#include <cstdlib>
#include <functional>

using namespace margelo::nitro::webcodecs;

static int failures = 0;

#define CHECK(cond)                                                   \
  do {                                                                \
    if (!(cond)) {                                                    \
      std::fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                     \
    }                                                                 \
  } while (0)

#define CHECK_EQ(a, b)                                                                                          \
  do {                                                                                                          \
    long long va = static_cast<long long>(a), vb = static_cast<long long>(b);                                   \
    if (va != vb) {                                                                                             \
      std::fprintf(stderr, "%s:%d: %s == %s (%lld != %lld)\n", __FILE__, __LINE__, #a, #b, va, vb);             \
      failures++;                                                                                               \
    }                                                                                                           \
  } while (0)

struct Rgb {
  float r, g, b;
};

static uint16_t toHalf(float v) {
  __fp16 h = static_cast<__fp16>(v);
  uint16_t bits;
  std::memcpy(&bits, &h, sizeof(bits));
  return bits;
}

// A picture converted as queueP010 does with a codec that reports no layout:
// the stride and size it computes, the buffer exactly that large.
struct P010 {
  int width, height;
  size_t stride, sliceHeight;
  std::vector<uint8_t> bytes;

  uint16_t y(int x, int row) const {
    uint16_t v;
    std::memcpy(&v, bytes.data() + row * stride + x * 2, 2);
    return v;
  }
  // Chroma pair `i` of chroma row `row`: Cb, then Cr.
  uint16_t cb(int i, int row) const {
    uint16_t v;
    std::memcpy(&v, bytes.data() + (sliceHeight + row) * stride + i * 4, 2);
    return v;
  }
  uint16_t cr(int i, int row) const {
    uint16_t v;
    std::memcpy(&v, bytes.data() + (sliceHeight + row) * stride + i * 4 + 2, 2);
    return v;
  }
};

static P010 convert(int width, int height, const std::function<Rgb(int, int)>& pixel) {
  // Rows of the source padded, as an AHardwareBuffer's may be.
  size_t srcStride = static_cast<size_t>(width + 3) * 4;
  std::vector<uint16_t> src(srcStride * height, toHalf(0.5f));
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      Rgb c = pixel(x, y);
      uint16_t* p = &src[y * srcStride + x * 4];
      p[0] = toHalf(c.r);
      p[1] = toHalf(c.g);
      p[2] = toHalf(c.b);
      p[3] = toHalf(1.0f);
    }
  }
  P010 out{width, height, p010Stride(width, 0), static_cast<size_t>(height), {}};
  out.bytes.assign(p010Size(out.stride, out.sliceHeight), 0);
  rgba16fToP010(src.data(), srcStride, width, height, out.bytes.data(), out.stride, out.sliceHeight);
  return out;
}

static const Rgb kRed{1, 0, 0};
static const Rgb kBlack{0, 0, 0};
static const Rgb kWhite{1, 1, 1};

// White and black land on the limited-range codes, in the top 10 bits.
static void whiteAndBlack() {
  P010 white = convert(4, 2, [](int, int) { return kWhite; });
  CHECK_EQ(white.y(0, 0), 940 << 6);
  CHECK_EQ(white.y(3, 1), 940 << 6);
  CHECK_EQ(white.cb(0, 0), 512 << 6);
  CHECK_EQ(white.cr(1, 0), 512 << 6);
  P010 black = convert(4, 2, [](int, int) { return kBlack; });
  CHECK_EQ(black.y(2, 1), 64 << 6);
  CHECK_EQ(black.cb(1, 0), 512 << 6);
}

// An odd width: the last column has a chroma pair of its own, written.
static void oddWidth() {
  P010 even = convert(2, 2, [](int, int) { return kRed; });
  P010 odd = convert(3, 2, [](int x, int) { return x == 2 ? kRed : kBlack; });
  CHECK_EQ(odd.y(2, 0), even.y(0, 0));
  CHECK_EQ(odd.cb(0, 0), 512 << 6);
  CHECK_EQ(odd.cb(1, 0), even.cb(0, 0));
  CHECK_EQ(odd.cr(1, 0), even.cr(0, 0));
}

// An odd height: the last row has a chroma row of its own, as saturated as
// the others (an average of the samples there are, not of four).
static void oddHeight() {
  P010 even = convert(2, 2, [](int, int) { return kRed; });
  P010 odd = convert(2, 3, [](int, int) { return kRed; });
  CHECK_EQ(odd.cb(0, 0), even.cb(0, 0));
  CHECK_EQ(odd.cr(0, 0), even.cr(0, 0));
  CHECK_EQ(odd.cb(0, 1), even.cb(0, 0));
  CHECK_EQ(odd.cr(0, 1), even.cr(0, 0));
}

// Both odd, and a size where each odd dimension is larger.
static void oddBoth() {
  P010 even = convert(2, 2, [](int, int) { return kRed; });
  P010 odd = convert(5, 5, [](int, int) { return kRed; });
  for (int row = 0; row < 3; row++) {
    for (int i = 0; i < 3; i++) {
      CHECK_EQ(odd.cb(i, row), even.cb(0, 0));
      CHECK_EQ(odd.cr(i, row), even.cr(0, 0));
    }
  }
  CHECK_EQ(odd.y(4, 4), even.y(0, 0));
}

// The codec's stride wins, in bytes or in pixels; the chroma rows always fit.
static void strides() {
  CHECK_EQ(p010Stride(1920, 0), 3840);
  CHECK_EQ(p010Stride(1920, 4096), 4096);
  CHECK_EQ(p010Stride(1920, 1920), 3840);
  CHECK_EQ(p010Stride(1920, 2048), 4096);
  CHECK(p010Stride(3, 0) >= 8);
  CHECK(p010Stride(3, 3) >= 8);
  // The size covers the chroma rows of every luma row.
  CHECK_EQ(p010Size(3840, 1080), 3840 * 1620);
  CHECK_EQ(p010Size(3840, 1088), 3840 * 1632);
  CHECK_EQ(p010Size(8, 3), 8 * 5);
}

int main() {
  whiteAndBlack();
  oddWidth();
  oddHeight();
  oddBoth();
  strides();
  if (failures > 0) {
    std::fprintf(stderr, "p010: %d check(s) failed\n", failures);
    return 1;
  }
  std::printf("p010: ok\n");
  return 0;
}

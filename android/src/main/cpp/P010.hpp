#pragma once

// The HDR path's RGBA half-float to P010 conversion, with no NDK in it, so
// that a host test (android/src/test/cpp, `yarn test:cpp`) can check it.

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace margelo::nitro::webcodecs {

// The chroma pairs (or rows) of `n` luma samples (or rows): an odd last one
// has its own.
inline int p010Chroma(int n) {
  return (n + 1) / 2;
}

// The bytes between rows of the codec's P010 input: what it reports
// (`reported`, 0 for nothing), else the luma row; at least a chroma row
// (4 bytes a pair), which is 2 bytes more than the luma for an odd width.
inline size_t p010Stride(int width, int32_t reported) {
  size_t stride = reported > 0 ? static_cast<size_t>(reported) : static_cast<size_t>(width) * 2;
  // A stride in pixels (some codecs) rather than bytes.
  if (stride < static_cast<size_t>(width) * 2) {
    stride *= 2;
  }
  return std::max(stride, static_cast<size_t>(p010Chroma(width)) * 4);
}

// The bytes of a P010 picture: `sliceHeight` rows of luma, then a chroma
// row for every two (an odd last one included).
inline size_t p010Size(size_t stride, size_t sliceHeight) {
  return stride * (sliceHeight + (sliceHeight + 1) / 2);
}

// One half float (IEEE 754 binary16) to a float.
inline float halfToFloat(uint16_t h) {
  __fp16 value;
  std::memcpy(&value, &h, sizeof(value));
  return static_cast<float>(value);
}

// Converts an RGBA half-float picture holding BT.2020 R'G'B' (already
// encoded with the transfer function, 0 to 1) to P010: 10-bit BT.2020
// non-constant-luminance YCbCr, limited range, 4:2:0, each sample in the top
// 10 bits of 16, then Cb and Cr interleaved. `srcStride` is in half floats,
// `dstStride` in bytes.
inline void rgba16fToP010(const uint16_t* src, size_t srcStride, int width, int height, uint8_t* dst, size_t dstStride,
                          size_t sliceHeight) {
  auto code = [](float v, float offset, float range) {
    float c = offset + range * v + 0.5f;
    c = c < 0.0f ? 0.0f : (c > 1023.0f ? 1023.0f : c);
    return static_cast<uint16_t>(static_cast<uint16_t>(c) << 6);
  };
  uint8_t* uv = dst + dstStride * sliceHeight;
  // Each chroma sample averages the luma samples it covers: four, or two or
  // one at an odd last column or row.
  const int chromaWidth = p010Chroma(width);
  std::vector<float> cb(chromaWidth);
  std::vector<float> cr(chromaWidth);
  std::vector<int> count(chromaWidth);
  for (int y = 0; y < height; y += 2) {
    std::fill(cb.begin(), cb.end(), 0.0f);
    std::fill(cr.begin(), cr.end(), 0.0f);
    std::fill(count.begin(), count.end(), 0);
    for (int dy = 0; dy < 2 && y + dy < height; dy++) {
      const uint16_t* row = src + (y + dy) * srcStride;
      auto* out = reinterpret_cast<uint16_t*>(dst + (y + dy) * dstStride);
      for (int x = 0; x < width; x++) {
        float r = halfToFloat(row[x * 4]);
        float g = halfToFloat(row[x * 4 + 1]);
        float b = halfToFloat(row[x * 4 + 2]);
        float l = 0.2627f * r + 0.6780f * g + 0.0593f * b;
        out[x] = code(l, 64.0f, 876.0f);
        cb[x / 2] += (b - l) / 1.8814f;
        cr[x / 2] += (r - l) / 1.4746f;
        count[x / 2]++;
      }
    }
    auto* out = reinterpret_cast<uint16_t*>(uv + (y / 2) * dstStride);
    for (int i = 0; i < chromaWidth; i++) {
      out[i * 2] = code(cb[i] / count[i], 512.0f, 896.0f);
      out[i * 2 + 1] = code(cr[i] / count[i], 512.0f, 896.0f);
    }
  }
}

} // namespace margelo::nitro::webcodecs

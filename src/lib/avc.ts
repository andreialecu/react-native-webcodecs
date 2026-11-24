// The picture size an H.264 stream declares in its sequence parameter set,
// read from an avcC record (ISO/IEC 14496-15) — what a VideoDecoderConfig
// without codedWidth/codedHeight still carries.

class BitReader {
  private bit = 0;
  constructor(private readonly bytes: Uint8Array) {}

  u(n: number) {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.bit >> 3];
      if (byte === undefined) {
        throw new RangeError("past the end of the SPS");
      }
      value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return value;
  }

  ue() {
    let zeros = 0;
    while (this.u(1) === 0) {
      if (++zeros > 31) {
        throw new RangeError("exp-Golomb code too long");
      }
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }

  se() {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }
}

// The NAL unit's payload without its emulation prevention bytes
// (00 00 03 → 00 00).
const unescape = (nal: Uint8Array) => {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
};

const skipScalingList = (r: BitReader, size: number) => {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) {
      next = (last + r.se() + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
};

// Profiles whose SPS carries chroma_format_idc, bit depths and scaling lists.
const HIGH_PROFILES = new Set([
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
]);

/** The size (after cropping) of an SPS NAL unit, header byte included. */
export const spsSize = (nal: Uint8Array) => {
  const r = new BitReader(unescape(nal));
  if ((r.u(8) & 0x1f) !== 7) {
    return undefined;
  }
  const profile = r.u(8);
  r.u(16); // constraint flags, level
  r.ue(); // seq_parameter_set_id
  let chromaFormat = 1;
  let separateColourPlane = false;
  if (HIGH_PROFILES.has(profile)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) {
      separateColourPlane = r.u(1) === 1;
    }
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.u(1); // qpprime_y_zero_transform_bypass_flag
    if (r.u(1) === 1) {
      const lists = chromaFormat === 3 ? 12 : 8;
      for (let i = 0; i < lists; i++) {
        if (r.u(1) === 1) {
          skipScalingList(r, i < 6 ? 16 : 64);
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (pocType === 1) {
    r.u(1); // delta_pic_order_always_zero_flag
    r.se(); // offset_for_non_ref_pic
    r.se(); // offset_for_top_to_bottom_field
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) {
      r.se();
    }
  }
  r.ue(); // max_num_ref_frames
  r.u(1); // gaps_in_frame_num_value_allowed_flag
  const widthInMbs = r.ue() + 1;
  const heightInMapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (frameMbsOnly === 0) {
    r.u(1); // mb_adaptive_frame_field_flag
  }
  r.u(1); // direct_8x8_inference_flag
  let width = widthInMbs * 16;
  let height = (2 - frameMbsOnly) * heightInMapUnits * 16;
  if (r.u(1) === 1) {
    const left = r.ue();
    const right = r.ue();
    const top = r.ue();
    const bottom = r.ue();
    // Crop units: one sample without chroma (monochrome or separate
    // planes), else the chroma subsampling; twice as tall for fields.
    const arrayType = separateColourPlane ? 0 : chromaFormat;
    const subWidth = arrayType === 1 || arrayType === 2 ? 2 : 1;
    const subHeight = arrayType === 1 ? 2 : 1;
    width -= subWidth * (left + right);
    height -= subHeight * (2 - frameMbsOnly) * (top + bottom);
  }
  if (width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
};

/**
 * The size of the stream an avcC record describes, from its first SPS;
 * undefined when the record or the SPS cannot be read.
 */
export const avcCodedSize = (
  avcC: ArrayBuffer | ArrayBufferView | undefined,
): { width: number; height: number } | undefined => {
  if (!avcC) {
    return undefined;
  }
  const bytes = ArrayBuffer.isView(avcC)
    ? new Uint8Array(avcC.buffer, avcC.byteOffset, avcC.byteLength)
    : new Uint8Array(avcC);
  if (bytes.length < 8 || bytes[0] !== 1 || (bytes[5]! & 0x1f) === 0) {
    return undefined;
  }
  const length = (bytes[6]! << 8) | bytes[7]!;
  if (8 + length > bytes.length) {
    return undefined;
  }
  try {
    return spsSize(bytes.subarray(8, 8 + length));
  } catch {
    return undefined;
  }
};

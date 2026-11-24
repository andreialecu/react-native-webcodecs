import { avcCodedSize } from "../../lib/avc";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

// avcC records from libx264 (ffmpeg 8.1, testsrc2), with the size ffprobe
// reports for each file.
const X264: [string, string, number, number][] = [
  [
    "High 1920x1080 (cropped from 1088)",
    "01640028ffe1001b67640028acd940780227e5c044000003000400000300f03c60c65801000668ebe3cb22c0fdf8f800",
    1920,
    1080,
  ],
  [
    "High 360x640 (cropped from 368)",
    "0164001effe1001a6764001eacd9417051e5f0110000030001000003003c0f162d9601000668ebe3cb22c0fdf8f800",
    360,
    640,
  ],
  [
    "High 3840x2160",
    "01640033ffe1001a67640033acd9403c0043ec0440000003004000000f03c60c658001000668ebe3cb22c0fdf8f800",
    3840,
    2160,
  ],
  [
    "Constrained Baseline 1278x718",
    "0142c01fffe1001a6742c01fd9005005beab0110000003001000000303c0f183248001000568cb83cb20",
    1278,
    718,
  ],
  [
    "High 4:4:4 642x358",
    "01f4001effe1001b67f4001e919b281485fc7c5e0220000003002000000781e2c5b2c001000668ebe3c44844fff8f800",
    642,
    358,
  ],
  [
    "High 4:2:2 642x358",
    "017a001effe1001b677a001ebcd940a42fe222f0110000030001000003003c0f162d9601000668ebe3cb22c0fef8f800",
    642,
    358,
  ],
  [
    "High interlaced 720x576",
    "0164001fffe100186764001facd940b424d80880000003008000001e0f8b16cb01000668fba3cb22c0fdf8f800",
    720,
    576,
  ],
  [
    "High monochrome 322x240",
    "0164000dffe100196764000df3650547f8ff016c80000003008000001e078a14cb01000668ebe3cb22c0fcf8f800",
    322,
    240,
  ],
];

describe("avcCodedSize", () => {
  it.each(X264)("reads %s", (_, record, width, height) => {
    expect(avcCodedSize(hex(record))).toEqual({ width, height });
  });

  // Written by hand (fields checked with ffmpeg's trace_headers): scaling
  // lists (one ending early, one default, one full 8x8), pic_order_cnt_type
  // 1 with a cycle, fields (frame_mbs_only_flag 0), crop on every side but
  // the top, and emulation prevention bytes. 1440x1088 coded, crop 4+12
  // horizontally, 8 at the bottom (2 units of 2 rows, twice for fields).
  it("reads scaling lists, POC type 1, fields and emulation prevention", () => {
    const record =
      "01640028ffe1003767640028ad88c32422534d34d34d34d34d34d34d34d34d34d34d34d34d34d34d34d4000003010000030072118000080000280b4089d9ed01000468ee3c80";
    expect(avcCodedSize(hex(record))).toEqual({ width: 1424, height: 1080 });
  });

  it("takes an ArrayBuffer or a view into a larger buffer", () => {
    const record = hex(X264[0]![1]);
    const padded = new Uint8Array(record.length + 4);
    padded.set(record, 4);
    expect(avcCodedSize(record.slice().buffer)).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(avcCodedSize(padded.subarray(4))).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("returns undefined, never throws, for what it cannot read", () => {
    const full = hex(X264[0]![1]);
    expect(avcCodedSize(undefined)).toBeUndefined();
    expect(avcCodedSize(new Uint8Array(0))).toBeUndefined();
    // The records other tests use: a header without parameter sets.
    expect(
      avcCodedSize(new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1])),
    ).toBeUndefined();
    // Not version 1.
    expect(avcCodedSize(Uint8Array.from([2, ...full.subarray(1)]))).toBe(
      undefined,
    );
    // Truncated at every length.
    for (let n = 0; n < full.length - 10; n++) {
      expect(() => avcCodedSize(full.subarray(0, n))).not.toThrow();
    }
    // The SPS cut short inside the record: a length past its end.
    const cut = full.slice(0, 14);
    expect(avcCodedSize(cut)).toBeUndefined();
    // A PPS where the SPS should be.
    const pps = hex("01640028ffe100046868ebe3cb");
    expect(avcCodedSize(pps)).toBeUndefined();
  });
});

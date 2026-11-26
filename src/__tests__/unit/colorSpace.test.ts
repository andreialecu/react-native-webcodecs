import type { NativeBufferColorSpace as WebGPUNativeBufferColorSpace } from "react-native-webgpu";

import type { NativeBufferColorSpace } from "../../lib/colorSpace";
import { toNativeBufferColorSpace } from "../../lib/colorSpace";

// What react-native-webgpu's createNativeBufferFromPointer takes, from the
// color spaces decoders put on their frames.
describe("toNativeBufferColorSpace", () => {
  it("names BT.709 limited range as Dawn does", () => {
    expect(
      toNativeBufferColorSpace({
        primaries: "bt709",
        transfer: "bt709",
        matrix: "bt709",
        fullRange: false,
      }),
    ).toEqual({
      primaries: "srgb",
      transfer: "smpte-170m",
      matrix: "rec709",
      range: "narrow",
    });
  });

  it("names BT.601 full range", () => {
    expect(
      toNativeBufferColorSpace({
        primaries: "smpte170m",
        transfer: "smpte170m",
        matrix: "smpte170m",
        fullRange: true,
      }),
    ).toEqual({
      primaries: "rec601",
      transfer: "smpte-170m",
      matrix: "rec601",
      range: "full",
    });
  });

  it("names HLG and PQ in BT.2020", () => {
    expect(
      toNativeBufferColorSpace({
        primaries: "bt2020",
        transfer: "hlg",
        matrix: "bt2020-ncl",
      }),
    ).toEqual({ primaries: "rec2020", transfer: "hlg", matrix: "rec2020" });
    expect(toNativeBufferColorSpace({ transfer: "pq" })).toEqual({
      transfer: "pq",
    });
  });

  it("names sRGB, Display P3 and linear", () => {
    expect(
      toNativeBufferColorSpace({
        primaries: "smpte432",
        transfer: "iec61966-2-1",
        matrix: "bt470bg",
      }),
    ).toEqual({ primaries: "display-p3", transfer: "srgb", matrix: "rec601" });
    expect(toNativeBufferColorSpace({ transfer: "linear" })).toEqual({
      transfer: "identity",
    });
  });

  it("leaves out what is unset or has no name, so the buffer's own stay", () => {
    expect(
      toNativeBufferColorSpace({
        primaries: null,
        transfer: "gamma22curve",
        matrix: "toString",
        fullRange: null,
      }),
    ).toEqual({});
    expect(toNativeBufferColorSpace({})).toEqual({});
  });
});

// The type is react-native-webgpu's, redeclared so that it stays a dev
// dependency: tsc fails here if the two drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameType: Same<NativeBufferColorSpace, WebGPUNativeBufferColorSpace> =
  true;
void sameType;

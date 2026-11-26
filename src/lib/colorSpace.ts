/**
 * A color space as react-native-webgpu names it, Dawn's names: what its
 * `createNativeBufferFromPointer(pointer, { colorSpace })` takes (its
 * `NativeBufferColorSpace`). Not in WebCodecs.
 */
export interface NativeBufferColorSpace {
  matrix?: "identity" | "rec601" | "rec709" | "rec2020";
  range?: "identity" | "narrow" | "full";
  primaries?: "srgb" | "rec709" | "rec601" | "rec2020" | "display-p3";
  transfer?:
    | "identity"
    | "srgb"
    | "display-p3"
    | "smpte-170m"
    | "hlg"
    | "pq"
    | "bt-1886";
}

/** @internal A WebCodecs color space, as VideoColorSpaceInit. */
export type ColorSpaceInit = {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
};

const PRIMARIES = new Map<string, NativeBufferColorSpace["primaries"]>([
  ["bt709", "srgb"],
  ["bt470bg", "rec601"],
  ["smpte170m", "rec601"],
  ["bt2020", "rec2020"],
  ["smpte432", "display-p3"],
]);

const TRANSFER = new Map<string, NativeBufferColorSpace["transfer"]>([
  ["bt709", "smpte-170m"],
  ["smpte170m", "smpte-170m"],
  ["iec61966-2-1", "srgb"],
  ["linear", "identity"],
  ["pq", "pq"],
  ["hlg", "hlg"],
]);

const MATRIX = new Map<string, NativeBufferColorSpace["matrix"]>([
  ["bt709", "rec709"],
  ["bt470bg", "rec601"],
  ["smpte170m", "rec601"],
  ["bt2020-ncl", "rec2020"],
]);

/**
 * @internal A WebCodecs color space in Dawn's names. Members it has no name
 * for are left out, so the buffer's own stay.
 */
export const toNativeBufferColorSpace = (
  colorSpace: ColorSpaceInit,
): NativeBufferColorSpace => {
  const primaries = PRIMARIES.get(colorSpace.primaries ?? "");
  const transfer = TRANSFER.get(colorSpace.transfer ?? "");
  const matrix = MATRIX.get(colorSpace.matrix ?? "");
  const { fullRange } = colorSpace;
  return {
    ...(primaries && { primaries }),
    ...(transfer && { transfer }),
    ...(matrix && { matrix }),
    ...(typeof fullRange === "boolean" && {
      range: fullRange ? "full" : "narrow",
    }),
  };
};

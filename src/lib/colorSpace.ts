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

/** @internal The members of a WebCodecs color space it reads. */
export interface WebCodecsColorSpace {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
}

const PRIMARIES: Record<string, NativeBufferColorSpace["primaries"]> = {
  bt709: "srgb",
  bt470bg: "rec601",
  smpte170m: "rec601",
  bt2020: "rec2020",
  smpte432: "display-p3",
};

const TRANSFER: Record<string, NativeBufferColorSpace["transfer"]> = {
  bt709: "smpte-170m",
  smpte170m: "smpte-170m",
  "iec61966-2-1": "srgb",
  linear: "identity",
  pq: "pq",
  hlg: "hlg",
};

const MATRIX: Record<string, NativeBufferColorSpace["matrix"]> = {
  bt709: "rec709",
  bt470bg: "rec601",
  smpte170m: "rec601",
  "bt2020-ncl": "rec2020",
};

const lookup = <T>(table: Record<string, T>, name?: string | null) =>
  name != null && Object.prototype.hasOwnProperty.call(table, name)
    ? table[name]
    : undefined;

/**
 * @internal A WebCodecs color space in Dawn's names. Members it has no name
 * for are left out, so the buffer's own stay.
 */
export const toNativeBufferColorSpace = (
  colorSpace: WebCodecsColorSpace,
): NativeBufferColorSpace => {
  const result: NativeBufferColorSpace = {};
  const primaries = lookup(PRIMARIES, colorSpace.primaries);
  if (primaries) {
    result.primaries = primaries;
  }
  const transfer = lookup(TRANSFER, colorSpace.transfer);
  if (transfer) {
    result.transfer = transfer;
  }
  const matrix = lookup(MATRIX, colorSpace.matrix);
  if (matrix) {
    result.matrix = matrix;
  }
  if (typeof colorSpace.fullRange === "boolean") {
    result.range = colorSpace.fullRange ? "full" : "narrow";
  }
  return result;
};

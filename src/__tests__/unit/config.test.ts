import {
  VIDEO_DECODER_CONFIG_MEMBERS,
  VIDEO_ENCODER_CONFIG_MEMBERS,
  cloneConfig,
} from "../../lib/native";

jest.mock("react-native-nitro-modules", () => ({}));

describe("cloneConfig", () => {
  it("keeps the specification's members and drops the others", () => {
    const config = {
      codec: "avc1.640028",
      width: 1080,
      height: 1920,
      bitrate: 8_000_000,
      avc: { format: "avc" },
      madeUp: true,
    };
    const clone = cloneConfig(config, VIDEO_ENCODER_CONFIG_MEMBERS);
    expect(clone).toEqual({
      codec: "avc1.640028",
      width: 1080,
      height: 1920,
      bitrate: 8_000_000,
      avc: { format: "avc" },
    });
    expect(clone.avc).not.toBe(config.avc);
  });

  it("copies buffers", () => {
    const description = new Uint8Array([1, 2, 3]);
    const clone = cloneConfig(
      { codec: "avc1.640028", description, outputFormat: "NV12" },
      VIDEO_DECODER_CONFIG_MEMBERS,
    );
    expect(clone.description).toEqual(description);
    expect(clone.description).not.toBe(description);
    expect(clone.outputFormat).toBe("NV12");
  });
});

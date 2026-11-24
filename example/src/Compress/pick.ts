import { NativeModules } from "react-native";

export interface Picked {
  name: string;
  path: string;
  size: number;
  file?: File;
}

// The example app's own picker (video-picker/): one video, as recorded, so
// an iPhone's HEVC stays HEVC, copied to the app's cache folder.
const { VideoPicker } = NativeModules as {
  VideoPicker: { pick(): Promise<Picked | null> };
};

export const pickVideo = () => VideoPicker.pick();

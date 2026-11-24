import type { SkData } from "react-native-skia";
import { loadData, Skia } from "react-native-skia";

import card from "./card.json";
import { assetBytes } from "./export";
import { boostLights } from "./hdr";

// The share card of react-native-skia's Skottie export example: its images
// and font, the animation built from them, and the sound that goes with it.
// The export screen and the e2e tests (Tests.tsx) both use these.

const json = JSON.stringify(card);
// For HDR, the lights go above SDR white, up to the HLG peak.
const hdrJson = JSON.stringify(boostLights(card));

export interface CardAssets {
  photo: SkData;
  logo: SkData;
  font: SkData;
}

const data = async (asset: number) => {
  const loaded = await loadData(asset, (d) => d);
  if (!loaded) {
    throw new Error("Could not load an asset of the card");
  }
  return loaded;
};

export const loadCardAssets = async (): Promise<CardAssets> => {
  const [photo, logo, font] = await Promise.all([
    data(require("./assets/photo.jpg")),
    data(require("./assets/logo.png")),
    data(require("./assets/Roboto-Bold.ttf")),
  ]);
  return { photo, logo, font };
};

// A new instance each time: seeking one does not move another.
export const makeCard = (assets: CardAssets, hdr: boolean) =>
  Skia.Skottie.Make(hdr ? hdrJson : json, {
    "photo.jpg": assets.photo,
    "logo.png": assets.logo,
    // The animation asks for SF Pro, which can't be redistributed: Roboto
    // stands in.
    SFProBold: assets.font,
  });

// The M4A the export copies as its sound track.
export const loadSound = () => assetBytes(require("./assets/sound.m4a"));

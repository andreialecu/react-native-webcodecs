// react-native-web ships no types for its asset registry.
declare module "react-native-web/dist/modules/AssetRegistry" {
  export const getAssetByID: (id: number) => {
    httpServerLocation: string;
    name: string;
    type: string;
  };
}

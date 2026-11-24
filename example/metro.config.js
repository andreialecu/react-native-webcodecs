const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const path = require('path');
const getWebMetroConfig = require('./getWebMetroConfig');

const root = path.resolve(__dirname, '..');
const escape = (s) => s.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
const defaultConfig = getDefaultConfig(__dirname);

const customConfig = {
  watchFolders: [root],
  resolver: {
    ...defaultConfig.resolver,
    assetExts: [...defaultConfig.resolver.assetExts, 'jpg'],
    // The library is the repository root, not a package in node_modules.
    extraNodeModules: { 'react-native-webcodecs': root },
    // Its own build output and the example's native folders are not sources.
    blockList: [
      new RegExp(`^${escape(path.join(root, 'lib'))}/.*`),
      new RegExp(`^${escape(path.join(root, 'example', 'ios', 'Pods'))}/.*`),
    ],
  },
  transformer: {
    ...defaultConfig.transformer,
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
};

const metroConfig = mergeConfig(defaultConfig, customConfig);

// `yarn web` serves the app to a browser, through react-native-web.
module.exports = process.env.IS_WEB_BUILD
  ? getWebMetroConfig(metroConfig)
  : metroConfig;

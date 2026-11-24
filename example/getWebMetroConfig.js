const fs = require("fs");
const path = require("path");
const rnwPath = path.dirname(
  require.resolve("react-native-web/package.json", { paths: [__dirname] }),
);
const assetRegistryPath = require.resolve(
  "react-native-web/dist/modules/AssetRegistry/index",
  { paths: [__dirname] },
);

module.exports = function (metroConfig) {
  metroConfig.resolver.platforms = ["ios", "android", "web"];
  const origResolveRequest = metroConfig.resolver.resolveRequest;
  metroConfig.resolver.resolveRequest = (contextRaw, moduleName, platform) => {
    const context = {
      ...contextRaw,
      preferNativePlatform: false,
    };

    // CanvasKit's Emscripten glue requires these only when it runs in Node.
    if (moduleName === "fs" || moduleName === "path") {
      return { type: "empty" };
    }

    // One asset registry: the one assets are registered in on the web.
    if (
      moduleName === "react-native/asset-registry" ||
      moduleName === "react-native/Libraries/Image/AssetRegistry"
    ) {
      return { filePath: assetRegistryPath, type: "sourceFile" };
    }

    if (moduleName === "react-native") {
      return {
        filePath: path.resolve(rnwPath, "dist/index.js"),
        type: "sourceFile",
      };
    }

    // Let default config handle other modules
    const resolution = origResolveRequest
      ? origResolveRequest(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
    // Metro tries each extension in turn, platform-specific first: a
    // Platform.ts wins over a Platform.web.tsx next to it (as in
    // react-native-skia). Prefer the web file when there is one.
    if (resolution.type === "sourceFile") {
      const match = /^(.*)\.(ts|tsx|js|jsx)$/.exec(resolution.filePath);
      if (match && !/\.web$/.test(match[1])) {
        for (const ext of ["ts", "tsx", "js", "jsx"]) {
          const web = `${match[1]}.web.${ext}`;
          if (fs.existsSync(web)) {
            return { type: "sourceFile", filePath: web };
          }
        }
      }
    }
    return resolution;
  };

  metroConfig.transformer.assetRegistryPath = assetRegistryPath;
  // The static build (scripts/build-web.js) serves the assets next to the
  // page, wherever it is hosted (GitHub Pages serves it under a subpath).
  if (process.env.WEB_PUBLIC_PATH) {
    metroConfig.transformer.publicPath = process.env.WEB_PUBLIC_PATH;
  }

  return metroConfig;
};

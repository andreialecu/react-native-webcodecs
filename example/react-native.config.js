const project = (() => {
  try {
    const { configureProjects } = require("react-native-test-app");
    return configureProjects({
      android: {
        sourceDir: "android",
        // The Java namespace of react-native-test-app's app module, where
        // BuildConfig lives (the application id is set in app.json).
        packageName: "com.microsoft.reacttestapp"
      },
      ios: {
        sourceDir: "ios",
      },
    });
  } catch (_) {
    return undefined;
  }
})();

const path = require("path");

module.exports = {
  ...(project ? { project } : undefined),
  // The library is the repository root, not a package in node_modules.
  dependencies: {
    "react-native-webcodecs": { root: path.resolve(__dirname, "..") },
    // The example's own video picker (PHPicker / ACTION_GET_CONTENT), so the
    // app needs no picker library.
    "video-picker": {
      root: path.resolve(__dirname, "video-picker"),
      platforms: {
        ios: { podspecPath: path.resolve(__dirname, "video-picker/VideoPicker.podspec") },
        android: {
          sourceDir: path.resolve(__dirname, "video-picker/android"),
          packageImportPath: "import com.webcodecs.videopicker.VideoPickerPackage;",
          packageInstance: "new VideoPickerPackage()",
        },
      },
    },
  },
};

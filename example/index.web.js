import { AppRegistry } from "react-native";
import { LoadSkiaWeb } from "react-native-skia/src/web";

import App from "./src/App";
import { name as appName } from "./app.json";

// On the web, React Native Skia runs on CanvasKit (WebAssembly), which must
// be loaded before the app renders. The binary has to match the canvaskit.js
// bundled with react-native-skia (canvaskit-wasm 0.41.1).
AppRegistry.registerComponent(appName, () => App);

LoadSkiaWeb({
  locateFile: (file) =>
    `https://cdn.jsdelivr.net/npm/canvaskit-wasm@0.41.1/bin/full/${file}`,
}).then(() => {
  AppRegistry.runApplication(appName, {
    rootTag: document.getElementById("root"),
  });
});

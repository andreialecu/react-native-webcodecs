import React, { useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
// Installs navigator.gpu.
import "react-native-webgpu";

import { supportedCodecs } from "./Compress/codecs";
import { compress, openSource } from "./Compress/compress";
import * as settings from "./Compress/settings";
import { serve } from "./serve";
import { useClient } from "./useClient";
import { loadCardAssets, loadSound, makeCard } from "./VideoExport/lottieCard";
import { exportVideo } from "./VideoExport/export";

// The example's own code, for the e2e tests of its screens: they run what
// the app runs, not copies of it.
const example = {
  exportVideo,
  loadCardAssets,
  makeCard,
  loadSound,
  openSource,
  compress,
  supportedCodecs,
  settings,
};

// The app's side of the e2e tests (src/__tests__): the
// host sends functions as source, run here with a WebGPU device and the
// modules they need.
export const Tests = () => {
  const [device, setDevice] = useState<GPUDevice | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          throw new Error("No appropriate GPUAdapter found.");
        }
        const d = await adapter.requestDevice();
        if (!cancelled) {
          setDevice(d);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[Tests] device setup failed: ${msg}`);
        if (!cancelled) {
          setSetupError(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const [client, hostname] = useClient();
  // Without a device, answer every call with the setup error right away,
  // rather than letting each test wait out the host's call timeout.
  useEffect(() => {
    if (client !== null && setupError !== null) {
      return serve(client, {
        eval: () => {
          throw new Error(`device setup failed: ${setupError}`);
        },
      });
    }
    return;
  }, [client, setupError]);
  useEffect(() => {
    if (client !== null && device !== null) {
      return serve(client, {
        eval: (params: { code: string; ctx: object }) =>
          eval(
            `(function Main() {
              return (${params.code})(this.ctx);
            })`,
          ).call({
            ctx: {
              gpu: navigator.gpu,
              device,
              mediabunny: require("mediabunny"),
              webcodecs: require("react-native-webcodecs"),
              AppState,
              example,
              ...params.ctx,
            },
          }),
      });
    }
    return;
  }, [client, device]);
  let status = "🟢 Waiting for the server to send tests";
  if (setupError) {
    status = `🔴 Test device setup failed: ${setupError}`;
  } else if (!device) {
    status = "⏳ Initializing GPU device…";
  } else if (client === null) {
    status = `⚪️ Connecting to ${hostname}. Run yarn test at the repository root.`;
  }
  return (
    <View style={{ flex: 1, padding: 16, backgroundColor: "white" }}>
      <Text style={{ color: setupError ? "red" : "black" }}>{status}</Text>
    </View>
  );
};

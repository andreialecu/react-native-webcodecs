import http from "http";
import { execFileSync } from "child_process";

import { WebSocketServer } from "ws";

import { Channel } from "./components/Channel";
import { TEST_SERVER_PORT } from "./config";

const isOS = (os: string): os is "android" | "ios" => {
  return ["ios", "android"].indexOf(os) !== -1;
};

const isArch = (arc: string): arc is "paper" | "fabric" => {
  return ["paper", "fabric"].indexOf(arc) !== -1;
};

// Map the device's own localhost:<TEST_SERVER_PORT> onto this machine, the same
// way the React Native CLI does for Metro on 8081. With it, an Android emulator
// and a physical device both reach the test server at "localhost", so useClient needs no per-platform host and no LAN
// address.
// Best effort: no adb, no device, or several devices attached just leaves the
// connection to whatever host the app is configured with.
const reversePort = (port: number) => {
  try {
    execFileSync("adb", ["reverse", `tcp:${port}`, `tcp:${port}`], {
      stdio: "ignore",
    });
  } catch {
    // Not an Android run (or adb is unavailable); iOS and the emulator default
    // work without it.
  }
};

// How long the server waits for the example app before failing the run. Without
// it, a crashed or never-launched app leaves jest waiting here until the CI job
// timeout. Generous because on a cold CI runner the first connection also waits
// for Metro to build the app's bundle.
const CONNECT_TIMEOUT_MS = 10 * 60 * 1000;

const globalSetup = () => {
  return new Promise<void>((resolve, reject) => {
    const port = TEST_SERVER_PORT;
    reversePort(port);
    global.testFixtureServer = http.createServer((_, res) => {
      res.writeHead(404).end();
    });
    global.testServer = new WebSocketServer({
      server: global.testFixtureServer,
    });
    global.testFixtureServer.listen(port);
    console.log(
      `\n\nTest server listening on port ${port} (waiting for the example app to open on E2E tests screen)`,
    );
    const timeout = setTimeout(() => {
      global.testServer.close();
      global.testFixtureServer.close();
      reject(
        new Error(
          `No device connected to the test server on port ${port} within ${CONNECT_TIMEOUT_MS / 1000}s. Is the example app running on the Tests screen (CI=true)?`,
        ),
      );
    }, CONNECT_TIMEOUT_MS);
    global.testServer.on("connection", (client) => {
      global.testClient = client;
      client.once("message", (msg) => {
        clearTimeout(timeout);
        const obj = JSON.parse(msg.toString("utf8"));
        const { OS, arch, host } = obj;
        if (!isOS(OS)) {
          throw new Error("Unknown testing platform: " + OS);
        }
        if (!isArch(arch)) {
          throw new Error("Unknown testing architecture: " + arch);
        }
        // The calls to the app go through a channel that lives as long as the
        // socket (see Channel).
        global.testChannel = new Channel(client);
        global.testOS = OS;
        global.testArch = arch;
        // The host the device reached us on (localhost for the simulator, a LAN
        // address for a physical device).
        global.testHost = typeof host === "string" ? host : "localhost";
        console.log(`${OS} device connected (${arch}) from ${global.testHost}`);
        resolve();
      });
    });
  });
};

// eslint-disable-next-line import/no-default-export
export default globalSetup;

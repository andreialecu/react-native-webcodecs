/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Server as HTTPServer } from "http";

import type { Server, WebSocket } from "ws";

import type { Channel } from "./components/Channel";

jest.setTimeout(180 * 1000);

type TestOS = "ios" | "android";

declare global {
  var testServer: Server;
  var testFixtureServer: HTTPServer;
  var testClient: WebSocket;
  // The calls to the app that said hello last (see Channel).
  var testChannel: Channel | undefined;
  var testOS: TestOS;
  var testArch: "paper" | "fabric";
  var testHost: string;
}

// What a function passed to client.eval receives on the device (see
// example/src/Tests.tsx), next to the context it is called with.
interface TestingContext {
  gpu: GPU;
  device: GPUDevice;
  // The modules as the example app loads them: untyped here, since the code
  // runs on the device as source.
  mediabunny: any;
  webcodecs: any;
  AppState: any;
}

type Ctx = Record<string, unknown>;

type JSONValue =
  { [key: string]: JSONValue } | JSONValue[] | number | string | boolean | null;

interface TestingClient {
  eval<C = Ctx, R = JSONValue>(
    fn: (ctx: TestingContext & C) => R | Promise<R>,
    ctx?: C,
  ): Promise<R>;
  OS: TestOS;
  arch: "paper" | "fabric";
}

class RemoteTestingClient implements TestingClient {
  readonly OS = global.testOS;
  readonly arch = global.testArch;

  eval<C = Ctx, R = JSONValue>(
    fn: (ctx: TestingContext & C) => R | Promise<R>,
    context?: C,
  ): Promise<R> {
    return this.channel.call<R>("eval", {
      code: fn.toString(),
      ctx: { ...(context ?? {}) },
    });
  }

  private get channel() {
    if (global.testChannel === undefined) {
      throw new Error("Client is not connected. Is the globalSetup running?");
    }
    return global.testChannel;
  }
}

export let client: TestingClient;

beforeAll(() => {
  client = new RemoteTestingClient();
});

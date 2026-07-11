import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AsyncAPIInvoker } from "./invoker.js";
import { FORMAT_TOKEN } from "./constants.js";

// Regression coverage for the [assumption] documented in
// spec/formats/asyncapi.md: "A channel without an `address` is assumed
// addressable by its channel name (the 2.x-lineage habit)." Mirrors the Go
// SDK's TestChannelAddressFallsBackToChannelName.
describe("channel-address fallback", () => {
  let server: Server;
  let port: number;
  let gotPath: string | undefined;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        gotPath = req.url;
        res.writeHead(202);
        res.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.closeAllConnections();
    server?.close();
  });

  it("falls back to the channel's own name when it declares no address", async () => {
    const spec = {
      asyncapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      servers: { test: { host: `127.0.0.1:${port}`, protocol: "http" } },
      // Deliberately no `address` on the channel.
      channels: { notify: {} },
      operations: {
        notifyOp: { action: "send" as const, channel: { $ref: "#/channels/notify" } },
      },
    };

    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: { format: FORMAT_TOKEN, content: spec },
      ref: "#/operations/notifyOp",
    });
    await call.write({});
    await call.close();
    await call.closed;

    expect(gotPath).toBe("/notify");
  });
});

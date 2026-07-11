import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AsyncAPIInvoker } from "./invoker.js";
import { FORMAT_TOKEN } from "./constants.js";

// Regression coverage for spec/formats/asyncapi.md's Open points: "the
// reference packages cap events/responses at 10 MiB per delivery unit
// (deliberately per-unit, so long-lived subscriptions are unbounded in
// total)". Mirrors the Go SDK's TestSSEReceiveCapIsPerEvent and
// TestSSEReceiveSingleOversizedEventErrors.
describe("SSE receive size cap is per-event, not cumulative", () => {
  let server: Server;
  let port: number;

  afterAll(() => {
    server?.closeAllConnections();
    server?.close();
  });

  function spec(path: string) {
    return {
      asyncapi: "3.0.0",
      info: { title: "SSE Cap Test", version: "1.0.0" },
      servers: { test: { host: `127.0.0.1:${port}`, protocol: "http" } },
      channels: { caps: { address: path } },
      operations: {
        receiveCaps: { action: "receive" as const, channel: { $ref: "#/channels/caps" } },
      },
    };
  }

  it("keeps flowing across a >10MB cumulative stream of small events", async () => {
    const eventSize = 2 * 1024 * 1024; // 2 MB per event, 6 events = 12 MB total
    const payload = "x".repeat(eventSize);

    await new Promise<void>((resolve) => {
      server = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (let i = 0; i < 6; i++) {
          res.write(`data: ${payload}\n\n`);
        }
        res.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });

    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: { format: FORMAT_TOKEN, content: spec("/") },
      ref: "#/operations/receiveCaps",
    });
    const events: unknown[] = [];
    for await (const v of call.outputs) events.push(v);
    await call.closed;

    expect(events).toHaveLength(6);
  });

  it("errors a single event larger than the cap with ERR_RESPONSE_ERROR", async () => {
    const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
    const payload = "x".repeat(MAX_RESPONSE_BYTES + 16);

    await new Promise<void>((resolve) => {
      server = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${payload}\n\n`);
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });

    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: { format: FORMAT_TOKEN, content: spec("/") },
      ref: "#/operations/receiveCaps",
    });

    await expect(call.closed).rejects.toMatchObject({ code: "ERR_RESPONSE_ERROR" });
  });
});

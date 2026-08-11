import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, afterAll } from "vitest";
import { OpenAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

// The SSE size cap is PER EVENT — each event is one delivery unit, so the
// consumer-configurable delivery-unit bound applies per emission, never
// cumulatively (a long-lived stream legitimately exceeds it in total).
// Mirrors asyncapi's sse-cap.test.ts and the Go SDK's
// TestDeliveryUnitBound_SSEPerEventNotCumulative /
// TestDeliveryUnitBound_SSETinyBoundRefusesLoudly.
describe("SSE size cap is per-event, not cumulative", () => {
  let server: Server;
  let port: number;

  afterAll(() => {
    server?.closeAllConnections();
    server?.close();
  });

  function spec() {
    return {
      openapi: "3.0.3",
      info: { title: "SSE Cap Test", version: "1.0.0" },
      servers: [{ url: `http://127.0.0.1:${port}` }],
      paths: {
        "/events": {
          get: {
            operationId: "subscribeEvents",
            responses: {
              "200": {
                description: "Stream of events",
                content: { "text/event-stream": {} },
              },
            },
          },
        },
      },
    };
  }

  it("keeps flowing across a >10MB cumulative stream of under-bound events", async () => {
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

    const invoker = new OpenAPIInvoker();
    const call = invoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec() },
      ref: "#/paths/~1events/get",
    });
    const events: unknown[] = [];
    for await (const v of call.outputs) events.push(v);
    await call.closed;

    expect(events).toHaveLength(6);
  });

  it("errors a single event larger than the default bound with ERR_RESPONSE_ERROR", async () => {
    const DEFAULT_MAX = 10 * 1024 * 1024;
    const payload = "x".repeat(DEFAULT_MAX + 16);

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

    const invoker = new OpenAPIInvoker();
    const call = invoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec() },
      ref: "#/paths/~1events/get",
    });

    await expect(call.closed).rejects.toMatchObject({ code: "ERR_RESPONSE_ERROR" });
  });

  it("honors a caller-tuned per-event delivery-unit bound (identity unchanged)", async () => {
    // The ruled knob (sdk-review ruling 4(a), 2026-07-20): a tiny
    // args.maxDeliveryUnitBytes trips the same abstract error identity; the
    // concrete SSE limit remains explicit native diagnostic evidence.
    const payload = "x".repeat(4096);

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

    const invoker = new OpenAPIInvoker();
    const call = invoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec() },
      ref: "#/paths/~1events/get",
      maxDeliveryUnitBytes: 1024,
    });

    await expect(call.closed).rejects.toMatchObject({
      code: "ERR_RESPONSE_ERROR",
      message: "Invocation result could not be processed",
      diagnostics: {
        openapiClient: {
          message: expect.stringContaining("SSE event exceeds 1024 byte limit"),
        },
      },
    });
  });
});

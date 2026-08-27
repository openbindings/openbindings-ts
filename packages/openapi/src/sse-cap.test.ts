import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, afterAll } from "vitest";
import { OpenAPIInvoker } from "./test-helpers.js";
import { BINDING_SPEC_OPENAPI_31 as BINDING_SPEC } from "./constants.js";

// SSE is unary on this binding line: the complete representation is one
// delivery unit, so the ordinary response bound applies to its total bytes.
describe("unary SSE size cap", () => {
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
      selector: "#/paths/~1events/get",
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
      selector: "#/paths/~1events/get",
      maxDeliveryUnitBytes: 1024,
    });

    const error = await call.closed.catch((caught: unknown) => caught) as { code?: string };
    expect(error.code).toBe("ERR_RESPONSE_ERROR");
    expect(Object.hasOwn(error, "data")).toBe(false);
    expect(Object.hasOwn(error, "diagnostics")).toBe(false);
  });
});

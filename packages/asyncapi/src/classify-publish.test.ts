import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

// C2f: a unary publish succeeds IFF the final status, after any redirects, is
// 2xx (ASYNC-P-06 / §9.4). A 3xx with no Location is not followed by fetch and
// is the reachable non-2xx window; before the fix, runUnaryPublish guarded
// failure with `>= 400`, so a 3xx read as success. The fix mirrors the SSE
// establishment path's strict-2xx test, so a 3xx maps via the shared status
// table to ERR_EXECUTION_FAILED — identical to the Go SDK.

function makeSpec(port: number) {
  return {
    asyncapi: "3.0.0",
    info: { title: "T", version: "1.0.0" },
    servers: { test: { host: `127.0.0.1:${port}`, protocol: "http" } },
    channels: {
      messages: {
        address: "/messages",
        messages: { Msg: { contentType: "application/json", payload: { type: "object" } } },
      },
    },
    operations: {
      sendOpenMessage: {
        action: "receive" as const,
        channel: { $ref: "#/channels/messages" },
        messages: [{ $ref: "#/channels/messages/messages/Msg" }],
        bindings: { http: { method: "POST" } },
      },
    },
  };
}

describe("AsyncAPI unary-publish classification (§9.4)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        // 3xx with NO Location: fetch returns it as final.
        res.writeHead(302, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not accepted" }));
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

  function source() {
    return { bindingSpec: BINDING_SPEC, content: JSON.stringify(makeSpec(port)) };
  }

  it("fails a unary publish whose final status is 3xx (ASYNC-P-06)", async () => {
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({ source: source(), ref: "#/operations/sendOpenMessage" });

    await call.write({ text: "hi" });
    const error = await call.closed.catch((caught: unknown) => caught) as {
      code?: string;
      data?: unknown;
    };
    expect(error.code).toBe("ERR_EXECUTION_FAILED");
    expect(Object.hasOwn(error, "data")).toBe(false);
  });
});

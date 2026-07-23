import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

// Regression coverage for openbindings.asyncapi@1 §9.3 (ASYNC-P-05): the
// per-message EFFECTIVE content type is the message's `contentType`, else
// the document's `defaultContentType` — still the declared lane, never
// payload sniffing. A publish output decodes by the REPLY-side governing
// declarations (direction-correct decode), so the fixture declares a reply.
// Mirrors the Go SDK's TestEffectiveContentType_FallsBackToDocumentDefault,
// exercised end-to-end.
describe("defaultContentType fallback", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((_req: IncomingMessage, res: ServerResponse) => {
        // The message inherits its declaration from defaultContentType; the
        // actual HTTP representation must agree with that declaration.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, n: 1 }));
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

  it("decodes a message with no per-message contentType as JSON via the document default", async () => {
    const spec = {
      asyncapi: "3.0.0",
      defaultContentType: "application/json",
      info: { title: "t", version: "1.0.0" },
      servers: { test: { host: `127.0.0.1:${port}`, protocol: "http" } },
      channels: {
        // The message declares no contentType of its own.
        reply: { address: "/reply", messages: { Msg: { payload: { type: "object" } } } },
      },
      operations: {
        ask: {
          action: "receive" as const,
          channel: { $ref: "#/channels/reply" },
          messages: [{ $ref: "#/channels/reply/messages/Msg" }],
          // The response decodes by the REPLY-side governing set
          // (direction-correct decode, ASYNC-P-05).
          reply: { messages: [{ $ref: "#/channels/reply/messages/Msg" }] },
          bindings: { http: { method: "POST" } },
        },
      },
    };

    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/ask",
    });
    await call.write({});
    const outputs: unknown[] = [];
    for await (const v of call.outputs) outputs.push(v);
    await call.closed;

    // A parsed object (JSON-decoded), not the raw response text.
    expect(outputs).toEqual([{ ok: true, n: 1 }]);
  });
});

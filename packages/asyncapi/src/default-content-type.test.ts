import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

// Regression coverage for spec/formats/asyncapi.md: decode looks at "the
// declared message contentType decides (operation messages, then reply
// messages, then the document's defaultContentType)". Mirrors the Go SDK's
// TestDeclaredContentType_FallsBackToDocumentDefault, exercised end-to-end
// since declaredContentType is not part of the TS package's public surface.
describe("defaultContentType fallback", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((_req: IncomingMessage, res: ServerResponse) => {
        // Deliberately NO Content-Type header on the response: the decode
        // lane must not sniff it, only consult the document's declared
        // defaultContentType.
        res.writeHead(200);
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

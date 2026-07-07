import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { single, CONTEXT_REQUIRED, type OBInterface } from "@openbindings/sdk";
import { AsyncAPIInvoker, AsyncAPISynthesizer } from "./invoker.js";
import { FORMAT_TOKEN } from "./constants.js";

const SECRET = "test-token-abc";

function makeAsyncAPISpec(port: number) {
  return {
    asyncapi: "3.0.0",
    info: { title: "Test API", version: "1.0.0" },
    servers: {
      test: {
        host: `127.0.0.1:${port}`,
        protocol: "http",
      },
    },
    channels: {
      messages: {
        address: "/messages",
        messages: {
          Msg: { contentType: "application/json", payload: { type: "object" } },
        },
      },
      events: {
        address: "/events",
        messages: {
          Event: { contentType: "application/json", payload: { type: "object" } },
        },
      },
      stream: {
        address: "/stream",
        messages: {
          Tick: { contentType: "application/json", payload: { type: "object" } },
        },
      },
    },
    operations: {
      // Declares bearer security: missing context must challenge
      // CONTEXT_REQUIRED before any I/O.
      sendMessage: {
        action: "send" as const,
        channel: { $ref: "#/channels/messages" },
        messages: [{ $ref: "#/channels/messages/messages/Msg" }],
        security: [{ $ref: "#/components/securitySchemes/bearer" }],
      },
      // No declared security: the server's 401 surfaces as ERR_AUTH_REQUIRED.
      sendOpenMessage: {
        action: "send" as const,
        channel: { $ref: "#/channels/messages" },
        messages: [{ $ref: "#/channels/messages/messages/Msg" }],
      },
      receiveEvents: {
        action: "receive" as const,
        channel: { $ref: "#/channels/events" },
        messages: [{ $ref: "#/channels/events/messages/Event" }],
        security: [{ $ref: "#/components/securitySchemes/bearer" }],
      },
      // Unsecured, never-ending stream: exercises caller cancellation.
      receiveStream: {
        action: "receive" as const,
        channel: { $ref: "#/channels/stream" },
        messages: [{ $ref: "#/channels/stream/messages/Tick" }],
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
      },
    },
  };
}

describe("AsyncAPI binding invoker (real HTTP)", () => {
  let server: Server;
  let port: number;
  let requestCount = 0;

  function handler(req: IncomingMessage, res: ServerResponse) {
    requestCount++;

    // POST /messages — requires Bearer token, echoes body
    if (req.url === "/messages" && req.method === "POST") {
      if (req.headers.authorization !== `Bearer ${SECRET}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ echo: parsed }));
      });
      return;
    }

    // GET /events — requires Bearer token, sends 2 SSE events then closes
    if (req.url === "/events" && req.method === "GET") {
      if (req.headers.authorization !== `Bearer ${SECRET}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("data: {\"seq\":1}\n\n");
      res.write("data: {\"seq\":2}\n\n");
      res.end();
      return;
    }

    // GET /stream — sends one SSE event, then keeps the connection open
    if (req.url === "/stream" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("data: {\"tick\":1}\n\n");
      // Never ends; the client cancels.
      return;
    }

    res.writeHead(404);
    res.end();
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer(handler);
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
    return {
      format: FORMAT_TOKEN,
      content: JSON.stringify(makeAsyncAPISpec(port)),
    };
  }

  async function buildOBI(): Promise<OBInterface> {
    const synthesizer = new AsyncAPISynthesizer();
    return synthesizer.synthesizeInterface({
      sources: [{ format: FORMAT_TOKEN, content: JSON.stringify(makeAsyncAPISpec(port)) }],
    });
  }

  it("challenges CONTEXT_REQUIRED before any I/O when context lacks declared credentials", async () => {
    const before = requestCount;
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({ source: source(), ref: "#/operations/sendMessage" });

    await expect(call.closed).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      details: {
        target: `http://127.0.0.1:${port}`,
        alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
      },
    });
    expect(requestCount).toBe(before); // no request was dispatched
  });

  it("applies bearer credentials on unary send and yields the response", async () => {
    const obi = await buildOBI();
    const binding = obi.bindings?.["sendMessage.asyncapi"];
    if (!binding?.ref) throw new Error("expected sendMessage.asyncapi binding with ref");

    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: source(),
      ref: binding.ref,
      context: { bearerToken: SECRET },
    });

    await call.write({ text: "hello" });
    const out = await single(call.outputs);
    expect(out).toEqual({ echo: { text: "hello" } });
    await call.closed;

    const header = await call.header;
    expect(header["content-type"]).toEqual(["application/json"]);
  });

  it("maps a server 401 to ERR_AUTH_REQUIRED with status and body details", async () => {
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({ source: source(), ref: "#/operations/sendOpenMessage" });

    await call.write({ text: "hi" });
    // Details carry the RAW capture (diagnostics, never a decoded value).
    await expect(call.closed).rejects.toMatchObject({
      code: "ERR_AUTH_REQUIRED",
      details: { status: 401, body: JSON.stringify({ error: "unauthorized" }) },
    });
  });

  it("fires ERR_MISSING_INPUT when input closes without a message on send", async () => {
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({ source: source(), ref: "#/operations/sendOpenMessage" });

    await call.close();
    await expect(call.closed).rejects.toMatchObject({ code: "ERR_MISSING_INPUT" });
  });

  it("streams SSE events as bare outputs on receive", async () => {
    const obi = await buildOBI();
    const binding = obi.bindings?.["receiveEvents.asyncapi"];
    if (!binding?.ref) throw new Error("expected receiveEvents.asyncapi binding with ref");

    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: source(),
      ref: binding.ref,
      context: { bearerToken: SECRET },
    });

    const events: unknown[] = [];
    for await (const m of call.outputs) events.push(m);
    expect(events).toEqual([{ seq: 1 }, { seq: 2 }]);
    await call.closed;
  });

  it("challenges CONTEXT_REQUIRED on receive when context lacks credentials", async () => {
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({ source: source(), ref: "#/operations/receiveEvents" });

    await expect(call.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
  });

  it("cancels a live subscription when the caller abandons the outputs", async () => {
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({ source: source(), ref: "#/operations/receiveStream" });

    let first: unknown;
    for await (const m of call.outputs) {
      first = m;
      break; // abandoning the sequence cancels the invocation
    }
    expect(first).toEqual({ tick: 1 });
    await expect(call.closed).rejects.toMatchObject({ code: "ERR_CANCELLED" });
  });

  it("fires ERR_REF_NOT_FOUND for an unknown operation", async () => {
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({ source: source(), ref: "#/operations/nope" });

    await expect(call.closed).rejects.toMatchObject({ code: "ERR_REF_NOT_FOUND" });
  });

  describe("prepareBinding", () => {
    it("reports the bearer requirement when context lacks it", async () => {
      const invoker = new AsyncAPIInvoker();
      const details = await invoker.prepareBinding({
        source: source(),
        ref: "#/operations/sendMessage",
      });

      expect(details).toMatchObject({
        target: `http://127.0.0.1:${port}`,
        alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
      });
    });

    it("returns null when context satisfies the requirement", async () => {
      const invoker = new AsyncAPIInvoker();
      const details = await invoker.prepareBinding({
        source: source(),
        ref: "#/operations/sendMessage",
        context: { bearerToken: SECRET },
      });

      expect(details).toBeNull();
    });

    it("returns null for operations without declared security", async () => {
      const invoker = new AsyncAPIInvoker();
      const details = await invoker.prepareBinding({
        source: source(),
        ref: "#/operations/sendOpenMessage",
      });

      expect(details).toBeNull();
    });

    it("maps apiKey and basic schemes to alternative requirement families", async () => {
      const spec = {
        asyncapi: "3.0.0",
        info: { title: "Multi-auth", version: "1.0.0" },
        servers: { prod: { host: "api.example.com", protocol: "https" } },
        channels: {
          pub: { address: "/pub", messages: { Msg: { payload: { type: "object" } } } },
        },
        operations: {
          publish: {
            action: "send" as const,
            channel: { $ref: "#/channels/pub" },
            security: [
              { type: "apiKey", in: "header", name: "X-Key" },
              { type: "userPassword" },
            ],
          },
        },
      };

      const invoker = new AsyncAPIInvoker();
      const details = await invoker.prepareBinding({
        source: { format: FORMAT_TOKEN, content: spec },
        ref: "#/operations/publish",
      });
      expect(details).toMatchObject({
        target: "https://api.example.com",
        alternatives: [
          { requirements: [{ type: "auth.apiKey" }] },
          { requirements: [{ type: "auth.basic" }] },
        ],
      });

      // Satisfying any one alternative suffices.
      const withKey = await invoker.prepareBinding({
        source: { format: FORMAT_TOKEN, content: spec },
        ref: "#/operations/publish",
        context: { apiKey: "k-123" },
      });
      expect(withKey).toBeNull();
    });
  });
});

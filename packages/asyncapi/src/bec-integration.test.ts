import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { single, CONTEXT_REQUIRED, type InvocationError, type OBInterface } from "@openbindings/sdk";
import { AsyncAPIInvoker, AsyncAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

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
        action: "receive" as const,
        channel: { $ref: "#/channels/messages" },
        messages: [{ $ref: "#/channels/messages/messages/Msg" }],
        reply: { messages: [{ $ref: "#/channels/messages/messages/Msg" }] },
        bindings: { http: { method: "POST" } },
        security: [{ $ref: "#/components/securitySchemes/bearer" }],
      },
      // No declared security: the server's 401 is an unsuccessful execution;
      // the native status remains diagnostic rather than becoming a portable code.
      sendOpenMessage: {
        action: "receive" as const,
        channel: { $ref: "#/channels/messages" },
        messages: [{ $ref: "#/channels/messages/messages/Msg" }],
        reply: { messages: [{ $ref: "#/channels/messages/messages/Msg" }] },
        bindings: { http: { method: "POST" } },
      },
      receiveEvents: {
        action: "send" as const,
        channel: { $ref: "#/channels/events" },
        messages: [{ $ref: "#/channels/events/messages/Event" }],
        security: [{ $ref: "#/components/securitySchemes/bearer" }],
      },
      // Unsecured, never-ending stream: exercises caller cancellation.
      receiveStream: {
        action: "send" as const,
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
      bindingSpec: BINDING_SPEC,
      content: JSON.stringify(makeAsyncAPISpec(port)),
    };
  }

  async function buildOBI(): Promise<OBInterface> {
    const synthesizer = new AsyncAPISynthesizer();
    return synthesizer.synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: JSON.stringify(makeAsyncAPISpec(port)) }],
    });
  }

  it("challenges CONTEXT_REQUIRED before any I/O when context lacks declared credentials", async () => {
    const before = requestCount;
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({ source: source(), ref: "#/operations/sendMessage" });

    await expect(call.closed).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      data: {
        target: `http://127.0.0.1:${port}`,
        // R2.a ruling: name is the components.securitySchemes key the
        // operation's $ref resolves through.
        alternatives: [{ requirements: [{ type: "auth.bearer", name: "bearer" }] }],
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
  });

  it("keeps a server 401 structural without exposing native evidence", async () => {
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({ source: source(), ref: "#/operations/sendOpenMessage" });

    await call.write({ text: "hi" });
    const error = await call.closed.catch((caught: unknown) => caught) as InvocationError;
    expect(error.code).toBe("ERR_EXECUTION_FAILED");
    expect(Object.hasOwn(error, "data")).toBe(false);
    expect(Object.hasOwn(error, "diagnostics")).toBe(false);
  });

  it("fires ERR_MISSING_INPUT when input closes without a message on send", async () => {
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({ source: source(), ref: "#/operations/sendOpenMessage" });

    await call.close();
    await expect(call.closed).rejects.toMatchObject({ code: "ERR_REFUSED" });
  });

  it("synthesizes standalone HTTP send but lets the built-in driver refuse before dispatch", async () => {
    const before = requestCount;
    const obi = await buildOBI();
    expect(obi.bindings?.["receiveEvents.asyncapi"]).toMatchObject({
      ref: "#/operations/receiveEvents",
    });

    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: source(),
      ref: "#/operations/receiveEvents",
      context: { bearerToken: SECRET },
    });

    await expect(call.closed).rejects.toMatchObject({ code: "ERR_REFUSED" });
    expect(requestCount).toBe(before);
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
        alternatives: [{ requirements: [{ type: "auth.bearer", name: "bearer" }] }],
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
        source: { bindingSpec: BINDING_SPEC, content: spec },
        ref: "#/operations/publish",
      });
      expect(details).toMatchObject({
        target: "https://api.example.com",
        alternatives: [
          { requirements: [{ type: "auth.apiKey" }] },
          { requirements: [{ type: "auth.basic" }] },
        ],
      });
      // R2.a ruling: these schemes are declared INLINE in `security` (no
      // components.securitySchemes, no $ref) — no addressable name exists,
      // so the requirements carry no `name`.
      expect(details?.alternatives[0]!.requirements[0]).not.toHaveProperty("name");
      expect(details?.alternatives[1]!.requirements[0]).not.toHaveProperty("name");

      // Satisfying any one alternative suffices.
      const withKey = await invoker.prepareBinding({
        source: { bindingSpec: BINDING_SPEC, content: spec },
        ref: "#/operations/publish",
        context: { apiKey: "k-123" },
      });
      expect(withKey).toBeNull();
    });
  });
});

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  MemoryStore,
  normalizeContextKey,
  type OBInterface,
  type StreamEvent,
} from "@openbindings/sdk";
import { AsyncAPIExecutor, AsyncAPICreator } from "./executor.js";
import { parseAsyncAPIDocument } from "./util.js";

async function collectStream(
  stream: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

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
          Msg: { payload: { type: "object" } },
        },
      },
      events: {
        address: "/events",
        messages: {
          Event: { payload: { type: "object" } },
        },
      },
    },
    operations: {
      sendMessage: {
        action: "send" as const,
        channel: { $ref: "#/channels/messages" },
        messages: [{ $ref: "#/channels/messages/messages/Msg" }],
      },
      receiveEvents: {
        action: "receive" as const,
        channel: { $ref: "#/channels/events" },
        messages: [{ $ref: "#/channels/events/messages/Event" }],
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
      },
    },
  };
}

function handler(port: number) {
  return (req: IncomingMessage, res: ServerResponse) => {
    // Serve the spec itself
    if (req.url === "/asyncapi.json" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(makeAsyncAPISpec(port)));
      return;
    }

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

    res.writeHead(404);
    res.end();
  };
}

describe("BEC Integration (AsyncAPI, real HTTP)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((_req, _res) => {});
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        server.removeAllListeners("request");
        server.on("request", handler(port));
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  async function buildOBI(): Promise<OBInterface> {
    const creator = new AsyncAPICreator();
    const specContent = JSON.stringify(makeAsyncAPISpec(port));
    return creator.createInterface({
      sources: [{ format: "asyncapi@^3.0.0", content: specContent }],
    });
  }

  it("returns 401 when no credentials are stored", async () => {
    const obi = await buildOBI();
    const binding = obi.bindings?.["sendMessage.asyncapi"];
    if (!binding?.ref) throw new Error("expected sendMessage.asyncapi binding with ref");

    const specContent = JSON.stringify(makeAsyncAPISpec(port));
    const asyncExecutor = new AsyncAPIExecutor();
    const events = await collectStream(
      asyncExecutor.executeBinding({
        ref: binding.ref,
        source: { format: "asyncapi@^3.0.0", content: specContent },
        input: { text: "hello" },
      }),
    );

    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.error).toBeDefined();
    expect(last.error!.code).toBe("auth_required");
  });

  it("succeeds with pre-stored bearer credentials on send", async () => {
    const store = new MemoryStore();
    const contextKey = normalizeContextKey(`http://127.0.0.1:${port}`);
    await store.set(contextKey, { bearerToken: SECRET });

    const obi = await buildOBI();
    const binding = obi.bindings?.["sendMessage.asyncapi"];
    if (!binding?.ref) throw new Error("expected sendMessage.asyncapi binding with ref");
    const specContent = JSON.stringify(makeAsyncAPISpec(port));

    const asyncExecutor = new AsyncAPIExecutor();
    const events = await collectStream(
      asyncExecutor.executeBinding({
        ref: binding.ref,
        source: { format: "asyncapi@^3.0.0", content: specContent },
        input: { text: "hello" },
        context: { bearerToken: SECRET },
        store,
      }),
    );

    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev.error).toBeUndefined();
    expect(ev.data).toEqual({ echo: { text: "hello" } });
    expect(ev.status).toBe(200);
  });

  it("receives SSE events with credentials", async () => {
    const obi = await buildOBI();
    const binding = obi.bindings?.["receiveEvents.asyncapi"];
    if (!binding?.ref) throw new Error("expected receiveEvents.asyncapi binding with ref");
    const specContent = JSON.stringify(makeAsyncAPISpec(port));

    const asyncExecutor = new AsyncAPIExecutor();
    const events = await collectStream(
      asyncExecutor.executeBinding({
        ref: binding.ref,
        source: { format: "asyncapi@^3.0.0", content: specContent },
        context: { bearerToken: SECRET },
      }),
    );

    // Should receive 2 data events
    const dataEvents = events.filter((e) => e.data !== undefined);
    expect(dataEvents.length).toBe(2);
    expect(dataEvents[0].data).toEqual({ seq: 1 });
    expect(dataEvents[1].data).toEqual({ seq: 2 });
  });

  it("SSE receive returns error when no credentials", async () => {
    const obi = await buildOBI();
    const binding = obi.bindings?.["receiveEvents.asyncapi"];
    if (!binding?.ref) throw new Error("expected receiveEvents.asyncapi binding with ref");
    const specContent = JSON.stringify(makeAsyncAPISpec(port));

    const asyncExecutor = new AsyncAPIExecutor();
    const events = await collectStream(
      asyncExecutor.executeBinding({
        ref: binding.ref,
        source: { format: "asyncapi@^3.0.0", content: specContent },
      }),
    );

    // Without credentials, should get an error (SSE connect fails with non-2xx)
    expect(events.length).toBeGreaterThan(0);
    const errorEvent = events.find((e) => e.error !== undefined);
    expect(errorEvent).toBeDefined();
  });
});

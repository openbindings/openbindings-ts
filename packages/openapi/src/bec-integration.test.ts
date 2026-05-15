import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  OperationInvoker,
  MemoryStore,
  fetchInterface,
  normalizeContextKey,
  type OBInterface,
  type PlatformCallbacks,
  type InvocationOutput,
} from "@openbindings/sdk";
import { OpenAPIInvoker, OpenAPICreator } from "./invoker.js";


async function collectStream(stream: AsyncIterable<InvocationOutput>): Promise<{ output?: unknown; error?: { code: string; message: string } }> {
  let lastOutput: unknown;
  let firstError: { code: string; message: string } | undefined;
  for await (const ev of stream) {
    if (ev.error && !firstError) firstError = ev.error;
    if (ev.output !== undefined) lastOutput = ev.output;
  }
  if (firstError) return { error: firstError };
  return { output: lastOutput };
}

const SECRET = "test-token-123";

function makeOpenAPISpec(port: number) {
  return {
    openapi: "3.0.3",
    info: { title: "Test API", version: "1.0.0" },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          summary: "List all items",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        name: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/items/{id}": {
        get: {
          operationId: "getItem",
          summary: "Get a single item",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
  };
}

const ITEMS = [
  { id: 1, name: "Alpha" },
  { id: 2, name: "Bravo" },
];

function handler(port: number) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/openapi.json" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(makeOpenAPISpec(port)));
      return;
    }

    if (req.url === "/items" && req.method === "GET") {
      if (req.headers.authorization !== `Bearer ${SECRET}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ITEMS));
      return;
    }

    const itemMatch = req.url?.match(/^\/items\/(\d+)$/);
    if (itemMatch && req.method === "GET") {
      if (req.headers.authorization !== `Bearer ${SECRET}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const item = ITEMS.find((i) => i.id === Number(itemMatch[1]));
      if (!item) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(item));
      return;
    }

    res.writeHead(404);
    res.end();
  };
}

const requiredInterface: OBInterface = {
  openbindings: "0.2",
  operations: {
    listItems: { kind: "method" },
    getItem: { kind: "method" },
  },
  bindings: {},
  sources: {},
};

describe("BEC Integration (real HTTP)", () => {
  let server: Server;
  let port: number;
  let specURL: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((_req, _res) => {});
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        specURL = `http://127.0.0.1:${port}/openapi.json`;
        server.removeAllListeners("request");
        server.on("request", handler(port));
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  async function fetch(): Promise<OBInterface> {
    const { iface } = await fetchInterface(specURL, { creators: [new OpenAPICreator()] });
    return iface;
  }

  function invokeListItems(opInv: OperationInvoker, iface: OBInterface) {
    return collectStream(opInv.invoke({ interface: iface, operation: "listItems" }));
  }

  function invokeGetItem(opInv: OperationInvoker, iface: OBInterface, input: { id: number }) {
    return collectStream(opInv.invoke({ interface: iface, operation: "getItem", input }));
  }

  it("returns 401 when no credentials are stored (no prompt/retry)", async () => {
    const store = new MemoryStore();
    const opInvoker = new OperationInvoker([new OpenAPIInvoker()], { contextStore: store });
    const iface = await fetch();

    const result = await invokeListItems(opInvoker, iface);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("auth_required");
  });

  it("succeeds when credentials are pre-stored, reuses across operations", async () => {
    const store = new MemoryStore();
    const contextKey = normalizeContextKey(`http://127.0.0.1:${port}`);
    await store.set(contextKey, { bearerToken: SECRET });

    const opInvoker = new OperationInvoker([new OpenAPIInvoker()], { contextStore: store });
    const iface = await fetch();

    const result1 = await invokeListItems(opInvoker, iface);
    expect(result1.error).toBeUndefined();
    expect(result1.output).toEqual(ITEMS);

    const result2 = await invokeListItems(opInvoker, iface);
    expect(result2.error).toBeUndefined();
    expect(result2.output).toEqual(ITEMS);

    const result3 = await invokeGetItem(opInvoker, iface, { id: 1 });
    expect(result3.error).toBeUndefined();
    expect(result3.output).toEqual({ id: 1, name: "Alpha" });
  });

  it("returns 401 error when no prompt callback is available", async () => {
    const store = new MemoryStore();
    const opInvoker = new OperationInvoker([new OpenAPIInvoker()], { contextStore: store });
    const iface = await fetch();

    const result = await invokeListItems(opInvoker, iface);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("auth_required");
  });

  it("skips prompt when credentials are pre-stored", async () => {
    const store = new MemoryStore();
    let promptCount = 0;

    const callbacks: PlatformCallbacks = {
      prompt: async () => {
        promptCount++;
        return "should-not-be-called";
      },
    };

    const contextKey = normalizeContextKey(`http://127.0.0.1:${port}`);
    await store.set(contextKey, { bearerToken: SECRET });

    const opInvoker = new OperationInvoker(
      [new OpenAPIInvoker()],
      { contextStore: store, platformCallbacks: callbacks },
    );
    const iface = await fetch();

    const result = await invokeListItems(opInvoker, iface);
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual(ITEMS);
    expect(promptCount).toBe(0);
  });

  it("isolated stores do not share credentials", async () => {
    const store1 = new MemoryStore();
    const store2 = new MemoryStore();
    const contextKey = normalizeContextKey(`http://127.0.0.1:${port}`);
    await store1.set(contextKey, { bearerToken: SECRET });

    const opInvoker1 = new OperationInvoker([new OpenAPIInvoker()], { contextStore: store1 });
    const opInvoker2 = new OperationInvoker([new OpenAPIInvoker()], { contextStore: store2 });
    const iface = await fetch();

    const result1 = await invokeListItems(opInvoker1, iface);
    expect(result1.error).toBeUndefined();
    expect(result1.output).toEqual(ITEMS);

    const result2 = await invokeListItems(opInvoker2, iface);
    expect(result2.error).toBeDefined();
    expect(result2.error!.code).toBe("auth_required");
  });
});

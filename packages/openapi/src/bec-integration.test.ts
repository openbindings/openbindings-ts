import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  InterfaceClient,
  OperationExecutor,
  MemoryStore,
  normalizeContextKey,
  type OBInterface,
  type PlatformCallbacks,
  type StreamEvent,
} from "@openbindings/sdk";
import { OpenAPIExecutor, OpenAPICreator } from "./executor.js";

async function collectStream(stream: AsyncIterable<StreamEvent>): Promise<{ data?: unknown; error?: { code: string; message: string } }> {
  let lastData: unknown;
  let firstError: { code: string; message: string } | undefined;
  for await (const ev of stream) {
    if (ev.error && !firstError) firstError = ev.error;
    if (ev.data !== undefined) lastData = ev.data;
  }
  if (firstError) return { error: firstError };
  return { data: lastData };
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

  it("returns 401 when no credentials are stored (no prompt/retry)", async () => {
    const store = new MemoryStore();

    const executor = new OperationExecutor(
      [new OpenAPIExecutor()],
      { contextStore: store },
    );

    const client = new InterfaceClient(requiredInterface, executor, {
      contextStore: store,
    });

    await client.resolve(specURL, { creators: [new OpenAPICreator()] });
    expect(client.state.kind).toBe("bound");

    // No credentials stored → 401 returned directly (no prompt, no retry)
    const result = await collectStream(client.execute("listItems" as any));
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("auth_required");
  });

  it("succeeds when credentials are pre-stored, reuses across operations", async () => {
    const store = new MemoryStore();
    const contextKey = normalizeContextKey(`http://127.0.0.1:${port}`);
    await store.set(contextKey, { bearerToken: SECRET });

    const executor = new OperationExecutor(
      [new OpenAPIExecutor()],
      { contextStore: store },
    );

    const client = new InterfaceClient(requiredInterface, executor, {
      contextStore: store,
    });

    await client.resolve(specURL, { creators: [new OpenAPICreator()] });
    expect(client.state.kind).toBe("bound");

    // First call: stored creds → 200
    const result1 = await collectStream(client.execute("listItems" as any));
    expect(result1.error).toBeUndefined();
    expect(result1.data).toEqual(ITEMS);

    // Second call: same stored creds → 200
    const result2 = await collectStream(client.execute("listItems" as any));
    expect(result2.error).toBeUndefined();
    expect(result2.data).toEqual(ITEMS);

    // Different operation on the same origin reuses the stored credential
    const result3 = await collectStream(client.execute("getItem" as any, { id: 1 } as any));
    expect(result3.error).toBeUndefined();
    expect(result3.data).toEqual({ id: 1, name: "Alpha" });
  });

  it("returns 401 error when no prompt callback is available", async () => {
    const store = new MemoryStore();

    const executor = new OperationExecutor(
      [new OpenAPIExecutor()],
      { contextStore: store },
    );

    const client = new InterfaceClient(requiredInterface, executor, {
      contextStore: store,
    });

    await client.resolve(specURL, { creators: [new OpenAPICreator()] });
    expect(client.state.kind).toBe("bound");

    const result = await collectStream(client.execute("listItems" as any));
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

    // Pre-store credentials under the normalized server key
    const contextKey = normalizeContextKey(`http://127.0.0.1:${port}`);
    await store.set(contextKey, { bearerToken: SECRET });

    const executor = new OperationExecutor(
      [new OpenAPIExecutor()],
      { contextStore: store, platformCallbacks: callbacks },
    );

    const client = new InterfaceClient(requiredInterface, executor, {
      contextStore: store,
      platformCallbacks: callbacks,
    });

    await client.resolve(specURL, { creators: [new OpenAPICreator()] });
    expect(client.state.kind).toBe("bound");

    const result = await collectStream(client.execute("listItems" as any));
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual(ITEMS);
    expect(promptCount).toBe(0);
  });

  it("isolated stores do not share credentials", async () => {
    const store1 = new MemoryStore();
    const store2 = new MemoryStore();
    const contextKey = normalizeContextKey(`http://127.0.0.1:${port}`);

    // Only store1 has credentials
    await store1.set(contextKey, { bearerToken: SECRET });

    const executor1 = new OperationExecutor(
      [new OpenAPIExecutor()],
      { contextStore: store1 },
    );
    const executor2 = new OperationExecutor(
      [new OpenAPIExecutor()],
      { contextStore: store2 },
    );

    const client1 = new InterfaceClient(requiredInterface, executor1, {
      contextStore: store1,
    });
    const client2 = new InterfaceClient(requiredInterface, executor2, {
      contextStore: store2,
    });

    await client1.resolve(specURL, { creators: [new OpenAPICreator()] });
    await client2.resolve(specURL, { creators: [new OpenAPICreator()] });

    // client1 has credentials → succeeds
    const result1 = await collectStream(client1.execute("listItems" as any));
    expect(result1.error).toBeUndefined();
    expect(result1.data).toEqual(ITEMS);

    // client2 has no credentials → 401
    const result2 = await collectStream(client2.execute("listItems" as any));
    expect(result2.error).toBeDefined();
    expect(result2.error!.code).toBe("auth_required");
  });
});

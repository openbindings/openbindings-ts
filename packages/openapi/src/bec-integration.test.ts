import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jsonata from "jsonata";
import { type OBInterface } from "@openbindings/core";
import {
  OperationInvoker,
  normalizeEndpoint,
  single,
  operationSignature,
  storeContextResolver,
  CONTEXT_REQUIRED,
  ERR_PROTOCOL,
  type ContextStore,
  type ContextRequiredDetails,
  type InvocationError,
} from "@openbindings/invoke";
import { fetchInterface } from "@openbindings/synthesize";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./test-helpers.js";

const SECRET = "test-token-123";

// Minimal in-memory ContextStore: the SDK ships only the interface, so tests
// supply their own backing.
class MemoryStore implements ContextStore {
  private data = new Map<string, Record<string, unknown>>();
  async get(key: string): Promise<Record<string, unknown> | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: Record<string, unknown> | null): Promise<void> {
    if (value == null) {
      this.data.delete(key);
      return;
    }
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

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

let protectedHits = 0;

function handler(port: number) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/openapi.json" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(makeOpenAPISpec(port)));
      return;
    }

    if (req.url === "/items" && req.method === "GET") {
      protectedHits++;
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
      protectedHits++;
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

  async function fetchIface(): Promise<OBInterface> {
    const { iface } = await fetchInterface(specURL, { synthesizers: [new OpenAPISynthesizer()] });
    return iface;
  }

  // The raw target the binding addresses (challenge carries it verbatim).
  function targetURL(): string {
    return `http://127.0.0.1:${port}`;
  }

  // The store key the resolver derives from that target.
  function contextKey(): string {
    return normalizeEndpoint(targetURL());
  }

  it("surfaces CONTEXT_REQUIRED without hitting the API when no credentials are available", async () => {
    const opInvoker = new OperationInvoker([new OpenAPIInvoker()]);
    const iface = await fetchIface();

    const before = protectedHits;
    const call = opInvoker.invoke(iface, operationSignature("listItems"));

    await expect(call.closed).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      data: {
        target: targetURL(),
        alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
      },
    });
    expect(protectedHits).toBe(before);
  });

  it("succeeds when credentials are pre-stored, reuses across operations", async () => {
    const store = new MemoryStore();
    await store.set(contextKey(), { bearerToken: SECRET });

    const opInvoker = new OperationInvoker([new OpenAPIInvoker()], {
      contextResolver: storeContextResolver(store),
      transformEvaluator: { evaluate: (expression, data) => jsonata(expression).evaluate(data) },
    });
    const iface = await fetchIface();

    const call1 = opInvoker.invoke(iface, operationSignature("listItems"));
    await expect(single(call1.outputs)).resolves.toEqual(ITEMS);

    const call2 = opInvoker.invoke(iface, operationSignature("listItems"));
    await expect(single(call2.outputs)).resolves.toEqual(ITEMS);

    const call3 = opInvoker.invoke(iface, operationSignature("getItem"));
    await call3.write({ id: 1 });
    await expect(single(call3.outputs)).resolves.toEqual({ id: 1, name: "Alpha" });
  });

  it("does not consult the resolver when caller context suffices", async () => {
    let resolves = 0;
    const opInvoker = new OperationInvoker([new OpenAPIInvoker()], {
      contextResolver: (_details: ContextRequiredDetails) => {
        resolves++;
        return null;
      },
    });
    const iface = await fetchIface();

    const call = opInvoker.invoke(iface, operationSignature("listItems"), {
      context: { bearerToken: SECRET },
    });

    await expect(single(call.outputs)).resolves.toEqual(ITEMS);
    expect(resolves).toBe(0);
  });

  it("keeps credential rejection structural without exposing HTTP evidence", async () => {
    const store = new MemoryStore();
    await store.set(contextKey(), { bearerToken: "wrong-token" });

    const opInvoker = new OperationInvoker([new OpenAPIInvoker()], {
      contextResolver: storeContextResolver(store),
    });
    const iface = await fetchIface();

    const call = opInvoker.invoke(iface, operationSignature("listItems"));
    const error = await call.closed.catch((caught: unknown) => caught) as InvocationError;
    expect(error.code).toBe(ERR_PROTOCOL);
    expect(Object.hasOwn(error, "data")).toBe(false);
    expect(Object.hasOwn(error, "diagnostics")).toBe(false);
  });

  it("isolated stores do not share credentials", async () => {
    const store1 = new MemoryStore();
    const store2 = new MemoryStore();
    await store1.set(contextKey(), { bearerToken: SECRET });

    const opInvoker1 = new OperationInvoker([new OpenAPIInvoker()], {
      contextResolver: storeContextResolver(store1),
    });
    const opInvoker2 = new OperationInvoker([new OpenAPIInvoker()], {
      contextResolver: storeContextResolver(store2),
    });
    const iface = await fetchIface();

    const call1 = opInvoker1.invoke(iface, operationSignature("listItems"));
    await expect(single(call1.outputs)).resolves.toEqual(ITEMS);

    const call2 = opInvoker2.invoke(iface, operationSignature("listItems"));
    await expect(call2.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
  });

  it("prepareBinding reports the challenge once the document is cached", async () => {
    const invoker = new OpenAPIInvoker();
    const opInvoker = new OperationInvoker([invoker]);
    const iface = await fetchIface();

    const args = {
      source: { bindingSpec: "openbindings.openapi-3.1@1", location: specURL },
      selector: "#/paths/~1items/get",
    };

    // Nothing cached yet: preflight declines rather than fetching.
    await expect(invoker.prepareBinding(args)).resolves.toBeNull();

    // A (challenged) invocation loads and caches the document.
    await opInvoker.invoke(iface, operationSignature("listItems")).closed.catch(() => {});

    await expect(invoker.prepareBinding(args)).resolves.toMatchObject({
      target: targetURL(),
      alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
    });

    await expect(
      invoker.prepareBinding({ ...args, context: { bearerToken: SECRET } }),
    ).resolves.toBeNull();
  });
});

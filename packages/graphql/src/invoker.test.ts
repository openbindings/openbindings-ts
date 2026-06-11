import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ERR_AUTH_REQUIRED,
  ERR_CANCELLED,
  ERR_EXECUTION_FAILED,
  ERR_INVALID_REF,
  ERR_PERMISSION_DENIED,
  ERR_REF_NOT_FOUND,
  ERR_SOURCE_LOAD_FAILED,
  ERR_STREAM_ERROR,
  single,
} from "@openbindings/sdk";
import { GraphQLInvoker } from "./invoker.js";
import type { IntrospectionSchema } from "./introspection.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENDPOINT = "https://api.example.com/graphql";

const testSchema: IntrospectionSchema = {
  queryType: { kind: "OBJECT", name: "Query", ofType: null },
  mutationType: null,
  subscriptionType: { kind: "OBJECT", name: "Subscription", ofType: null },
  types: [
    {
      kind: "OBJECT", name: "Query",
      fields: [
        {
          name: "user",
          args: [{ name: "id", type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "ID", ofType: null } } }],
          type: { kind: "OBJECT", name: "User", ofType: null },
          isDeprecated: false,
        },
        { name: "ping", args: [], type: { kind: "SCALAR", name: "String", ofType: null }, isDeprecated: false },
      ],
    },
    {
      kind: "OBJECT", name: "User",
      fields: [
        { name: "id", type: { kind: "SCALAR", name: "ID", ofType: null }, args: [], isDeprecated: false },
        { name: "name", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false },
      ],
    },
    {
      kind: "OBJECT", name: "Subscription",
      fields: [
        { name: "onOrder", args: [], type: { kind: "OBJECT", name: "Order", ofType: null }, isDeprecated: false },
        {
          name: "onStatus",
          args: [{ name: "topic", type: { kind: "SCALAR", name: "String", ofType: null } }],
          type: { kind: "SCALAR", name: "String", ofType: null },
          isDeprecated: false,
        },
      ],
    },
    {
      kind: "OBJECT", name: "Order",
      fields: [
        { name: "id", type: { kind: "SCALAR", name: "ID", ofType: null }, args: [], isDeprecated: false },
        { name: "status", type: { kind: "SCALAR", name: "String", ofType: null }, args: [], isDeprecated: false },
      ],
    },
  ],
};

const source = { format: "graphql", location: ENDPOINT, content: testSchema };

interface CapturedRequest {
  url: string;
  body: { query: string; variables?: Record<string, unknown> };
  headers: Record<string, string>;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A fetch stub that records each GraphQL POST and responds via the handler. */
function mockFetch(respond: (body: { query: string; variables?: Record<string, unknown> }) => Response) {
  const calls: CapturedRequest[] = [];
  const fn: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables?: Record<string, unknown> };
    calls.push({ url: String(input), body, headers: (init?.headers ?? {}) as Record<string, string> });
    return respond(body);
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Unary (Query / Mutation)
// ---------------------------------------------------------------------------

describe("GraphQLInvoker unary", () => {
  it("invokes a query: write + single", async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({ data: { user: { id: "123", name: "Ada" } } }));
    const call = new GraphQLInvoker().invokeBinding({ source, ref: "Query/user", fetch: fn });

    await call.write({ id: "123" });
    await expect(single(call.outputs)).resolves.toEqual({ id: "123", name: "Ada" });
    await expect(call.closed).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].body.query).toBe("query($id: ID!) { user(id: $id) { id name } }");
    expect(calls[0].body.variables).toEqual({ id: "123" });
  });

  it("dispatches a no-argument field without any input (no-input recipe)", async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({ data: { ping: "pong" } }));
    const call = new GraphQLInvoker().invokeBinding({ source, ref: "Query/ping", fetch: fn });

    // No write, no close: the binding closes input on entry.
    await expect(single(call.outputs)).resolves.toBe("pong");
    expect(calls[0].body.variables).toBeUndefined();
  });

  it("treats close-without-write as empty variables", async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({ data: { user: null } }));
    const call = new GraphQLInvoker().invokeBinding({ source, ref: "Query/user", fetch: fn });

    await call.close();
    await expect(single(call.outputs)).resolves.toBeNull();
    expect(calls[0].body.variables).toBeUndefined();
  });

  it("exposes HTTP response headers as leading metadata", async () => {
    const { fn } = mockFetch(() =>
      jsonResponse({ data: { ping: "pong" } }, {
        headers: { "content-type": "application/json", "x-request-id": "r1" },
      }),
    );
    const call = new GraphQLInvoker().invokeBinding({ source, ref: "Query/ping", fetch: fn });

    await expect(single(call.outputs)).resolves.toBe("pong");
    await expect(call.header).resolves.toMatchObject({ "x-request-id": ["r1"] });
  });

  it("applies bearer context to the Authorization header", async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({ data: { ping: "pong" } }));
    const call = new GraphQLInvoker().invokeBinding({
      source, ref: "Query/ping", fetch: fn, context: { bearerToken: "tok_123" },
    });

    await expect(single(call.outputs)).resolves.toBe("pong");
    expect(calls[0].headers["Authorization"]).toBe("Bearer tok_123");
  });

  it("uses a prebuilt _query const and skips schema loading", async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({ data: { users: [{ id: "1" }] } }));
    const call = new GraphQLInvoker().invokeBinding({
      source: { format: "graphql", location: ENDPOINT }, // no inline content
      ref: "Query/users",
      inputSchema: {
        type: "object",
        properties: {
          _query: { type: "string", const: "query($limit: Int) { users(limit: $limit) { id } }" },
          limit: { type: "integer" },
        },
      },
      fetch: fn,
    });

    await call.write({ limit: 10 });
    await expect(single(call.outputs)).resolves.toEqual([{ id: "1" }]);

    // Exactly one request: no introspection round-trip.
    expect(calls).toHaveLength(1);
    expect(calls[0].body.query).toBe("query($limit: Int) { users(limit: $limit) { id } }");
    expect(calls[0].body.variables).toEqual({ limit: 10 });
  });

  it("dispatches a prebuilt _query with no variable properties without input", async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({ data: { users: [] } }));
    const call = new GraphQLInvoker().invokeBinding({
      source: { format: "graphql", location: ENDPOINT },
      ref: "Query/users",
      inputSchema: {
        type: "object",
        properties: { _query: { type: "string", const: "query { users { id } }" } },
      },
      fetch: fn,
    });

    await expect(single(call.outputs)).resolves.toEqual([]);
    expect(calls[0].body.variables).toBeUndefined();
  });

  it("introspects once per endpoint when no inline content is given", async () => {
    const { fn, calls } = mockFetch((body) =>
      body.query.includes("__schema")
        ? jsonResponse({ data: { __schema: testSchema } })
        : jsonResponse({ data: { ping: "pong" } }),
    );
    const invoker = new GraphQLInvoker();
    const src = { format: "graphql", location: ENDPOINT };

    await expect(single(invoker.invokeBinding({ source: src, ref: "Query/ping", fetch: fn }).outputs)).resolves.toBe("pong");
    await expect(single(invoker.invokeBinding({ source: src, ref: "Query/ping", fetch: fn }).outputs)).resolves.toBe("pong");

    const introspections = calls.filter((c) => c.body.query.includes("__schema"));
    expect(introspections).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("keys the introspection cache by the full endpoint URL, not the host", async () => {
    const { fn, calls } = mockFetch((body) =>
      body.query.includes("__schema")
        ? jsonResponse({ data: { __schema: testSchema } })
        : jsonResponse({ data: { ping: "pong" } }),
    );
    const invoker = new GraphQLInvoker();
    const srcA = { format: "graphql", location: "https://api.example.com/graphql" };
    const srcB = { format: "graphql", location: "https://api.example.com/tenant-b/graphql" };

    await expect(single(invoker.invokeBinding({ source: srcA, ref: "Query/ping", fetch: fn }).outputs)).resolves.toBe("pong");
    await expect(single(invoker.invokeBinding({ source: srcB, ref: "Query/ping", fetch: fn }).outputs)).resolves.toBe("pong");

    // Two endpoints on one host: each must be introspected separately.
    const introspections = calls.filter((c) => c.body.query.includes("__schema"));
    expect(introspections).toHaveLength(2);
    expect(new Set(introspections.map((c) => c.url)).size).toBe(2);
  });

  it("maps GraphQL response errors to ERR_EXECUTION_FAILED with errors details", async () => {
    const { fn } = mockFetch(() => jsonResponse({ errors: [{ message: "boom" }] }));
    const call = new GraphQLInvoker().invokeBinding({ source, ref: "Query/ping", fetch: fn });

    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      details: { errors: [{ message: "boom" }] },
    });
  });

  it("maps HTTP 401 to ERR_AUTH_REQUIRED with status and body details", async () => {
    const { fn } = mockFetch(() => new Response("denied", { status: 401 }));
    const call = new GraphQLInvoker().invokeBinding({ source, ref: "Query/ping", fetch: fn });

    await expect(call.closed).rejects.toMatchObject({
      code: ERR_AUTH_REQUIRED,
      details: { status: 401, body: "denied" },
    });
  });

  it("maps HTTP 403 to ERR_PERMISSION_DENIED", async () => {
    const { fn } = mockFetch(() => new Response("forbidden", { status: 403 }));
    const call = new GraphQLInvoker().invokeBinding({ source, ref: "Query/ping", fetch: fn });

    await expect(call.closed).rejects.toMatchObject({
      code: ERR_PERMISSION_DENIED,
      details: { status: 403 },
    });
  });

  it("fails a malformed ref pre-dispatch without any I/O", async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({ data: {} }));
    const call = new GraphQLInvoker().invokeBinding({ source, ref: "bogus", fetch: fn });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_INVALID_REF });
    expect(calls).toHaveLength(0);
  });

  it("fails a missing endpoint pre-dispatch with ERR_SOURCE_LOAD_FAILED", async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({ data: {} }));
    const call = new GraphQLInvoker().invokeBinding({
      source: { format: "graphql" }, ref: "Query/ping", fetch: fn,
    });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_SOURCE_LOAD_FAILED });
    expect(calls).toHaveLength(0);
  });

  it("fails an unknown field with ERR_REF_NOT_FOUND before dispatch", async () => {
    const { fn, calls } = mockFetch(() => jsonResponse({ data: {} }));
    const call = new GraphQLInvoker().invokeBinding({ source, ref: "Query/nope", fetch: fn });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_REF_NOT_FOUND });
    expect(calls).toHaveLength(0);
  });

  it("cancel aborts an in-flight request", async () => {
    const fn: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    const call = new GraphQLInvoker().invokeBinding({ source, ref: "Query/ping", fetch: fn });

    // Let the dispatch start, then cancel.
    await new Promise((r) => setTimeout(r, 0));
    await call.cancel();
    await expect(call.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
  });
});

// ---------------------------------------------------------------------------
// Subscriptions (graphql-transport-ws)
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;

  constructor(public url: string, public protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    // Auto-ack the handshake so tests only drive subscription frames.
    if (msg.type === "connection_init") {
      queueMicrotask(() => this.receive({ type: "connection_ack" }));
    }
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  // Test drivers.
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  fail(): void {
    this.onerror?.();
  }
}

describe("GraphQLInvoker subscriptions", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function start(ref: string, opts?: { context?: Record<string, unknown>; write?: Record<string, unknown> }) {
    const call = new GraphQLInvoker().invokeBinding({ source, ref, context: opts?.context });
    if (opts?.write) await call.write(opts.write);
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThan(0); });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.open();
    await vi.waitFor(() => { expect(ws.sent.some((m) => m.type === "subscribe")).toBe(true); });
    return { call, ws };
  }

  it("streams events with for-await and ends cleanly on complete", async () => {
    const { call, ws } = await start("Subscription/onOrder");

    ws.receive({ type: "next", payload: { data: { onOrder: { id: "o1", status: "created" } } } });
    ws.receive({ type: "next", payload: { data: { onOrder: { id: "o1", status: "paid" } } } });
    ws.receive({ type: "complete" });

    const events: unknown[] = [];
    for await (const ev of call.outputs) events.push(ev);
    expect(events).toEqual([
      { onOrder: { id: "o1", status: "created" } },
      { onOrder: { id: "o1", status: "paid" } },
    ]);
    await expect(call.closed).resolves.toBeUndefined();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("reads the first input as subscription variables", async () => {
    const { ws } = await start("Subscription/onStatus", { write: { topic: "orders" } });

    const subscribe = ws.sent.find((m) => m.type === "subscribe") as { payload: { query: string; variables?: unknown } };
    expect(subscribe.payload.query).toBe("subscription($topic: String) { onStatus(topic: $topic) }");
    expect(subscribe.payload.variables).toEqual({ topic: "orders" });
  });

  it("forwards auth via the connection_init payload", async () => {
    const { ws } = await start("Subscription/onOrder", { context: { bearerToken: "tok_ws" } });

    const init = ws.sent.find((m) => m.type === "connection_init") as { payload?: Record<string, unknown> };
    expect(init.payload).toEqual({ authorization: "Bearer tok_ws" });
  });

  it("maps a subscription error frame to ERR_EXECUTION_FAILED", async () => {
    const { call, ws } = await start("Subscription/onOrder");

    ws.receive({ type: "error", payload: [{ message: "subscribe failed" }] });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_EXECUTION_FAILED });
    await vi.waitFor(() => { expect(ws.readyState).toBe(FakeWebSocket.CLOSED); });
  });

  it("maps a mid-stream socket failure to ERR_STREAM_ERROR", async () => {
    const { call, ws } = await start("Subscription/onOrder");

    ws.receive({ type: "next", payload: { data: { onOrder: { id: "o1", status: "created" } } } });
    ws.fail();
    await expect(call.closed).rejects.toMatchObject({ code: ERR_STREAM_ERROR });
  });

  it("maps an abnormal post-ack close without a complete frame to ERR_STREAM_ERROR", async () => {
    const { call, ws } = await start("Subscription/onOrder");

    ws.receive({ type: "next", payload: { data: { onOrder: { id: "o1", status: "created" } } } });
    ws.close(); // server drops the connection without sending `complete`

    await expect(call.closed).rejects.toMatchObject({
      code: ERR_STREAM_ERROR,
      message: expect.stringContaining("before subscription complete"),
    });
  });

  it("bounds the event queue and fails ERR_STREAM_ERROR on backpressure overflow", async () => {
    const { call, ws } = await start("Subscription/onOrder");

    // Nobody drains the outputs; flood past the queue bound.
    for (let i = 0; i < 1100; i++) {
      ws.receive({ type: "next", payload: { data: { onOrder: { id: String(i), status: "s" } } } });
    }

    await expect(call.closed).rejects.toMatchObject({
      code: ERR_STREAM_ERROR,
      message: expect.stringContaining("backpressure overflow"),
    });
    await vi.waitFor(() => { expect(ws.readyState).toBe(FakeWebSocket.CLOSED); });
  });

  it("cancel tears down the WebSocket", async () => {
    const { call, ws } = await start("Subscription/onOrder");

    await call.cancel();
    await expect(call.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
    await vi.waitFor(() => { expect(ws.readyState).toBe(FakeWebSocket.CLOSED); });
  });
});

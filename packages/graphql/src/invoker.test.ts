import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_REQUIRED,
  ERR_EXECUTION_FAILED,
  ERR_REF_NOT_FOUND,
  ERR_SOURCE_CONFIG_ERROR,
  type Invocation,
} from "@openbindings/sdk";
import { BINDING_SPEC } from "./constants.js";
import { GraphQLInvoker, GraphQLSynthesizer } from "./invoker.js";
import type { GraphQLWebSocketInit } from "./configuration.js";

const endpoint = "https://api.example.test/graphql";
const schema = {
  queryType: { kind: "OBJECT", name: "RootQuery", ofType: null },
  mutationType: null,
  subscriptionType: { kind: "OBJECT", name: "RootSubscription", ofType: null },
  types: [
    {
      kind: "OBJECT",
      name: "RootQuery",
      fields: [
        {
          name: "viewer",
          args: [],
          type: { kind: "SCALAR", name: "String", ofType: null },
          isDeprecated: false,
        },
        {
          name: "health",
          args: [],
          type: { kind: "SCALAR", name: "String", ofType: null },
          isDeprecated: false,
        },
      ],
    },
    {
      kind: "OBJECT",
      name: "RootSubscription",
      fields: [
        {
          name: "updates",
          args: [],
          type: { kind: "SCALAR", name: "String", ofType: null },
          isDeprecated: false,
        },
      ],
    },
    { kind: "SCALAR", name: "String" },
  ],
};
const source = {
  bindingSpec: BINDING_SPEC,
  location: endpoint,
  content: { data: { __schema: schema } },
};

async function outputs(invocation: Invocation<unknown, unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of invocation.outputs) values.push(value);
  return values;
}

function response(
  body: unknown,
  status = 200,
  contentType = "application/graphql-response+json",
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType, ...headers },
  });
}

describe("GraphQLInvoker HTTP", () => {
  it("carries the exact document and wholesale variables, preserving the whole envelope", async () => {
    let dispatched: Record<string, unknown> | undefined;
    const fetchFn: typeof fetch = vi.fn(async (_url, init) => {
      dispatched = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response(
        { data: { viewer: null }, errors: [{ message: "resolver warning" }] },
        200,
        "application/graphql-response+json; charset=utf-8",
        { "x-request-id": "req-1" },
      );
    });
    const invocation = new GraphQLInvoker().invokeBinding({
      source,
      ref: "query/viewer",
      inputSchema: { type: "object" },
      context: {
        configuration: {
          document: {
            source: "query Viewer($id: ID!) { viewer(id: $id) }",
            operationName: "Viewer",
          },
        },
      },
      fetch: fetchFn,
    });
    await invocation.write({ id: "u-1", unused: 7, _query: "ordinary variable" });

    await expect(outputs(invocation)).resolves.toEqual([
      { data: { viewer: null }, errors: [{ message: "resolver warning" }] },
    ]);
    expect(dispatched).toEqual({
      query: "query Viewer($id: ID!) { viewer(id: $id) }",
      operationName: "Viewer",
      variables: { id: "u-1", unused: 7, _query: "ordinary variable" },
    });
    await expect(invocation.header).resolves.toMatchObject({ "x-request-id": ["req-1"] });
  });

  it("omits variables when caller input is absent", async () => {
    let dispatched: Record<string, unknown> | undefined;
    const invocation = new GraphQLInvoker().invokeBinding({
      source,
      ref: "query/health",
      context: { configuration: { document: "query { health }" } },
      fetch: vi.fn(async (_url, init) => {
        dispatched = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ data: { health: "ok" } });
      }),
    });
    await expect(outputs(invocation)).resolves.toEqual([{ data: { health: "ok" } }]);
    expect(dispatched).not.toHaveProperty("variables");
  });

  it("emits a +json request-error response even at HTTP 400", async () => {
    const body = { errors: [{ message: "request rejected" }] };
    const invocation = new GraphQLInvoker().invokeBinding({
      source,
      ref: "query/viewer",
      context: { configuration: { document: "query { viewer }" } },
      fetch: vi.fn(async () => response(body, 400)),
    });
    await expect(outputs(invocation)).resolves.toEqual([body]);
  });

  it("treats an application/json non-2xx response as terminal", async () => {
    const invocation = new GraphQLInvoker().invokeBinding({
      source,
      ref: "query/viewer",
      context: { configuration: { document: "query { viewer }" } },
      fetch: vi.fn(async () => response({ errors: [{ message: "rejected" }] }, 400, "application/json")),
    });
    await expect(invocation.closed).rejects.toMatchObject({ code: ERR_EXECUTION_FAILED });
  });

  it("challenges for a missing document before source loading or dispatch", async () => {
    const fetchFn = vi.fn();
    const invoker = new GraphQLInvoker();
    await expect(invoker.prepareBinding({ source, ref: "query/viewer" })).resolves.toMatchObject({
      alternatives: [{ requirements: [{ type: "config.value", point: "document" }] }],
    });
    const invocation = invoker.invokeBinding({ source: { bindingSpec: BINDING_SPEC, location: endpoint }, ref: "query/viewer", fetch: fetchFn });
    await expect(invocation.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses root mismatch and processor-owned header collision before dispatch", async () => {
    const fetchFn = vi.fn();
    const mismatch = new GraphQLInvoker().invokeBinding({
      source,
      ref: "query/viewer",
      context: { configuration: { document: "query { health }" } },
      fetch: fetchFn,
    });
    await expect(mismatch.closed).rejects.toMatchObject({ code: ERR_SOURCE_CONFIG_ERROR });

    const collision = new GraphQLInvoker().invokeBinding({
      source,
      ref: "query/viewer",
      context: {
        configuration: {
          document: "query { viewer }",
          protocolFields: { httpHeaders: { "content-TYPE": "text/plain" } },
        },
      },
      fetch: fetchFn,
    });
    await expect(collision.closed).rejects.toMatchObject({ code: ERR_SOURCE_CONFIG_ERROR });

    const unnamedCredential = new GraphQLInvoker().invokeBinding({
      source,
      ref: "query/viewer",
      context: {
        bearerToken: "ambiguous",
        configuration: { document: "query { viewer }" },
      },
      fetch: fetchFn,
    });
    await expect(unnamedCredential.closed).rejects.toMatchObject({ code: ERR_SOURCE_CONFIG_ERROR });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("resolves refs against pinned content and never supplements a pin", async () => {
    const fetchFn = vi.fn();
    const invocation = new GraphQLInvoker().invokeBinding({
      source,
      ref: "query/missing",
      context: { configuration: { document: "query { missing }" } },
      fetch: fetchFn,
    });
    await expect(invocation.closed).rejects.toMatchObject({ code: ERR_REF_NOT_FOUND });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;

  send(value: string): void { this.sent.push(JSON.parse(value)); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

describe("GraphQLInvoker subscription", () => {
  const priorWebSocket = globalThis.WebSocket;
  beforeEach(() => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
  });
  afterEach(() => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: priorWebSocket });
  });

  it("uses the explicit target and emits complete next envelopes including errors", async () => {
    let init: GraphQLWebSocketInit | undefined;
    let socket: FakeWebSocket | undefined;
    const invoker = new GraphQLInvoker((value) => {
      init = value;
      socket = new FakeWebSocket();
      return socket as unknown as WebSocket;
    });
    const invocation = invoker.invokeBinding({
      source,
      ref: "subscription/updates",
      context: {
        configuration: {
          document: { source: "subscription Watch { updates }", operationName: "Watch" },
          subscriptionTarget: "wss://stream.example.test/graphql",
          protocolFields: {
            websocketHeaders: { "x-tenant": "demo" },
            connectionInitPayload: { tenant: "demo" },
          },
        },
      },
    });
    await vi.waitFor(() => expect(socket).toBeDefined());
    socket!.open();
    expect(socket!.sent[0]).toEqual({ type: "connection_init", payload: { tenant: "demo" } });
    socket!.message({ type: "connection_ack" });
    expect(socket!.sent[1]).toEqual({
      id: "1",
      type: "subscribe",
      payload: { query: "subscription Watch { updates }", operationName: "Watch" },
    });
    socket!.message({
      type: "next",
      id: "1",
      payload: { data: { updates: null }, errors: [{ message: "warning" }] },
    });
    socket!.message({ type: "complete", id: "1" });

    await expect(outputs(invocation)).resolves.toEqual([
      { data: { updates: null }, errors: [{ message: "warning" }] },
    ]);
    expect(init).toEqual({
      url: "wss://stream.example.test/graphql",
      protocols: ["graphql-transport-ws"],
      headers: { "x-tenant": "demo" },
    });
  });

  it("refuses explicit upgrade fields when no WebSocket factory can carry them", async () => {
    const invocation = new GraphQLInvoker().invokeBinding({
      source,
      ref: "subscription/updates",
      context: {
        configuration: {
          document: "subscription { updates }",
          subscriptionTarget: "wss://stream.example.test/graphql",
          protocolFields: { websocketHeaders: { "x-tenant": "demo" } },
        },
      },
    });
    await expect(invocation.closed).rejects.toMatchObject({ code: ERR_SOURCE_CONFIG_ERROR });
  });
});

describe("GraphQLSynthesizer", () => {
  it("uses pinned content for exhaustive lower-case inspection", async () => {
    const inspection = await new GraphQLSynthesizer().inspectSource(source);
    expect(inspection.exhaustive).toBe(true);
    expect(inspection.targets.map((target) => target.ref)).toEqual([
      "query/health",
      "query/viewer",
      "subscription/updates",
    ]);
  });
});

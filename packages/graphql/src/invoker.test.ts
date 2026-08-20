import { describe, expect, it, vi } from "vitest";
import {
  CONTEXT_REQUIRED,
  ERR_EXECUTION_FAILED,
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_SOURCE_CONFIG_ERROR,
  type Invocation,
} from "@openbindings/invoke";
import { BINDING_SPEC } from "./constants.js";
import { GraphQLInvoker, GraphQLSynthesizer } from "./invoker.js";

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

async function drain(invocation: Invocation<unknown, unknown>): Promise<{ values: unknown[]; error?: unknown }> {
  const values: unknown[] = [];
  try {
    for await (const value of invocation.outputs) values.push(value);
    return { values };
  } catch (error) {
    return { values, error };
  }
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
  it("carries the exact document and wholesale variables, then preserves partial application data before failure", async () => {
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

    const result = await drain(invocation);
    expect(result.values).toEqual([null]);
    expect(result.error).toMatchObject({ code: ERR_EXECUTION_FAILED });
    expect(dispatched).toEqual({
      query: "query Viewer($id: ID!) { viewer(id: $id) }",
      operationName: "Viewer",
      variables: { id: "u-1", unused: 7, _query: "ordinary variable" },
    });
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
    await expect(outputs(invocation)).resolves.toEqual(["ok"]);
    expect(dispatched).not.toHaveProperty("variables");
  });

  it("classifies a +json request-error response at HTTP 400 without emitting its native envelope", async () => {
    const body = { errors: [{ message: "request rejected" }] };
    const invocation = new GraphQLInvoker().invokeBinding({
      source,
      ref: "query/viewer",
      context: { configuration: { document: "query { viewer }" } },
      fetch: vi.fn(async () => response(body, 400)),
    });
    await expect(invocation.closed).rejects.toMatchObject({ code: ERR_EXECUTION_FAILED });
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
      alternatives: [{ requirements: [{ type: "config.value", point: "document", path: "" }] }],
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

describe("GraphQLInvoker excluded targets", () => {
  it("refuses subscription refs before dispatch", async () => {
    const fetchFn = vi.fn();
    const invocation = new GraphQLInvoker().invokeBinding({
      source,
      ref: "subscription/updates",
      context: {
        configuration: {
          document: "subscription { updates }",
        },
      },
      fetch: fetchFn,
    });
    await expect(invocation.closed).rejects.toMatchObject({ code: ERR_INVALID_REF });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("GraphQLSynthesizer", () => {
  it("uses pinned content for exhaustive lower-case inspection", async () => {
    const inspection = await new GraphQLSynthesizer().inspectSource(source);
    expect(inspection.exhaustive).toBe(true);
    expect(inspection.targets.map((target) => target.ref)).toEqual([
      "query/health",
      "query/viewer",
    ]);
  });
});

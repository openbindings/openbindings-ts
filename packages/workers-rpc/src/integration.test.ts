/**
 * End-to-end integration test for the workers-rpc binding format.
 *
 * Wires up a fake "codegenned client" (constructed by hand here to
 * mirror what `ob codegen --lang typescript` produces) against a
 * WorkersRpcExecutor + a mock service binding, and verifies that
 * method calls flow through the OperationExecutor → executor →
 * mock binding → result chain end-to-end.
 *
 * This is the integration test for the whole stack: SDK
 * (InterfaceClient + OperationExecutor) + workers-rpc executor +
 * mock binding. If `ob codegen` produces a client that doesn't work
 * against this stack, this test will catch it.
 */

import { describe, it, expect } from "vitest";
import {
  InterfaceClient,
  OperationExecutor,
  ERR_EXECUTION_FAILED,
  ERR_REF_NOT_FOUND,
  type OBInterface,
} from "@openbindings/sdk";
import { WorkersRpcExecutor, type WorkersRpcBinding } from "./index.js";

// A minimal OBI shaped exactly like what `ob create` + hand-edits
// would produce for a workers-rpc surface. Two operations: one
// happy-path (`ping`), one with structured business errors (`addItem`,
// returning a discriminated-union result).
const TEST_OBI: OBInterface = {
  openbindings: "0.1.0",
  name: "TestService",
  version: "0.1.0",
  operations: {
    ping: {
      description: "Health check",
      input: {
        type: "object",
        properties: { message: { type: "string" } },
      },
      output: {
        type: "object",
        required: ["echoed"],
        properties: { echoed: { type: "string" } },
      },
    },
    addItem: {
      description: "Add an item; returns a discriminated-union result",
      input: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          id: { type: "string" },
          code: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
  sources: {
    rpc: {
      format: "workers-rpc@^1.0.0",
      location: "workers-rpc://test-service",
    },
  },
  bindings: {
    "ping.rpc": {
      operation: "ping",
      source: "rpc",
      ref: "ping",
    },
    "addItem.rpc": {
      operation: "addItem",
      source: "rpc",
      ref: "addItem",
    },
  },
};

// Helper: build an InterfaceClient + executor stack pointing at the
// given mock binding. Mirrors what the codegenned client constructor
// does internally.
function buildClient(binding: WorkersRpcBinding): InterfaceClient {
  const executor = new OperationExecutor([new WorkersRpcExecutor({ binding })]);
  const client = new InterfaceClient(TEST_OBI, executor);
  return client;
}

// Helper: drain the execute() stream into a single result. The cast on
// `client.execute` is intentional — InterfaceClient<T>.execute is typed
// against the operation map type parameter, which our untyped fixture
// client (`InterfaceClient`, no generic) doesn't carry. The runtime
// behavior is what we're testing.
async function executeOnce(
  client: InterfaceClient,
  op: string,
  input: unknown,
): Promise<{ data?: unknown; error?: { code: string; message: string } }> {
  const stream = (client.execute as (op: string, input: unknown) => AsyncIterable<{ data?: unknown; error?: { code: string; message: string } }>)(op, input);
  for await (const event of stream) {
    return event;
  }
  throw new Error("no event yielded");
}

describe("workers-rpc end-to-end via InterfaceClient", () => {
  it("connect() with the symbolic workers-rpc:// URL succeeds without fetching", async () => {
    const client = buildClient({});
    // The URL is symbolic — there's no HTTP server at workers-rpc://test.
    // The fallback path in InterfaceClient.resolve() detects the non-HTTP
    // scheme + embedded interface and uses the embedded OBI directly.
    await client.resolve("workers-rpc://test-service");
    expect(client.state.kind).toBe("bound");
  });

  it("dispatches a unary call through the WorkersRpcExecutor", async () => {
    const binding: WorkersRpcBinding = {
      ping: async (arg: unknown) => {
        const input = arg as { message?: string } | undefined;
        return { echoed: input?.message ?? "" };
      },
    };
    const client = buildClient(binding);
    await client.resolve("workers-rpc://test-service");

    const result = await executeOnce(client, "ping", { message: "hello" });
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ echoed: "hello" });
  });

  it("propagates a discriminated-union result from the binding", async () => {
    const binding: WorkersRpcBinding = {
      addItem: async (arg: unknown) => {
        const input = arg as { name: string };
        if (input.name.length === 0) {
          return { ok: false, code: "invalid_name", message: "name is empty" };
        }
        return { ok: true, id: "item-123" };
      },
    };
    const client = buildClient(binding);
    await client.resolve("workers-rpc://test-service");

    const happy = await executeOnce(client, "addItem", { name: "widget" });
    expect(happy.error).toBeUndefined();
    expect(happy.data).toEqual({ ok: true, id: "item-123" });

    const sad = await executeOnce(client, "addItem", { name: "" });
    expect(sad.error).toBeUndefined();
    // The SDK doesn't introspect the discriminated union — it just
    // passes the structured result through. The caller checks
    // `result.data.ok` to discriminate.
    expect(sad.data).toEqual({ ok: false, code: "invalid_name", message: "name is empty" });
  });

  it("surfaces a thrown error from the binding as a stream event error", async () => {
    const binding: WorkersRpcBinding = {
      ping: async () => {
        throw new Error("backend exploded");
      },
    };
    const client = buildClient(binding);
    await client.resolve("workers-rpc://test-service");

    const result = await executeOnce(client, "ping", { message: "test" });
    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe(ERR_EXECUTION_FAILED);
    expect(result.error?.message).toBe("backend exploded");
  });

  it("surfaces ref_not_found when the binding is missing the method", async () => {
    // The OBI declares ping + addItem but the binding only has ping.
    // Calling addItem should surface a ref_not_found error.
    const binding: WorkersRpcBinding = {
      ping: async () => ({ echoed: "" }),
    };
    const client = buildClient(binding);
    await client.resolve("workers-rpc://test-service");

    const result = await executeOnce(client, "addItem", { name: "widget" });
    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe(ERR_REF_NOT_FOUND);
    expect(result.error?.message).toContain("addItem");
  });

  it("preserves structured input through the executor (no JSON round-trip)", async () => {
    // Workers RPC structured-cloning preserves complex types like Date,
    // Map, Uint8Array, etc. The executor must not pre-serialize.
    const date = new Date("2026-01-01T00:00:00Z");
    let received: unknown;
    const binding: WorkersRpcBinding = {
      ping: async (arg: unknown) => {
        received = arg;
        return { echoed: "" };
      },
    };
    const client = buildClient(binding);
    await client.resolve("workers-rpc://test-service");

    // Pass a Date object as part of the input. Note: the OBI says the
    // input is `{message: string}` but for this test we're verifying
    // structured-clone passthrough; the executor doesn't validate
    // against the schema.
    await executeOnce(client, "ping", { message: "x", when: date } as unknown);
    const r = received as { when?: Date };
    expect(r.when).toBe(date); // identity, not equality
  });
});

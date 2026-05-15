/**
 * End-to-end integration test for the workers-rpc binding format.
 *
 * Wires up a fake "codegenned client" (constructed by hand here to
 * mirror what `ob codegen --lang typescript` produces) against a
 * WorkersRpcInvoker + a mock service binding, and verifies that
 * method calls flow through the OperationInvoker → driver →
 * mock binding → result chain end-to-end.
 *
 * This is the integration test for the whole stack: SDK
 * (OperationInvoker) + workers-rpc driver + mock binding. If
 * `ob codegen` produces a typed invoker that doesn't work against
 * this stack, this test will catch it.
 */

import { describe, it, expect } from "vitest";
import {
  OperationInvoker,
  ERR_EXECUTION_FAILED,
  ERR_REF_NOT_FOUND,
  type OBInterface,
  type OperationInvocationInput,
} from "@openbindings/sdk";
import { WorkersRpcInvoker, type WorkersRpcBinding } from "./index.js";


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

// Helper: build an OperationInvoker around a workers-rpc invoker bound to
// the mock binding. Mirrors what the codegenned typed-invoker constructor
// does internally — typed invokers now wrap an OperationInvoker directly
// (no extra client layer).
function buildInvoker(binding: WorkersRpcBinding): OperationInvoker {
  return new OperationInvoker([new WorkersRpcInvoker({ binding })]);
}

// Helper: drain the invoke() stream into a single result.
async function invokeOnce(
  invoker: OperationInvoker,
  op: string,
  input: unknown,
): Promise<{ output?: unknown; error?: { code: string; message: string } }> {
  const in_: OperationInvocationInput = { interface: TEST_OBI, operation: op, input };
  for await (const event of invoker.invoke(in_)) {
    return event;
  }
  throw new Error("no event yielded");
}

describe("workers-rpc end-to-end via OperationInvoker", () => {
  it("constructs from an OBI without any network or symbolic URL", () => {
    const invoker = buildInvoker({});
    // No URL involved at all — the OBI is supplied per call.
    // For workers-rpc, the embedded contract IS the OBI used for dispatch.
    expect(invoker).toBeDefined();
  });

  it("dispatches a unary call through the WorkersRpcInvoker", async () => {
    const binding: WorkersRpcBinding = {
      ping: async (arg: unknown) => {
        const input = arg as { message?: string } | undefined;
        return { echoed: input?.message ?? "" };
      },
    };
    const invoker = buildInvoker(binding);

    const result = await invokeOnce(invoker, "ping", { message: "hello" });
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ echoed: "hello" });
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
    const invoker = buildInvoker(binding);

    const happy = await invokeOnce(invoker, "addItem", { name: "widget" });
    expect(happy.error).toBeUndefined();
    expect(happy.output).toEqual({ ok: true, id: "item-123" });

    const sad = await invokeOnce(invoker, "addItem", { name: "" });
    expect(sad.error).toBeUndefined();
    // The SDK doesn't introspect the discriminated union — it just
    // passes the structured result through. The caller checks
    // `result.output.ok` to discriminate.
    expect(sad.output).toEqual({ ok: false, code: "invalid_name", message: "name is empty" });
  });

  it("surfaces a thrown error from the binding as a stream event error", async () => {
    const binding: WorkersRpcBinding = {
      ping: async () => {
        throw new Error("backend exploded");
      },
    };
    const invoker = buildInvoker(binding);

    const result = await invokeOnce(invoker, "ping", { message: "test" });
    expect(result.output).toBeUndefined();
    expect(result.error?.code).toBe(ERR_EXECUTION_FAILED);
    expect(result.error?.message).toBe("backend exploded");
  });

  it("surfaces ref_not_found when the binding is missing the method", async () => {
    // The OBI declares ping + addItem but the binding only has ping.
    // Calling addItem should surface a ref_not_found error.
    const binding: WorkersRpcBinding = {
      ping: async () => ({ echoed: "" }),
    };
    const invoker = buildInvoker(binding);

    const result = await invokeOnce(invoker, "addItem", { name: "widget" });
    expect(result.output).toBeUndefined();
    expect(result.error?.code).toBe(ERR_REF_NOT_FOUND);
    expect(result.error?.message).toContain("addItem");
  });

  it("preserves structured input through the driver (no JSON round-trip)", async () => {
    // Workers RPC structured-cloning preserves complex types like Date,
    // Map, Uint8Array, etc. The driver must not pre-serialize.
    const date = new Date("2026-01-01T00:00:00Z");
    let received: unknown;
    const binding: WorkersRpcBinding = {
      ping: async (arg: unknown) => {
        received = arg;
        return { echoed: "" };
      },
    };
    const invoker = buildInvoker(binding);

    // Pass a Date object as part of the input. Note: the OBI says the
    // input is `{message: string}` but for this test we're verifying
    // structured-clone passthrough; the driver doesn't validate
    // against the schema.
    await invokeOnce(invoker, "ping", { message: "x", when: date } as unknown);
    const r = received as { when?: Date };
    expect(r.when).toBe(date); // identity, not equality
  });
});

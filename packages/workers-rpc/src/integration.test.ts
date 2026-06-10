/**
 * End-to-end integration test for the workers-rpc binding format.
 *
 * Wires up the OperationInvoker against a WorkersRpcInvoker + a mock
 * service binding, and verifies that invocations flow through the
 * OperationInvoker → invoker → mock binding → output chain end-to-end.
 *
 * This is the integration test for the whole stack: SDK
 * (OperationInvoker) + workers-rpc invoker + mock binding. If
 * `ob codegen` produces a typed invoker that doesn't work against
 * this stack, this test will catch it.
 */

import { describe, it, expect } from "vitest";
import {
  OperationInvoker,
  ERR_EXECUTION_FAILED,
  ERR_REF_NOT_FOUND,
  single,
  type OBInterface,
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
// the mock binding. Mirrors what a generated typed invoker wraps internally.
function buildInvoker(binding: WorkersRpcBinding): OperationInvoker {
  return new OperationInvoker([new WorkersRpcInvoker({ binding })]);
}

// Helper: drive a unary operation through the handle — write one input,
// take the single output.
async function invokeOnce(
  invoker: OperationInvoker,
  op: string,
  input: unknown,
): Promise<unknown> {
  const call = invoker.invoke({ interface: TEST_OBI, operation: op });
  await call.write(input);
  return single(call.outputs);
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
    expect(result).toEqual({ echoed: "hello" });
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
    expect(happy).toEqual({ ok: true, id: "item-123" });

    // The SDK doesn't introspect the discriminated union — it just
    // passes the structured result through. The caller checks
    // `output.ok` to discriminate.
    const sad = await invokeOnce(invoker, "addItem", { name: "" });
    expect(sad).toEqual({ ok: false, code: "invalid_name", message: "name is empty" });
  });

  it("surfaces a thrown error from the binding as a terminal invocation error", async () => {
    const binding: WorkersRpcBinding = {
      ping: async () => {
        throw new Error("backend exploded");
      },
    };
    const invoker = buildInvoker(binding);

    const call = invoker.invoke({ interface: TEST_OBI, operation: "ping" });
    await call.write({ message: "test" });
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      message: "backend exploded",
    });
  });

  it("surfaces ERR_REF_NOT_FOUND when the binding is missing the method", async () => {
    // The OBI declares ping + addItem but the binding only has ping.
    // Calling addItem should terminate with ERR_REF_NOT_FOUND — before
    // any input is consumed (pre-dispatch classification).
    const binding: WorkersRpcBinding = {
      ping: async () => ({ echoed: "" }),
    };
    const invoker = buildInvoker(binding);

    const call = invoker.invoke({ interface: TEST_OBI, operation: "addItem" });
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_REF_NOT_FOUND,
      message: expect.stringContaining("addItem"),
    });
  });

  it("preserves structured input through the invoker (no JSON round-trip)", async () => {
    // Workers RPC structured-cloning preserves complex types like Date,
    // Map, Uint8Array, etc. The invoker must not pre-serialize.
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
    // structured-clone passthrough; OBI-T-07 validation only checks the
    // declared properties.
    await invokeOnce(invoker, "ping", { message: "x", when: date });
    const r = received as { when?: Date };
    expect(r.when).toBe(date); // identity, not equality
  });
});

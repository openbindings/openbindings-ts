/**
 * Real-codegen integration test.
 *
 * Uses `ob codegen` output (snapshot at `__codegen__/test-client.ts`, generated
 * from `__codegen__/test-service.obi.json`) — the OperationSignatures namespace
 * for a hand-authored workers-rpc OBI — and exercises those generated signatures
 * against the `WorkersRpcInvoker` + a mock binding through the SDK's
 * `OperationInvoker.invoke`. Fails if any of these regress:
 *
 *   - codegen emits signatures that import unavailable SDK exports
 *   - a generated signature doesn't dispatch through OperationInvoker.invoke
 *   - the invoker doesn't reach the correct binding method
 *
 * Regenerate the test-client.ts fixture after any change to the codegen
 * typescript template (ob/internal/codegen/typescript.go) or the source OBI:
 *
 *   ob codegen packages/workers-rpc/src/__codegen__/test-service.obi.json \
 *     --lang typescript -o packages/workers-rpc/src/__codegen__/test-client.ts
 */

import { describe, it, expect } from "vitest";
import { OperationInvoker, single, ERR_EXECUTION_FAILED, type OBInterface } from "@openbindings/sdk";
import { OperationSignatures } from "./__codegen__/test-client.js";
import { WorkersRpcInvoker, type WorkersRpcBinding } from "./index.js";

const buildInvoker = (binding: WorkersRpcBinding) =>
  new OperationInvoker([new WorkersRpcInvoker({ binding })]);

// The runtime interface the generated signatures are invoked against. Mirrors
// __codegen__/test-service.obi.json (the OBI the fixture was generated from);
// signatures carry only operation keys, so the interface is supplied here at
// call time rather than baked into the codegen output.
const TEST_OBI: OBInterface = {
  openbindings: "0.1.0",
  name: "TestWorkersRpc",
  version: "0.1.0",
  operations: {
    ping: {
      description: "Health check",
      input: { type: "object", properties: { message: { type: "string" } } },
      output: { type: "object", required: ["echoed"], properties: { echoed: { type: "string" } } },
    },
    addItem: {
      description: "Add an item to the store",
      input: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, qty: { type: "integer" } },
      },
      output: { type: "object", properties: { ok: { type: "boolean" }, id: { type: "string" } } },
    },
  },
  sources: { rpc: { bindingSpec: "workers-rpc@^1.0.0", location: "workers-rpc://test-service" } },
  bindings: {
    "ping.rpc": { operation: "ping", source: "rpc", ref: "ping" },
    "addItem.rpc": { operation: "addItem", source: "rpc", ref: "addItem" },
  },
};

describe("ob codegen output for workers-rpc OBI", () => {
  it("exposes a typed signature per operation", () => {
    expect(OperationSignatures.ping.key).toBe("ping");
    expect(OperationSignatures.addItem.key).toBe("addItem");
  });

  it("dispatches the ping operation through a generated signature", async () => {
    const binding: WorkersRpcBinding = {
      ping: async (arg: unknown) => {
        const input = arg as { message?: string } | undefined;
        return { echoed: `pong: ${input?.message ?? ""}` };
      },
      addItem: async () => ({ id: "id-1" }),
    };
    const invoker = buildInvoker(binding);

    const call = invoker.invoke(TEST_OBI, OperationSignatures.ping);
    await call.write({ message: "hello" });
    const result = await single(call.outputs);
    expect(result).toEqual({ echoed: "pong: hello" });
  });

  it("dispatches addItem with input passthrough", async () => {
    let received: unknown;
    const binding: WorkersRpcBinding = {
      ping: async () => ({ echoed: "" }),
      addItem: async (arg: unknown) => {
        received = arg;
        return { id: "newly-created" };
      },
    };
    const invoker = buildInvoker(binding);

    const call = invoker.invoke(TEST_OBI, OperationSignatures.addItem);
    await call.write({ name: "widget", qty: 5 });
    const result = await single(call.outputs);
    expect(result).toEqual({ id: "newly-created" });
    expect(received).toEqual({ name: "widget", qty: 5 });
  });

  it("surfaces ERR_EXECUTION_FAILED when the binding throws", async () => {
    const binding: WorkersRpcBinding = {
      ping: async () => {
        throw new Error("bound method failed");
      },
      addItem: async () => ({ id: "x" }),
    };
    const invoker = buildInvoker(binding);

    const call = invoker.invoke(TEST_OBI, OperationSignatures.ping);
    await call.write({ message: "test" });
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      message: "bound method failed",
    });
  });
});

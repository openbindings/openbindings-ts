/**
 * Real-codegen integration test.
 *
 * Uses an `ob codegen` output shape (snapshot at `__codegen__/test-client.ts`)
 * — a typed invoker generated against a hand-authored workers-rpc OBI — and
 * exercises it against the `WorkersRpcInvoker` + a mock binding. This test
 * fails if any of these regress:
 *
 *   - codegen template emits a typed invoker that imports unavailable SDK exports
 *   - the generated invoker's per-operation methods don't reach the OperationInvoker
 *   - the invoker doesn't dispatch to the correct binding method
 *
 * The test-client.ts fixture should be regenerated after any change to:
 *   - the codegen typescript template (ob/internal/codegen/typescript.go)
 *   - the embedded OBI shape (the fixture is /tmp/workers-rpc-test.obi.json
 *     mirrored in this file's TEST_OBI_DESCRIPTION below)
 *
 * Regen procedure:
 *   1. Save TEST_OBI_DESCRIPTION contents to a .obi.json file
 *   2. Run: ob codegen <file> --lang typescript -o packages/workers-rpc/src/__codegen__/test-client.ts
 *   3. Re-run this test
 */

import { describe, it, expect } from "vitest";
import { OperationInvoker, single, ERR_EXECUTION_FAILED } from "@openbindings/sdk";
import { createTestWorkersRpcInvoker, CONTRACT } from "./__codegen__/test-client.js";
import { WorkersRpcInvoker, type WorkersRpcBinding } from "./index.js";

const buildInvoker = (binding: WorkersRpcBinding) =>
  new OperationInvoker([new WorkersRpcInvoker({ binding })]);

// Mirror of the OBI used to generate test-client.ts. Kept here as a
// reference; the codegen output embeds this OBI as a string constant
// inside the generated module (`const INTERFACE = JSON.parse('...')`),
// re-exported as `CONTRACT`. If the fixture is regenerated, this comment
// block can be updated to point at the source OBI file location.
const TEST_OBI_DESCRIPTION = `
{
  "openbindings": "0.1.0",
  "name": "TestWorkersRpc",
  "operations": {
    "ping": { "input": {...}, "output": {...} },
    "addItem": { "input": {...}, "output": {...} }
  },
  "sources": { "rpc": { "format": "workers-rpc@^1.0.0", ... } },
  "bindings": { "ping.rpc": {...}, "addItem.rpc": {...} }
}
`;

describe("ob codegen output for workers-rpc OBI", () => {
  it("constructs a typed invoker over the embedded contract", () => {
    const binding: WorkersRpcBinding = {
      ping: async () => ({ echoed: "ok" }),
      addItem: async () => ({ id: "id-1" }),
    };
    const invoker = createTestWorkersRpcInvoker(buildInvoker(binding));
    // No exception means construction succeeded; the embedded CONTRACT is
    // the default iface (workers-rpc OBIs ship in the codegen output).
    expect(invoker).toBeDefined();
    expect(CONTRACT.name).toBe("TestWorkersRpc");
    void TEST_OBI_DESCRIPTION; // suppress unused warning
  });

  it("dispatches the ping operation through the invoker", async () => {
    const binding: WorkersRpcBinding = {
      ping: async (arg: unknown) => {
        const input = arg as { message?: string } | undefined;
        return { echoed: `pong: ${input?.message ?? ""}` };
      },
      addItem: async () => ({ id: "id-1" }),
    };
    const invoker = createTestWorkersRpcInvoker(buildInvoker(binding));

    const call = invoker.ping();
    await call.write({ message: "hello" });
    const result = await single(call.outputs);
    expect(result).toEqual({ echoed: "pong: hello" });
  });

  it("dispatches the addItem operation with input passthrough", async () => {
    let received: unknown;
    const binding: WorkersRpcBinding = {
      ping: async () => ({ echoed: "" }),
      addItem: async (arg: unknown) => {
        received = arg;
        return { id: "newly-created" };
      },
    };
    const invoker = createTestWorkersRpcInvoker(buildInvoker(binding));

    const call = invoker.addItem();
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
    const invoker = createTestWorkersRpcInvoker(buildInvoker(binding));

    const call = invoker.ping();
    await call.write({ message: "test" });
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      message: "bound method failed",
    });
  });
});

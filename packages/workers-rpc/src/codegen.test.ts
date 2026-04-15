/**
 * Real-codegen integration test.
 *
 * Uses an actual `ob codegen` output (snapshot at `__codegen__/test-client.ts`)
 * — produced by running `ob codegen <fixture-obi> --lang typescript -o ...`
 * against a hand-authored workers-rpc OBI — and exercises it against the
 * `WorkersRpcExecutor` + a mock binding. This test fails if any of these
 * regress:
 *
 *   - codegen template emits a client that imports unavailable SDK exports
 *   - the generated client's connect() flow can't handle a workers-rpc:// URL
 *   - the generated client's execute() dispatch doesn't reach the executor
 *   - the executor doesn't dispatch to the correct binding method
 *
 * The test-client.ts fixture should be regenerated after any change to:
 *   - the codegen typescript template (cli/internal/codegen/typescript.go)
 *   - the embedded OBI shape (the fixture is /tmp/workers-rpc-test.obi.json
 *     mirrored in this file's TEST_OBI_JSON below)
 *
 * Regen procedure:
 *   1. Save TEST_OBI_JSON contents to a .obi.json file
 *   2. Run: ob codegen <file> --lang typescript -o packages/workers-rpc/src/__codegen__/test-client.ts
 *   3. Re-run this test
 */

import { describe, it, expect } from "vitest";
import { TestWorkersRpcClient } from "./__codegen__/test-client.js";
import { WorkersRpcExecutor, type WorkersRpcBinding } from "./index.js";

// Mirror of the OBI used to generate test-client.ts. Kept here as a
// reference; the codegen output embeds this OBI as a string constant
// inside the generated client (`const INTERFACE = JSON.parse('...')`).
// If the fixture is regenerated, this comment block can be updated to
// point at the source OBI file location.
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
  it("produces a client that connects to a workers-rpc:// URL", async () => {
    const binding: WorkersRpcBinding = {
      ping: async () => ({ echoed: "ok" }),
      addItem: async () => ({ id: "id-1" }),
    };
    const client = new TestWorkersRpcClient([new WorkersRpcExecutor({ binding })]);
    // The URL is symbolic — InterfaceClient.resolve() falls back to the
    // embedded OBI for non-HTTP URLs when no synthesizer is provided.
    await client.connect("workers-rpc://test-service");
    // No exception means connect succeeded and the client is bound.
    expect(client).toBeDefined();
    void TEST_OBI_DESCRIPTION; // suppress unused warning
  });

  it("dispatches the ping operation through the executor", async () => {
    const binding: WorkersRpcBinding = {
      ping: async (arg: unknown) => {
        const input = arg as { message?: string } | undefined;
        return { echoed: `pong: ${input?.message ?? ""}` };
      },
      addItem: async () => ({ id: "id-1" }),
    };
    const client = new TestWorkersRpcClient([new WorkersRpcExecutor({ binding })]);
    await client.connect("workers-rpc://test-service");

    const result = await client.ping({ message: "hello" });
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
    const client = new TestWorkersRpcClient([new WorkersRpcExecutor({ binding })]);
    await client.connect("workers-rpc://test-service");

    const result = await client.addItem({ name: "widget", qty: 5 });
    expect(result).toEqual({ id: "newly-created" });
    expect(received).toEqual({ name: "widget", qty: 5 });
  });

  it("propagates execution_failed when the binding throws", async () => {
    const binding: WorkersRpcBinding = {
      ping: async () => {
        throw new Error("bound method failed");
      },
      addItem: async () => ({ id: "x" }),
    };
    const client = new TestWorkersRpcClient([new WorkersRpcExecutor({ binding })]);
    await client.connect("workers-rpc://test-service");

    await expect(client.ping({ message: "test" })).rejects.toThrow(/bound method failed/);
  });
});

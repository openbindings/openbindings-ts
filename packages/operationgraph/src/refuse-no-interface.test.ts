import { describe, it, expect } from "vitest";
import { OperationInvoker, single, type InvocationError } from "@openbindings/invoke";
import { OperationGraphInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

// C3f / OG-V-11: `operation` and `each` nodes resolve ONLY against the
// containing OBI's operations map (§281). A direct binding invocation supplies
// no interface — hence no operations map — so a graph carrying operation/each
// nodes is unexecutable in that mode and MUST be refused pre-execution with
// ERR_VALIDATION_FAILED, not passed an undefined interface downstream (the
// engine's non-null `this.args.interface!` assertions).

function invoker(): OperationInvoker {
  const op = new OperationInvoker([]);
  op.addBindingInvoker(new OperationGraphInvoker(op));
  return op;
}

describe("operation-graph direct binding without an interface (C3f)", () => {
  it("refuses a graph with an operation node when no interface is supplied", async () => {
    const graph = {
      "openbindings.operation-graph": "0.2.0",
      nodes: {
        in: { type: "input" },
        call: { type: "operation", operation: "items.fetch" },
        out: { type: "output" },
      },
      edges: [
        { from: "in", to: "call" },
        { from: "call", to: "out" },
      ],
    };
    const call = invoker().invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: { graphs: { g: graph } } },
      selector: "#/graphs/g",
      // no interface
    });
    void call.write({});
    void call.close();

    let terminal: InvocationError | undefined;
    try {
      for await (const _out of call.outputs) {
        /* drain */
      }
    } catch (err) {
      terminal = err as InvocationError;
    }
    expect(terminal, "expected a pre-execution refusal").toBeDefined();
    expect(terminal!.code).toBe("ERR_VALIDATION_FAILED");
    expect(Object.hasOwn(terminal!, "data")).toBe(false);
  });

  it("runs a pure pass-through graph without an interface", async () => {
    const graph = {
      "openbindings.operation-graph": "0.2.0",
      nodes: { in: { type: "input" }, out: { type: "output" } },
      edges: [{ from: "in", to: "out" }],
    };
    const call = invoker().invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: { graphs: { g: graph } } },
      selector: "#/graphs/g",
    });
    void call.write({ ok: true });
    void call.close();
    const out = await single(call.outputs);
    expect(out).toEqual({ ok: true });
  });
});

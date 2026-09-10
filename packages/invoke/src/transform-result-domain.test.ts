import { describe, expect, it } from "vitest";
import type { OBInterface, TransformOrRef } from "@openbindings/core";
import { OperationInvoker } from "./operation-invoker.js";
import { InvocationImpl, InvocationError, type Invocation } from "./invocation.js";
import type { BindingInvoker, TransformEvaluator } from "./invokers.js";
import type { BindingInvocationArgs } from "./invoker-types.js";
import { ERR_TRANSFORM_ERROR } from "./errcodes.js";
import { JSONNumber, equalJSON, parseJSON } from "@openbindings/json";

async function run(
  direction: "input" | "output",
  evaluate: TransformEvaluator["evaluate"],
  referenced = false,
  emitted: unknown[] = [1],
  schema: "absent" | "permissive" = "absent",
) {
  let attempts = 0;
  const received: unknown[] = [];
  const binding: BindingInvoker = {
    bindingSpecs: () => [{ bindingSpec: "test.transform-domain@1" }],
    checkBindingSpecs: specs => specs.map(bindingSpec => ({ bindingSpec, supported: bindingSpec === "test.transform-domain@1" })),
    invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
      attempts++;
      const inner = new InvocationImpl<unknown, unknown>({ signal: args.signal });
      void (async () => {
        for await (const value of inner.inputs()) received.push(value);
        for (const value of emitted) await inner.emitOutput(value);
        inner.closeOutput();
      })().catch(() => { inner.fireError(new InvocationError(ERR_TRANSFORM_ERROR)); });
      return inner as Invocation<I, O>;
    },
  };
  const transform: TransformOrRef = referenced ? { $ref: "#/transforms/map" } : "$";
  const iface: OBInterface = {
    openbindings: "0.2.0",
    operations: { test: schema === "permissive" ? { input: {}, output: {} } : {} },
    sources: { test: { bindingSpec: "test.transform-domain@1", content: {} } },
    transforms: { map: "$" },
    bindings: { test: { operation: "test", source: "test", [direction + "Transform"]: transform } },
  };
  const call = new OperationInvoker([binding], { transformEvaluator: { evaluate } }).invoke(iface, { key: "test" });
  const values: unknown[] = [];
  const read = (async () => {
    try { for await (const value of call.outputs) values.push(value); }
    catch (error) { return error; }
  })();
  const closed = call.closed.then(() => undefined, error => error);
  try { await call.write({ id: 1 }); await call.close(); } catch { /* terminal is asserted below */ }
  return { values, error: await closed, readError: await read, received, attempts };
}

describe("Core transform result JSON domain", () => {
  const invalid = [
    ["Infinity", Infinity], ["-Infinity", -Infinity], ["NaN", NaN],
    ["nested Infinity", { values: [Infinity] }], ["nested -Infinity", [-Infinity]],
    ["nested NaN", { n: NaN }], ["undefined", undefined], ["function", () => 1],
  ] as const;
  for (const direction of ["input", "output"] as const) {
    for (const referenced of [false, true]) {
      for (const schema of ["absent", "permissive"] as const) {
        for (const [name, value] of invalid) {
          it(`${direction} ${referenced ? "reference" : "inline"} ${schema}: rejects ${name}`, async () => {
            const result = await run(direction, async () => value, referenced, [1], schema);
            expect(result.error).toMatchObject({ code: ERR_TRANSFORM_ERROR });
            expect(result.readError).toMatchObject({ code: ERR_TRANSFORM_ERROR });
            expect(result.values).toEqual([]);
            expect(result.attempts).toBe(1); // No replay after a local failure.
            if (direction === "input") expect(result.received).toEqual([]);
          });
        }
      }
    }
  }

  for (const value of [null, 0, false, "", [1, 2], { nested: [null, 0] }]) {
    it(`keeps valid result ${JSON.stringify(value)}`, async () => {
      const result = await run("output", async () => value);
      expect(result.error).toBeUndefined();
      expect(result.values).toEqual([value]);
    });
  }

  it("allows the reference evaluator's array sequence metadata", async () => {
    const sequence = Object.assign([1, 2], { sequence: true });
    const result = await run("output", async () => sequence);
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result.values)).toBe("[[1,2]]");
  });

  it("admits authenticated SDK numbers without inspecting marker-like data fields", async () => {
    for (const value of [new JSONNumber("9223372036854775807"), parseJSON('{"amount":1e-400,"rawJSON":"7","isLosslessNumber":true,"_jsonata_function":true}')]) {
      const result = await run("output", async () => value);
      expect(result.error).toBeUndefined();
      expect(result.values).toHaveLength(1);
      expect(equalJSON(result.values[0], value)).toBe(true);
    }
  });

  it("retains prior stream values, then fails once without replay", async () => {
    const result = await run("output", async (_expression, data) => data === 2 ? Infinity : data, false, [1, 2, 3]);
    expect(result.values).toEqual([1]);
    expect(result.error).toMatchObject({ code: ERR_TRANSFORM_ERROR });
    expect(result.attempts).toBe(1);
  });
});

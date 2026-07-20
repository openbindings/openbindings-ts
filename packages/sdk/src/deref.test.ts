/**
 * dereference() no-mutation contract (deref.ts).
 *
 * dereference documents "Returns a new object (the original is not mutated)".
 * Internal (`#/...`) refs must therefore resolve against the working CLONE,
 * never the caller's document: resolving against the original both mutates
 * the caller's input in place and aliases resolved output nodes back to input.
 */
import { describe, it, expect } from "vitest";
import { dereference } from "./deref.js";

describe("dereference — no caller-input mutation", () => {
  it("does not mutate the input document and does not alias output to input", async () => {
    // Nested internal refs: `top` -> components.b -> components.c. The buggy
    // path resolves against the original, walks it in place (rewriting
    // components.b.deep from a $ref to the resolved leaf), and splices the
    // original node into the output.
    const doc = {
      top: { $ref: "#/components/b" },
      components: {
        b: { deep: { $ref: "#/components/c" } },
        c: { leaf: true },
      },
    };
    const before = structuredClone(doc);

    const result = await dereference<{
      top: { deep: { leaf: boolean } };
      components: { b: { deep: { leaf: boolean } }; c: { leaf: boolean } };
    }>(doc);

    // The input is byte-for-byte what it was: the documented no-mutate contract.
    expect(doc).toEqual(before);

    // The output is fully resolved.
    expect(result).toEqual({
      top: { deep: { leaf: true } },
      components: {
        b: { deep: { leaf: true } },
        c: { leaf: true },
      },
    });

    // No output node aliases a node of the caller's document.
    expect(result.top).not.toBe(doc.components.b);
    expect(result.components.c).not.toBe(doc.components.c);
  });

  it("leaves a deep-frozen input intact and shares repeats within the output only", async () => {
    const deepFreeze = <T>(o: T): T => {
      if (o && typeof o === "object") {
        for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
        Object.freeze(o);
      }
      return o;
    };
    // Two refs to one shared definition. Resolving against the frozen original
    // would throw on the first in-place write; resolving against the clone is
    // clean.
    const doc = deepFreeze({
      a: { $ref: "#/defs/shared" },
      b: { $ref: "#/defs/shared" },
      defs: { shared: { x: 1 } },
    });

    const result = await dereference<{
      a: { x: number };
      b: { x: number };
      defs: { shared: { x: number } };
    }>(doc);

    expect(result).toEqual({
      a: { x: 1 },
      b: { x: 1 },
      defs: { shared: { x: 1 } },
    });
    // Repeated internal refs share ONE resolved node within the output
    // (documented shared-reference behavior) — and never the frozen input node.
    expect(result.a).toBe(result.b);
    expect(result.a).not.toBe((doc as { defs: { shared: unknown } }).defs.shared);
  });
});

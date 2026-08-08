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

describe("dereference — document-root ref", () => {
  it("resolves a bare \"#\" ref to the document root", async () => {
    const doc = {
      title: "root",
      self: { $ref: "#" },
      nested: { deep: { $ref: "#" } },
    };
    const result = await dereference<Record<string, any>>(doc);
    // "#" addresses the whole document: the resolved node carries the
    // document's own members, not an undefined "#" property lookup.
    expect(result.self.title).toBe("root");
    expect(result.nested.deep.title).toBe("root");
  });
});

describe("dereference — RFC 6901 pointer evaluation", () => {
  it("decodes URI fragments, escaped tokens, and the empty property name", async () => {
    const doc = {
      defs: {
        "a b": { value: "space" },
        "slash/key": { value: "slash" },
        "tilde~key": { value: "tilde" },
      },
      "": { value: "empty" },
      space: { $ref: "#/defs/a%20b" },
      slash: { $ref: "#/defs/slash~1key" },
      tilde: { $ref: "#/defs/tilde~0key" },
      empty: { $ref: "#/" },
    };

    const result = await dereference<Record<string, any>>(doc);

    expect(result.space.value).toBe("space");
    expect(result.slash.value).toBe("slash");
    expect(result.tilde.value).toBe("tilde");
    expect(result.empty.value).toBe("empty");
  });

  it("rejects malformed array indexes and pointer syntax", async () => {
    const doc = {
      items: [{ value: "first" }],
      valid: { $ref: "#/items/0" },
      trailingJunk: { $ref: "#/items/0junk" },
      leadingZero: { $ref: "#/items/00" },
      invalidEscape: { $ref: "#/items/~2" },
      missingSlash: { $ref: "#items" },
    };

    const result = await dereference<Record<string, any>>(doc);

    expect(result.valid.value).toBe("first");
    expect(result.trailingJunk).toEqual({ $ref: "#/items/0junk" });
    expect(result.leadingZero).toEqual({ $ref: "#/items/00" });
    expect(result.invalidEscape).toEqual({ $ref: "#/items/~2" });
    expect(result.missingSlash).toEqual({ $ref: "#items" });
  });

  it("resolves only own properties, never Object.prototype members", async () => {
    const doc = {
      constructor: { value: "own" },
      own: { $ref: "#/constructor" },
      inherited: { $ref: "#/toString" },
      prototype: { $ref: "#/__proto__" },
    };

    const result = await dereference<Record<string, any>>(doc);

    expect(result.own.value).toBe("own");
    expect(result.inherited).toEqual({ $ref: "#/toString" });
    expect(result.prototype).toEqual({ $ref: "#/__proto__" });
  });

  it("merges ref siblings as JSON properties without prototype mutation", async () => {
    const doc = JSON.parse(`{
      "target": { "value": "base" },
      "resolved": {
        "$ref": "#/target",
        "constructor": { "value": "sibling" },
        "__proto__": { "polluted": true }
      }
    }`) as Record<string, unknown>;

    const result = await dereference<Record<string, any>>(doc);

    expect(Object.hasOwn(result.resolved, "constructor")).toBe(true);
    expect(result.resolved.constructor.value).toBe("sibling");
    expect(Object.hasOwn(result.resolved, "__proto__")).toBe(true);
    expect(result.resolved.__proto__.polluted).toBe(true);
    expect(Object.getPrototypeOf(result.resolved)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

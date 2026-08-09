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

  it("memoizes the resolved value of ref aliases reached before their declaration", async () => {
    const doc = {
      useBeforeComponents: { $ref: "#/components/alias" },
      useAgain: { $ref: "#/components/alias" },
      components: {
        alias: { $ref: "#/components/concrete" },
        concrete: { type: "string", enum: ["a", "b"] },
      },
    };

    const result = await dereference<Record<string, any>>(doc);

    expect(result.useBeforeComponents).toEqual({ type: "string", enum: ["a", "b"] });
    expect(result.useAgain).toBe(result.useBeforeComponents);
    expect(result.components.alias).toBe(result.useBeforeComponents);
    expect(JSON.stringify(result)).not.toContain("$ref");
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
    const root = { items: [{ value: "first" }] };
    const valid = await dereference<Record<string, any>>({
      ...root,
      use: { $ref: "#/items/0" },
    });
    expect(valid.use.value).toBe("first");

    for (const ref of ["#/items/0junk", "#/items/00", "#/items/~2", "#items"]) {
      await expect(dereference({ ...root, use: { $ref: ref } })).rejects.toThrow(
        "unresolvable $ref",
      );
    }
  });

  it("resolves only own properties, never Object.prototype members", async () => {
    const doc = {
      constructor: { value: "own" },
      own: { $ref: "#/constructor" },
    };

    const result = await dereference<Record<string, any>>(doc);

    expect(result.own.value).toBe("own");
    for (const ref of ["#/toString", "#/__proto__"]) {
      await expect(dereference({ use: { $ref: ref } })).rejects.toThrow(
        "unresolvable $ref",
      );
    }
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

describe("dereference — multi-document resource scope", () => {
  it("resolves fragment-only refs inside an external document against that external document", async () => {
    const documents: Record<string, unknown> = {
      "https://example.test/parts/operation.json": {
        operation: {
          parameter: { $ref: "#/definitions/trace" },
        },
        definitions: {
          trace: { name: "trace", in: "query" },
        },
      },
    };
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      const value = documents[url];
      return value === undefined
        ? new Response("missing", { status: 404 })
        : new Response(JSON.stringify(value), { status: 200 });
    };

    const result = await dereference<Record<string, any>>(
      { use: { $ref: "./parts/operation.json#/operation" } },
      { baseUrl: "https://example.test/openapi.json", fetch },
    );

    expect(result.use.parameter).toEqual({ name: "trace", in: "query" });
  });

  it("keeps a sibling-merged external alias in the target resource scope", async () => {
    const documents: Record<string, unknown> = {
      "https://example.test/parts/alias.json": {
        $ref: "./value.json",
      },
      "https://example.test/parts/value.json": {
        type: "string",
      },
    };
    const fetch: typeof globalThis.fetch = async (input) => {
      const value = documents[String(input)];
      return value === undefined
        ? new Response("missing", { status: 404 })
        : new Response(JSON.stringify(value), { status: 200 });
    };

    const result = await dereference<Record<string, any>>(
      { use: { $ref: "./parts/alias.json", description: "named" } },
      { baseUrl: "https://example.test/openapi.json", fetch },
    );

    expect(result.use).toEqual({ type: "string", description: "named" });
  });

  it("indexes the complete document before resolving $id resources and anchors", async () => {
    let fetched = false;
    const result = await dereference<Record<string, any>>(
      {
        byID: { $ref: "https://schemas.example/child.json" },
        byAnchor: { $ref: "https://schemas.example/root.json#kind" },
        definitions: {
          root: {
            $id: "https://schemas.example/root.json",
            $defs: {
              child: {
                $id: "child.json",
                type: "object",
                properties: { name: { type: "string" } },
              },
              kind: { $anchor: "kind", enum: ["a", "b"] },
            },
          },
        },
      },
      {
        fetch: async () => {
          fetched = true;
          return new Response("missing", { status: 404 });
        },
      },
    );

    expect(fetched).toBe(false);
    expect(result.byID.properties.name.type).toBe("string");
    expect(result.byAnchor.enum).toEqual(["a", "b"]);
  });

  it("refuses a dangling pointer instead of returning a partially dereferenced graph", async () => {
    await expect(
      dereference({ use: { $ref: "#/missing" } }),
    ).rejects.toThrow("unresolvable $ref");
  });

  it("can retain a dangling pointer for a processor that adjudicates targets individually", async () => {
    const result = await dereference<{ use: { $ref: string } }>(
      { use: { $ref: "#/missing" } },
      { allowUnresolved: true },
    );

    expect(result.use).toEqual({ $ref: "#/missing" });
  });
});

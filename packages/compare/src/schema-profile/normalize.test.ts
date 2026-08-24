import { describe, it, expect } from "vitest";
import canonicalize from "canonicalize";
import { Normalizer } from "./normalize.js";
import { OutsideProfileError, SelectorError, SchemaError } from "./errors.js";

describe("Normalizer.normalize", () => {
  it("strips annotation keywords", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      type: "string",
      description: "A name",
      title: "Name",
      default: "foo",
    });
    expect(result).toEqual({ type: ["string"] });
  });

  it("normalizes type string to array", async () => {
    const n = new Normalizer();
    const result = await n.normalize({ type: "integer" });
    expect(result.type).toEqual(["integer"]);
  });

  it("deduplicates and sorts type array", async () => {
    const n = new Normalizer();
    const result = await n.normalize({ type: ["string", "number", "string"] });
    expect(result.type).toEqual(["number", "string"]);
  });

  it("sorts required array", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      type: "object",
      required: ["b", "a", "c"],
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
    });
    expect(result.required).toEqual(["a", "b", "c"]);
  });

  it("resolves $ref within root", async () => {
    const root = {
      schemas: {
        Name: { type: "string", minLength: 1 },
      },
    };
    const n = new Normalizer({ root });
    const result = await n.normalize({ $ref: "#/schemas/Name" });
    expect(result).toEqual({ type: ["string"], minLength: 1 });
  });

  it("detects $ref cycles", async () => {
    const root = {
      schemas: {
        Self: { $ref: "#/schemas/Self" },
      },
    };
    const n = new Normalizer({ root });
    await expect(n.normalize({ $ref: "#/schemas/Self" })).rejects.toThrow(SelectorError);
  });

  it("fails a relative $ref with no base", async () => {
    // A path-carrying relative ref cannot resolve without a base; it must
    // fail closed, never silently fall back to root-fragment resolution.
    // Mirrors the Go SDK's TestNormalize_RefResolutionRelativeWithoutBase;
    // the full message is the parity-pinned SelectorError rendering.
    const n = new Normalizer({ root: { schemas: { Foo: { type: "string" } } } });
    await expect(n.normalize({ $ref: "schemas.json#/schemas/Foo" })).rejects.toThrow(SelectorError);
    await expect(n.normalize({ $ref: "schemas.json#/schemas/Foo" })).rejects.toThrow(
      '<root>.$ref "schemas.json#/schemas/Foo": relative $ref with no base',
    );
  });

  it("fails an external $ref without a fetcher", async () => {
    // Mirrors the Go SDK's TestNormalize_RefResolutionExternalWithoutFetcher.
    const n = new Normalizer({ root: {} });
    await expect(
      n.normalize({ $ref: "https://example.com/schema.json#/schemas/Foo" }),
    ).rejects.toThrow("external $ref unsupported (no fetcher)");
  });

  it("rejects out-of-profile keywords", async () => {
    const n = new Normalizer();
    await expect(
      n.normalize({ type: "string", pattern: "^foo$" }),
    ).rejects.toThrow(OutsideProfileError);
  });

  it("flattens allOf", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(result.type).toEqual(["object"]);
    expect(Object.keys(result.properties as any)).toEqual(["a", "b"]);
    expect(result.required).toEqual(["a", "b"]);
  });

  it("intersects types in allOf", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      allOf: [{ type: ["string", "number"] }, { type: ["number", "integer"] }],
    });
    expect(result.type).toEqual(["number"]);
  });

  it("errors on empty allOf type intersection", async () => {
    const n = new Normalizer();
    await expect(
      n.normalize({ allOf: [{ type: "string" }, { type: "integer" }] }),
    ).rejects.toThrow(SchemaError);
  });

  it("sorts union variants by canonical form", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      oneOf: [{ type: "string" }, { type: "integer" }],
    });
    const variants = result.oneOf as any[];
    const types = variants.map((v: any) => v.type[0]);
    expect(types).toEqual(["integer", "string"]);
  });

  it("strips $defs", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      type: "string",
      $defs: { Foo: { type: "number" } },
    });
    expect("$defs" in result).toBe(false);
  });

  it("strips format keyword as annotation", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      type: "string",
      format: "email",
    });
    expect(result).toEqual({ type: ["string"] });
    expect("format" in result).toBe(false);
  });

  it("strips discriminator keyword as annotation", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      oneOf: [
        { type: "object", properties: { kind: { const: "a" } }, required: ["kind"] },
        { type: "object", properties: { kind: { const: "b" } }, required: ["kind"] },
      ],
      discriminator: { propertyName: "kind" },
    });
    expect("discriminator" in result).toBe(false);
    expect(result.oneOf).toBeDefined();
  });

  it("strips x- extension keywords", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      type: "string",
      "x-ob": { delegate: "ob" },
      "x-custom": true,
    });
    expect(result).toEqual({ type: ["string"] });
    expect("x-ob" in result).toBe(false);
    expect("x-custom" in result).toBe(false);
  });

  it("converts nullable: true to type union", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      type: "string",
      nullable: true,
    });
    expect(result.type).toEqual(["null", "string"]);
    expect("nullable" in result).toBe(false);
  });

  it("nullable: true with type array merges null", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      type: ["string", "integer"],
      nullable: true,
    });
    const types = result.type as string[];
    expect(types).toContain("null");
    expect(types).toContain("string");
    expect(types).toContain("integer");
    expect("nullable" in result).toBe(false);
  });

  it("nullable: true with type already containing null is idempotent", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      type: ["string", "null"],
      nullable: true,
    });
    const types = result.type as string[];
    expect(types.filter((t) => t === "null")).toHaveLength(1);
  });

  it("nullable: false is stripped without changing type", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      type: "string",
      nullable: false,
    });
    expect(result.type).toEqual(["string"]);
    expect("nullable" in result).toBe(false);
  });

  it("handles nullable in allOf branches", async () => {
    const n = new Normalizer();
    const result = await n.normalize({
      allOf: [
        { type: "string", nullable: true },
        { minLength: 1 },
      ],
    });
    const types = result.type as string[];
    expect(types).toContain("null");
    expect(types).toContain("string");
  });
});

describe("Normalizer.inputCompatible", () => {
  it("Top ⊆ Top", async () => {
    const n = new Normalizer();
    expect((await n.inputCompatible({}, {})).compatible).toBe(true);
  });

  it("constrained ⊆ Top", async () => {
    const n = new Normalizer();
    expect((await n.inputCompatible({ type: "string" }, {})).compatible).toBe(true);
  });

  it("string ⊆ string", async () => {
    const n = new Normalizer();
    expect(
      (await n.inputCompatible({ type: "string" }, { type: "string" })).compatible,
    ).toBe(true);
  });

  it("string ⊄ integer", async () => {
    const n = new Normalizer();
    expect(
      (await n.inputCompatible({ type: "string" }, { type: "integer" })).compatible,
    ).toBe(false);
  });

  it("integer ⊆ number", async () => {
    const n = new Normalizer();
    expect(
      (await n.inputCompatible({ type: "integer" }, { type: "number" })).compatible,
    ).toBe(true);
  });
});

describe("Normalizer.outputCompatible", () => {
  it("string ⊆ string", async () => {
    const n = new Normalizer();
    expect(
      (await n.outputCompatible({ type: "string" }, { type: "string" })).compatible,
    ).toBe(true);
  });

  it("number ⊄ integer (output direction)", async () => {
    const n = new Normalizer();
    expect(
      (await n.outputCompatible({ type: "integer" }, { type: "number" })).compatible,
    ).toBe(false);
  });

  it("Top candidate requires Top target", async () => {
    const n = new Normalizer();
    expect((await n.outputCompatible({ type: "string" }, {})).compatible).toBe(false);
    expect((await n.outputCompatible({}, {})).compatible).toBe(true);
  });
});

// --- allOf soundness: mirrored unit tests ------------------------------------
//
// These pin the defect family of the allOf unsoundness (sibling keywords,
// nested allOf, $ref in overlapping-property merges, $ref-carried
// out-of-profile keywords) plus the sibling-union refusal, mirrored with
// schemaprofile/schemaprofile_test.go in the Go SDK: same shapes, same
// expected canonical forms, byte-identical error and reason strings. The
// SchemaError lane is pinned HERE because it is not corpus-expressible:
// comparison fixture format 1.0 has no error verdict
// (compatible|incompatible|indeterminate only).

describe("Normalizer allOf soundness", () => {
  it("sibling keywords merge as one additional branch", async () => {
    const n = new Normalizer({ root: {} });
    const target = {
      type: "object",
      required: ["id"],
      allOf: [{ properties: { id: { type: "string" } } }],
    };

    const out = await n.normalize(target);
    expect(canonicalize(out)).toBe(
      '{"properties":{"id":{"type":["string"]}},"required":["id"],"type":["object"]}',
    );

    // The false-compatible polarity of the original defect: a candidate that
    // omits the sibling-carried required must be output-incompatible.
    const result = await n.outputCompatible(target, {
      type: "object",
      properties: { id: { type: "string" } },
    });
    expect(result.compatible).toBe(false);
    expect(result.reason).toBe('required: target requires "id" but candidate does not');
  });

  it("sibling enum intersects in sibling-first order", async () => {
    const n = new Normalizer({ root: {} });
    const out = await n.normalize({
      type: "string",
      enum: ["a", "b", "c"],
      allOf: [{ enum: ["c", "b", "d"] }],
    });
    // The sibling branch merges first, and enum intersection preserves the
    // first branch's value order: ["b","c"], not ["c","b"].
    expect(canonicalize(out)).toBe('{"enum":["b","c"],"type":["string"]}');
  });

  it("nested allOf flattens recursively", async () => {
    const n = new Normalizer({ root: {} });
    const target = { allOf: [{ allOf: [{ type: "string", minLength: 3 }] }] };

    const out = await n.normalize(target);
    expect(canonicalize(out)).toBe('{"minLength":3,"type":["string"]}');

    // Previously this normalized to Top and reported any candidate compatible.
    const result = await n.outputCompatible(target, { type: "number" });
    expect(result.compatible).toBe(false);
    expect(result.reason).toBe('type: candidate allows "number" but target does not');
  });

  it("ref-carried oneOf inside allOf is refused", async () => {
    const n = new Normalizer({
      root: { $defs: { U: { oneOf: [{ type: "string" }, { type: "number" }] } } },
    });
    const err = await n
      .normalize({ allOf: [{ $ref: "#/$defs/U" }, { type: "string" }] })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutsideProfileError);
    expect((err as Error).message).toBe(
      'outside profile at allOf[0]: keyword "oneOf inside allOf"',
    );
  });

  it("ref-carried out-of-profile keyword inside allOf is refused", async () => {
    const n = new Normalizer({
      root: { $defs: { P: { type: "string", pattern: "^a+$" } } },
    });
    const err = await n
      .normalize({ allOf: [{ $ref: "#/$defs/P" }] })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutsideProfileError);
    expect((err as Error).message).toBe('outside profile at allOf[0]: keyword "pattern"');
  });

  it("ref in overlapping-property merge is inlined and preserved", async () => {
    const n = new Normalizer({
      root: { schemas: { ShortString: { type: "string", minLength: 2 } } },
    });
    const out = await n.normalize({
      allOf: [
        { type: "object", properties: { p: { type: "string", maxLength: 10 } } },
        { properties: { p: { $ref: "#/schemas/ShortString" } } },
      ],
    });
    expect(canonicalize(out)).toBe(
      '{"properties":{"p":{"maxLength":10,"minLength":2,"type":["string"]}},"type":["object"]}',
    );
  });

  it("unsatisfiable ref-carried property merge is a SchemaError", async () => {
    // The schema-error lane of the ref-in-overlapping-property-merge shape:
    // not corpus-expressible (fixture format 1.0 has no error verdict), so
    // the pin lives here, mirrored in the Go SDK's schemaprofile_test.go.
    const n = new Normalizer({ root: { schemas: { S: { type: "string" } } } });
    const err = await n
      .normalize({
        allOf: [
          { properties: { p: { type: "number" } } },
          { properties: { p: { $ref: "#/schemas/S" } } },
        ],
      })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaError);
    expect((err as Error).message).toBe(
      'schema error at allOf[1].properties["p"]: allOf type intersection is empty',
    );
  });

  it("union alongside allOf is refused", async () => {
    const n = new Normalizer({ root: {} });

    const oneOfErr = await n
      .normalize({ oneOf: [{ type: "string" }], allOf: [{ minLength: 1 }] })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(oneOfErr).toBeInstanceOf(OutsideProfileError);
    expect((oneOfErr as Error).message).toBe('outside profile: keyword "oneOf alongside allOf"');

    const anyOfErr = await n
      .normalize({ anyOf: [{ type: "string" }], allOf: [{ minLength: 1 }] })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(anyOfErr).toBeInstanceOf(OutsideProfileError);
    expect((anyOfErr as Error).message).toBe('outside profile: keyword "anyOf alongside allOf"');
  });
});

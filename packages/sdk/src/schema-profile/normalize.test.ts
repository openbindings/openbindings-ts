import { describe, it, expect } from "vitest";
import { Normalizer } from "./normalize.js";
import { OutsideProfileError, RefError, SchemaError } from "./errors.js";

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
    await expect(n.normalize({ $ref: "#/schemas/Self" })).rejects.toThrow(RefError);
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
    } as any);
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
    } as any);
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

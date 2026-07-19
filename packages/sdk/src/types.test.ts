import { describe, it, expect } from "vitest";
import { isTransformRef, resolveTransform } from "./types.js";
import type { TransformOrRef, Transform } from "./types.js";

describe("isTransformRef", () => {
  it("returns true for a $ref object", () => {
    expect(isTransformRef({ $ref: "#/transforms/myTransform" })).toBe(true);
  });

  it("returns false for a plain string transform", () => {
    expect(isTransformRef("$.input.name")).toBe(false);
  });

  it("returns false for null or undefined cast as TransformOrRef", () => {
    expect(isTransformRef(null as unknown as TransformOrRef)).toBe(false);
    expect(isTransformRef(undefined as unknown as TransformOrRef)).toBe(false);
  });

  it("returns false for an object with an empty $ref", () => {
    expect(isTransformRef({ $ref: "" })).toBe(false);
  });

  it("returns false for an object with a non-string $ref", () => {
    expect(isTransformRef({ $ref: 42 } as unknown as TransformOrRef)).toBe(false);
  });
});

describe("resolveTransform", () => {
  const transforms: Record<string, Transform> = {
    uppercase: "$uppercase($.input)",
    flatten: "$flatten($.items)",
  };

  it("returns the expression directly for an inline string transform", () => {
    expect(resolveTransform("$.input.name", transforms)).toBe("$.input.name");
  });

  it("resolves a $ref to the named transform expression", () => {
    expect(resolveTransform({ $ref: "#/transforms/uppercase" }, transforms)).toBe(
      "$uppercase($.input)",
    );
  });

  it("returns undefined when the ref name is not in the transforms map", () => {
    expect(
      resolveTransform({ $ref: "#/transforms/nonexistent" }, transforms),
    ).toBeUndefined();
  });

  it("returns undefined when the transforms map is not provided", () => {
    expect(
      resolveTransform({ $ref: "#/transforms/uppercase" }),
    ).toBeUndefined();
  });

  it("returns undefined when the $ref does not start with #/transforms/", () => {
    expect(
      resolveTransform({ $ref: "uppercase" }, transforms),
    ).toBeUndefined();
  });

  it("returns undefined for non-string, non-ref values", () => {
    expect(resolveTransform(42 as unknown as TransformOrRef, transforms)).toBeUndefined();
  });

  // Prototype-chain hardening: a named-transform ref whose name collides with
  // a built-in object property must resolve against the document's own
  // transforms map only, never a Function inherited from Object.prototype.
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"])(
    "returns undefined for the built-in property name %s when no such transform exists",
    (name) => {
      expect(
        resolveTransform({ $ref: `#/transforms/${name}` }, transforms),
      ).toBeUndefined();
    },
  );

  it("still resolves a transform genuinely named constructor", () => {
    expect(
      resolveTransform({ $ref: "#/transforms/constructor" }, { constructor: "$.x" }),
    ).toBe("$.x");
  });
});

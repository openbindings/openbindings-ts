import { describe, expect, it } from "vitest";
import { resolveDeclaration } from "./resolved-declaration.js";

describe("resolved declaration procedure", () => {
  it.each([
    ["typeless", {}, false, false, true],
    ["type array retained", { type: ["string", "null"] }, false, true, false],
    ["single non-null anyOf branch", { anyOf: [{ type: "object" }, { type: "null" }] }, true, false, false],
    ["ambiguous choice proves no type", { oneOf: [{ type: "object" }, { type: "string" }] }, false, false, true],
    ["allOf conjoins", { allOf: [{}, { type: "object" }] }, true, false, false],
    ["contradictory allOf proves no inhabited type", { allOf: [{ type: "object" }, { type: "string" }] }, false, false, true],
    ["not and conditionals do not participate", {
      not: { type: "object" },
      if: { type: "object" },
      then: { type: "object" },
    }, false, false, true],
  ])("%s", (_name, schema, onlyObject, stringOnly, noProvedType) => {
    const resolved = resolveDeclaration(schema, false);
    expect(resolved.declaresOnly("object")).toBe(onlyObject);
    expect(resolved.admitsStringAsSoleNonNullType()).toBe(stringOnly);
    if (noProvedType) expect(resolved.types?.size ?? 0).toBe(0);
  });

  it("applies the 3.0 single-type and nullable rules", () => {
    expect(resolveDeclaration({ type: "string", nullable: true }, true)
      .admitsStringAsSoleNonNullType()).toBe(true);
    expect(resolveDeclaration({ type: ["string", "null"] }, true).types).toBeNull();
  });

  it("conjoins members from allOf and the selected choice", () => {
    const resolved = resolveDeclaration({
      allOf: [
        {
          type: "object",
          properties: {
            item: { anyOf: [{ type: "array" }, { type: "null" }] },
          },
        },
        { properties: { other: { type: "string" } } },
      ],
    }, false);
    expect(resolved.declaresOnly("object")).toBe(true);
    expect(resolved.property("item").declaresOnly("array")).toBe(true);
    expect(resolved.propertyNames()).toEqual(["item", "other"]);
  });

  it("follows a supplied reference resolver and preserves 3.1 siblings", () => {
    const resolved = resolveDeclaration(
      { $ref: "#Nested", allOf: [{ properties: { label: { type: "string" } } }] },
      false,
      (reference) => reference === "#Nested"
        ? { type: "object", properties: { nested: { type: "array" } } }
        : undefined,
    );
    expect(resolved.declaresOnly("object")).toBe(true);
    expect(resolved.propertyNames()).toEqual(["label", "nested"]);
  });
});

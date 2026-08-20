import { describe, it, expect } from "vitest";
import { inputCompatible, outputCompatible } from "./compat.js";

describe("inputCompatible", () => {
  it("empty schemas are compatible", () => {
    expect(inputCompatible({}, {}).compatible).toBe(true);
  });

  it("empty candidate is compatible with any target", () => {
    expect(inputCompatible({ type: ["string"] }, {}).compatible).toBe(true);
  });

  it("empty target with constrained candidate is incompatible (candidate cannot handle Top)", () => {
    expect(inputCompatible({}, { type: ["string"] }).compatible).toBe(false);
  });

  it("same type is compatible", () => {
    expect(inputCompatible({ type: ["string"] }, { type: ["string"] }).compatible).toBe(true);
  });

  it("subset type is compatible", () => {
    expect(inputCompatible({ type: ["string"] }, { type: ["string", "number"] }).compatible).toBe(true);
  });

  it("incompatible types", () => {
    expect(inputCompatible({ type: ["boolean"] }, { type: ["string"] }).compatible).toBe(false);
  });

  it("integer is subset of number", () => {
    expect(inputCompatible({ type: ["integer"] }, { type: ["number"] }).compatible).toBe(true);
  });

  it("number is not subset of integer", () => {
    expect(inputCompatible({ type: ["number"] }, { type: ["integer"] }).compatible).toBe(false);
  });

  describe("const/enum", () => {
    it("target const matches candidate const", () => {
      expect(inputCompatible({ const: "a" }, { const: "a" }).compatible).toBe(true);
    });

    it("target const does not match different candidate const", () => {
      expect(inputCompatible({ const: "a" }, { const: "b" }).compatible).toBe(false);
    });

    it("target const is in candidate enum", () => {
      expect(inputCompatible({ const: "a" }, { enum: ["a", "b"] }).compatible).toBe(true);
    });

    it("target const is not in candidate enum", () => {
      expect(inputCompatible({ const: "a" }, { enum: ["b", "c"] }).compatible).toBe(false);
    });

    it("target enum subset of candidate enum", () => {
      expect(inputCompatible({ enum: ["a", "b"] }, { enum: ["a", "b", "c"] }).compatible).toBe(true);
    });

    it("target enum not subset of candidate enum", () => {
      expect(inputCompatible({ enum: ["a", "b"] }, { enum: ["a", "c"] }).compatible).toBe(false);
    });
  });

  describe("object properties", () => {
    it("candidate required must be subset of target required", () => {
      expect(
        inputCompatible(
          { type: ["object"], required: ["a", "b"] },
          { type: ["object"], required: ["a"] },
        ).compatible,
      ).toBe(true);

      expect(
        inputCompatible(
          { type: ["object"], required: ["a"] },
          { type: ["object"], required: ["a", "b"] },
        ).compatible,
      ).toBe(false);
    });

    it("nested properties are checked recursively", () => {
      expect(
        inputCompatible(
          {
            type: ["object"],
            properties: { x: { type: ["string"] } },
          },
          {
            type: ["object"],
            properties: { x: { type: ["string"] } },
          },
        ).compatible,
      ).toBe(true);

      expect(
        inputCompatible(
          {
            type: ["object"],
            properties: { x: { type: ["string"] } },
          },
          {
            type: ["object"],
            properties: { x: { type: ["number"] } },
          },
        ).compatible,
      ).toBe(false);
    });
  });

  describe("array items", () => {
    it("compatible items", () => {
      expect(
        inputCompatible(
          { type: ["array"], items: { type: ["string"] } },
          { type: ["array"], items: { type: ["string"] } },
        ).compatible,
      ).toBe(true);
    });

    it("incompatible items", () => {
      expect(
        inputCompatible(
          { type: ["array"], items: { type: ["string"] } },
          { type: ["array"], items: { type: ["number"] } },
        ).compatible,
      ).toBe(false);
    });
  });

  describe("numeric bounds", () => {
    it("candidate min <= target min", () => {
      expect(
        inputCompatible(
          { type: ["number"], minimum: 5 },
          { type: ["number"], minimum: 3 },
        ).compatible,
      ).toBe(true);
    });

    it("candidate min > target min fails", () => {
      expect(
        inputCompatible(
          { type: ["number"], minimum: 5 },
          { type: ["number"], minimum: 10 },
        ).compatible,
      ).toBe(false);
    });

    it("candidate max >= target max", () => {
      expect(
        inputCompatible(
          { type: ["number"], maximum: 10 },
          { type: ["number"], maximum: 20 },
        ).compatible,
      ).toBe(true);
    });

    it("candidate max < target max fails", () => {
      expect(
        inputCompatible(
          { type: ["number"], maximum: 10 },
          { type: ["number"], maximum: 5 },
        ).compatible,
      ).toBe(false);
    });

    it("exclusive bounds respected", () => {
      expect(
        inputCompatible(
          { type: ["number"], exclusiveMinimum: 5 },
          { type: ["number"], minimum: 5 },
        ).compatible,
      ).toBe(true);

      expect(
        inputCompatible(
          { type: ["number"], minimum: 5 },
          { type: ["number"], exclusiveMinimum: 5 },
        ).compatible,
      ).toBe(false);
    });
  });

  describe("string bounds", () => {
    it("candidate minLength <= target minLength", () => {
      expect(
        inputCompatible(
          { type: ["string"], minLength: 3 },
          { type: ["string"], minLength: 1 },
        ).compatible,
      ).toBe(true);
    });

    it("candidate minLength > target minLength fails", () => {
      expect(
        inputCompatible(
          { type: ["string"], minLength: 3 },
          { type: ["string"], minLength: 5 },
        ).compatible,
      ).toBe(false);
    });
  });

  describe("oneOf/anyOf", () => {
    it("all target variants covered by candidate", () => {
      expect(
        inputCompatible(
          { oneOf: [{ type: ["string"] }, { type: ["number"] }] },
          { oneOf: [{ type: ["string"] }, { type: ["number"] }, { type: ["boolean"] }] },
        ).compatible,
      ).toBe(true);
    });

    it("target variant not covered fails", () => {
      expect(
        inputCompatible(
          { oneOf: [{ type: ["string"] }, { type: ["boolean"] }] },
          { oneOf: [{ type: ["string"] }, { type: ["number"] }] },
        ).compatible,
      ).toBe(false);
    });
  });
});

describe("outputCompatible", () => {
  it("empty schemas are compatible", () => {
    expect(outputCompatible({}, {}).compatible).toBe(true);
  });

  it("non-empty candidate with empty target: candidate is accepted since empty target has no constraints", () => {
    expect(outputCompatible({}, { type: ["string"] }).compatible).toBe(true);
  });

  it("empty candidate is incompatible with non-empty target", () => {
    expect(outputCompatible({ type: ["string"] }, {}).compatible).toBe(false);
  });

  it("same type is compatible", () => {
    expect(outputCompatible({ type: ["string"] }, { type: ["string"] }).compatible).toBe(true);
  });

  it("candidate type must be subset of target type", () => {
    expect(
      outputCompatible(
        { type: ["string", "number"] },
        { type: ["string"] },
      ).compatible,
    ).toBe(true);

    expect(
      outputCompatible(
        { type: ["string"] },
        { type: ["string", "number"] },
      ).compatible,
    ).toBe(false);
  });

  describe("object properties", () => {
    it("target required must be subset of candidate required", () => {
      expect(
        outputCompatible(
          { type: ["object"], required: ["a"] },
          { type: ["object"], required: ["a", "b"] },
        ).compatible,
      ).toBe(true);

      expect(
        outputCompatible(
          { type: ["object"], required: ["a", "b"] },
          { type: ["object"], required: ["a"] },
        ).compatible,
      ).toBe(false);
    });

    it("additionalProperties: false blocks unknown props", () => {
      expect(
        outputCompatible(
          { type: ["object"], additionalProperties: false },
          {
            type: ["object"],
            properties: { x: { type: ["string"] } },
          },
        ).compatible,
      ).toBe(false);
    });
  });

  describe("numeric bounds", () => {
    it("candidate min >= target min for output", () => {
      expect(
        outputCompatible(
          { type: ["number"], minimum: 5 },
          { type: ["number"], minimum: 5 },
        ).compatible,
      ).toBe(true);
    });

    it("candidate min < target min fails for output", () => {
      expect(
        outputCompatible(
          { type: ["number"], minimum: 5 },
          { type: ["number"], minimum: 3 },
        ).compatible,
      ).toBe(false);
    });

    it("target has min but candidate doesn't fails for output", () => {
      expect(
        outputCompatible(
          { type: ["number"], minimum: 5 },
          { type: ["number"] },
        ).compatible,
      ).toBe(false);
    });
  });

  describe("oneOf/anyOf", () => {
    it("all candidate variants covered by target", () => {
      expect(
        outputCompatible(
          { oneOf: [{ type: ["string"] }, { type: ["number"] }, { type: ["boolean"] }] },
          { oneOf: [{ type: ["string"] }, { type: ["number"] }] },
        ).compatible,
      ).toBe(true);
    });

    it("candidate variant not covered fails", () => {
      expect(
        outputCompatible(
          { oneOf: [{ type: ["string"] }] },
          { oneOf: [{ type: ["string"] }, { type: ["number"] }] },
        ).compatible,
      ).toBe(false);
    });
  });
});

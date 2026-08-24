import { describe, expect, it } from "vitest";
import { checkBindingSpecs } from "./bindingspec.js";

describe("checkBindingSpecs", () => {
  const supported = [
    { bindingSpec: "example.alpha@1" },
    { bindingSpec: "example.beta@2", description: "Beta" },
  ];

  it("uses exact identifier equality, preserves order, and removes duplicates", () => {
    expect(checkBindingSpecs([
      "example.beta@2",
      "example.alpha@1.0",
      "example.alpha@1",
      "example.beta@2",
      "example.alpha@1-extra",
    ], supported)).toEqual([
      { bindingSpec: "example.beta@2", supported: true },
      { bindingSpec: "example.alpha@1.0", supported: false },
      { bindingSpec: "example.alpha@1", supported: true },
      { bindingSpec: "example.alpha@1-extra", supported: false },
    ]);
  });

  it("returns an empty array for an empty request", () => {
    expect(checkBindingSpecs([], supported)).toEqual([]);
  });
});

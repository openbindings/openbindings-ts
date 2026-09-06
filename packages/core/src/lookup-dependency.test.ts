import { describe, expect, it } from "vitest";
import { lookupDependency } from "./lookup-dependency.js";
import type { OBInterface } from "./types.js";

describe("lookupDependency", () => {
  const iface: OBInterface = {
    openbindings: "0.2.0",
    operations: {
      deliver: { aliases: ["events.deliver"] },
      constructor: {},
    },
    dependencies: {
      customerDelivery: {
        operation: "deliver",
        bindingSpecs: ["openbindings.openapi@1"],
      },
      constructor: { operation: "constructor" },
    },
  };

  it("returns the named dependency and its exact operation", () => {
    expect(lookupDependency(iface, "customerDelivery")).toEqual({
      key: "customerDelivery",
      dependency: iface.dependencies!.customerDelivery,
      operationKey: "deliver",
      operation: iface.operations.deliver,
    });
  });

  it("does not treat an operation alias as a dependency key", () => {
    expect(lookupDependency(iface, "events.deliver")).toBeUndefined();
  });

  it("uses own-property lookup for dependency and operation keys", () => {
    expect(lookupDependency(iface, "constructor")?.operationKey).toBe("constructor");
    expect(
      lookupDependency(
        { openbindings: "0.2.0", operations: {}, dependencies: {} },
        "constructor",
      ),
    ).toBeUndefined();
  });

  it("fails closed for a malformed dangling dependency", () => {
    const malformed: OBInterface = {
      openbindings: "0.2.0",
      operations: { deliver: {} },
      dependencies: { delivery: { operation: "missing" } },
    };
    expect(lookupDependency(malformed, "delivery")).toBeUndefined();
  });
});

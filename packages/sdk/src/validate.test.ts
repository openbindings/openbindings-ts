import { describe, it, expect } from "vitest";
import { validateInterface } from "./validate.js";
import type { OBInterface } from "./types.js";
import { ValidationError } from "./errors.js";

function minimalInterface(): OBInterface {
  return {
    openbindings: "0.1.0",
    operations: {
      getUser: {
        input: { type: "object" },
        output: { type: "object" },
      },
    },
    sources: {
      main: { format: "openapi@3.1", location: "https://example.com/api.json" },
    },
    bindings: {
      "getUser.main": {
        operation: "getUser",
        source: "main",
        ref: "#/paths/~1users/get",
      },
    },
  };
}

describe("validateInterface", () => {
  it("passes on a minimal valid interface", () => {
    expect(() => validateInterface(minimalInterface())).not.toThrow();
  });

  it("requires openbindings field", () => {
    const iface = minimalInterface();
    iface.openbindings = "";
    expect(() => validateInterface(iface)).toThrow(ValidationError);
  });

  it("requires semver format", () => {
    const iface = minimalInterface();
    iface.openbindings = "1.0";
    expect(() => validateInterface(iface)).toThrow("MAJOR.MINOR.PATCH");
  });

  it("requires operations", () => {
    const iface = minimalInterface();
    (iface as any).operations = undefined;
    expect(() => validateInterface(iface)).toThrow("operations: required");
  });

  it("catches source with both location and content", () => {
    const iface = minimalInterface();
    iface.sources!.main.content = { openapi: "3.1.0" };
    expect(() => validateInterface(iface)).toThrow("cannot have both location and content");
  });

  it("catches binding referencing unknown operation", () => {
    const iface = minimalInterface();
    iface.bindings!["bad.main"] = { operation: "nonexistent", source: "main" };
    expect(() => validateInterface(iface)).toThrow("references unknown operation");
  });

  it("catches binding referencing unknown source", () => {
    const iface = minimalInterface();
    iface.bindings!["bad.main"] = { operation: "getUser", source: "gone" };
    expect(() => validateInterface(iface)).toThrow("references unknown source");
  });

  it("rejects unknown typed fields in strict mode", () => {
    const iface = minimalInterface();
    (iface as any).customField = "oops";
    expect(() =>
      validateInterface(iface, { rejectUnknownTypedFields: true }),
    ).toThrow("unknown fields: customField");
  });

  it("allows x- extensions even in strict mode", () => {
    const iface = minimalInterface();
    (iface as any)["x-custom"] = "fine";
    expect(() =>
      validateInterface(iface, { rejectUnknownTypedFields: true }),
    ).not.toThrow();
  });

  it("enforces supported version when requested", () => {
    const iface = minimalInterface();
    iface.openbindings = "9.9.9";
    expect(() =>
      validateInterface(iface, { requireSupportedVersion: true }),
    ).toThrow("unsupported version");
  });

  it("catches binding referencing unknown security", () => {
    const iface = minimalInterface();
    iface.bindings!["getUser.main"].security = "nonexistent";
    expect(() => validateInterface(iface)).toThrow('references unknown security "nonexistent"');
  });

  it("passes when binding references valid security", () => {
    const iface = minimalInterface();
    iface.security = { default: [{ type: "bearer" }] };
    iface.bindings!["getUser.main"].security = "default";
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("catches inline transform missing type", () => {
    const iface = minimalInterface();
    iface.bindings!["getUser.main"] = {
      ...iface.bindings!["getUser.main"],
      inputTransform: { expression: "foo" } as any,
    };
    expect(() => validateInterface(iface)).toThrow("inputTransform.type: required");
  });

  it("validates alias uniqueness", () => {
    const iface = minimalInterface();
    iface.operations.createUser = {
      aliases: ["getUser"],
    };
    expect(() => validateInterface(iface)).toThrow("conflicts with operation key");
  });
});

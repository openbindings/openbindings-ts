import { describe, it, expect } from "vitest";
import { validateInterface } from "./validate.js";
import type { OBInterface } from "./index.js";
import { ValidationError } from "./index.js";

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

  it("requires SemVer 2.0.0 format (OBI-D-16)", () => {
    const iface = minimalInterface();
    iface.openbindings = "1.0";
    expect(() => validateInterface(iface)).toThrow("OBI-D-16");
  });

  it("requires operations", () => {
    const iface = minimalInterface();
    (iface as any).operations = undefined;
    expect(() => validateInterface(iface)).toThrow("operations: required");
  });

  it("accepts source with both location and content", () => {
    const iface = minimalInterface();
    iface.sources!.main.content = { openapi: "3.1.0" };
    expect(() => validateInterface(iface)).not.toThrow();
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

  it("refuses higher-major versions unconditionally (OBI-T-04)", () => {
    const iface = minimalInterface();
    iface.openbindings = "9.9.9";
    expect(() => validateInterface(iface)).toThrow("OBI-T-04");
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

  it("catches non-string inline transform", () => {
    // Per v0.2 §6.5, inline transforms are JSONata expression strings.
    const iface = minimalInterface();
    iface.bindings!["getUser.main"] = {
      ...iface.bindings!["getUser.main"],
      inputTransform: { expression: "foo" } as any,
    };
    expect(() => validateInterface(iface)).toThrow("must be a non-empty JSONata expression");
  });

  it("validates alias uniqueness", () => {
    const iface = minimalInterface();
    iface.operations.createUser = {
      aliases: ["getUser"],
    };
    expect(() => validateInterface(iface)).toThrow("conflicts with operation key");
  });
});

describe("validateInterface example validation (OBI-D-15)", () => {
  function ifaceWithExample(overrides?: {
    input?: unknown;
    output?: unknown;
    inputSchema?: Record<string, unknown> | null;
    outputSchema?: Record<string, unknown> | null;
  }): OBInterface {
    const op: Record<string, unknown> = {};
    if (overrides?.inputSchema !== null) {
      op.input = overrides?.inputSchema ?? {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      };
    }
    if (overrides?.outputSchema !== null) {
      op.output = overrides?.outputSchema ?? {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      };
    }
    op.examples = {
      basic: {
        ...(overrides?.input !== undefined ? { input: overrides.input } : { input: { name: "Alice" } }),
        ...(overrides?.output !== undefined ? { output: overrides.output } : { output: { id: 42 } }),
      },
    };
    return {
      openbindings: "0.1.0",
      operations: { createUser: op as any },
      sources: {
        main: { format: "openapi@3.1", location: "https://example.com/api.json" },
      },
      bindings: {
        "createUser.main": { operation: "createUser", source: "main", ref: "#/paths/~1users/post" },
      },
    };
  }

  it("passes when examples match their schemas", () => {
    const iface = ifaceWithExample();
    expect(() => validateInterface(iface, { validateExamples: true })).not.toThrow();
  });

  it("fails when example input does not match the input schema", () => {
    const iface = ifaceWithExample({ input: { name: 123 } });
    expect(() => validateInterface(iface, { validateExamples: true })).toThrow(
      /OBI-D-15/,
    );
    try {
      validateInterface(iface, { validateExamples: true });
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const problems = (err as InstanceType<typeof ValidationError>).problems;
      expect(problems.some((p: string) => p.includes('examples["basic"].input'))).toBe(true);
    }
  });

  it("fails when example output does not match the output schema", () => {
    const iface = ifaceWithExample({ output: { id: "not-a-number" } });
    expect(() => validateInterface(iface, { validateExamples: true })).toThrow(
      /OBI-D-15/,
    );
    try {
      validateInterface(iface, { validateExamples: true });
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const problems = (err as InstanceType<typeof ValidationError>).problems;
      expect(problems.some((p: string) => p.includes('examples["basic"].output'))).toBe(true);
    }
  });

  it("checks examples by default", () => {
    const iface = ifaceWithExample({ input: { name: 123 } });
    expect(() => validateInterface(iface)).toThrow(/OBI-D-15/);
    expect(() => validateInterface(iface, {})).toThrow(/OBI-D-15/);
    expect(() => validateInterface(iface, { validateExamples: false })).toThrow(/OBI-D-15/);
  });

  it("skips operations without examples gracefully", () => {
    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: {
        noExamples: {
          input: { type: "object" },
          output: { type: "object" },
        },
      },
      sources: {
        main: { format: "openapi@3.1", location: "https://example.com/api.json" },
      },
      bindings: {
        "noExamples.main": { operation: "noExamples", source: "main", ref: "#/paths/~1foo/get" },
      },
    };
    expect(() => validateInterface(iface, { validateExamples: true })).not.toThrow();
  });

  it("skips examples when the operation has no schemas", () => {
    const iface = ifaceWithExample({ inputSchema: null, outputSchema: null });
    expect(() => validateInterface(iface, { validateExamples: true })).not.toThrow();
  });
});

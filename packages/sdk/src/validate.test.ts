import { describe, it, expect } from "vitest";
import { validateInterface } from "./validate.js";
import type { OBInterface } from "./index.js";
import { ValidationError } from "./index.js";

function minimalInterface(): OBInterface {
  return {
    openbindings: "0.2.0",
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

  it("rejects a relative source location (OBI-D-05)", () => {
    const iface = minimalInterface();
    iface.sources!.main.location = "./api.json";
    expect(() => validateInterface(iface)).toThrow("OBI-D-05");
  });

  it("rejects a relative schema $ref (OBI-D-05)", () => {
    const iface = minimalInterface();
    iface.operations.getUser.output = { $ref: "./schemas.json#/User" };
    expect(() => validateInterface(iface)).toThrow("OBI-D-05");
  });

  it("rejects a dangling same-document $ref (OBI-D-16)", () => {
    const iface = minimalInterface();
    iface.schemas = { Task: { type: "object" } };
    iface.operations.getUser.output = { $ref: "#/schemas/Missing" };
    expect(() => validateInterface(iface)).toThrow("does not resolve within the document (OBI-D-16)");
  });

  it("skips D-16 for $refs under a nested $id (resource-internal)", () => {
    const iface = minimalInterface();
    iface.schemas = {
      Task: {
        $id: "https://example.com/task.schema.json",
        type: "object",
        properties: { parent: { $ref: "#/$defs/base" } },
        $defs: { base: { type: "string" } },
      },
    };
    iface.operations.getUser.output = { $ref: "#/schemas/Task" };
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("permits a plain-name fragment inside an embedded $id-declaring schema", () => {
    // OBI-D-05's pointer-form rule carves out $id scopes (same rule as D-16).
    const iface = minimalInterface();
    iface.schemas = {
      Task: {
        $id: "https://example.com/task.schema.json",
        type: "object",
        properties: { kind: { $ref: "#kindAnchor" } },
        $defs: { kind: { $anchor: "kindAnchor", type: "string" } },
      },
    };
    iface.operations.getUser.output = { $ref: "#/schemas/Task" };
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("rejects a plain-name ($anchor) fragment $ref (OBI-D-05)", () => {
    const iface = minimalInterface();
    iface.schemas = { User: { $anchor: "user", type: "object" } };
    iface.operations.getUser.output = { $ref: "#user" };
    expect(() => validateInterface(iface)).toThrow("plain-name fragment");
  });

  it("accepts a same-document fragment $ref", () => {
    const iface = minimalInterface();
    iface.schemas = { User: { type: "object" } };
    iface.operations.getUser.output = { $ref: "#/schemas/User" };
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("rejects an unsupported pre-release openbindings version (OBI-T-04)", () => {
    const iface = minimalInterface();
    iface.openbindings = "0.2.0-rc.1";
    expect(() => validateInterface(iface)).toThrow("pre-release");
  });

  it("requires openbindings field", () => {
    const iface = minimalInterface();
    iface.openbindings = "";
    expect(() => validateInterface(iface)).toThrow(ValidationError);
  });

  it("requires SemVer 2.0.0 format (OBI-D-12)", () => {
    const iface = minimalInterface();
    iface.openbindings = "1.0";
    expect(() => validateInterface(iface)).toThrow("OBI-D-12");
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

  it("catches non-string inline transform", () => {
    // Per v0.2 §6.5, inline transforms are JSONata expression strings.
    const iface = minimalInterface();
    iface.bindings!["getUser.main"] = {
      ...iface.bindings!["getUser.main"],
      inputTransform: { expression: "foo" } as any,
    };
    expect(() => validateInterface(iface)).toThrow(
      "must be a JSONata expression string or a $ref object",
    );
  });

  it("accepts empty transform expressions (no document rule forbids them)", () => {
    // The schema allows any string; empty expressions fail at invoke time
    // (ERR_TRANSFORM_ERROR / EmptyTransformExpressionError), not at
    // document validation.
    const iface = minimalInterface();
    iface.transforms = { t: "" };
    iface.bindings!["getUser.main"] = {
      ...iface.bindings!["getUser.main"],
      inputTransform: "",
      outputTransform: { $ref: "#/transforms/t" },
    };
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("cites OBI-D-10 for unresolvable transform $refs", () => {
    const iface = minimalInterface();
    iface.bindings!["getUser.main"] = {
      ...iface.bindings!["getUser.main"],
      inputTransform: { $ref: "#/transforms/nonexistent" },
    };
    expect(() => validateInterface(iface)).toThrow(/OBI-D-10/);
  });

  it("accepts any non-empty sources[*].format string at document level (OBI-T-01)", () => {
    // Spec §6.4 deliberately does not constrain the format value beyond
    // being a string; rejecting unrecognized spellings would make the
    // document fail solely due to an unsupported binding format.
    const iface = minimalInterface();
    iface.sources!.main.format = "workers_rpc@1.0";
    expect(() => validateInterface(iface)).not.toThrow();
    iface.sources!.main.format = "vnd custom";
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("validates alias uniqueness", () => {
    const iface = minimalInterface();
    iface.operations.createUser = {
      aliases: ["getUser"],
    };
    expect(() => validateInterface(iface)).toThrow("conflicts with operation key");
  });
});

describe("validateInterface example validation (OBI-D-11)", () => {
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
      openbindings: "0.2.0",
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
    expect(() => validateInterface(iface,)).not.toThrow();
  });

  it("fails when example input does not match the input schema", () => {
    const iface = ifaceWithExample({ input: { name: 123 } });
    expect(() => validateInterface(iface,)).toThrow(
      /OBI-D-11/,
    );
    try {
      validateInterface(iface,);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const problems = (err as InstanceType<typeof ValidationError>).problems;
      expect(problems.some((p: string) => p.includes('examples["basic"].input'))).toBe(true);
    }
  });

  it("fails when example output does not match the output schema", () => {
    const iface = ifaceWithExample({ output: { id: "not-a-number" } });
    expect(() => validateInterface(iface,)).toThrow(
      /OBI-D-11/,
    );
    try {
      validateInterface(iface,);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const problems = (err as InstanceType<typeof ValidationError>).problems;
      expect(problems.some((p: string) => p.includes('examples["basic"].output'))).toBe(true);
    }
  });

  it("checks examples by default", () => {
    const iface = ifaceWithExample({ input: { name: 123 } });
    expect(() => validateInterface(iface)).toThrow(/OBI-D-11/);
    expect(() => validateInterface(iface, {})).toThrow(/OBI-D-11/);
    expect(() => validateInterface(iface,)).toThrow(/OBI-D-11/);
  });

  it("skips operations without examples gracefully", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
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
    expect(() => validateInterface(iface,)).not.toThrow();
  });

  it("skips examples when the operation has no schemas", () => {
    const iface = ifaceWithExample({ inputSchema: null, outputSchema: null });
    expect(() => validateInterface(iface,)).not.toThrow();
  });
});

describe("validateInterface example validation edge cases (OBI-D-11)", () => {
  function baseIface(input: Record<string, unknown>, example: Record<string, unknown>): OBInterface {
    return {
      openbindings: "0.2.0",
      operations: {
        greet: {
          input,
          examples: { ex: example },
        },
      },
    };
  }

  it("validates an explicit null example value (distinct from absent)", () => {
    const iface = baseIface({ type: "object" }, { input: null });
    expect(() => validateInterface(iface)).toThrow(/OBI-D-11/);
  });

  it("does not validate an absent example value", () => {
    const iface = baseIface({ type: "object" }, { output: { ok: true } });
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("abstains from example validation when the operation schema has an external $ref", () => {
    // Capability-relative verification: an unresolvable external reference
    // means the validator abstains rather than failing the document.
    const iface = baseIface(
      { $ref: "https://schemas.example.com/user.json" },
      { input: { anything: true } },
    );
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("abstains when an external $ref is reachable via the schemas map", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      schemas: {
        User: { $ref: "https://schemas.example.com/user.json" },
      },
      operations: {
        greet: {
          input: { $ref: "#/schemas/User" },
          examples: { ex: { input: { anything: true } } },
        },
      },
    };
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("still validates examples against internal #/schemas/ refs", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      schemas: {
        User: { type: "object", required: ["name"] },
      },
      operations: {
        greet: {
          input: { $ref: "#/schemas/User" },
          examples: { bad: { input: { wrong: 42 } } },
        },
      },
    };
    expect(() => validateInterface(iface)).toThrow(/OBI-D-11/);
  });
});

// OBI-T-04's refusal runs downward too: a version below the SDK's minimum is
// refused rather than processed under the wrong rules (pre-1.0 minors may
// change field semantics in either direction). Mirrors the Go SDK's message.
describe("OBI-T-04 downward refusal", () => {
  it("refuses a document below MIN_SUPPORTED_VERSION", () => {
    expect(() => validateInterface({ openbindings: "0.1.0", operations: {} }))
      .toThrowError(/below this SDK's MinSupportedVersion "0\.2\.0" \(OBI-T-04\)/);
  });
});

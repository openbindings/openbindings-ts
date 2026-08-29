import { describe, it, expect } from "vitest";
import { validateInterface } from "./validate.js";
import type { BindingEntry, OBInterface, Operation, Source } from "./index.js";
import { ValidationError } from "./index.js";

// The fixture with its known members typed as present, so tests can reach
// into them without per-site narrowing. Still a plain OBInterface to every
// consumer; `sources`/`bindings` stay optional so tests may delete them.
type MinimalInterface = OBInterface & {
  operations: { getUser: Operation };
  sources?: { main: Source };
  bindings?: { "getUser.main": BindingEntry };
};

function minimalInterface(): MinimalInterface {
  return {
    openbindings: "0.2.0",
    operations: {
      getUser: {
        input: { type: "object" },
        output: { type: "object" },
      },
    },
    sources: {
      main: {
        bindingSpec: "openbindings.openapi-3.1@1",
        location: "https://example.com/api.json",
      },
    },
    bindings: {
      "getUser.main": {
        operation: "getUser",
        source: "main",
        selector: "#/paths/~1users/get",
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

  // OBI-D-05: a sources[*].location may be a format-defined absolute address
  // (e.g. a gRPC host:port), not only a URI. These need no base URI and must
  // not be rejected as relative references, including IP-literal and IPv6
  // hosts that a URL parser cannot parse as a URI. Mirrors the Go SDK's
  // TestInterfaceValidate_SourceLocationFormatDefinedAddress.
  it.each([
    "grpc.example.com:443",
    "localhost:50051",
    "10.0.0.1:443",
    "[::1]:443",
    "dns:///grpc.example.com:443",
    "https://api.example.com/openapi.json",
  ])(
    "accepts format-defined absolute address %s as a source location (OBI-D-05)",
    (addr) => {
      const iface = minimalInterface();
      iface.sources!.main = {
        bindingSpec: "openbindings.grpc@1",
        location: addr,
      };
      delete iface.bindings;
      expect(() => validateInterface(iface)).not.toThrow();
    },
  );

  // OBI-D-05: a relative reference needs a base URI and is not allowed.
  // Mirrors the Go SDK's TestInterfaceValidate_SourceLocationRelativeRejected.
  it.each([
    "./openapi.json",
    "openapi.json",
    "../api/openapi.json",
    "/abs/openapi.json",
  ])("rejects relative source location %s (OBI-D-05)", (loc) => {
    const iface = minimalInterface();
    iface.sources!.main.location = loc;
    expect(() => validateInterface(iface)).toThrow(
      "not a relative reference (OBI-D-05)",
    );
  });

  it("rejects a dangling same-document $ref (OBI-D-16)", () => {
    const iface = minimalInterface();
    iface.schemas = { Task: { type: "object" } };
    iface.operations.getUser.output = { $ref: "#/schemas/Missing" };
    expect(() => validateInterface(iface)).toThrow(
      "does not resolve within the document (OBI-D-16)",
    );
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

  it("permits a nested relative $id inside an embedded $id-declaring schema", () => {
    // §10 clause 2 / OBI-D-05: a nested $id inside a schema that already
    // declares its own $id resolves against that resource's base per JSON
    // Schema 2020-12 and MAY be relative — resource-internal, the same
    // scope carve-out as $ref/$anchor/dynamic-pair.
    const iface = minimalInterface();
    iface.schemas = {
      Task: {
        $id: "https://example.com/task.schema.json",
        type: "object",
        $defs: { kind: { $id: "kind.schema.json", type: "string" } },
      },
    };
    iface.operations.getUser.output = { $ref: "#/schemas/Task" };
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("rejects a relative $id at an OBI position (OBI-D-05)", () => {
    const iface = minimalInterface();
    iface.schemas = { Task: { $id: "task.schema.json", type: "object" } };
    iface.operations.getUser.output = { $ref: "#/schemas/Task" };
    expect(() => validateInterface(iface)).toThrow(
      '$id: "task.schema.json" must be an absolute URI (OBI-D-05)',
    );
  });

  it("rejects a percent-encoded fragment as not in literal form (OBI-D-05)", () => {
    // Literal form (§7): same-document fragments are written with the
    // pointer's characters unencoded, so #/schemas/T%61sk is not a
    // conformant OBI reference even though it would decode to the existing
    // Task schema. Reported rather than silently decoded and resolved.
    const iface = minimalInterface();
    iface.schemas = { Task: { type: "object" } };
    iface.operations.getUser.output = { $ref: "#/schemas/T%61sk" };
    expect(() => validateInterface(iface)).toThrow("is not in literal form");
  });

  it("rejects a dangling percent-encoded fragment at the literal-form gate (OBI-D-05, before OBI-D-16)", () => {
    // A percent-encoded fragment is non-conformant regardless of whether it
    // would decode to a present location: the literal-form gate fires before
    // the referential-integrity check.
    const iface = minimalInterface();
    iface.schemas = { Task: { type: "object" } };
    iface.operations.getUser.output = { $ref: "#/schemas/M%69ssing" };
    expect(() => validateInterface(iface)).toThrow("is not in literal form");
  });

  it("rejects $dynamicRef at an operation output position (OBI-D-05)", () => {
    // OBI-D-05: the dynamic pair does not appear at OBI positions at all.
    const iface = minimalInterface();
    iface.operations.getUser.output = { $dynamicRef: "#node" };
    expect(() => validateInterface(iface)).toThrow(
      /\$dynamicRef does not appear at OBI positions.*OBI-D-05/,
    );
  });

  it("rejects $dynamicAnchor in the schemas map (OBI-D-05)", () => {
    // OBI-D-05: $dynamicAnchor would be a second named-schema mechanism
    // competing with the schemas map, exactly as $anchor would.
    const iface = minimalInterface();
    iface.schemas = { Task: { $dynamicAnchor: "task", type: "object" } };
    iface.operations.getUser.output = { $ref: "#/schemas/Task" };
    expect(() => validateInterface(iface)).toThrow(
      /\$dynamicAnchor does not appear at OBI positions.*OBI-D-05/,
    );
  });

  it("permits the dynamic pair inside an embedded $id-declaring schema", () => {
    // A schema resource declaring its own $id may use the dynamic pair
    // internally, per the same scope rule as $ref/$anchor — including full
    // 2020-12 recursive-extension semantics (a sibling $dynamicAnchor plus a
    // nested $dynamicRef referencing it).
    const iface = minimalInterface();
    iface.schemas = {
      Tree: {
        $id: "https://example.com/tree.schema.json",
        $dynamicAnchor: "node",
        type: "object",
        properties: {
          children: { type: "array", items: { $dynamicRef: "#node" } },
        },
      },
    };
    iface.operations.getUser.output = { $ref: "#/schemas/Tree" };
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("treats a property NAMED $dynamicRef under properties as data, not a keyword", () => {
    // Keyword-shape-aware, mirroring the same guard already in place for $ref.
    const iface = minimalInterface();
    iface.operations.getUser.output = {
      type: "object",
      properties: {
        $dynamicRef: { type: "string" },
        $dynamicAnchor: { type: "string" },
      },
    };
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
    expect(() => validateInterface(iface)).toThrow(
      "references unknown operation",
    );
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
    // Per v0.2 §5.5, inline transforms are JSONata expression strings.
    const iface = minimalInterface();
    iface.bindings!["getUser.main"] = {
      ...iface.bindings!["getUser.main"],
      inputTransform: { expression: "foo" } as any,
    };
    expect(() => validateInterface(iface)).toThrow(
      "must be a JSONata expression string or a $ref object",
    );
  });

  it("rejects empty transform expressions (OBI-D-18)", () => {
    // OBI-D-18: every transform expression parses as a syntactically valid
    // JSONata expression; an empty string is not one (jsonata-js 2.1.1
    // rejects it at parse, the normative tiebreak).
    const iface = minimalInterface();
    iface.transforms = { t: "" };
    iface.bindings!["getUser.main"] = {
      ...iface.bindings!["getUser.main"],
      inputTransform: "",
      outputTransform: { $ref: "#/transforms/t" },
    };
    let msg = "";
    try {
      validateInterface(iface);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(
      'transforms["t"]: not a syntactically valid JSONata expression (OBI-D-18)',
    );
    expect(msg).toContain(
      'bindings["getUser.main"].inputTransform: not a syntactically valid JSONata expression (OBI-D-18)',
    );
  });

  it("cites OBI-D-10 for unresolvable transform $refs", () => {
    const iface = minimalInterface();
    iface.bindings!["getUser.main"] = {
      ...iface.bindings!["getUser.main"],
      inputTransform: { $ref: "#/transforms/nonexistent" },
    };
    expect(() => validateInterface(iface)).toThrow(/OBI-D-10/);
  });

  it("accepts any non-empty sources[*].bindingSpec string at document level (OBI-T-01)", () => {
    // The spec deliberately does not constrain the bindingSpec value beyond
    // being a non-empty string (identifiers are exact and opaque, core §6);
    // rejecting unrecognized spellings would make the document fail solely
    // due to an unsupported binding specification.
    const iface = minimalInterface();
    iface.sources!.main.bindingSpec = "workers_rpc@1.0";
    expect(() => validateInterface(iface)).not.toThrow();
    iface.sources!.main.bindingSpec = "vnd custom";
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("validates alias uniqueness", () => {
    const iface = minimalInterface();
    iface.operations.createUser = {
      aliases: ["getUser"],
    };
    expect(() => validateInterface(iface)).toThrow(
      "conflicts with operation key",
    );
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
        ...(overrides?.input !== undefined
          ? { input: overrides.input }
          : { input: { name: "Alice" } }),
        ...(overrides?.output !== undefined
          ? { output: overrides.output }
          : { output: { id: 42 } }),
      },
    };
    return {
      openbindings: "0.2.0",
      operations: { createUser: op },
      sources: {
        main: {
          bindingSpec: "openbindings.openapi-3.1@1",
          location: "https://example.com/api.json",
        },
      },
      bindings: {
        "createUser.main": {
          operation: "createUser",
          source: "main",
          selector: "#/paths/~1users/post",
        },
      },
    };
  }

  it("passes when examples match their schemas", () => {
    const iface = ifaceWithExample();
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("fails when example input does not match the input schema", () => {
    const iface = ifaceWithExample({ input: { name: 123 } });
    expect(() => validateInterface(iface)).toThrow(/OBI-D-11/);
    try {
      validateInterface(iface);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const problems = (err as InstanceType<typeof ValidationError>).problems;
      expect(
        problems.some((p: string) => p.includes('examples["basic"].input')),
      ).toBe(true);
    }
  });

  it("fails when example output does not match the output schema", () => {
    const iface = ifaceWithExample({ output: { id: "not-a-number" } });
    expect(() => validateInterface(iface)).toThrow(/OBI-D-11/);
    try {
      validateInterface(iface);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const problems = (err as InstanceType<typeof ValidationError>).problems;
      expect(
        problems.some((p: string) => p.includes('examples["basic"].output')),
      ).toBe(true);
    }
  });

  it("checks examples by default", () => {
    const iface = ifaceWithExample({ input: { name: 123 } });
    expect(() => validateInterface(iface)).toThrow(/OBI-D-11/);
    expect(() => validateInterface(iface, {})).toThrow(/OBI-D-11/);
    expect(() => validateInterface(iface)).toThrow(/OBI-D-11/);
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
        main: {
          bindingSpec: "openbindings.openapi-3.1@1",
          location: "https://example.com/api.json",
        },
      },
      bindings: {
        "noExamples.main": {
          operation: "noExamples",
          source: "main",
          selector: "#/paths/~1foo/get",
        },
      },
    };
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("skips examples when the operation has no schemas", () => {
    const iface = ifaceWithExample({ inputSchema: null, outputSchema: null });
    expect(() => validateInterface(iface)).not.toThrow();
  });
});

describe("validateInterface example validation edge cases (OBI-D-11)", () => {
  function baseIface(
    input: Record<string, unknown>,
    example: Record<string, unknown>,
  ): OBInterface {
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

  it("validates examples with refs resolved from the OBI document root", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: {
        greet: {
          input: {
            type: "object",
            properties: {
              name: { $ref: "#/operations/greet/input/$defs/Name" },
            },
            required: ["name"],
            $defs: { Name: { type: "string" } },
          },
          examples: { bad: { input: { name: 42 } } },
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
    expect(() =>
      validateInterface({ openbindings: "0.1.0", operations: {} }),
    ).toThrowError(
      /older than the oldest version this implementation supports \(0\.2\.0\) \(OBI-T-04\)/,
    );
  });
});

// OBI-D-17: every schema in the document is well-formed — object or boolean
// form, meta-schema-valid, recursively through subschemas. Mirrors the Go
// SDK's tests and detail strings.
describe("OBI-D-17 schema well-formedness", () => {
  it("accepts boolean-form schemas at every schema position", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      schemas: { Anything: true },
      operations: {
        op: { input: true, output: false },
        nested: {
          input: {
            type: "object",
            properties: {
              locked: false,
              values: { type: "array", items: true },
            },
            additionalProperties: false,
          },
        },
      },
    };
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it.each([
    [
      "type as number at input",
      { input: { type: 42 } },
      'operations["op"].input',
    ],
    [
      "unknown simple type",
      { input: { type: "str" } },
      'operations["op"].input',
    ],
    [
      "nested minLength as string",
      { output: { type: "object", properties: { a: { minLength: "3" } } } },
      'operations["op"].output',
    ],
    [
      "oneOf as object",
      { output: { oneOf: { type: "string" } } },
      'operations["op"].output',
    ],
  ])("rejects meta-schema violations: %s", (_name, op, prefix) => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { op: op },
    };
    let msg = "";
    try {
      validateInterface(iface);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(
      `${prefix}: not a well-formed JSON Schema 2020-12 schema:`,
    );
    expect(msg).toContain("(OBI-D-17)");
  });

  it("rejects non-object-non-boolean schema values with a deterministic diagnostic", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      schemas: { Task: 42 as never },
      operations: { op: { output: "not-a-schema" as never } },
    };
    let msg = "";
    try {
      validateInterface(iface);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(
      'schemas["Task"]: a schema is a JSON Schema 2020-12 object or boolean; got number (OBI-D-17)',
    );
    expect(msg).toContain(
      'operations["op"].output: a schema is a JSON Schema 2020-12 object or boolean; got string (OBI-D-17)',
    );
  });

  it("is deliberately narrow: unknown keywords, bad pattern regexes, unresolvable external $refs pass", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: {
        op: {
          input: {
            type: "object",
            "x-internal": true,
            futureKeyword: { arbitrary: "annotation" },
            properties: {
              code: { type: "string", pattern: "([unclosed" },
            },
          },
          output: {
            $ref: "https://schemas.example.com/never-published/task.json",
          },
        },
      },
    };
    expect(() => validateInterface(iface)).not.toThrow();
  });
});

// A boundary schema synthesized from a heavily-referenced artifact is a DAG:
// one dereferenced component subtree occurs at hundreds of positions, in every
// operation that mentions it. Deciding OBI-D-17 by walking the expanded TREE
// costs the product of those repetitions, which is how a 1.1 MB OpenAPI
// artifact exhausted an 8 GB heap (corpus-lab F-O1-1). The verdict is decided
// per distinct node, so these documents must stay cheap without any change to
// what OBI-D-17 accepts or to the diagnostics it emits.
describe("OBI-D-17 on shared component graphs", () => {
  // One shared "component": a wide object whose properties are themselves
  // shared, so its expanded tree is far larger than its node count.
  function component(
    depth: number,
    shared: Record<string, unknown>,
  ): Record<string, unknown> {
    if (depth === 0) return shared;
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++)
      properties[`field${i}`] = component(depth - 1, shared);
    return {
      type: "object",
      properties,
      required: ["field0"],
      additionalProperties: false,
    };
  }

  function corpusShapedInterface(operationCount: number): OBInterface {
    const leaf = { type: "string", description: "a shared leaf component" };
    const shared = component(5, leaf);
    const operations: Record<string, Operation> = {};
    for (let i = 0; i < operationCount; i++) {
      // Every operation carries its OWN copy, exactly as per-operation
      // projection produces: sharing is real inside an operation, absent
      // across them.
      operations[`op${i}`] = {
        input: structuredClone(shared),
        output: structuredClone(shared),
      };
    }
    return { openbindings: "0.2.0", operations };
  }

  it("validates a many-operation shared-component document in bounded time", () => {
    const iface = corpusShapedInterface(10);
    const started = performance.now();
    expect(() => validateInterface(iface)).not.toThrow();
    const elapsed = performance.now() - started;
    // Tree-expanded validation of this document is ~78,000 schema positions
    // — a minute of wall clock, and hundreds of megabytes of live validator
    // state. Node-wise it is six distinct shapes. The bound is deliberately
    // loose so it fails only on the growth class, never on machine speed.
    expect(elapsed).toBeLessThan(10_000);
  }, 120_000);

  it("still reports a violation buried in a shared subtree", () => {
    // Deliberately small: a document that fails is decided by the ordinary
    // whole-tree walk, which is the sole authority on the diagnostics.
    const leaf = { type: "string" };
    const shared = {
      type: "object",
      properties: { field0: leaf, field1: leaf },
    };
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: {
        op0: { input: structuredClone(shared) },
        op1: { input: structuredClone(shared) },
      },
    };
    const input = iface.operations["op1"]!.input as Record<string, unknown>;
    const properties = input["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    // `items` in array form is draft-4 syntax, not 2020-12 (prefixItems).
    properties["field1"]!["items"] = [{ type: "string" }];
    let msg = "";
    try {
      validateInterface(iface);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(
      'operations["op1"].input: not a well-formed JSON Schema 2020-12 schema:',
    );
    expect(msg).toContain("/properties/field1/items");
    expect(msg).toContain("(OBI-D-17)");
    // The identical, well-formed sibling operation is untouched.
    expect(msg).not.toContain('operations["op0"]');
  });

  it("keeps a malformed value that repeats at many positions reported once per schema position", () => {
    const bad = { minLength: "3" };
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: {
        op: {
          input: { type: "object", properties: { a: bad, b: bad }, items: bad },
        },
      },
    };
    let msg = "";
    try {
      validateInterface(iface);
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const pointer of [
      "/properties/a/minLength",
      "/properties/b/minLength",
      "/items/minLength",
    ]) {
      expect(msg).toContain(pointer);
    }
  });
});

// OBI-D-18: transform parse-validity — parse-only membership in the pinned
// language. Mirrors the Go SDK's tests and detail strings.
describe("OBI-D-18 transform parse-validity", () => {
  it("accepts parse-valid transforms, including expressions whose evaluation would fail", () => {
    const iface = minimalInterface();
    iface.transforms = {
      nontrivial:
        'items[price > 10].{ "label": name & " ($" & $string(price) & ")", "total": price * quantity }',
      evalWouldFail: "payload.does.not.exist",
      unknownFunction: "$definitelyNotARealFunction(payload)",
    };
    iface.bindings!["getUser.main"] = {
      ...iface.bindings!["getUser.main"],
      inputTransform: '{ "task_title": title }',
    };
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("rejects expressions that do not parse, at named and inline positions", () => {
    const iface = minimalInterface();
    iface.transforms = { unbalanced: "(a + b" };
    iface.bindings!["getUser.main"] = {
      ...iface.bindings!["getUser.main"],
      inputTransform: "items[",
      outputTransform: '{ "id": }',
    };
    let msg = "";
    try {
      validateInterface(iface);
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const want of [
      'transforms["unbalanced"]: not a syntactically valid JSONata expression (OBI-D-18)',
      'bindings["getUser.main"].inputTransform: not a syntactically valid JSONata expression (OBI-D-18)',
      'bindings["getUser.main"].outputTransform: not a syntactically valid JSONata expression (OBI-D-18)',
    ]) {
      expect(msg).toContain(want);
    }
  });
});

// Boolean schemas must survive parse and round-trip (§5.2 admits boolean
// form at every schema position).
describe("boolean schema round-trip", () => {
  it("parses and re-serializes boolean input/output/schemas entries", () => {
    const raw =
      '{"openbindings":"0.2.0","operations":{"op":{"input":true,"output":false}},"schemas":{"Anything":true}}';
    const iface = JSON.parse(raw) as OBInterface;
    expect(() => validateInterface(iface)).not.toThrow();
    const round = JSON.parse(JSON.stringify(iface)) as Record<string, unknown>;
    const op = (round.operations as { op: Record<string, unknown> }).op;
    expect(op.input).toBe(true);
    expect(op.output).toBe(false);
    expect((round.schemas as Record<string, unknown>).Anything).toBe(true);
  });
});

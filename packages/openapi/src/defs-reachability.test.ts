import { describe, expect, it } from "vitest";
import { OpenAPISynthesizer } from "./test-helpers.js";
import { BINDING_SPEC_OPENAPI_31 as BINDING_SPEC } from "./constants.js";

// Twin of openbindings-go/formats/openapi/defs_reachability_test.go.
//
// One self-recursive component, reached from a request body only through a
// property the OAS declares readOnly. Request projection removes that
// property, so the emitted input schema cannot reach the component; the
// emitted output schema, where readOnly properties stand, can. The emitted
// `$defs` map must state exactly that difference.
//
// The document is authored from the OAS text (readOnly is an OAS 3.1 Schema
// Object keyword inherited from JSON Schema 2020-12 §9.4.1; a self-recursive
// component is JSON Schema's own recursion) and from no corpus artifact.
const REACHABILITY_DOC = {
  openapi: "3.1.0",
  info: { title: "defs reachability", version: "1.0.0" },
  paths: {
    "/records": {
      post: {
        operationId: "createRecord",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Record" } } },
        },
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Record" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Record: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          audit: {
            readOnly: true,
            anyOf: [{ type: "string" }, { $ref: "#/components/schemas/AuditEntry" }],
          },
        },
      },
      AuditEntry: {
        type: "object",
        properties: {
          actor: { type: "string" },
          previous: {
            anyOf: [{ type: "string" }, { $ref: "#/components/schemas/AuditEntry" }],
          },
        },
      },
    },
  },
};

/** Every `$ref` string value anywhere in a node, at any position. */
function refStrings(node: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$ref" && typeof child === "string") {
        out.push(child);
        continue;
      }
      walk(child);
    }
  };
  walk(node);
  return out;
}

/**
 * The invariant both engines hold: an emitted operation schema's `$defs` map
 * contains exactly the definitions reachable from that schema's root (for a
 * document that declares no `$defs` of its own), and every emitted `$ref`
 * into it resolves within the emitted document (OBI-D-16).
 */
function assertDefsReachabilityClosed(schema: Record<string, unknown>, refBase: string): void {
  const defs = (schema.$defs ?? {}) as Record<string, unknown>;
  const prefix = `${refBase}/$defs/`;
  const reachable = new Set<string>();
  const pending: string[] = [];
  const visit = (node: unknown): void => {
    for (const ref of refStrings(node)) {
      if (!ref.startsWith(prefix)) continue;
      const name = ref.slice(prefix.length).split("/")[0]!
        .replaceAll("~1", "/").replaceAll("~0", "~");
      expect(Object.hasOwn(defs, name), `$ref ${ref} must resolve in the emitted document`).toBe(true);
      if (!reachable.has(name)) {
        reachable.add(name);
        pending.push(name);
      }
    }
  };
  const { $defs: _omitted, ...root } = schema;
  visit(root);
  while (pending.length > 0) visit(defs[pending.pop()!]);
  expect([...Object.keys(defs)].sort()).toEqual([...reachable].sort());
}

async function synthesizeReachabilityDoc(): Promise<Record<string, any>> {
  const synth = new OpenAPISynthesizer();
  const result = await synth.synthesizeInterfaceWithCoverage({
    sources: [{ bindingSpec: BINDING_SPEC, content: structuredClone(REACHABILITY_DOC) }],
  });
  const op = result.interface.operations.createRecord;
  expect(op, "expected createRecord").toBeDefined();
  return op as Record<string, any>;
}

describe("$defs reachability closure (F-O1-5b)", () => {
  it("preserves an annotated request branch and its reachable cut point", async () => {
    const op = await synthesizeReachabilityDoc();
    const input = op.input as Record<string, any>;

    expect(Object.keys(input.properties)).toContain("audit");
    expect(Object.keys(input.$defs ?? {})).toEqual(["AuditEntry"]);
    const want = "#/operations/createRecord/input/$defs/AuditEntry";
    const { $defs, ...root } = input;
    expect(refStrings(root)).toEqual([want]);
    expect(refStrings($defs.AuditEntry)).toEqual([want]);
    assertDefsReachabilityClosed(input, "#/operations/createRecord/input");
  });

  it("keeps a reached self-recursive component as exactly one referenced definition", async () => {
    const op = await synthesizeReachabilityDoc();
    const output = op.output as Record<string, any>;

    expect(Object.keys(output.properties)).toContain("audit");
    expect(Object.keys(output.$defs ?? {})).toEqual(["AuditEntry"]);

    const want = "#/operations/createRecord/output/$defs/AuditEntry";
    const { $defs, ...root } = output;
    expect(refStrings(root)).toEqual([want]);
    expect(refStrings($defs.AuditEntry)).toEqual([want]);
    assertDefsReachabilityClosed(output, "#/operations/createRecord/output");
  });

  it("keeps a definition the artifact's own Schema Object declares", async () => {
    // An OAS 3.1 Schema Object is a JSON Schema 2020-12 schema and may carry
    // its own `$defs`. Those members are artifact content, not synthesis
    // output, and stand whether or not anything references them.
    const synth = new OpenAPISynthesizer();
    const result = await synth.synthesizeInterfaceWithCoverage({
      sources: [{
        bindingSpec: BINDING_SPEC,
        content: {
          openapi: "3.1.0",
          info: { title: "authorial defs", version: "1.0.0" },
          paths: {
            "/values": {
              get: {
                operationId: "readValue",
                responses: {
                  "200": {
                    description: "ok",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          $defs: { Unused: { type: "string" } },
                          properties: { name: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }],
    });
    const output = result.interface.operations.readValue?.output as Record<string, any>;
    expect(Object.keys(output.$defs ?? {})).toEqual(["Unused"]);
  });
});

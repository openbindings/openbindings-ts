import { describe, expect, it } from "vitest";
import { OpenAPISynthesizer } from "./test-helpers.js";
import { BINDING_SPEC_OPENAPI_31 as BINDING_SPEC } from "./constants.js";

// A document with one clean operation and two operations that are genuinely
// unrepresentable by the complete first candidate: a required multipart
// scalar body with no OpenAPI-defined carriage, and two header parameters
// whose case-folded wire identities collide. The tolerant coverage surface
// must return a sound partial OBI that binds the clean operation and accounts
// for both exclusions; strict synthesis must refuse the whole document.
const MIXED_DOC = {
  openapi: "3.0.3",
  info: { title: "mixed", version: "1.0.0" },
  paths: {
    "/good": {
      get: {
        operationId: "getGood",
        responses: { "200": { description: "ok" } },
      },
    },
    "/conditional": {
      post: {
        operationId: "postUncarriable",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: { type: "string" },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/collide": {
      get: {
        operationId: "getCollide",
        parameters: [
          { name: "X-ID", in: "header", schema: { type: "string" } },
          { name: "x-id", in: "header", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

function input() {
  return { sources: [{ bindingSpec: BINDING_SPEC, content: MIXED_DOC }] };
}

describe("per-operation tolerant coverage synthesis", () => {
  it("strict synthesis still refuses the whole document", async () => {
    const synth = new OpenAPISynthesizer();
    await expect(synth.synthesizeInterface(input())).rejects.toThrow(/cannot synthesize OpenAPI operation/);
  });

  it("coverage synthesis returns a sound partial OBI with every omission accounted", async () => {
    const synth = new OpenAPISynthesizer();
    const result = await synth.synthesizeInterfaceWithCoverage(input());

    // The clean operation is bound; the unrepresentable ones are omitted.
    expect(Object.keys(result.interface.operations)).toEqual(["getGood"]);
    expect(Object.values(result.interface.bindings ?? {}).map((b) => b.selector)).toEqual(["#/paths/~1good/get"]);

    // Every omission is a spec-governed excluded target, never an
    // implementation-unsupported invariant violation.
    const targets = result.coverage.entries.filter((e) => e.scope === "target");
    const byRef = new Map(targets.map((e) => [e.sourceRef, e]));

    expect(byRef.get("#/paths/~1good/get")?.status).toBe("represented");

    const conditional = byRef.get("#/paths/~1conditional/post");
    expect(conditional?.status).toBe("excluded");
    expect(conditional?.reasonCode).toMatch(/^openapi\.(unresolvable_request_body|media_schema_mismatch)$/);
    expect(conditional?.rule).toBe("OAPI30-P-03");
    expect(conditional?.message).toBeTruthy();

    const collide = byRef.get("#/paths/~1collide/get");
    expect(collide?.status).toBe("excluded");
    expect(collide?.reasonCode).toBe("openapi.flattening_collision");
    expect(collide?.rule).toBe("OAPI30-P-02");

    expect(targets.some((e) => e.status === "implementation-unsupported")).toBe(false);

    // The inventory is exhaustive; it is honestly not fully represented.
    expect(result.coverage.exhaustive).toBe(true);
    expect(result.coverage.fullyRepresented).toBe(false);
  });

  it("source inspection filters unrepresentable targets instead of refusing the document", async () => {
    const synth = new OpenAPISynthesizer();
    const inspection = await synth.inspectSource({ bindingSpec: BINDING_SPEC, content: MIXED_DOC });
    expect(inspection.targets.map((t) => t.selector)).toEqual(["#/paths/~1good/get"]);
    expect(inspection.exhaustive).toBe(true);
  });

  it("a document whose every operation is unrepresentable yields an empty sound OBI", async () => {
    const synth = new OpenAPISynthesizer();
    const doc = {
      openapi: "3.0.3",
      info: { title: "all-bad", version: "1.0.0" },
      paths: { "/conditional": MIXED_DOC.paths["/conditional"] },
    };
    const result = await synth.synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content: doc }],
    });
    expect(Object.keys(result.interface.operations)).toEqual([]);
    const targets = result.coverage.entries.filter((e) => e.scope === "target");
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("excluded");
  });
});

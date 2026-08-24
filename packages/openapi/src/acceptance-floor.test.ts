// Integration tests for the acceptance floor's evidenced surfaces (block
// 8d-1): Scenario B confinement — the affected operation is entried as
// `invalid` under `openapi.invalid_unit`, siblings synthesize — the §3
// part-2 whole-source refusal on both synthesis surfaces, and the
// per-reaching-unit invalidation of unresolvable internal references.

import { describe, expect, it } from "vitest";
import { OpenAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

const synthesizer = new OpenAPISynthesizer();

function input(content: unknown) {
  return { sources: [{ bindingSpec: BINDING_SPEC, content }] };
}

describe("acceptance floor at synthesis", () => {
  it("entries a ladder-invalid target and synthesizes its sibling (Scenario B)", async () => {
    const result = await synthesizer.synthesizeInterfaceWithCoverage(input({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/good": { get: { operationId: "getGood", responses: { "200": { description: "ok" } } } },
        "/bad": {
          get: {
            operationId: "getBad",
            responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "int" } } } } },
          },
        },
      },
    }));
    expect(result.interface.operations["getGood"]).toBeDefined();
    expect(result.interface.operations["getBad"]).toBeUndefined();
    const invalid = result.coverage.entries.find((e) => e.status === "invalid");
    expect(invalid).toMatchObject({
      sourceRef: "#/paths/~1bad/get",
      scope: "target",
      reasonCode: "openapi.invalid_unit",
    });
    const defects = (invalid?.details as { defects: Array<{ authority: string; position: string }> }).defects;
    expect(defects).toHaveLength(1);
    expect(defects[0]!.position).toBe("#/paths/~1bad/get/responses/200/content/application~1json/schema/type");
    expect(defects[0]!.authority).toContain("OAS 3.0 line");
    expect(result.coverage.fullyRepresented).toBe(false);
  });

  it("refuses the whole source when every declared target is invalid (§3 part 2)", async () => {
    await expect(synthesizer.synthesizeInterfaceWithCoverage(input({
      openapi: "3.1.0",
      info: { title: "T", version: "1" },
      paths: {
        "/only": { get: { responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } } },
      },
    }))).rejects.toThrow(/whole-source refusal/);
  });

  it("strict synthesis refuses any ladder-invalid target", async () => {
    await expect(synthesizer.synthesizeInterface(input({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/good": { get: { operationId: "getGood", responses: { "200": { description: "ok" } } } },
        "/bad": {
          get: {
            operationId: "getBad",
            responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "int" } } } } },
          },
        },
      },
    }))).rejects.toThrow(/statically unbindable/);
  });

  it("accepts paths: {} with an empty interface (the emptiness carve-out)", async () => {
    const result = await synthesizer.synthesizeInterfaceWithCoverage(input({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {},
    }));
    expect(Object.keys(result.interface.operations)).toHaveLength(0);
    expect(result.coverage.fullyRepresented).toBe(true);
  });

  it("keeps the excluded-request-media target ADDRESSED and flips its alternatives to invalid", async () => {
    const result = await synthesizer.synthesizeInterfaceWithCoverage(input({
      openapi: "3.1.0",
      info: { title: "T", version: "1" },
      paths: {
        "/pets": {
          post: {
            operationId: "createPet",
            requestBody: { required: true, content: { "and-another": { schema: { type: "string" } } } },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    }));
    expect(Object.keys(result.interface.operations)).toHaveLength(0);
    const excluded = result.coverage.entries.find((e) => e.status === "excluded" && e.scope === "target");
    expect(excluded?.reasonCode).toBe("openapi.unresolvable_request_body");
    const invalidAlt = result.coverage.entries.find((e) => e.status === "invalid" && e.scope === "alternative");
    expect(invalidAlt).toMatchObject({
      sourceRef: "#/paths/~1pets/post/requestBody/content/and-another",
      reasonCode: "openapi.invalid_unit",
    });
  });

  it("emits a projection entry on a unit reaching a defective component key (tier 2)", async () => {
    const result = await synthesizer.synthesizeInterfaceWithCoverage(input({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      components: { schemas: { "Bad Key": { type: "object" } } },
      paths: {
        "/a": {
          get: {
            operationId: "getA",
            responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Bad Key" } } } } },
          },
        },
      },
    }));
    expect(result.interface.operations["getA"]).toBeDefined();
    const projection = result.coverage.entries.find((e) => e.scope === "projection" && e.status === "invalid");
    expect(projection).toMatchObject({ sourceRef: "#/paths/~1a/get", reasonCode: "openapi.invalid_unit" });
    expect(result.coverage.fullyRepresented).toBe(false);
  });

  it("invalidates the unit whose closure reaches a dangling internal $ref instead of failing the load", async () => {
    // The nocodb framing: the load-time `unresolvable $ref` throw is
    // relaxed; the floor invalidates the reaching unit (P2 here) and its
    // sibling synthesizes.
    const result = await synthesizer.synthesizeInterfaceWithCoverage(input({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/good": { get: { operationId: "getGood", responses: { "200": { description: "ok" } } } },
        "/dangling": {
          get: {
            operationId: "getDangling",
            responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } } },
          },
        },
      },
    }));
    expect(result.interface.operations["getGood"]).toBeDefined();
    expect(result.interface.operations["getDangling"]).toBeUndefined();
    const invalid = result.coverage.entries.find((e) => e.status === "invalid" && e.scope === "target");
    expect(invalid).toMatchObject({ sourceRef: "#/paths/~1dangling/get", reasonCode: "openapi.invalid_unit" });
    const defects = (invalid?.details as { defects: Array<{ authority: string; position: string }> }).defects;
    expect(defects[0]!.authority).toContain("RFC 6901");
  });
});

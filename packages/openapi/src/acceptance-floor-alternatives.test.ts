// Block 8d-3: a ladder-invalid request media ALTERNATIVE is a unit that is
// malformed under its upstream authority, so the operation must not carry it.
// It never climbs, which is what the two cases here separate:
//
//   - an OPTIONAL body whose only alternative is invalid: the operation is
//     still represented, and the invalid alternative is simply not in its
//     input.
//   - a REQUIRED body whose only alternative is invalid: no candidate carriage
//     remains, so the operation falls to the existing OAPI-P-04 exclusion,
//     under `openapi.unresolvable_request_body` and not misreported as a
//     flattening collision.
//
// Both bite in both directions, and the Go SDK carries the identical pair
// (formats/openapi/acceptance_floor_alternatives_test.go).

import { describe, expect, it } from "vitest";
import { OpenAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

const synthesizer = new OpenAPISynthesizer();

function document(required: boolean): unknown {
  return {
    openapi: "3.0.3",
    info: { title: "T", version: "1" },
    paths: {
      "/a": {
        post: {
          operationId: "postA",
          requestBody: {
            required,
            content: { "application/json": { schema: { type: "object", properties: { f: { type: "string", required: true } } } } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

describe("acceptance floor: a ladder-invalid request media alternative is not carried", () => {
  it("keeps an OPTIONAL body's operation and drops only the alternative", async () => {
    const result = await synthesizer.synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content: document(false) }],
    });
    const op = result.interface.operations["postA"];
    expect(op, "the operation survives an invalid optional alternative").toBeDefined();
    const properties = (op!.input as { properties?: Record<string, unknown> } | undefined)?.properties;
    expect(properties?.["f"], "the invalid alternative must not reach the emitted input").toBeUndefined();
    expect(result.coverage.entries).toContainEqual(expect.objectContaining({
      scope: "alternative",
      status: "invalid",
      reasonCode: "openapi.invalid_unit",
      sourceRef: "#/paths/~1a/post/requestBody/content/application~1json",
    }));
  });

  // F-O1-13, the ruled outcome: a boolean-literal part schema on the 3.0 line
  // is not a Schema Object there (that line's Wright Draft 00 subset grants a
  // boolean only at `additionalProperties`), so it is a defect that confines
  // to the request media alternative owning it while the operation stays
  // represented on its healthy sibling and the SOURCE IS ACCEPTED. This
  // engine used to ADMIT the spelling silently and value-dispatch the part;
  // its Go twins refused the whole source. Both now land here.
  it("confines a 3.0 boolean-literal part schema to its own alternative", async () => {
    const result = await synthesizer.synthesizeInterfaceWithCoverage({
      sources: [{
        bindingSpec: BINDING_SPEC,
        content: {
          openapi: "3.0.3",
          info: { title: "T", version: "1" },
          paths: {
            "/uploads": {
              post: {
                operationId: "upload",
                requestBody: {
                  required: true,
                  content: {
                    "multipart/form-data": {
                      schema: { type: "object", properties: { note: true, label: { type: "string" } } },
                    },
                    "application/json": { schema: { type: "object" } },
                  },
                },
                responses: { "204": { description: "stored" } },
              },
            },
          },
        },
      }],
    });
    expect(result.interface.operations["upload"], "the operation survives on its sibling").toBeDefined();
    expect(result.coverage.entries).toContainEqual(expect.objectContaining({
      scope: "alternative",
      status: "invalid",
      reasonCode: "openapi.invalid_unit",
      sourceRef: "#/paths/~1uploads/post/requestBody/content/multipart~1form-data",
    }));
    expect(result.coverage.entries).toContainEqual(expect.objectContaining({
      scope: "alternative",
      status: "represented",
      sourceRef: "#/paths/~1uploads/post/requestBody/content/application~1json",
    }));
  });

  it("excludes the operation when a REQUIRED body has no surviving alternative", async () => {
    const result = await synthesizer.synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content: document(true) }],
    });
    expect(result.interface.operations["postA"]).toBeUndefined();
    expect(result.coverage.entries).toContainEqual(expect.objectContaining({
      scope: "target",
      status: "excluded",
      reasonCode: "openapi.unresolvable_request_body",
      sourceRef: "#/paths/~1a/post",
    }));
    expect(result.coverage.fullyRepresented).toBe(false);
  });
});

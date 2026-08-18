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

import { describe, expect, it } from "vitest";
import jsonata from "jsonata";
import { OpenAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC_OPENAPI_20 } from "./constants.js";

describe("Swagger 2.0 adapter synthesis", () => {
  it("keeps contracts flat and constructs only the invocation envelope", async () => {
    const iface = await new OpenAPISynthesizer().synthesizeInterface({ sources: [{
      bindingSpec: BINDING_SPEC_OPENAPI_20,
      content: {
        swagger: "2.0", schemes: ["https"], host: "api.example", consumes: ["application/json"],
        paths: { "/pets": { post: {
          operationId: "createPet",
          parameters: [
            { name: "id", in: "query", required: true, type: "string" },
            { name: "payload", in: "body", required: true, schema: { type: "object" } },
          ],
          responses: { 204: { description: "ok" } },
        } } },
      },
    }] });
    expect(iface.operations.createPet?.input).toMatchObject({
      type: "object",
      properties: { id: { type: "string" }, body: { type: "object" } },
      required: ["body", "id"],
    });
    const binding = iface.bindings?.["createPet.openapi"];
    expect(binding?.outputTransform).toBeUndefined();
    expect(await jsonata(binding?.inputTransform as string).evaluate({ id: "7", body: { name: "Ada" } })).toEqual({
      parameters: { id: "7" },
      body: { name: "Ada" },
    });
  });
});

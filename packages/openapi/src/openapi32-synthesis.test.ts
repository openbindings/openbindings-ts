import { describe, expect, it } from "vitest";

import { OpenAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC_OPENAPI_32 } from "./constants.js";

describe("OpenAPI 3.2 request synthesis", () => {
  it.each([
    ["application/jsonl", { itemSchema: { type: "string" } }, { type: "string" }],
    ["multipart/form-data", {
      itemSchema: { type: "integer" },
      itemEncoding: {
        headers: { "Content-Disposition": { schema: { const: "form-data; name=item" } } },
      },
    }, { type: "integer" }],
  ])("projects %s itemSchema as one array-of-items caller contract", async (mediaType, media, item) => {
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{
        bindingSpec: BINDING_SPEC_OPENAPI_32,
        content: {
          openapi: "3.2.0",
          info: { title: "item request", version: "1" },
          paths: {
            "/items": {
              post: {
                operationId: "sendItems",
                requestBody: { required: true, content: { [mediaType]: media } },
                responses: { "204": { description: "ok" } },
              },
            },
          },
        },
      }],
    });
    const input = iface.operations.sendItems?.input as Record<string, unknown>;
    const properties = input.properties as Record<string, unknown>;
    expect(properties.body).toEqual({ type: "array", items: item });
    expect(input.required).toEqual(["body"]);
  });
});

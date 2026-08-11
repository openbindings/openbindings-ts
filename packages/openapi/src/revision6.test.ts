import { describe, expect, it } from "vitest";
import jsonata from "jsonata";
import { OperationInvoker, operationSignature } from "@openbindings/sdk";
import { BINDING_SPEC } from "./constants.js";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./invoker.js";

function unionDocument(
  mediaType = "application/json",
  schema: Record<string, unknown> = {
    oneOf: [
      {
        type: "object",
        properties: { kind: { const: "named" }, name: { type: "string" } },
        required: ["kind", "name"],
        additionalProperties: false,
      },
      {
        type: "array",
        items: { type: "string" },
      },
    ],
  },
): Record<string, unknown> {
  return {
    openapi: "3.1.2",
    info: { title: "whole JSON carriage", version: "1" },
    servers: [{ url: "https://api.example.test" }],
    paths: {
      "/items": {
        post: {
          operationId: "createItem",
          parameters: [{
            name: "kind",
            in: "query",
            required: true,
            schema: { type: "string" },
          }],
          requestBody: {
            required: true,
            content: {
              [mediaType]: {
                schema,
              },
            },
          },
          responses: { "204": { description: "stored" } },
        },
      },
    },
  };
}

describe("openbindings.openapi@1 whole JSON carriage", () => {
  it("keeps a combinatorial JSON schema as one application value and sends it unchanged", async () => {
    const source = unionDocument();
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: source }],
    });
    expect(iface.operations.createItem?.input).toEqual({
      type: "object",
      properties: {
        kind: { type: "string" },
        payload: (source.paths as any)["/items"].post.requestBody.content["application/json"].schema,
      },
      additionalProperties: false,
      required: ["kind", "payload"],
    });
    expect(iface.bindings?.["createItem.openapi"]?.inputTransform).toContain('"whole":"payload"');

    const invoker = new OperationInvoker([new OpenAPIInvoker()], {
      fetch: async (request, init) => {
        const observed = new Request(request, init);
        expect(new URL(observed.url).searchParams.get("kind")).toBe("query");
        expect(await observed.json()).toEqual({ kind: "named", name: "Ada" });
        return new Response(undefined, { status: 204 });
      },
      transformEvaluator: { evaluate: (expression, data) => jsonata(expression).evaluate(data) },
    });
    const call = invoker.invoke(iface, operationSignature("createItem"));
    await call.write({ kind: "query", payload: { kind: "named", name: "Ada" } });
    await call.close();
    for await (const _output of call.outputs) { /* drain */ }
  });

  it("does not pretend that whole-JSON carriage defines form serialization", async () => {
    await expect(new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content: unionDocument("application/x-www-form-urlencoded") }],
    })).rejects.toThrow(/conditional\/combinatorial request schema/);
  });

  it("uses whole-value carriage for every declaration-complex top-level trigger, including through allOf", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["anyOf", { anyOf: [{ type: "object" }, { type: "array" }] }],
      ["not", { type: "object", not: { required: ["forbidden"] } }],
      ["if", { type: "object", if: { required: ["kind"] } }],
      ["then", { type: "object", then: { required: ["name"] } }],
      ["else", { type: "object", else: { required: ["fallback"] } }],
      ["dependentSchemas", { type: "object", dependentSchemas: { kind: { required: ["name"] } } }],
      ["unevaluatedProperties", { type: "object", unevaluatedProperties: true }],
      ["allOf traversal", { allOf: [{ type: "object" }, { anyOf: [{ required: ["a"] }, { required: ["b"] }] }] }],
    ];

    for (const [name, schema] of cases) {
      const iface = await new OpenAPISynthesizer().synthesizeInterface({
        sources: [{ bindingSpec: BINDING_SPEC, content: unionDocument("application/json", schema) }],
      });
      const properties = (iface.operations.createItem?.input as any).properties;
      expect(properties.payload, name).toEqual(schema);
      expect(iface.bindings?.["createItem.openapi"]?.inputTransform, name).toContain('"whole":"payload"');
    }
  });

  it("does not promote inert or nested declarations into a top-level whole-value route", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["empty dependentSchemas", { type: "object", properties: { value: { type: "string" } }, dependentSchemas: {} }],
      ["closed unevaluatedProperties", { type: "object", properties: { value: { type: "string" } }, unevaluatedProperties: false }],
      ["nested oneOf", { type: "object", properties: { value: { oneOf: [{ type: "string" }, { type: "number" }] } } }],
    ];

    for (const [name, schema] of cases) {
      const iface = await new OpenAPISynthesizer().synthesizeInterface({
        sources: [{ bindingSpec: BINDING_SPEC, content: unionDocument("application/json", schema) }],
      });
      const properties = (iface.operations.createItem?.input as any).properties;
      expect(properties.value, name).toEqual((schema.properties as any).value);
      expect(properties.payload, name).toBeUndefined();
    }
  });
});

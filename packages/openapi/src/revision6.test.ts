import { describe, expect, it } from "vitest";
import jsonata from "jsonata";
import { OperationInvoker, operationSignature } from "@openbindings/invoke";
import { BINDING_SPEC_OPENAPI_31 as BINDING_SPEC } from "./constants.js";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./test-helpers.js";

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

describe("openbindings.openapi-3.1@1 whole JSON carriage", () => {
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
    expect(iface.bindings?.["createItem.openapi"]?.inputTransform).toContain('$lookup($,"payload")');
    // No engine-private marker enters an OBI: the emitted transform is the
    // flat caller envelope, and neither engine's routed-envelope discriminator
    // (TS/Go standalone: `$openapi`; the OBI SDK's former `$openbindings`) nor
    // the marker may appear in it. The Go twins (media_v3/v5/v6_test.go) pin the
    // same absence; the runtime envelope's key parity is pinned in
    // input-routes-v2.test.ts.
    for (const forbidden of ["$openbindings", "$openapi", "openapi-client.routed@1"]) {
      expect(iface.bindings?.["createItem.openapi"]?.inputTransform).not.toContain(forbidden);
    }

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
      [
        "unevaluatedProperties false",
        { type: "object", properties: { value: { type: "string" } }, unevaluatedProperties: false },
      ],
      ["allOf traversal", { allOf: [{ type: "object" }, { anyOf: [{ required: ["a"] }, { required: ["b"] }] }] }],
    ];

    for (const [name, schema] of cases) {
      const iface = await new OpenAPISynthesizer().synthesizeInterface({
        sources: [{ bindingSpec: BINDING_SPEC, content: unionDocument("application/json", schema) }],
      });
      const properties = (iface.operations.createItem?.input as any).properties;
      expect(properties.payload, name).toEqual(schema);
      expect(iface.bindings?.["createItem.openapi"]?.inputTransform, name).toContain('$lookup($,"payload")');
    }
  });

  it("does not promote inert or nested declarations into a top-level whole-value route", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["empty dependentSchemas", { type: "object", properties: { value: { type: "string" } }, dependentSchemas: {} }],
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

import { describe, expect, it } from "vitest";
import { validateInterface } from "@openbindings/core";
import { convertToInterface } from "./test-helpers.js";
import { loadOpenAPIDocument } from "./util.js";

function refSiblingSpec(openapi: "3.0.3" | "3.1.2"): Record<string, unknown> {
  return {
    openapi,
    info: { title: "ref siblings", version: "1" },
    components: {
      schemas: {
        Base: { type: "string", maxLength: 10 },
      },
    },
    paths: {
      "/value": {
        get: {
          operationId: "readValue",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Base",
                    maxLength: 5,
                    nullable: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

describe("OpenAPI edition-specific Schema Object $ref siblings", () => {
  it("ignores every sibling in 3.0 Reference Object positions", async () => {
    const iface = await convertToInterface(undefined, refSiblingSpec("3.0.3"));
    expect(iface.operations["readValue"]?.output).toEqual({
      type: "string",
      maxLength: 10,
    });
  });

  it("composes semantic and annotation siblings in 3.1 without inventing null", async () => {
    const iface = await convertToInterface(undefined, refSiblingSpec("3.1.2"));
    expect(iface.operations["readValue"]?.output).toEqual({
      maxLength: 5,
      nullable: true,
      allOf: [{ type: "string", maxLength: 10 }],
    });
  });

  it("applies 3.1 Reference Object descriptions per site and ignores structural siblings", async () => {
    const source = {
      openapi: "3.1.2",
      info: { title: "reference metadata", version: "1" },
      components: {
        parameters: {
          Shared: {
            name: "value",
            in: "query",
            description: "component description",
            schema: { type: "string" },
          },
        },
      },
      paths: {
        "/one": {
          get: {
            operationId: "one",
            parameters: [{
              $ref: "#/components/parameters/Shared",
              description: "first use",
              required: true,
              schema: { type: "integer" },
            }],
            responses: { "204": { description: "done" } },
          },
        },
        "/two": {
          get: {
            operationId: "two",
            parameters: [{
              $ref: "#/components/parameters/Shared",
              description: "second use",
            }],
            responses: { "204": { description: "done" } },
          },
        },
      },
    };

    const loaded = await loadOpenAPIDocument(undefined, source);
    const first = loaded.paths?.["/one"]?.get?.parameters?.[0];
    const second = loaded.paths?.["/two"]?.get?.parameters?.[0];
    expect(first).toMatchObject({
      name: "value",
      in: "query",
      description: "first use",
      schema: { type: "string" },
    });
    expect(first).not.toHaveProperty("required");
    expect(second?.description).toBe("second use");

    const iface = await convertToInterface(undefined, source);
    const firstInput = iface.operations.one?.input as Record<string, unknown>;
    const secondInput = iface.operations.two?.input as Record<string, unknown>;
    const firstProperties = firstInput.properties as Record<string, unknown>;
    const secondProperties = secondInput.properties as Record<string, unknown>;
    expect(firstProperties.value).toEqual({ type: "string", description: "first use" });
    expect(secondProperties.value).toEqual({ type: "string", description: "second use" });
    expect(firstInput.required).toBeUndefined();
  });

  it("ignores Reference Object metadata and structural siblings in 3.0", async () => {
    const source = {
      openapi: "3.0.3",
      info: { title: "legacy references", version: "1" },
      components: {
        parameters: {
          Shared: {
            name: "value",
            in: "query",
            description: "component description",
            schema: { type: "string" },
          },
        },
      },
      paths: {
        "/value": {
          get: {
            operationId: "legacyReference",
            parameters: [{
              $ref: "#/components/parameters/Shared",
              description: "ignored description",
              required: true,
            }],
            responses: { "204": { description: "done" } },
          },
        },
      },
    };

    const loaded = await loadOpenAPIDocument(undefined, source);
    const parameter = loaded.paths?.["/value"]?.get?.parameters?.[0];
    expect(parameter?.description).toBe("component description");
    expect(parameter).not.toHaveProperty("required");
  });

  it("retains nested sibling constraints across an external 2020-12 resource", async () => {
    const root = {
      openapi: "3.1.2",
      info: { title: "external", version: "1" },
      paths: {
        "/names": {
          get: {
            operationId: "names",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: {
                        $ref: "./name-schema.json",
                        minLength: 2,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const external = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: "#/$defs/Base",
      maxLength: 4,
      pattern: "^[a-z]+$",
      $defs: { Base: { type: "string", maxLength: 10 } },
    };
    const fetch: typeof globalThis.fetch = async input => String(input) === "https://description.example/name-schema.json"
      ? new Response(JSON.stringify(external), { status: 200 })
      : new Response("missing", { status: 404 });

    const iface = await convertToInterface(
      "https://description.example/openapi.json",
      root,
      { fetch },
    );
    expect(iface.operations["names"]?.output).toEqual({
      type: "array",
      items: {
        minLength: 2,
        allOf: [{
          $schema: "https://json-schema.org/draft/2020-12/schema",
          maxLength: 4,
          pattern: "^[a-z]+$",
          $defs: { Base: { type: "string", maxLength: 10 } },
          allOf: [{ type: "string", maxLength: 10 }],
        }],
      },
    });
  });

  it("resolves a named anchor in an external schema resource without a root $schema", async () => {
    const root = {
      openapi: "3.1.2",
      info: { title: "external anchor", version: "1" },
      paths: {
        "/value": {
          get: {
            operationId: "externalAnchor",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "./bundle.json#foo" },
                  },
                },
              },
            },
          },
        },
      },
    };
    const bundle = {
      $defs: {
        Foo: { $anchor: "foo", type: "string", minLength: 1 },
      },
    };
    const fetch: typeof globalThis.fetch = async input => String(input) === "https://description.example/bundle.json"
      ? new Response(JSON.stringify(bundle), { status: 200 })
      : new Response("missing", { status: 404 });

    const iface = await convertToInterface(
      "https://description.example/openapi.json",
      root,
      { fetch },
    );
    expect(iface.operations.externalAnchor?.output).toEqual({
      $anchor: "foo",
      type: "string",
      minLength: 1,
    });
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("normalizes external Parameter, RequestBody, and redirected Response targets by position", async () => {
    const root = {
      openapi: "3.1.2",
      info: { title: "external fragments", version: "1" },
      paths: {
        "/value": {
          post: {
            operationId: "externalFragments",
            parameters: [{ $ref: "./fragments.json#/Parameter" }],
            requestBody: { $ref: "./fragments.json#/RequestBody" },
            responses: { "200": { $ref: "./redirect-response.json#/Response" } },
          },
        },
      },
    };
    const literalExample = {
      $ref: "#/Schemas/ParameterValue",
      schema: { $ref: "#/Schemas/ParameterValue", maxLength: 1 },
    };
    const fragments = {
      Parameter: {
        name: "value",
        in: "query",
        example: literalExample,
        schema: {
          $ref: "#/Schemas/ParameterValue",
          maxLength: 5,
        },
      },
      RequestBody: {
        content: {
          "application/json": {
            schema: {
              $ref: "#/Schemas/Body",
              maxProperties: 2,
            },
          },
        },
      },
      Schemas: {
        ParameterValue: { type: "string", maxLength: 10 },
        Body: {
          type: "object",
          maxProperties: 10,
          properties: { name: { type: "string" } },
        },
      },
    };
    const responseFragment = {
      Response: {
        $ref: "#/BaseResponse",
        description: "ref-site response",
        // Not a legal Reference Object sibling; must not replace the target.
        content: { "application/json": { schema: { type: "integer" } } },
      },
      BaseResponse: {
        description: "ok",
        content: {
          "application/json": {
            schema: { $ref: "./schema.json", maxLength: 4 },
          },
        },
      },
    };
    const redirectedSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: "#/$defs/Base",
      maxLength: 8,
      $defs: { Base: { type: "string", maxLength: 12 } },
    };
    const at = (url: string, body: unknown): Response => {
      const response = new Response(JSON.stringify(body), { status: 200 });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    const fetch: typeof globalThis.fetch = async input => {
      switch (String(input)) {
        case "https://description.example/fragments.json":
          return at("https://description.example/fragments.json", fragments);
        case "https://description.example/redirect-response.json":
          return at("https://cdn.example/contracts/response.json", responseFragment);
        case "https://cdn.example/contracts/schema.json":
          return at("https://cdn.example/contracts/schema.json", redirectedSchema);
        default:
          return new Response("missing", { status: 404 });
      }
    };

    const loaded = await loadOpenAPIDocument(
      "https://description.example/openapi.json",
      root,
      undefined,
      fetch,
    );
    const operation = loaded.paths?.["/value"]?.post;
    expect(operation?.parameters?.[0]?.schema).toEqual({
      maxLength: 5,
      allOf: [{ type: "string", maxLength: 10 }],
    });
    expect(operation?.parameters?.[0]?.example).toEqual(literalExample);
    expect(operation?.requestBody?.content?.["application/json"]?.schema).toEqual({
      maxProperties: 2,
      allOf: [{
        type: "object",
        maxProperties: 10,
        properties: { name: { type: "string" } },
      }],
    });
    expect(operation?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({
      maxLength: 4,
      allOf: [{
        $schema: "https://json-schema.org/draft/2020-12/schema",
        maxLength: 8,
        $defs: { Base: { type: "string", maxLength: 12 } },
        allOf: [{ type: "string", maxLength: 12 }],
      }],
    });
    expect(operation?.responses?.["200"]?.description).toBe("ref-site response");
  });

  it("resolves a relative ref from the enclosing nested $id of an external schema fragment", async () => {
    const root = {
      openapi: "3.1.2",
      info: { title: "nested resource base", version: "1" },
      paths: {
        "/value": {
          get: {
            operationId: "nestedResourceValue",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "./bundle.json#/$defs/Nested/$defs/Value" },
                  },
                },
              },
            },
          },
        },
      },
    };
    // Deliberately no root `$schema`: this resource is reached as a schema
    // fragment, and the target sits below an ancestor `$id` rather than
    // carrying that base itself.
    const bundle = {
      $defs: {
        Nested: {
          $id: "nested/",
          $defs: {
            Value: { $ref: "base.json", maxLength: 5 },
          },
        },
      },
    };
    const requested: string[] = [];
    const fetch: typeof globalThis.fetch = async input => {
      const url = String(input);
      requested.push(url);
      if (url === "https://description.example/bundle.json") {
        return new Response(JSON.stringify(bundle), { status: 200 });
      }
      if (url === "https://description.example/nested/base.json") {
        return new Response(JSON.stringify({ type: "string", maxLength: 10 }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };

    const iface = await convertToInterface(
      "https://description.example/openapi.json",
      root,
      { fetch },
    );
    expect(iface.operations.nestedResourceValue?.output).toEqual({
      maxLength: 5,
      allOf: [{ type: "string", maxLength: 10 }],
    });
    expect(requested).toContain("https://description.example/nested/base.json");
    expect(requested).not.toContain("https://description.example/base.json");
  });

  it("internalizes nested relative schema references from external OpenAPI 3.0 resources", async () => {
    const root = {
      openapi: "3.0.3",
      info: { title: "nested external schemas", version: "1" },
      paths: {
        "/prime": { $ref: "./paths/prime.yaml#/paths/~1prime" },
        "/value": { $ref: "./paths/value.yaml#/paths/~1value" },
      },
    };
    const resources: Record<string, unknown> = {
      "https://description.example/paths/prime.yaml": {
        paths: {
          "/prime": {
            get: {
              operationId: "primeExternal",
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "../schemas/envelope.yaml#/Prime" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "https://description.example/paths/value.yaml": {
        paths: {
          "/value": {
            get: {
              operationId: "nestedExternal",
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { $ref: "../schemas/envelope.yaml#/Envelope" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "https://description.example/schemas/envelope.yaml": {
        Prime: { type: "boolean" },
        Envelope: {
          type: "object",
          properties: {
            value: { $ref: "./value.yaml#/Value" },
          },
        },
      },
      "https://description.example/schemas/value.yaml": {
        Value: { type: "string", minLength: 1 },
      },
    };
    const fetch: typeof globalThis.fetch = async input => {
      const resource = resources[String(input)];
      return resource === undefined
        ? new Response("missing", { status: 404 })
        : new Response(JSON.stringify(resource), { status: 200 });
    };

    const iface = await convertToInterface(
      "https://description.example/openapi.yaml",
      root,
      { fetch },
    );
    expect(iface.operations.primeExternal?.output).toEqual({ type: "boolean" });
    expect(iface.operations.nestedExternal?.output).toEqual({
      type: "object",
      properties: {
        value: { type: "string", minLength: 1 },
      },
    });
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("resolves same-fragment schema references within an external OpenAPI resource", async () => {
    const root = {
      openapi: "3.0.3",
      info: { title: "external path resource", version: "1" },
      paths: {
        "/prime": { $ref: "./paths/prime.yaml#/paths/~1prime" },
        "/events": { $ref: "./paths/events.yaml#/paths/~1events" },
      },
    };
    const prime = {
      paths: {
        "/prime": {
          get: {
            operationId: "primeComponents",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "../schemas/common.yaml#/components/schemas/Prime" },
                  },
                },
              },
            },
          },
        },
      },
    };
    const events = {
      paths: {
        "/events": {
          get: {
            operationId: "externalEvents",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "../schemas/common.yaml#/components/schemas/EventList" },
                  },
                },
              },
            },
          },
        },
      },
    };
    const common = {
      components: {
        schemas: {
          Prime: { type: "boolean" },
          EventList: {
            type: "array",
            items: { $ref: "#/components/schemas/Event" },
          },
          Event: {
            $id: "https://schemas.example/Event",
            type: "object",
            $defs: {
              EventID: { $anchor: "eventID", type: "string", minLength: 1 },
            },
            properties: { id: { $ref: "#eventID" } },
          },
        },
      },
    };
    const resources: Record<string, unknown> = {
      "https://description.example/paths/prime.yaml": prime,
      "https://description.example/paths/events.yaml": events,
      "https://description.example/schemas/common.yaml": common,
    };
    const fetch: typeof globalThis.fetch = async input => {
      const resource = resources[String(input)];
      return resource === undefined
        ? new Response("missing", { status: 404 })
        : new Response(JSON.stringify(resource), { status: 200 });
    };

    const iface = await convertToInterface(
      "https://description.example/openapi.yaml",
      root,
      { fetch },
    );
    expect(iface.operations.primeComponents?.output).toEqual({ type: "boolean" });
    expect(iface.operations.externalEvents?.output).toEqual({
      type: "array",
      items: {
        $id: "https://schemas.example/Event",
        type: "object",
        $defs: {
          EventID: { $anchor: "eventID", type: "string", minLength: 1 },
        },
        properties: {
          id: { $anchor: "eventID", type: "string", minLength: 1 },
        },
      },
    });
    expect(() => validateInterface(iface)).not.toThrow();
  });

  it("does not dereference data-shaped $ref or schema keys in examples and extensions", async () => {
    const literal = {
      $ref: "#/components/schemas/Base",
      $schema: "https://example.com/data-not-a-dialect",
      keep: "literal sibling",
      schema: {
        $ref: "#/components/schemas/Base",
        maxLength: 1,
      },
    };
    const source = refSiblingSpec("3.1.2");
    source["x-literal"] = structuredClone(literal);
    const components = source.components as Record<string, unknown>;
    components.examples = { Literal: { value: structuredClone(literal) } };

    const loaded = await loadOpenAPIDocument(undefined, source);
    expect((loaded as unknown as Record<string, unknown>)["x-literal"]).toEqual(literal);
    const loadedComponents = loaded.components as Record<string, unknown>;
    const examples = loadedComponents.examples as Record<string, Record<string, unknown>>;
    expect(examples.Literal?.value).toEqual(literal);
  });

  it("does not let data-shaped anchors or IDs shadow Schema Object scope", async () => {
    const source = {
      openapi: "3.1.2",
      info: { title: "anchor scope", version: "1" },
      components: {
        schemas: {
          Real: { $anchor: "Value", type: "string", maxLength: 10 },
        },
        examples: {
          Fake: {
            value: {
              $anchor: "Value",
              $id: "https://attacker.example/fake-schema",
              type: "integer",
            },
          },
        },
      },
      paths: {
        "/value": {
          get: {
            operationId: "anchoredValue",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#Value", maxLength: 5 },
                  },
                },
              },
            },
          },
        },
      },
      // Last in traversal order: the generic resolver previously indexed
      // this arbitrary extension value and let it replace the real anchor.
      "x-fake-schema": {
        $anchor: "Value",
        $id: "https://attacker.example/last",
        type: "boolean",
      },
    };

    const loaded = await loadOpenAPIDocument(undefined, source);
    const schema = loaded.paths?.["/value"]?.get?.responses?.["200"]
      ?.content?.["application/json"]?.schema;
    expect(schema).toEqual({
      maxLength: 5,
      allOf: [{ $anchor: "Value", type: "string", maxLength: 10 }],
    });
    expect((loaded as unknown as Record<string, unknown>)["x-fake-schema"]).toEqual(
      source["x-fake-schema"],
    );
    const components = loaded.components as Record<string, unknown>;
    const examples = components.examples as Record<string, Record<string, unknown>>;
    expect(examples.Fake?.value).toEqual(source.components.examples.Fake.value);
  });

  it("keeps a parent-resource anchor distinct from the same anchor under a nested $id", async () => {
    const source = {
      openapi: "3.1.2",
      info: { title: "resource-scoped anchors", version: "1" },
      components: {
        schemas: {
          NestedResource: {
            $id: "https://schemas.example/nested",
            $defs: {
              NestedValue: { $anchor: "Value", type: "integer" },
            },
          },
          ParentValue: { $anchor: "Value", type: "string", maxLength: 10 },
        },
      },
      paths: {
        "/value": {
          get: {
            operationId: "parentValue",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#Value", maxLength: 5 },
                  },
                },
              },
            },
          },
        },
      },
    };

    const loaded = await loadOpenAPIDocument(undefined, source);
    expect(
      loaded.paths?.["/value"]?.get?.responses?.["200"]
        ?.content?.["application/json"]?.schema,
    ).toEqual({
      maxLength: 5,
      allOf: [{ $anchor: "Value", type: "string", maxLength: 10 }],
    });
  });

  it("excludes a custom document dialect before per-operation projection", async () => {
    const source = {
      openapi: "3.1.2",
      jsonSchemaDialect: "https://example.com/custom-schema-dialect",
      info: { title: "custom default", version: "1" },
      components: { schemas: { Base: { type: "string" } } },
      paths: {
        "/health": {
          get: {
            operationId: "health",
            responses: { "204": { description: "ok" } },
          },
        },
        "/value": {
          get: {
            operationId: "customDefault",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        value: { $ref: "#/components/schemas/Base" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    await expect(convertToInterface(undefined, source)).rejects.toThrow(
      "whole-source exclusion",
    );
  });

  it("does not let a supported per-schema resource reopen a custom root dialect", async () => {
    const source = {
      openapi: "3.1.2",
      jsonSchemaDialect: "https://example.com/custom-schema-dialect",
      info: { title: "portable resource override", version: "1" },
      paths: {
        "/value": {
          get: {
            operationId: "portableOverride",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      $schema: "https://json-schema.org/draft/2020-12/schema",
                      type: "string",
                      maxLength: 8,
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    await expect(convertToInterface(undefined, source)).rejects.toThrow("whole-source exclusion");
  });

  it("refuses a per-resource unsupported $schema before interpreting nested refs", async () => {
    const source = {
      openapi: "3.1.2",
      info: { title: "custom resource", version: "1" },
      components: { schemas: { Base: { type: "string" } } },
      paths: {
        "/value": {
          get: {
            operationId: "customResource",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      $schema: "https://json-schema.org/draft-07/schema#",
                      type: "object",
                      properties: {
                        value: { $ref: "#/components/schemas/Base" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    await expect(convertToInterface(undefined, source)).rejects.toThrow(
      "https://json-schema.org/draft-07/schema#",
    );
  });
});

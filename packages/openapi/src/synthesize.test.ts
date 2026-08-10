import { describe, it, expect } from "vitest";
import { convertToInterface } from "./synthesize.js";
import { OpenAPIInvoker } from "./invoker.js";
import { DEFAULT_SOURCE_NAME } from "./constants.js";

const MINIMAL_SPEC = {
  openapi: "3.1.0",
  info: { title: "Test API", version: "1.0.0", description: "A test" },
  paths: {
    "/users": {
      get: {
        operationId: "listUsers",
        summary: "List all users",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "array", items: { type: "object" } },
              },
            },
          },
        },
      },
      post: {
        operationId: "createUser",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  email: { type: "string" },
                },
                required: ["name", "email"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: { type: "object", properties: { id: { type: "string" } } },
              },
            },
          },
        },
      },
    },
    "/users/{id}": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      get: {
        operationId: "getUser",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
        },
      },
      delete: {
        operationId: "deleteUser",
        deprecated: true,
        responses: { "204": { description: "Deleted" } },
      },
    },
  },
  servers: [{ url: "https://api.example.com" }],
};

describe("convertToInterface", () => {
  it("converts a minimal OpenAPI spec to OBI", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    expect(iface.name).toBe("Test API");
    expect(iface.version).toBe("1.0.0");
    expect(iface.description).toBe("A test");

    expect(iface.operations["listUsers"]).toBeDefined();

    expect(iface.operations["createUser"]).toBeDefined();
    expect(iface.operations["getUser"]).toBeDefined();
    expect(iface.operations["deleteUser"]).toBeDefined();
    expect(iface.operations["deleteUser"]?.deprecated).toBe(true);
  });

  it("generates input schemas from parameters", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    const listInput = iface.operations["listUsers"]?.input as Record<string, unknown>;
    expect(listInput).toBeDefined();
    expect(listInput.type).toBe("object");
    const props = listInput.properties as Record<string, unknown>;
    expect(props["limit"]).toEqual({ type: "integer" });
  });

  it("generates input schemas from request body", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    const synthesizeInput = iface.operations["createUser"]?.input as Record<string, unknown>;
    expect(synthesizeInput).toBeDefined();
    const props = synthesizeInput.properties as Record<string, unknown>;
    expect(props["name"]).toEqual({ type: "string" });
    expect(props["email"]).toEqual({ type: "string" });
    expect(synthesizeInput.required).toContain("email");
    expect(synthesizeInput.required).toContain("name");
  });

  it("generates output schemas from 200/201 responses", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    expect(iface.operations["listUsers"]?.output).toEqual({
      type: "array", items: { type: "object" },
    });
    expect(iface.operations["createUser"]?.output).toEqual({
      type: "object", properties: { id: { type: "string" } },
    });
  });

  it("merges path-level parameters into operation", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    const getInput = iface.operations["getUser"]?.input as Record<string, unknown>;
    expect(getInput).toBeDefined();
    const props = getInput.properties as Record<string, unknown>;
    expect(props["id"]).toBeDefined();
    expect(getInput.required).toContain("id");
  });

  it("creates bindings with JSON pointer refs", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    const binding = iface.bindings?.["listUsers.openapi"];
    expect(binding).toBeDefined();
    expect(binding?.operation).toBe("listUsers");
    expect(binding?.source).toBe("openapi");
    expect(binding?.ref).toBe("#/paths/~1users/get");
  });

  it("creates source entries", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    expect(iface.sources?.["openapi"]).toBeDefined();
    expect(iface.sources?.["openapi"]?.bindingSpec).toBe("openbindings.openapi@6");
  });

  it("handles specs with no paths", async () => {
    const iface = await convertToInterface(undefined, {
      openapi: "3.0.0",
      info: { title: "Empty" },
    });
    expect(Object.keys(iface.operations)).toHaveLength(0);
  });

  it("derives operation keys when operationId is missing", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "No IDs" },
      paths: {
        "/items/{itemId}/reviews": {
          get: {
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const iface = await convertToInterface(undefined, spec);
    const keys = Object.keys(iface.operations);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe("items.reviews.get");
  });

  it("handles operationId collisions", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Collisions" },
      paths: {
        "/a": { get: { operationId: "dupe" } },
        "/b": { get: { operationId: "dupe" } },
      },
    };
    const iface = await convertToInterface(undefined, spec);
    const keys = Object.keys(iface.operations);
    expect(keys).toHaveLength(2);
    expect(keys).toContain("dupe");
  });

  it("sets location when provided", async () => {
    const iface = await convertToInterface(
      "https://example.com/api.json",
      { openapi: "3.0.0", info: { title: "Located" }, paths: {} },
    );
    expect(iface.sources?.["openapi"]?.location).toBe("https://example.com/api.json");
  });

  it("does not emit a security section (auth is negotiated at invoke time)", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Secure API" },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
      security: [{ bearerAuth: [] }],
      paths: {
        "/items": {
          get: {
            operationId: "listItems",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const iface = await convertToInterface(undefined, spec);

    // Security schemes stay in the OpenAPI source; the binding invoker
    // derives requirements from them at invoke time (CONTEXT_REQUIRED).
    expect(iface.security).toBeUndefined();
    const listItems = iface.bindings?.["listItems.openapi"];
    expect(listItems).toBeDefined();
    expect(listItems?.security).toBeUndefined();
  });
});

describe("convertToInterface — OpenAPI 3.0 dialect translation", () => {
  const SPEC_30_NULLABLE = {
    openapi: "3.0.3",
    info: { title: "PokéAPI-ish", version: "1.0.0" },
    paths: {
      "/ability": {
        get: {
          operationId: "abilityList",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      count: { type: "integer" },
                      next: { type: "string", nullable: true, format: "uri" },
                      previous: { type: "string", nullable: true, format: "uri" },
                    },
                    required: ["count"],
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  it("translates nullable: true in 3.0 documents to type arrays with 'null'", async () => {
    const iface = await convertToInterface(undefined, SPEC_30_NULLABLE);
    const output = iface.operations["abilityList"]?.output as Record<string, unknown>;
    const props = output.properties as Record<string, Record<string, unknown>>;
    expect(props["next"]).toEqual({ type: ["string", "null"], format: "uri" });
    expect(props["previous"]).toEqual({ type: ["string", "null"], format: "uri" });
    expect(props["count"]).toEqual({ type: "integer" });
  });

  it("stamps the exact identifier for 3.0.x sources (the artifact version drives dialect only)", async () => {
    const iface = await convertToInterface(undefined, SPEC_30_NULLABLE);
    expect(iface.sources?.["openapi"]?.bindingSpec).toBe("openbindings.openapi@6");
  });

  it("preserves 3.1 schemas verbatim (already 2020-12)", async () => {
    const spec31 = {
      openapi: "3.1.0",
      info: { title: "T", version: "1.0.0" },
      paths: {
        "/x": {
          get: {
            operationId: "x",
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        next: { type: ["string", "null"], format: "uri" },
                        // Inert nullable in 3.1 — should pass through unchanged
                        legacy: { type: "string", nullable: true },
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
    const iface = await convertToInterface(undefined, spec31);
    const output = iface.operations["x"]?.output as Record<string, unknown>;
    const props = output.properties as Record<string, Record<string, unknown>>;
    expect(props["next"]).toEqual({ type: ["string", "null"], format: "uri" });
    // In 3.1 this is an unknown annotation, not the 3.0 type modifier.
    expect(props["legacy"]).toEqual({ type: "string", nullable: true });
  });

  it("translates boolean exclusiveMinimum to numeric form", async () => {
    const spec30 = {
      openapi: "3.0.3",
      info: { title: "T", version: "1.0.0" },
      paths: {
        "/q": {
          get: {
            operationId: "q",
            parameters: [
              {
                name: "page",
                in: "query",
                schema: {
                  type: "integer",
                  minimum: 0,
                  exclusiveMinimum: true,
                  maximum: 100,
                  exclusiveMaximum: false,
                },
              },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const iface = await convertToInterface(undefined, spec30);
    const input = iface.operations["q"]?.input as Record<string, unknown>;
    const props = input.properties as Record<string, Record<string, unknown>>;
    expect(props["page"]).toEqual({
      type: "integer",
      exclusiveMinimum: 0,
      maximum: 100,
    });
  });
});


// Multi-source composition is implementation-defined; a single-source
// synthesizer refuses extras loudly rather than silently using a subset.
import { MultipleSourcesError } from "@openbindings/sdk";
import { OpenAPISynthesizer } from "./index.js";
import { describe as describeMS, expect as expectMS, it as itMS } from "vitest";

describeMS("multi-source refusal", () => {
  itMS("throws MultipleSourcesError for two sources", async () => {
    const synth = new OpenAPISynthesizer();
    await expectMS(
      synth.synthesizeInterface({
        sources: [
          { bindingSpec: "openbindings.openapi@1", content: "{}" },
          { bindingSpec: "openbindings.openapi@1", content: "{}" },
        ],
      }),
    ).rejects.toBeInstanceOf(MultipleSourcesError);
  });
});

describe("synthesizer artifact resolver", () => {
  it("uses the injected fetch implementation for external reference closure", async () => {
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url !== "https://description.example/path-item.yaml") {
        return new Response("missing", { status: 404 });
      }
      return new Response(`get:
  operationId: externalGet
  responses: {"200": {description: ok}}
`, { status: 200 });
    };
    const iface = await new OpenAPISynthesizer({ fetch }).synthesizeInterface({
      sources: [{
        bindingSpec: "openbindings.openapi@2",
        location: "https://description.example/openapi.yaml",
        content: `openapi: 3.1.2
info: {title: External, version: "1"}
paths: {/items: {$ref: "./path-item.yaml"}}
`,
      }],
    });

    expect(iface.operations.externalGet).toBeDefined();
    expect(requests).toEqual(["https://description.example/path-item.yaml"]);
  });
});

describe("synthesis coverage", () => {
  it("accounts for request alternatives and reverse interactions", async () => {
    const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{
        bindingSpec: "openbindings.openapi@1",
        content: {
          openapi: "3.1.0",
          info: { title: "coverage", version: "1" },
          paths: {
            "/jobs": {
              post: {
                operationId: "createJob",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } },
                    "application/x-custom": { schema: { type: "string" } },
                  },
                },
                callbacks: {
                  completed: {
                    "{$request.body#/callbackUrl}": {
                      post: { responses: { "200": { description: "ok" } } },
                    },
                  },
                },
                responses: { "200": { description: "ok" } },
              },
            },
          },
          webhooks: {
            jobChanged: {
              post: { responses: { "200": { description: "ok" } } },
            },
          },
        },
      }],
    });
    expect(result.coverage).toMatchObject({
      exhaustive: true,
      fullyRepresented: false,
    });
    const statusByRef = new Map(result.coverage.entries.map((entry) => [entry.sourceRef, entry.status]));
    expect(statusByRef.get("#/paths/~1jobs/post")).toBe("represented");
    expect(statusByRef.get("#/paths/~1jobs/post/requestBody/content/application~1json")).toBe("represented");
    expect(statusByRef.get("#/paths/~1jobs/post/requestBody/content/application~1x-custom")).toBe("excluded");
    expect(statusByRef.get("#/webhooks/jobChanged/post")).toBe("excluded");
  });

  it("can prove full representation for an ordinary paths-only document", async () => {
    const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{
        bindingSpec: "openbindings.openapi@1",
        content: {
          openapi: "3.1.0",
          info: { title: "coverage", version: "1" },
          paths: {
            "/users": {
              get: {
                operationId: "listUsers",
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
      }],
    });
    expect(result.coverage.fullyRepresented).toBe(true);
  });
});

// Field-collision rule, synthesis half: the parameter/body merge is
// deterministic (body schema wins) and never silent — a synthesizer
// warning names the field and the delivery rule. Also closes the TS
// warning-channel gap (SynthesizeInput.onWarning, mirroring Go).
// Free-form object bodies flatten OPEN, never wrap under the synthetic
// `body` property (openbindings.openapi@1 §9.1): the synthetic wrap is
// reserved for NON-object body schemas, and wrapping would describe a field
// the conformant invoker refuses as unmatched — breaking the
// synthesize→invoke round trip. Mirrors the Go SDK's resolved synthesis body
// shape (formats/openapi/synthesize.go).
describe("free-form object bodies", () => {
  function specWithBody(bodySchema: Record<string, unknown>) {
    return {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/things": {
          post: {
            operationId: "makeThing",
            requestBody: {
              required: true,
              content: { "application/json": { schema: bodySchema } },
            },
            responses: { "200": { description: "ok", content: { "application/json": {} } } },
          },
        },
      },
    };
  }

  it("synthesizes a free-form object body as an OPEN flattened surface", async () => {
    const iface = await convertToInterface(undefined, specWithBody({ type: "object" }));
    // No parameters and no named properties: the flattened surface is the
    // open object itself — never a synthetic `body` wrap, never absent.
    expect(iface.operations["makeThing"]?.input).toEqual({ type: "object" });

    const declaredByEmptyProperties = await convertToInterface(
      undefined,
      specWithBody({ properties: {} }),
    );
    expect(declaredByEmptyProperties.operations["makeThing"]?.input).toEqual({ type: "object" });
  });

  it("still wraps a NON-object body schema under the synthetic body property", async () => {
    const iface = await convertToInterface(
      undefined,
      specWithBody({ type: "array", items: { type: "integer" } }),
    );
    const input = iface.operations["makeThing"]?.input as Record<string, unknown>;
    const props = input.properties as Record<string, unknown>;
    expect(props["body"]).toMatchObject({ type: "array" });
    expect(input.required).toEqual(["body"]);
  });

  it("treats a single-element 3.1 type array [\"object\"] as object-typed", async () => {
    const iface = await convertToInterface(undefined, specWithBody({ type: ["object"] }));
    expect(iface.operations["makeThing"]?.input).toEqual({ type: "object" });
  });

  // The round trip the wrap used to break: the synthesized open surface's
  // fields pass through into the body at invocation (§9.1 evaluation-free
  // passthrough) instead of refusing as unmatched.
  it("round-trips: invoking with free-form fields passes them through into the body", async () => {
    const spec = specWithBody({ type: "object" });
    let captured: string | undefined;
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.body as string;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;

    const call = new OpenAPIInvoker().invokeBinding({
      source: { bindingSpec: "openbindings.openapi@1", content: spec },
      ref: "#/paths/~1things/post",
      fetch: fetchFn,
    });
    await call.write({ anything: "goes", n: 1 });
    for await (const _ of call.outputs) void _;
    expect(JSON.parse(captured!)).toEqual({ anything: "goes", n: 1 });
  });
});

describe("param/body field collision", () => {
  it("refuses a partial interface when no required-body candidate can flatten faithfully", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/users/{id}": {
          put: {
            operationId: "updateUser",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" }, name: { type: "string" } },
                    required: ["id", "name"],
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const warnings: Array<{ code: string; path?: string }> = [];
    await expect(new OpenAPISynthesizer().synthesizeInterface({
        sources: [{ bindingSpec: "openbindings.openapi@1", content: spec }],
        onWarning: (w) => warnings.push(w),
      })).rejects.toThrow(/updateUser.*statically unbindable partial interface/);
    expect(warnings).toHaveLength(0);
  });
});

// Pins the synthesis half of §9.2's degenerate media/schema combination
// rule (OAPI-P-04): when an optional request body's only declared media
// cannot carry it — multipart or urlencoded selected while the body schema
// does not flatten, text/plain selected while it does — synthesis can still
// emit a usable no-body operation and warns about the lossy projection. A
// co-declared JSON media type is selected instead and silences the warning.
// Required degenerate bodies fail synthesis. Mirrors the Go SDK.
describe("degenerate media/schema combination warning", () => {
  it("warns for combinations the invoker refuses, stays silent with co-declared JSON", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/scalar-multipart": {
          post: {
            operationId: "scalarMultipart",
            requestBody: {
              required: false,
              content: { "multipart/form-data": { schema: { type: "string" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
        "/object-text": {
          post: {
            operationId: "objectText",
            requestBody: {
              required: false,
              content: {
                "text/plain": { schema: { type: "object", properties: { a: { type: "string" } } } },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
        "/fine": {
          post: {
            operationId: "fine",
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": { schema: { type: "string" } },
                "application/json": { schema: { type: "string" } },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const warnings: Array<{ code: string; message: string; path?: string }> = [];
    await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: "openbindings.openapi@1", content: spec }],
      onWarning: (w) => warnings.push(w),
    });
    const byPath = new Map<string | undefined, { code: string; message: string; path?: string }>();
    for (const w of warnings) {
      if (w.code === "openapi.media_schema_mismatch") byPath.set(w.path, w);
    }
    expect(byPath.size).toBe(2);
    expect(byPath.get("operations.scalarMultipart.input")?.message).toBe(
      "request media candidate multipart/form-data has a non-object body schema and is inadmissible; optional body omitted from the synthesized contract",
    );
    expect(byPath.get("operations.objectText.input")?.message).toBe(
      "request media candidate text/plain has an object body schema and is inadmissible; optional body omitted from the synthesized contract",
    );
  });
});

describe("candidate-specific synthesized input", () => {
  it("preserves distinct realizable media surfaces instead of inventing one preferred schema", async () => {
    const iface = await convertToInterface(undefined, {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/send": {
          post: {
            operationId: "send",
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": { schema: { type: "object", properties: { metadata: { type: "string" } } } },
                "text/plain": { schema: { type: "string" } },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const input = iface.operations.send?.input as { anyOf?: Array<Record<string, unknown>> };
    expect(input.anyOf).toHaveLength(2);
    expect(input.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ properties: expect.objectContaining({ metadata: { type: "string" } }), additionalProperties: false }),
      expect.objectContaining({ properties: expect.objectContaining({ body: { type: "string" } }), required: ["body"], additionalProperties: false }),
    ]));
  });
});

describe("synthesis coverage disposition identity", () => {
  it("does not misclassify an out-of-revision media declaration as a flattening collision", async () => {
    const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{
        bindingSpec: "openbindings.openapi@1",
        content: {
          openapi: "3.1.0",
          info: { title: "coverage", version: "1" },
          paths: {
            "/jobs": {
              post: {
                operationId: "createJob",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } },
                    "application/x-custom": { schema: { type: "string" } },
                  },
                },
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
      }],
    });
    expect(result.coverage.entries).toContainEqual(expect.objectContaining({
      sourceRef: "#/paths/~1jobs/post/requestBody/content/application~1x-custom",
      status: "excluded",
      reasonCode: "openapi.request_media_excluded",
      rule: "OAPI-P-04",
    }));
  });
});

// Pins the contract half of the §9.1 declaration-only object
// determination: a TYPELESS request-body schema — neither `properties` nor
// an explicit object type — is non-object, so the published contract
// carries it under the synthetic `body` property (required when the
// artifact declares the body required); a schema declaring `properties`
// WITHOUT a type is object by declaration and flattens by property name.
// planRequestBody (media.ts) routes the wire with the same predicate
// (bodySchemaFlattens), so contract and wire cannot disagree. Mirrors the
// Go SDK's TestSynthesize_TypelessBodyWrapsSynthetic.
describe("typeless request-body contract", () => {
  it("wraps a typeless body synthetic and flattens properties-without-type", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/opaque": {
          post: {
            operationId: "sendOpaque",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { description: "opaque payload" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
        "/named": {
          post: {
            operationId: "sendNamed",
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { properties: { name: { type: "string" } } } },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: "openbindings.openapi@1", content: spec }],
    });

    const opaque = iface.operations.sendOpaque?.input as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(opaque.properties)).toEqual(["body"]);
    expect(opaque.required).toEqual(["body"]);

    const named = iface.operations.sendNamed?.input as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(named.properties)).toEqual(["name"]);
  });
});

// ---------------------------------------------------------------------------
// InspectSource operationKey (Go parity: list_refs.go's InspectSource calls
// the SAME deriveOperationKey/httpMethods synthesis uses, so a caller
// previewing bindable targets sees the exact key SynthesizeInterface would
// assign.)
// ---------------------------------------------------------------------------

describe("inspectSource", () => {
  const SPEC_WITH_COLLISION = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/users": {
        get: { responses: { "200": { description: "ok" } } },
        post: { operationId: "createUser", responses: { "201": { description: "created" } } },
      },
      "/users/{id}": {
        // operationId collides with the fallback key /users GET would have
        // produced ("users.get") — de-duplication must kick in, and it must
        // pick the SAME key convertToInterface itself would pick.
        get: { operationId: "users.get", responses: { "200": { description: "ok" } } },
      },
    },
  };

  it("suggests the same operationKey synthesis would assign, including de-duplication", async () => {
    const inspection = await new OpenAPISynthesizer().inspectSource({
      bindingSpec: "openbindings.openapi@1",
      content: SPEC_WITH_COLLISION,
    });
    const byRef = Object.fromEntries(inspection.targets.map((t) => [t.ref, t.operationKey]));

    expect(byRef["#/paths/~1users/get"]).toBe("users.get");
    expect(byRef["#/paths/~1users/post"]).toBe("createUser");
    expect(byRef["#/paths/~1users~1{id}/get"]).toBe("users.get_2");
  });

  it("matches convertToInterface's own operation keys exactly", async () => {
    const iface = await convertToInterface(undefined, SPEC_WITH_COLLISION);
    const inspection = await new OpenAPISynthesizer().inspectSource({
      bindingSpec: "openbindings.openapi@1",
      content: SPEC_WITH_COLLISION,
    });

    for (const target of inspection.targets) {
      expect(Object.keys(iface.operations)).toContain(target.operationKey);
      expect(iface.bindings?.[`${target.operationKey}.${DEFAULT_SOURCE_NAME}`]?.ref).toBe(target.ref);
    }
  });
});

// ---------------------------------------------------------------------------
// Content-fed synthesis: a source needs location or content; dropping the
// provided content when no location was given would emit an uninvocable
// source (Go parity: invoker.go's SynthesizeInterface — "the emitted source
// must stay invocable").
// ---------------------------------------------------------------------------

describe("content-fed synthesis", () => {
  it("returns the deterministic source-less scaffold", async () => {
    await expect(new OpenAPISynthesizer().synthesizeInterface({ name: "scaffold" })).resolves.toEqual({
      openbindings: "0.2.0", name: "scaffold", operations: {},
    });
  });

  it("refuses a process-local path rather than introducing a Node dependency", async () => {
    await expect(new OpenAPISynthesizer().synthesizeInterface({
      sources: [{
        bindingSpec: "openbindings.openapi@1",
        location: "./api.json",
        embed: true,
      }],
    })).rejects.toThrow(/process-local authoring path.*embedded content.*absolute artifact URI/);
  });

  it("embeds the artifact verbatim into the source when no location is given", async () => {
    const content = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "T", version: "1.0.0" },
      paths: { "/x": { get: { operationId: "getX", responses: { "200": { description: "ok" } } } } },
    });
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: "openbindings.openapi@1", content }],
    });

    const src = iface.sources?.[DEFAULT_SOURCE_NAME];
    expect(src?.location).toBeUndefined();
    expect(src?.content).toBe(content);
  });

  it("does not invent a location, and embeds a non-string content as JSON text", async () => {
    const content = {
      openapi: "3.0.3",
      info: { title: "T", version: "1.0.0" },
      paths: {},
    };
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: "openbindings.openapi@1", content }],
    });

    const src = iface.sources?.[DEFAULT_SOURCE_NAME];
    expect(src?.location).toBeUndefined();
    expect(src?.content).toEqual(content);
  });

  it("preserves authoritative content when a location is also its base and provenance", async () => {
    const content = { openapi: "3.0.3", info: { title: "T", version: "1" }, paths: {} };
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: "openbindings.openapi@1", location: "https://example.com/openapi.json", content }],
    });

    const src = iface.sources?.[DEFAULT_SOURCE_NAME];
    expect(src?.location).toBe("https://example.com/openapi.json");
    expect(src?.content).toEqual(content);
  });
});

describe("deterministic ordering", () => {
  it("orders mixed-case paths by code point, not locale collation", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "Case API", version: "1.0.0" },
      paths: {
        "/adopt": {
          get: { operationId: "adoptPet", responses: { "200": { description: "OK" } } },
        },
        "/Pets": {
          get: { operationId: "listPets", responses: { "200": { description: "OK" } } },
        },
      },
    };

    const iface = await convertToInterface(undefined, spec);

    // "P" (U+0050) < "a" (U+0061) by code point — the order Go's byte-wise
    // comparison produces; ICU locale collation would flip the pair.
    expect(Object.keys(iface.operations)).toEqual(["listPets", "adoptPet"]);
  });
});

describe("directional request/response schema projection", () => {
  for (const openapi of ["3.0.3", "3.1.0"]) {
    it(`projects readOnly/writeOnly through nested, allOf, and recursive refs in OpenAPI ${openapi}`, async () => {
      const spec = {
        openapi,
        info: { title: "Directional API", version: "1" },
        servers: [{ url: "https://api.example.test" }],
        components: {
          schemas: {
            Filter: {
              type: "object",
              required: ["serverGenerated", "clientProvided", "ordinary"],
              properties: {
                serverGenerated: { type: "string", readOnly: true },
                clientProvided: { type: "string", writeOnly: true },
                ordinary: { type: "string" },
              },
            },
            Profile: {
              type: "object",
              required: ["serverNote", "clientSecret", "displayName", "nested", "neverDirectional"],
              properties: {
                serverNote: { type: "string", readOnly: true },
                clientSecret: { type: "string", writeOnly: true },
                displayName: { type: "string" },
                neverDirectional: {
                  type: "string",
                  readOnly: true,
                  writeOnly: true,
                },
                nested: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["createdAt", "draft", "label"],
                    properties: {
                      createdAt: { type: "string", readOnly: true },
                      draft: { type: "string", writeOnly: true },
                      label: { type: "string" },
                    },
                  },
                },
              },
            },
            User: {
              type: "object",
              // Parent-level required names deliberately target properties
              // declared only in allOf members. Projection must repair this
              // list as well as each member's local list.
              required: [
                "id",
                "password",
                "serverNote",
                "clientSecret",
                "displayName",
                "nested",
                "manager",
                "neverDirectional",
              ],
              allOf: [
                { $ref: "#/components/schemas/Profile" },
                {
                  type: "object",
                  required: ["id", "password", "manager"],
                  properties: {
                    id: { type: "string", readOnly: true },
                    password: { type: "string", writeOnly: true },
                    manager: { $ref: "#/components/schemas/User" },
                  },
                },
              ],
            },
          },
        },
        paths: {
          "/users": {
            post: {
              operationId: "upsertUser",
              parameters: [
                {
                  name: "filter",
                  in: "query",
                  required: true,
                  schema: { $ref: "#/components/schemas/Filter" },
                },
              ],
              requestBody: {
                required: true,
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/User" } },
                },
              },
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/User" } },
                  },
                },
              },
            },
          },
        },
      };

      const iface = await convertToInterface(undefined, spec);
      const input = iface.operations.upsertUser?.input as Record<string, unknown>;
      const output = iface.operations.upsertUser?.output as Record<string, unknown>;
      const inputProps = input.properties as Record<string, Record<string, unknown>>;

      expect(Object.keys(inputProps)).toEqual(expect.arrayContaining([
        "filter", "password", "clientSecret", "displayName", "nested", "manager",
      ]));
      expect(inputProps).not.toHaveProperty("id");
      expect(inputProps).not.toHaveProperty("serverNote");
      expect(inputProps).not.toHaveProperty("neverDirectional");
      expect(input.required).toEqual(expect.arrayContaining([
        "filter", "password", "clientSecret", "displayName", "nested", "manager",
      ]));
      expect(input.required).not.toEqual(expect.arrayContaining([
        "id", "serverNote", "neverDirectional",
      ]));

      const filterProps = inputProps.filter!.properties as Record<string, unknown>;
      expect(filterProps).not.toHaveProperty("serverGenerated");
      expect(filterProps).toHaveProperty("clientProvided");
      expect(inputProps.filter!.required).toEqual(["clientProvided", "ordinary"]);

      const inputNested = inputProps.nested!.items as Record<string, unknown>;
      const inputNestedProps = inputNested.properties as Record<string, unknown>;
      expect(inputNestedProps).not.toHaveProperty("createdAt");
      expect(inputNestedProps).toHaveProperty("draft");
      expect(inputNested.required).toEqual(["draft", "label"]);

      const outputProfile = findSchemaWithProperty(output, "displayName");
      const outputProfileProps = outputProfile.properties as Record<string, unknown>;
      expect(outputProfileProps).toHaveProperty("serverNote");
      expect(outputProfileProps).not.toHaveProperty("clientSecret");
      expect(outputProfileProps).not.toHaveProperty("neverDirectional");
      expect(outputProfile.required).toEqual(["serverNote", "displayName", "nested"]);

      const outputIdentity = findSchemaWithProperty(output, "id");
      const outputIdentityProps = outputIdentity.properties as Record<string, unknown>;
      expect(outputIdentityProps).toHaveProperty("id");
      expect(outputIdentityProps).not.toHaveProperty("password");
      expect(outputIdentity.required).toEqual(["id", "manager"]);

      const outputNested = findSchemaWithProperty(output, "label");
      const outputNestedProps = outputNested.properties as Record<string, unknown>;
      expect(outputNestedProps).toHaveProperty("createdAt");
      expect(outputNestedProps).not.toHaveProperty("draft");
      expect(outputNested.required).toEqual(["createdAt", "label"]);

      const outputRoot = findSchemaWithRequired(output, "manager");
      expect(outputRoot.required).toEqual(expect.arrayContaining([
        "id", "serverNote", "displayName", "nested", "manager",
      ]));
      expect(outputRoot.required).not.toEqual(expect.arrayContaining([
        "password", "clientSecret", "neverDirectional",
      ]));

      // The recursive component keeps its stable name after projection and
      // decycling; directionality is applied inside the reachable definition.
      expect(JSON.stringify(input)).toContain("#/operations/upsertUser/input/$defs/User");
      expect(JSON.stringify(output)).toContain("#/operations/upsertUser/output/$defs/User");
      expect(JSON.stringify(input)).not.toContain('"readOnly":true');
      expect(JSON.stringify(output)).not.toContain('"writeOnly":true');
    });
  }
});

function findSchemaWithProperty(
  root: unknown,
  property: string,
): Record<string, unknown> {
  return findSchema(root, (schema) => {
    const properties = schema.properties;
    return !!properties && typeof properties === "object" && !Array.isArray(properties)
      && Object.hasOwn(properties, property);
  });
}

function findSchemaWithRequired(root: unknown, property: string): Record<string, unknown> {
  return findSchema(
    root,
    (schema) => Array.isArray(schema.required) && schema.required.includes(property),
  );
}

function findSchema(
  root: unknown,
  predicate: (schema: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  const seen = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value) && predicate(value as Record<string, unknown>)) {
      return value as Record<string, unknown>;
    }
    pending.push(...Object.values(value));
  }
  throw new Error("expected schema fragment was not found");
}

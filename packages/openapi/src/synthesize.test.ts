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
    expect(iface.operations["deleteUser"].deprecated).toBe(true);
  });

  it("generates input schemas from parameters", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    const listInput = iface.operations["listUsers"].input as Record<string, unknown>;
    expect(listInput).toBeDefined();
    expect(listInput.type).toBe("object");
    const props = listInput.properties as Record<string, unknown>;
    expect(props["limit"]).toEqual({ type: "integer" });
  });

  it("generates input schemas from request body", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    const synthesizeInput = iface.operations["createUser"].input as Record<string, unknown>;
    expect(synthesizeInput).toBeDefined();
    const props = synthesizeInput.properties as Record<string, unknown>;
    expect(props["name"]).toEqual({ type: "string" });
    expect(props["email"]).toEqual({ type: "string" });
    expect(synthesizeInput.required).toContain("email");
    expect(synthesizeInput.required).toContain("name");
  });

  it("generates output schemas from 200/201 responses", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    expect(iface.operations["listUsers"].output).toEqual({
      type: "array", items: { type: "object" },
    });
    expect(iface.operations["createUser"].output).toEqual({
      type: "object", properties: { id: { type: "string" } },
    });
  });

  it("merges path-level parameters into operation", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    const getInput = iface.operations["getUser"].input as Record<string, unknown>;
    expect(getInput).toBeDefined();
    const props = getInput.properties as Record<string, unknown>;
    expect(props["id"]).toBeDefined();
    expect(getInput.required).toContain("id");
  });

  it("creates bindings with JSON pointer refs", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    const binding = iface.bindings!["listUsers.openapi"];
    expect(binding).toBeDefined();
    expect(binding.operation).toBe("listUsers");
    expect(binding.source).toBe("openapi");
    expect(binding.ref).toBe("#/paths/~1users/get");
  });

  it("creates source entries", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    expect(iface.sources?.["openapi"]).toBeDefined();
    expect(iface.sources?.["openapi"].bindingSpec).toBe("openbindings.openapi@1");
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
    expect(iface.sources?.["openapi"].location).toBe("https://example.com/api.json");
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
    expect(iface.bindings!["listItems.openapi"].security).toBeUndefined();
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
    const output = iface.operations["abilityList"].output as Record<string, unknown>;
    const props = output.properties as Record<string, Record<string, unknown>>;
    expect(props["next"]).toEqual({ type: ["string", "null"], format: "uri" });
    expect(props["previous"]).toEqual({ type: ["string", "null"], format: "uri" });
    expect(props["count"]).toEqual({ type: "integer" });
  });

  it("stamps the exact identifier for 3.0.x sources (the artifact version drives dialect only)", async () => {
    const iface = await convertToInterface(undefined, SPEC_30_NULLABLE);
    expect(iface.sources?.["openapi"].bindingSpec).toBe("openbindings.openapi@1");
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
    const output = iface.operations["x"].output as Record<string, unknown>;
    const props = output.properties as Record<string, Record<string, unknown>>;
    expect(props["next"]).toEqual({ type: ["string", "null"], format: "uri" });
    // The inert nullable: true survives untouched in 3.1 — we don't second-guess.
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
    const input = iface.operations["q"].input as Record<string, unknown>;
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

// Field-collision rule, synthesis half: the parameter/body merge is
// deterministic (body schema wins) and never silent — a synthesizer
// warning names the field and the delivery rule. Also closes the TS
// warning-channel gap (SynthesizeInput.onWarning, mirroring Go).
// Free-form object bodies flatten OPEN, never wrap under the synthetic
// `body` property (openbindings.openapi@1 §9.1): the synthetic wrap is
// reserved for NON-object body schemas, and wrapping would describe a field
// the conformant invoker refuses as unmatched — breaking the
// synthesize→invoke round trip. Mirrors the Go SDK's hasOpenBody /
// isObjectTypedSchema (formats/openapi/synthesize.go).
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
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
  }

  it("synthesizes a free-form object body as an OPEN flattened surface", async () => {
    const iface = await convertToInterface(undefined, specWithBody({ type: "object" }));
    // No parameters and no named properties: the flattened surface is the
    // open object itself — never a synthetic `body` wrap, never absent.
    expect(iface.operations["makeThing"].input).toEqual({ type: "object" });
  });

  it("still wraps a NON-object body schema under the synthetic body property", async () => {
    const iface = await convertToInterface(
      undefined,
      specWithBody({ type: "array", items: { type: "integer" } }),
    );
    const input = iface.operations["makeThing"].input as Record<string, unknown>;
    const props = input.properties as Record<string, unknown>;
    expect(props["body"]).toMatchObject({ type: "array" });
    expect(input.required).toEqual(["body"]);
  });

  it("treats a single-element 3.1 type array [\"object\"] as object-typed", async () => {
    const iface = await convertToInterface(undefined, specWithBody({ type: ["object"] }));
    expect(iface.operations["makeThing"].input).toEqual({ type: "object" });
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
  it("warns and flattens to one field", async () => {
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
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: "openbindings.openapi@1", content: spec }],
      onWarning: (w) => warnings.push(w),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("openapi.param_body_collision");
    expect(warnings[0].path).toBe("operations.updateUser.input.properties.id");
    const props = (iface.operations.updateUser.input as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(props).sort()).toEqual(["id", "name"]);
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

    const opaque = iface.operations.sendOpaque.input as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(opaque.properties)).toEqual(["body"]);
    expect(opaque.required).toEqual(["body"]);

    const named = iface.operations.sendNamed.input as {
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
    expect(JSON.parse(src?.content as string)).toEqual(content);
  });

  it("does not re-embed content when a location is present (location is provenance)", async () => {
    const content = { openapi: "3.0.3", info: { title: "T", version: "1" }, paths: {} };
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: "openbindings.openapi@1", location: "https://example.com/openapi.json", content }],
    });

    const src = iface.sources?.[DEFAULT_SOURCE_NAME];
    expect(src?.location).toBe("https://example.com/openapi.json");
    expect(src?.content).toBeUndefined();
  });
});

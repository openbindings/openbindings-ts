import { describe, it, expect } from "vitest";
import { convertToInterface } from "./create.js";

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

    const listInput = iface.operations["listUsers"].input;
    expect(listInput).toBeDefined();
    expect(listInput!.type).toBe("object");
    const props = listInput!.properties as Record<string, unknown>;
    expect(props["limit"]).toEqual({ type: "integer" });
  });

  it("generates input schemas from request body", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);

    const createInput = iface.operations["createUser"].input;
    expect(createInput).toBeDefined();
    const props = createInput!.properties as Record<string, unknown>;
    expect(props["name"]).toEqual({ type: "string" });
    expect(props["email"]).toEqual({ type: "string" });
    expect(createInput!.required).toContain("email");
    expect(createInput!.required).toContain("name");
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

    const getInput = iface.operations["getUser"].input;
    expect(getInput).toBeDefined();
    const props = getInput!.properties as Record<string, unknown>;
    expect(props["id"]).toBeDefined();
    expect(getInput!.required).toContain("id");
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
    expect(iface.sources?.["openapi"].format).toBe("openapi@3.1");
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

  it("populates security from bearer auth scheme", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Secure API" },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
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

    expect(iface.security).toBeDefined();
    expect(iface.security!["bearerAuth"]).toEqual([
      { type: "bearer" },
    ]);
    expect(iface.bindings!["listItems.openapi"].security).toBe("bearerAuth");
  });

  it("populates security from apiKey scheme", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "API Key API" },
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            name: "X-API-Key",
            in: "header",
          },
        },
      },
      security: [{ apiKey: [] }],
      paths: {
        "/data": {
          get: {
            operationId: "getData",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const iface = await convertToInterface(undefined, spec);

    expect(iface.security!["apiKey"]).toEqual([
      { type: "apiKey", name: "X-API-Key", in: "header" },
    ]);
    expect(iface.bindings!["getData.openapi"].security).toBe("apiKey");
  });

  it("populates security from oauth2 scheme", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "OAuth API" },
      components: {
        securitySchemes: {
          oauth: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://auth.example.com/authorize",
                tokenUrl: "https://auth.example.com/token",
                scopes: {
                  "read:data": "Read data",
                  "write:data": "Write data",
                },
              },
            },
          },
        },
      },
      security: [{ oauth: [] }],
      paths: {
        "/resource": {
          get: {
            operationId: "getResource",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const iface = await convertToInterface(undefined, spec);

    expect(iface.security!["oauth"]).toEqual([
      {
        type: "oauth2",
        authorizeUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/token",
        scopes: ["read:data", "write:data"],
      },
    ]);
  });

  it("uses operation-level security over document-level", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Mixed Security" },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
          apiKey: { type: "apiKey", name: "key", in: "query" },
        },
      },
      security: [{ bearerAuth: [] }],
      paths: {
        "/public": {
          get: {
            operationId: "publicOp",
            security: [{}],
            responses: { "200": { description: "OK" } },
          },
        },
        "/special": {
          get: {
            operationId: "specialOp",
            security: [{ apiKey: [] }],
            responses: { "200": { description: "OK" } },
          },
        },
        "/default": {
          get: {
            operationId: "defaultOp",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const iface = await convertToInterface(undefined, spec);

    // Public operation has empty security, so no security ref.
    expect(iface.bindings!["publicOp.openapi"].security).toBeUndefined();

    // Special operation uses apiKey.
    expect(iface.bindings!["specialOp.openapi"].security).toBe("apiKey");

    // Default operation inherits doc-level bearerAuth.
    expect(iface.bindings!["defaultOp.openapi"].security).toBe("bearerAuth");
  });

  it("handles openIdConnect as bearer", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "OIDC API" },
      components: {
        securitySchemes: {
          oidc: {
            type: "openIdConnect",
            openIdConnectUrl: "https://example.com/.well-known/openid-configuration",
          },
        },
      },
      security: [{ oidc: [] }],
      paths: {
        "/me": {
          get: {
            operationId: "getMe",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const iface = await convertToInterface(undefined, spec);

    expect(iface.security!["oidc"]).toEqual([
      { type: "bearer", description: "OpenID Connect" },
    ]);
  });

  it("combines multiple security schemes into a single key", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Multi Auth" },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
          apiKey: { type: "apiKey", name: "key", in: "header" },
        },
      },
      security: [{ bearerAuth: [] }, { apiKey: [] }],
      paths: {
        "/data": {
          get: {
            operationId: "getData",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const iface = await convertToInterface(undefined, spec);

    expect(iface.security!["apiKey+bearerAuth"]).toBeDefined();
    expect(iface.bindings!["getData.openapi"].security).toBe("apiKey+bearerAuth");
  });

  it("skips security when no securitySchemes defined", async () => {
    const iface = await convertToInterface(undefined, MINIMAL_SPEC);
    expect(iface.security).toBeUndefined();
  });
});

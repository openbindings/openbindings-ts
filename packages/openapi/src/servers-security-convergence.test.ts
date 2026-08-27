import { ERR_REFUSED, type InvocationError } from "@openbindings/invoke";
import { describe, expect, it } from "vitest";
import { REFERRING_SECURITY_SCHEMES_MARKER } from "./binding-origins.js";
import {
  requiredImplicitConnectionScopeContext,
  securityCoverageRequirements,
  securityPlans,
} from "./security.js";
import { OpenAPIInvoker } from "./test-helpers.js";
import type { OpenAPIDocument, OpenAPIOperation, OpenAPIParameter } from "./types.js";

const SELECTOR = "#/paths/~1items~1{id}/get";

interface CapturedRequest {
  url: string;
  headers: Headers;
}

function document(options: {
  openapi?: string;
  servers?: OpenAPIDocument["servers"];
  parameters?: OpenAPIParameter[];
  security?: unknown[];
  schemes?: Record<string, unknown>;
} = {}): OpenAPIDocument {
  return {
    openapi: options.openapi ?? "3.1.2",
    info: { title: "convergence", version: "1" },
    servers: options.servers ?? [{ url: "https://api.example.test" }],
    paths: {
      "/items/{id}": {
        get: {
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            ...(options.parameters ?? []),
          ],
          security: options.security ?? [],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": {} },
            },
          },
        },
      },
    },
    components: { securitySchemes: options.schemes ?? {} },
  };
}

async function invoke(
  content: unknown,
  input: unknown,
  context?: Record<string, unknown>,
  resources: Record<string, unknown> = {},
  location?: string,
  selector = SELECTOR,
): Promise<{ error?: InvocationError; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const fetch = async (raw: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = raw instanceof Request ? raw.url : String(raw);
    if (Object.hasOwn(resources, url)) {
      return new Response(JSON.stringify(resources[url]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    requests.push({
      url,
      headers: raw instanceof Request ? new Headers(raw.headers) : new Headers(init?.headers),
    });
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const call = new OpenAPIInvoker().invokeBinding({
    source: {
      bindingSpec: "openbindings.openapi-3.1@1",
      ...(location ? { location } : {}),
      content,
    },
    selector,
    context,
    fetch,
  });
  const closed = call.closed.then(
    () => undefined,
    (error: InvocationError) => error,
  );
  const drained = (async () => {
    try {
      for await (const _output of call.outputs) { /* drain */ }
    } catch { /* call.closed carries the terminal classification */ }
  })();
  try { await call.write(input); } catch { /* a preflight refusal can close first */ }
  try { await call.close(); } catch { /* a preflight refusal can close first */ }
  const error = await closed;
  await drained;
  return { ...(error ? { error } : {}), requests };
}

describe("server convergence", () => {
  it("preserves empty variable values and appends operation path bytes verbatim", async () => {
    const spec = document({
      servers: [{
        url: "https://api.example.test/{segment}",
        variables: { segment: { default: "", enum: [""] } },
      }],
      parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
    });
    const result = await invoke(spec, { parameters: { id: "42", q: "yes" } });
    expect(result.error).toBeUndefined();
    expect(result.requests.map(({ url }) => url)).toEqual([
      "https://api.example.test//items/42?q=yes",
    ]);
  });

  it.each([
    ["empty enum", "3.1.2", { url: "https://{env}.example.test", variables: { env: { default: "prod", enum: [] } } }, undefined],
    ["default outside enum", "3.1.2", { url: "https://{env}.example.test", variables: { env: { default: "prod", enum: ["stage"] } } }, undefined],
    ["supplied outside enum", "3.1.2", { url: "https://{env}.example.test", variables: { env: { default: "prod", enum: ["prod"] } } }, { configuration: { server: { variables: { env: "stage" } } } }],
    ["3.0 missing default", "3.0.4", { url: "https://{env}.example.test", variables: { env: { enum: ["prod"] } } }, undefined],
    ["query", "3.1.2", { url: "https://api.example.test/base?x=1" }, undefined],
    ["fragment", "3.1.2", { url: "https://api.example.test/base#frag" }, undefined],
    ["duplicate template variable", "3.1.2", { url: "https://{env}.example.test/{env}", variables: { env: { default: "prod" } } }, undefined],
  ])("refuses the %s declaration/value defect before dispatch", async (_name, openapi, server, context) => {
    const result = await invoke(document({ openapi, servers: [server] }), {
      parameters: { id: "42" },
    }, context);
    expect(result.error?.code).toBe(ERR_REFUSED);
    expect(result.requests).toHaveLength(0);
  });

  it("replaces only the server base while preserving path and query construction", async () => {
    const spec = document({
      servers: [{ url: "https://artifact.example/base" }],
      parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
    });
    const result = await invoke(
      spec,
      { parameters: { id: "42", q: "yes" } },
      { configuration: { server: { baseUrl: "https://configured.example/root/" } } },
    );
    expect(result.error).toBeUndefined();
    expect(result.requests[0]?.url).toBe("https://configured.example/root//items/42?q=yes");
  });

  it.each(["3.0.4", "3.1.2"])(
    "refuses a completed %s target that cannot percent-decode before dispatch",
    async (openapi) => {
      const spec = document({ openapi });
      spec.paths!["/items%ZZ/{id}"] = spec.paths!["/items/{id}"]!;
      delete spec.paths!["/items/{id}"];
      const result = await invoke(
        spec,
        { parameters: { id: "42" } },
        undefined,
        {},
        undefined,
        "#/paths/~1items%ZZ~1{id}/get",
      );
      expect(result.error?.code).toBe(ERR_REFUSED);
      expect(result.requests).toHaveLength(0);
    },
  );

  it("resolves an external operation server against its declaring document", async () => {
    const external = document({ servers: [] });
    const externalPath = external.paths?.["/items/{id}"];
    const operation = externalPath?.get as OpenAPIOperation;
    operation.servers = [{ url: "../api/" }];
    const entry = {
      openapi: "3.1.2",
      info: { title: "entry", version: "1" },
      paths: {
        "/items/{id}": {
          $ref: "https://docs.example/specs/parts.json#/paths/~1items~1{id}",
        },
      },
    };
    const result = await invoke(
      entry,
      { parameters: { id: "42" } },
      undefined,
      { "https://docs.example/specs/parts.json": external },
      "https://entry.example/root/openapi.json",
    );
    expect(result.error).toBeUndefined();
    expect(result.requests[0]?.url).toBe("https://docs.example/api//items/42");
  });
});

describe("security convergence", () => {
  it("requires an explicit authored alternative and applies only the selected one", async () => {
    const spec = document({
      security: [{ first: [] }, { second: [] }],
      schemes: {
        first: { type: "apiKey", in: "header", name: "X-First" },
        second: { type: "apiKey", in: "header", name: "X-Second" },
      },
    });
    const credentials = { apiKeys: { first: "one", second: "two" } };
    const unselected = await invoke(spec, { parameters: { id: "42" } }, credentials);
    expect(unselected.error?.code).toBe(ERR_REFUSED);
    expect(unselected.requests).toHaveLength(0);

    const selected = await invoke(spec, { parameters: { id: "42" } }, {
      ...credentials,
      configuration: { security: { index: 1 } },
    });
    expect(selected.error).toBeUndefined();
    expect(selected.requests[0]?.headers.get("X-Second")).toBe("two");
    expect(selected.requests[0]?.headers.get("X-First")).toBeNull();
  });

  it("percent-encodes every non-unreserved query apiKey byte with uppercase hex", async () => {
    const spec = document({
      security: [{ key: [] }],
      schemes: { key: { type: "apiKey", in: "query", name: "api_key" } },
    });
    const result = await invoke(spec, { parameters: { id: "42" } }, {
      apiKeys: { key: "a/b? c&d=é" },
    });
    expect(result.error).toBeUndefined();
    expect(result.requests[0]?.url).toBe(
      "https://api.example.test/items/42?api_key=a%2Fb%3F%20c%26d%3D%C3%A9",
    );
  });

  it("confines a credential collision to the alternative that owns it", async () => {
    const spec = document({
      parameters: [{ name: "X-Key", in: "header", schema: { type: "string" } }],
      security: [{ colliding: [] }, { safe: [] }],
      schemes: {
        colliding: { type: "apiKey", in: "header", name: "X-Key" },
        safe: { type: "apiKey", in: "header", name: "X-Safe" },
      },
    });
    const result = await invoke(spec, { parameters: { id: "42" } }, {
      apiKeys: { colliding: "bad", safe: "good" },
      configuration: { security: { index: 1 } },
    });
    expect(result.error).toBeUndefined();
    expect(result.requests[0]?.headers.get("X-Safe")).toBe("good");
    expect(result.requests[0]?.headers.get("X-Key")).toBeNull();
  });

  it.each([
    ["cookie", { type: "apiKey", in: "cookie", name: "session" }, { apiKeys: { key: "bad;value" } }],
    ["basic colon user", { type: "http", scheme: "basic" }, { credentials: { key: { username: "a:b", password: "secret" } } }],
    ["basic non-ASCII", { type: "http", scheme: "basic" }, { credentials: { key: { username: "é", password: "secret" } } }],
    ["basic control", { type: "http", scheme: "basic" }, { credentials: { key: { username: "user", password: "bad\nvalue" } } }],
    ["bearer space", { type: "http", scheme: "bearer" }, { credentials: { key: "bad token" } }],
    ["bearer padding only", { type: "http", scheme: "bearer" }, { credentials: { key: "=" } }],
  ])("refuses invalid %s credential bytes before dispatch", async (_name, scheme, context) => {
    const result = await invoke(document({
      security: [{ key: [] }],
      schemes: { key: scheme },
    }), { parameters: { id: "42" } }, context);
    expect(result.error?.code).toBe(ERR_REFUSED);
    expect(result.requests).toHaveLength(0);
  });

  it("surfaces 3.1 roles and confines non-scope arrays and mutualTLS under 3.0", () => {
    const operation = { security: [{ key: ["operator", "auditor"] }] } as OpenAPIOperation;
    const doc31 = document({
      security: [],
      schemes: { key: { type: "apiKey", in: "header", name: "X-Key" } },
    });
    expect(securityPlans(doc31, operation, "https://api.example.test")[0]?.context)
      .toMatchObject({ requirements: [{ roles: ["operator", "auditor"] }] });

    const doc30 = { ...doc31, openapi: "3.0.4" };
    expect(securityPlans(doc30, operation, "https://api.example.test")).toEqual([]);
    expect(securityPlans(
      { ...doc30, components: { securitySchemes: { mtls: { type: "mutualTLS" } } } },
      { security: [{ mtls: [] }] },
      "https://api.example.test",
    )).toEqual([]);
  });

  it("makes implicitConnectionScope typed and discoverable when only referring scope resolves", () => {
    const operation = {
      security: [{ key: [] }],
      [REFERRING_SECURITY_SCHEMES_MARKER]: {
        key: { type: "apiKey", in: "header", name: "X-Referring" },
      },
    } as OpenAPIOperation;
    const doc = document({ schemes: {} });
    const details = requiredImplicitConnectionScopeContext(
      doc,
      operation,
      undefined,
      "https://api.example.test",
      [],
      "https://api.example.test",
    );
    expect(details).toMatchObject({
      target: "https://api.example.test",
      alternatives: [{ requirements: [{
        type: "config.value",
        point: "implicitConnectionScope",
        path: "",
        schema: { type: "string", enum: ["referring"] },
      }] }],
    });
    expect(securityCoverageRequirements(doc, operation, [])).toEqual([
      "configuration.implicitConnectionScope",
    ]);
  });

  it("uses entry security schemes by default and referring schemes when configured", async () => {
    const external = document({
      servers: [],
      security: [{ key: [] }],
      schemes: { key: { type: "apiKey", in: "header", name: "X-Referring" } },
    });
    const entry = {
      openapi: "3.1.2",
      info: { title: "entry", version: "1" },
      servers: [{ url: "https://api.example.test" }],
      paths: {
        "/items/{id}": { $ref: "https://docs.example/parts.json#/paths/~1items~1{id}" },
      },
      components: {
        securitySchemes: {
          key: { type: "apiKey", in: "header", name: "X-Entry" },
        },
      },
    };
    for (const [scope, header] of [[undefined, "X-Entry"], ["referring", "X-Referring"]] as const) {
      const result = await invoke(
        entry,
        { parameters: { id: "42" } },
        {
          apiKeys: { key: "credential" },
          ...(scope ? { configuration: { implicitConnectionScope: scope } } : {}),
        },
        { "https://docs.example/parts.json": external },
        "https://entry.example/openapi.json",
      );
      expect(result.error).toBeUndefined();
      expect(result.requests[0]?.headers.get(header)).toBe("credential");
    }
  });

  it("preflights an unselected multi-alternative requirement as typed configuration", async () => {
    const details = await new OpenAPIInvoker().prepareBinding({
      source: {
        bindingSpec: "openbindings.openapi-3.1@1",
        content: document({
          security: [{ first: [] }, { second: [] }],
          schemes: {
            first: { type: "apiKey", in: "header", name: "X-First" },
            second: { type: "apiKey", in: "header", name: "X-Second" },
          },
        }),
      },
      selector: SELECTOR,
    });
    expect(details).toMatchObject({
      alternatives: [{ requirements: [{
        type: "config.value",
        point: "security",
        path: "/index",
        schema: { type: "integer", enum: [0, 1] },
      }] }],
    });
    await expect(new OpenAPIInvoker().prepareBinding({
      source: {
        bindingSpec: "openbindings.openapi-3.1@1",
        content: document({
          security: [{ first: [] }, { second: [] }],
          schemes: {
            first: { type: "apiKey", in: "header", name: "X-First" },
            second: { type: "apiKey", in: "header", name: "X-Second" },
          },
        }),
      },
      selector: SELECTOR,
      context: { configuration: { security: { index: 9 } } },
    })).rejects.toMatchObject({ code: ERR_REFUSED });
  });

  it("retains convergence preflight semantics for a cached location source", async () => {
    const spec = document({
      security: [{ first: [] }, { second: [] }],
      schemes: {
        first: { type: "apiKey", in: "header", name: "X-First" },
        second: { type: "apiKey", in: "header", name: "X-Second" },
      },
    });
    const location = "https://docs.example/openapi.json";
    const invoker = new OpenAPIInvoker();
    const fetch = async (): Promise<Response> => new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const call = invoker.invokeBinding({
      source: { bindingSpec: "openbindings.openapi-3.1@1", content: spec, location },
      selector: SELECTOR,
      context: {
        apiKeys: { second: "two" },
        configuration: { security: { index: 1 } },
      },
      fetch,
    });
    const drained = (async () => {
      for await (const _output of call.outputs) { /* drain */ }
    })();
    await call.write({ parameters: { id: "42" } });
    await call.close();
    await drained;

    const details = await invoker.prepareBinding({
      source: { bindingSpec: "openbindings.openapi-3.1@1", location },
      selector: SELECTOR,
    });
    expect(details).toMatchObject({
      alternatives: [{ requirements: [{ point: "security", path: "/index" }] }],
    });
  });
});

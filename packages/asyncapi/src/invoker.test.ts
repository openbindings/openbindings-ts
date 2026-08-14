import { describe, it, expect, vi, afterEach } from "vitest";
import { CONTEXT_REQUIRED, InvocationError, single } from "@openbindings/sdk";
import { AsyncAPIEngine, AsyncAPIExecutionError } from "@openbindings/asyncapi-client/engine";
import { AsyncAPIInvoker, AsyncAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AsyncAPI standalone-runtime error bridge", () => {
  it("does not promote protocol-driver details into abstract error data", async () => {
    const engine = {
      prepare: async () => {
        throw new AsyncAPIExecutionError("DRIVER_FAILED", "native failure", {
          details: { reasonCode: 7 },
          evidence: { protocol: "example" },
        });
      },
      close: () => undefined,
    } as unknown as AsyncAPIEngine;
    const call = new AsyncAPIInvoker(engine).invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: {} },
      ref: "#/operations/example",
    });

    try {
      await single(call.outputs);
      expect.fail("expected unsuccessful completion");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvocationError);
      expect(error).toMatchObject({ code: "DRIVER_FAILED" });
      expect(Object.hasOwn(error as object, "data")).toBe(false);
    }
  });

  it("preserves only explicitly portable driver values, including null", async () => {
    for (const value of [{ reason: "rejected" }, null]) {
      const engine = {
        prepare: async () => {
          throw new AsyncAPIExecutionError("APPLICATION_FAILURE", "application failure", {
            details: value,
            detailsPresent: true,
          });
        },
        close: () => undefined,
      } as unknown as AsyncAPIEngine;
      const call = new AsyncAPIInvoker(engine).invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: {} },
        ref: "#/operations/example",
      });

      const error = await call.closed.catch((caught: unknown) => caught);
      expect(JSON.parse(JSON.stringify(error))).toEqual({
        code: "APPLICATION_FAILURE",
        data: value,
      });
    }
  });

  it("settles with ERR_RUNTIME when a driver marks a non-JSON value portable", async () => {
    const engine = {
      prepare: async () => {
        throw new AsyncAPIExecutionError("APPLICATION_FAILURE", "application failure", {
          details: new Uint8Array([1, 2, 3]),
          detailsPresent: true,
        });
      },
      close: () => undefined,
    } as unknown as AsyncAPIEngine;
    const call = new AsyncAPIInvoker(engine).invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: {} },
      ref: "#/operations/example",
    });

    await expect(call.closed).rejects.toMatchObject({ code: "ERR_RUNTIME" });
  });
});

// ---------------------------------------------------------------------------
// Fetch mock (mirrors packages/openapi/src/invoker.test.ts's mockFetch)
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: BodyInit | null;
}

function mockFetch(
  respond: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req: CapturedRequest = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    requests.push(req);
    return respond(req);
  };
  return { fetch: fn, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// prepareBinding is side-effect-free
// ---------------------------------------------------------------------------

describe("AsyncAPIInvoker.prepareBinding", () => {
  it("returns null with ZERO fetches when inline content carries an external $ref", async () => {
    let fetchCount = 0;
    const countingFetch = (async () => {
      fetchCount++;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    vi.stubGlobal("fetch", countingFetch);

    const spec = {
      asyncapi: "3.0.0",
      info: { title: "External refs", version: "1.0.0" },
      servers: { prod: { host: "api.example.com", protocol: "https" } },
      channels: {
        c: {
          address: "/c",
          messages: { M: { payload: { $ref: "https://schemas.example.com/m.json#/payload" } } },
        },
      },
      operations: {
        pub: {
          action: "send" as const,
          channel: { $ref: "#/channels/c" },
          security: [{ $ref: "https://schemas.example.com/security.json#/bearer" }],
        },
      },
    };

    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/pub",
    });

    // The requirements are not knowable without I/O: report null, never fetch.
    expect(details).toBeNull();
    expect(fetchCount).toBe(0);
  });

  it("still reports requirements for fully inline content", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", (async () => {
      fetchCount++;
      return new Response("{}", { status: 200 });
    }));

    const spec = {
      asyncapi: "3.0.0",
      info: { title: "Inline", version: "1.0.0" },
      servers: { prod: { host: "api.example.com", protocol: "https" } },
      channels: { c: { address: "/c", messages: { M: { payload: { type: "object" } } } } },
      operations: {
        pub: {
          action: "send" as const,
          channel: { $ref: "#/channels/c" },
          security: [{ type: "http", scheme: "bearer" }],
        },
      },
    };

    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/pub",
    });

    expect(details).toMatchObject({
      target: "https://api.example.com",
      alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
    });
    expect(fetchCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Publish presence rule (ASYNC-P-03): the input IS the message
// ---------------------------------------------------------------------------

describe("AsyncAPIInvoker no-input publish refusal", () => {
  it("refuses ERR_MISSING_INPUT pre-dispatch when binding is set and inputSchema is absent", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: init?.body });
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;

    const spec = {
      asyncapi: "3.0.0",
      info: { title: "Notify", version: "1.0.0" },
      servers: { prod: { host: "api.example.com", protocol: "https" } },
      channels: { n: { address: "/notify", messages: { M: { contentType: "application/json", payload: { type: "object" } } } } },
      operations: {
        notify: {
          action: "receive" as const,
          channel: { $ref: "#/channels/n" },
          bindings: { http: { method: "POST", bindingVersion: "0.3.0" } },
        },
      },
    };

    // binding present + inputSchema absent: the operation declares NO input,
    // but a publish invocation requires one — the input IS the message and
    // this family defines no empty message (ASYNC-P-03). The refusal fires
    // before any dispatch, and never parks on a read.
    const call = new AsyncAPIInvoker().invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/notify",
      binding: { operation: "notify", source: "api", ref: "#/operations/notify" },
      fetch: fetchFn,
    });

    await expect(call.closed).rejects.toMatchObject({ code: "ERR_REFUSED" });
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Content-fed synthesis must embed the artifact so it stays invocable
// ---------------------------------------------------------------------------

// Per spec/binding-specs/asyncapi/openbindings.asyncapi.md: "A synthesized source carries the artifact
// (location, or embedded content when synthesized from content) so it
// stays invocable as written." Mirrors the Go SDK's
// TestSynthesizeInterface_ContentOnlyEmbedsSource.
describe("AsyncAPISynthesizer content-fed synthesis", () => {
  it("returns the deterministic source-less scaffold", async () => {
    await expect(new AsyncAPISynthesizer().synthesizeInterface({ name: "scaffold" })).resolves.toEqual({
      openbindings: "0.2.0", name: "scaffold", operations: {},
    });
  });

  it("refuses a process-local path rather than introducing a Node dependency", async () => {
    await expect(new AsyncAPISynthesizer().synthesizeInterface({
      sources: [{
        bindingSpec: BINDING_SPEC,
        location: "./api.json",
        embed: true,
      }],
    })).rejects.toThrow(/process-local authoring path.*embedded content.*absolute artifact URI/);
  });

  it("embeds the provided content verbatim when the source has no location", async () => {
    const content = '{"asyncapi":"3.0.0","info":{"title":"T","version":"1.0.0"},"operations":{}}';
    const iface = await new AsyncAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content }],
    });

    const src = iface.sources?.[DEFAULT_SOURCE_NAME];
    expect(src).toBeDefined();
    expect(src!.location).toBeUndefined();
    expect(src!.content).toBe(content);
  });

  it("retains authoritative content even when the source also has a provenance location", async () => {
    const content = '{"asyncapi":"3.0.0","info":{"title":"T","version":"1.0.0"},"operations":{}}';

    const iface = await new AsyncAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, location: "https://example.com/spec.json", content }],
    });

    const src = iface.sources?.[DEFAULT_SOURCE_NAME];
    expect(src?.location).toBe("https://example.com/spec.json");
    expect(src?.content).toBe(content);
  });

  it("preserves object-form authoritative content as an object", async () => {
    const content = { asyncapi: "3.0.0", info: { title: "T", version: "1.0.0" }, operations: {} };
    const iface = await new AsyncAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC, content }],
    });
    expect(iface.sources?.[DEFAULT_SOURCE_NAME]?.content).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// R2.b ruling: oauth2 requirements carry authorizeUrl/tokenUrl/scopes and
// grantType naming the SELECTED flow, per the SAME fixed priority as the
// openapi format (authorizationCode > implicit > password > clientCredentials).
// ---------------------------------------------------------------------------

/** Builds a one-operation AsyncAPI 3.0 spec with a single oauth2 scheme, addressed via $ref (so `name` resolves too). */
function oauth2Spec(flows: Record<string, unknown>) {
  return {
    asyncapi: "3.0.0",
    info: { title: "OAuth", version: "1.0.0" },
    servers: { prod: { host: "api.example.com", protocol: "https" } },
    channels: { pub: { address: "/pub", messages: { Msg: { payload: { type: "object" } } } } },
    operations: {
      publish: {
        action: "send" as const,
        channel: { $ref: "#/channels/pub" },
        security: [{ $ref: "#/components/securitySchemes/oauth" }],
      },
    },
    components: { securitySchemes: { oauth: { type: "oauth2", flows } } },
  };
}

describe("context requirements — oauth2 flows (R2.b ruling)", () => {
  it("carries tokenUrl/scopes and grantType client_credentials for a token-only flow", async () => {
    const spec = oauth2Spec({
      clientCredentials: {
        tokenUrl: "https://auth.example.com/token",
        scopes: { read: "Read" },
      },
    });
    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
    });
    expect(details).toMatchObject({
      target: "https://api.example.com",
      alternatives: [
        {
          requirements: [
            {
              type: "auth.oauth2",
              name: "oauth",
              tokenUrl: "https://auth.example.com/token",
              scopes: ["read"],
              grantType: "client_credentials",
            },
          ],
        },
      ],
    });
  });

  it("prefers password over clientCredentials by fixed priority, not declaration order", async () => {
    const spec = oauth2Spec({
      clientCredentials: { tokenUrl: "https://auth.example.com/cc/token" },
      password: { tokenUrl: "https://auth.example.com/pw/token" },
    });
    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
    });
    expect(details).toMatchObject({
      alternatives: [
        {
          requirements: [
            { type: "auth.oauth2", tokenUrl: "https://auth.example.com/pw/token", grantType: "password" },
          ],
        },
      ],
    });
  });

  it("prefers authorizationCode over every other flow when multiple are declared", async () => {
    const spec = oauth2Spec({
      clientCredentials: { tokenUrl: "https://auth.example.com/cc/token" },
      password: { tokenUrl: "https://auth.example.com/pw/token" },
      implicit: { authorizationUrl: "https://auth.example.com/implicit/authorize" },
      authorizationCode: {
        authorizationUrl: "https://auth.example.com/authorize",
        tokenUrl: "https://auth.example.com/authcode/token",
      },
    });
    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
    });
    expect(details).toMatchObject({
      alternatives: [
        {
          requirements: [
            {
              type: "auth.oauth2",
              authorizeUrl: "https://auth.example.com/authorize",
              tokenUrl: "https://auth.example.com/authcode/token",
              grantType: "authorization_code",
            },
          ],
        },
      ],
    });
  });

  it("carries no grantType when the scheme declares no flows", async () => {
    const spec = oauth2Spec({});
    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
    });
    const req = (details as { alternatives: Array<{ requirements: Array<Record<string, unknown>> }> })
      .alternatives.at(0)?.requirements.at(0);
    if (!req) throw new Error("expected a requirement in the first alternative");
    expect(req).not.toHaveProperty("grantType");
  });
});

// ---------------------------------------------------------------------------
// R2.c ruling: unmapped schemes are SURFACED as typed requirements instead
// of silently dropped, so the alternative stays discoverable and a document
// whose every alternative is unmappable still produces a pre-dispatch
// CONTEXT_REQUIRED challenge instead of dispatching unauthenticated.
// ---------------------------------------------------------------------------

describe("context requirements — unmapped schemes surfaced (R2.c ruling)", () => {
  it("surfaces an unmapped http scheme as auth.http.<scheme>, named via $ref", async () => {
    const spec = {
      asyncapi: "3.0.0",
      info: { title: "Digest", version: "1.0.0" },
      servers: { prod: { host: "api.example.com", protocol: "https" } },
      channels: { pub: { address: "/pub", messages: { Msg: { contentType: "application/json", payload: { type: "object" } } } } },
      operations: {
        publish: {
          action: "send" as const,
          channel: { $ref: "#/channels/pub" },
          security: [{ $ref: "#/components/securitySchemes/digestAuth" }],
        },
      },
      components: { securitySchemes: { digestAuth: { type: "http", scheme: "digest" } } },
    };
    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
    });
    expect(details).toMatchObject({
      alternatives: [{ requirements: [{ type: "auth.http.digest", name: "digestAuth" }] }],
    });
  });

  it("maps SCRAM to abstract username/password context while surfacing X509", async () => {
    const spec = {
      asyncapi: "3.0.0",
      info: { title: "Multi", version: "1.0.0" },
      servers: { prod: { host: "api.example.com", protocol: "https" } },
      channels: { pub: { address: "/pub", messages: { Msg: { contentType: "application/json", payload: { type: "object" } } } } },
      operations: {
        publish: {
          action: "send" as const,
          channel: { $ref: "#/channels/pub" },
          security: [{ type: "scramSha256" }, { type: "X509" }],
        },
      },
    };
    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
    });
    expect(details).toMatchObject({
      alternatives: [
        { requirements: [{ type: "auth.basic" }] },
        { requirements: [{ type: "auth.X509" }] },
      ],
    });
    // Both declared inline (no $ref): no addressable name.
    const alts = (details as { alternatives: Array<{ requirements: Array<Record<string, unknown>> }> })
      .alternatives;
    const req0 = alts.at(0)?.requirements.at(0);
    const req1 = alts.at(1)?.requirements.at(0);
    if (!req0 || !req1) throw new Error("expected a requirement in each alternative");
    expect(req0).not.toHaveProperty("name");
    expect(req1).not.toHaveProperty("name");
  });

  it("surfaces a genuinely unmapped scheme type verbatim as auth.<type>", async () => {
    const spec = {
      asyncapi: "3.0.0",
      info: { title: "Future", version: "1.0.0" },
      servers: { prod: { host: "api.example.com", protocol: "https" } },
      channels: { pub: { address: "/pub", messages: { Msg: { contentType: "application/json", payload: { type: "object" } } } } },
      operations: {
        publish: {
          action: "send" as const,
          channel: { $ref: "#/channels/pub" },
          security: [{ type: "futureSasl" }],
        },
      },
    };
    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
    });
    expect(details).toMatchObject({ alternatives: [{ requirements: [{ type: "auth.futureSasl" }] }] });
  });

  it("a document whose EVERY alternative is unmappable challenges CONTEXT_REQUIRED before dispatch, instead of a blind 401", async () => {
    const spec = {
      asyncapi: "3.0.0",
      info: { title: "AllUnmapped", version: "1.0.0" },
      servers: { prod: { host: "api.example.com", protocol: "https" } },
      channels: { pub: { address: "/pub", messages: { Msg: { contentType: "application/json", payload: { type: "object" } } } } },
      operations: {
        publish: {
          action: "receive" as const,
          channel: { $ref: "#/channels/pub" },
          bindings: { http: { method: "POST", bindingVersion: "0.3.0" } },
          security: [{ type: "http", scheme: "digest" }, { type: "X509" }],
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new AsyncAPIInvoker().invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
      fetch,
    });
    await call.write({});
    await expect(call.closed).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      data: {
        alternatives: [
          { requirements: [{ type: "auth.http.digest" }] },
          { requirements: [{ type: "auth.X509" }] },
        ],
      },
    });
    // Pre-dispatch: previously these unmapped schemes were dropped entirely
    // (alternatives.length === 0), so requiredContext returned null and the
    // publish WOULD have dispatched here with no credentials at all.
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ASYNC-P-07: server and operation security are CONJUNCTIVE — the targeted
// server's list applies, and the operation's, when declared, applies in
// addition; within each list one entry suffices (cross-product alternatives).
// ---------------------------------------------------------------------------

describe("context requirements — conjunctive server + operation security (ASYNC-P-07)", () => {
  function conjunctiveSpec(opSecurity: unknown[]) {
    return {
      asyncapi: "3.0.0",
      info: { title: "Conjunctive", version: "1.0.0" },
      servers: {
        prod: {
          host: "api.example.com",
          protocol: "https",
          security: [{ $ref: "#/components/securitySchemes/bearer" }],
        },
      },
      channels: { pub: { address: "/pub", messages: { Msg: { contentType: "application/json", payload: { type: "object" } } } } },
      operations: {
        publish: {
          action: "receive" as const,
          channel: { $ref: "#/channels/pub" },
          bindings: { http: { method: "POST", bindingVersion: "0.3.0" } },
          security: opSecurity,
        },
      },
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer" },
          key: { type: "httpApiKey", in: "query", name: "k" },
        },
      },
    };
  }

  it("pairs the server entry with the operation entry in one conjunctive alternative", async () => {
    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: conjunctiveSpec([{ $ref: "#/components/securitySchemes/key" }]) },
      ref: "#/operations/publish",
    });
    expect(details?.alternatives).toHaveLength(1);
    expect(details).toMatchObject({
      alternatives: [{ requirements: [{ type: "auth.bearer" }, { type: "auth.apiKey", name: "key" }] }],
    });
  });

  it("neither credential alone satisfies; both together do", async () => {
    const spec = conjunctiveSpec([{ $ref: "#/components/securitySchemes/key" }]);
    const bearerOnly = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
      context: { bearerToken: "t" },
    });
    expect(bearerOnly).not.toBeNull();

    const keyOnly = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
      context: { apiKeys: { key: "k-1" } },
    });
    expect(keyOnly).not.toBeNull();

    const both = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
      context: { bearerToken: "t", apiKeys: { key: "k-1" } },
    });
    expect(both).toBeNull();

    const named = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
      context: { credentials: { bearer: "t", key: "k-1" } },
    });
    expect(named).toBeNull();
  });

  it("a scheme declared on both levels is one requirement, not a duplicated conjunct", async () => {
    const details = await new AsyncAPIInvoker().prepareBinding({
      source: { bindingSpec: BINDING_SPEC, content: conjunctiveSpec([{ $ref: "#/components/securitySchemes/bearer" }]) },
      ref: "#/operations/publish",
    });
    expect(details?.alternatives).toHaveLength(1);
    expect(details?.alternatives[0]!.requirements).toHaveLength(1);
    expect(details?.alternatives[0]!.requirements[0]).toMatchObject({ type: "auth.bearer" });
  });
});

// ---------------------------------------------------------------------------
// R2.d ruling: apiKeys keyed lookup in credential application — two apiKey
// schemes with different addressable names, placed in different wire
// locations, resolve to distinct keys via the apiKeys map.
// ---------------------------------------------------------------------------

describe("credential application — apiKeys keyed lookup (R2.d ruling)", () => {
  it("distinguishes two apiKey schemes by name via the apiKeys map, placing each in its own wire location", async () => {
    const spec = {
      asyncapi: "3.0.0",
      info: { title: "TwoKeys", version: "1.0.0" },
      servers: { prod: { host: "api.example.com", protocol: "https" } },
      channels: { pub: { address: "/pub", messages: { Msg: { contentType: "application/json", payload: { type: "object" } } } } },
      operations: {
        publish: {
          action: "receive" as const,
          channel: { $ref: "#/channels/pub" },
          bindings: { http: { method: "POST", bindingVersion: "0.3.0" } },
          reply: { messages: [{ name: "Reply", contentType: "application/json" }] },
          security: [
            { $ref: "#/components/securitySchemes/headerKey" },
            { $ref: "#/components/securitySchemes/queryKey" },
          ],
        },
      },
      components: {
        securitySchemes: {
          headerKey: { type: "apiKey", in: "header", name: "X-Header-Key" },
          queryKey: { type: "apiKey", in: "query", name: "api_key" },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new AsyncAPIInvoker().invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec },
      ref: "#/operations/publish",
      context: { apiKeys: { headerKey: "hk-1", queryKey: "qk-1" } },
      fetch,
    });
    await call.write({});
    await single(call.outputs);
    expect(requests.at(0)?.headers.get("X-Header-Key")).toBe("hk-1");
    expect(requests.at(0)?.url).toBe("https://api.example.com/pub?api_key=qk-1");
  });
});

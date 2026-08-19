/**
 * Binding execution context (BEC) tests: the context store, the well-known
 * context helpers, and the store-backed CONTEXT_REQUIRED resolver that
 * composes the binding-invoker and context-store roles.
 */
import { describe, it, expect, vi } from "vitest";
import {
  normalizeContextKey,
  normalizeEndpoint,
  contextBearerToken,
  contextBearerTokenFor,
  contextApiKey,
  contextApiKeyFor,
  contextBasicAuth,
  contextBasicAuthFor,
  contextAccessTokenFor,
  contextString,
  contextAnonymous,
  buildAuthHeaders,
  contextSatisfies,
  storeContextResolver,
  OperationInvoker,
  InvocationImpl,
  single,
  operationSignature,
} from "./index.js";
import type {
  ContextStore,
  BindingInvoker,
  BindingInvocationArgs,
  ContextRequiredDetails,
  Invocation,
  OBInterface,
} from "./index.js";

// Minimal in-memory ContextStore for exercising the store-backed resolver.
// Storage backing is the consuming tool's job, so the SDK ships only the
// ContextStore interface; tests supply their own.
class MemoryStore implements ContextStore {
  private data = new Map<string, Record<string, unknown>>();

  async get(key: string): Promise<Record<string, unknown> | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: Record<string, unknown> | null): Promise<void> {
    if (value == null) {
      this.data.delete(key);
      return;
    }
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

// ---------------------------------------------------------------------------
// normalizeContextKey
// ---------------------------------------------------------------------------

describe("normalizeContextKey", () => {
  it.each([
    ["https://api.example.com/v1/users", "api.example.com"],
    ["http://api.example.com/v1", "api.example.com"],
    ["https://api.example.com", "api.example.com"],
    ["ws://api.example.com:8080/stream", "api.example.com:8080"],
    ["wss://api.example.com", "api.example.com"],
    ["grpc://localhost:50051/svc", "localhost:50051"],
    ["localhost:50051", "localhost:50051"],
    ["", ""],
    ["  https://api.example.com/path  ", "api.example.com"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizeContextKey(input)).toBe(expected);
  });

  // An explicit port matching the scheme's default is elided so a key
  // written with the default port and one written without it collide — the
  // origin is the same, so credentials stored under one must be found via
  // the other. A non-default port, and any string with no scheme (a
  // format-defined address like gRPC's bare "host:port"), are returned
  // unchanged. IPv6 hosts are covered so the bracketed form isn't corrupted
  // by the suffix-strip.
  it.each([
    ["https://api.example.com:443", "api.example.com"],
    ["http://x:80", "x"],
    ["wss://x:443", "x"],
    ["ws://x:80", "x"],
    ["https://x:8443", "x:8443"], // non-default port kept
    ["10.0.0.1:443", "10.0.0.1:443"], // no scheme: unchanged
    ["host:50051", "host:50051"], // no scheme: unchanged
    ["https://[::1]:443", "[::1]"], // IPv6 default port elided
    ["https://[::1]:8443", "[::1]:8443"], // IPv6 non-default port kept
    ["https://[::1]", "[::1]"], // IPv6 no port, unaffected
  ])("elides an explicit default port: %s → %s", (input, expected) => {
    expect(normalizeContextKey(input)).toBe(expected);
  });

  // Pins the actual bug: a URL with an explicit default port and the same
  // URL without one must produce the IDENTICAL key.
  it.each([
    ["https://api.example.com:443", "https://api.example.com"],
    ["http://x:80", "http://x"],
    ["wss://x:443", "wss://x"],
    ["ws://x:80", "ws://x"],
  ])("%s and %s are equivalent (same key)", (withPort, withoutPort) => {
    expect(normalizeContextKey(withPort)).toBe(normalizeContextKey(withoutPort));
  });

  // The keying rule the binding-invoker README owns: normalize to the host —
  // lowercased, userinfo excluded (RFC 3986). A password in userinfo must
  // never ride into a store key (the one surface redactContext cannot reach),
  // and a case-variant host must derive the same key (DNS is case-insensitive)
  // so a credential is not silently fragmented across casings.
  it.each([
    ["https://API.example.com/v1/users", "api.example.com"],
    ["https://alice:hunter2@API.example.com/v1", "api.example.com"],
    ["https://alice:hunter2@api.example.com", "api.example.com"],
    ["https://u:p@Host.Example.COM:8443/x", "host.example.com:8443"],
    ["https://user@API.example.com:443", "api.example.com"],
    ["https://u:p@[2001:DB8::1]:8080", "[2001:db8::1]:8080"],
  ])("strips userinfo and folds case: %s → %s", (input, expected) => {
    const got = normalizeContextKey(input);
    expect(got).toBe(expected);
    expect(got).not.toContain("hunter2"); // userinfo password never in the key
  });
});

// ---------------------------------------------------------------------------
// write/read key agreement + cross-SDK contract
// ---------------------------------------------------------------------------

// The write helper (normalizeContextKey) and the read/resolver helper
// (normalizeEndpoint) must derive the IDENTICAL key for the same input across
// mixed-case hosts, userinfo-bearing URLs, and port variants — otherwise a
// credential written one way is silently never resolved. The expected VALUES
// are also the cross-SDK contract, pinned identically in the Go SDK's
// TestNormalizeKey_WriteReadAgree.
describe("normalizeContextKey / normalizeEndpoint agreement (cross-SDK)", () => {
  it.each([
    ["https://API.example.com/v1", "api.example.com"],
    ["https://alice:hunter2@API.example.com/v1", "api.example.com"],
    ["https://API.example.com:443", "api.example.com"],
    ["https://API.example.com:8443/x", "api.example.com:8443"],
    ["http://User@Host.EXAMPLE.com:80", "host.example.com"],
  ])("%s → %s from both normalizers", (input, expected) => {
    expect(normalizeContextKey(input)).toBe(expected);
    expect(normalizeEndpoint(input)).toBe(expected);
    expect(normalizeContextKey(input)).toBe(normalizeEndpoint(input));
  });
});

// ---------------------------------------------------------------------------
// normalizeEndpoint
// ---------------------------------------------------------------------------

describe("normalizeEndpoint", () => {
  // Mirrors the normalizeContextKey default-port case through
  // normalizeEndpoint — the actual runtime path storeContextResolver uses —
  // since normalizeEndpoint parses the URL first and must carry the scheme
  // through to the elision logic rather than dropping it (dropping it would
  // silently disable elision for every URL).
  it.each([
    ["https://api.example.com:443/v1", "api.example.com"],
    ["https://api.example.com/v1", "api.example.com"],
    ["http://x:80", "x"],
    ["wss://x:443/stream", "x"],
    ["https://x:8443", "x:8443"],
    ["10.0.0.1:443", "10.0.0.1:443"],
    ["host:50051", "host:50051"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizeEndpoint(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Well-known context helpers
// ---------------------------------------------------------------------------

describe("well-known context helpers", () => {
  const ctx: Record<string, unknown> = {
    bearerToken: "tok123",
    apiKey: "key456",
    basic: { username: "u", password: "p" },
    custom: "value",
  };

  it("extracts from populated context", () => {
    expect(contextBearerToken(ctx)).toBe("tok123");
    expect(contextApiKey(ctx)).toBe("key456");
    expect(contextBasicAuth(ctx)).toEqual({ username: "u", password: "p" });
    expect(contextString(ctx, "custom")).toBe("value");
  });

  it("returns empty/null from nil context", () => {
    expect(contextBearerToken(null)).toBe("");
    expect(contextApiKey(null)).toBe("");
    expect(contextBasicAuth(null)).toBeNull();
    expect(contextString(null, "custom")).toBe("");
  });

  it("returns empty/null from undefined context", () => {
    expect(contextBearerToken(undefined)).toBe("");
    expect(contextApiKey(undefined)).toBe("");
    expect(contextBasicAuth(undefined)).toBeNull();
    expect(contextString(undefined, "custom")).toBe("");
  });

  it("returns empty/null when fields are missing", () => {
    expect(contextBearerToken({})).toBe("");
    expect(contextApiKey({})).toBe("");
    expect(contextBasicAuth({})).toBeNull();
    expect(contextString({}, "custom")).toBe("");
  });

  it("resolves every standard auth family through the general named credential map", () => {
    const named = {
      credentials: {
        bearer: "bearer-named",
        key: "key-named",
        basic: { username: "named-user", password: "named-pass" },
        oauth: { accessToken: "access-named", refreshToken: "refresh-named" },
      },
    };
    expect(contextBearerTokenFor(named, "bearer")).toBe("bearer-named");
    expect(contextApiKeyFor(named, "key")).toBe("key-named");
    expect(contextBasicAuthFor(named, "basic")).toEqual({
      username: "named-user",
      password: "named-pass",
    });
    expect(contextAccessTokenFor(named, "oauth")).toBe("access-named");
  });
});

// ---------------------------------------------------------------------------
// contextApiKeyFor (R2.d ruling: named-entry-first, single-apiKey-fallback)
// ---------------------------------------------------------------------------

describe("contextApiKeyFor", () => {
  it("resolves the named entry from apiKeys when present", () => {
    const ctx = { apiKeys: { headerKey: "k1", queryKey: "k2" }, apiKey: "fallback" };
    expect(contextApiKeyFor(ctx, "headerKey")).toBe("k1");
    expect(contextApiKeyFor(ctx, "queryKey")).toBe("k2");
  });

  it("falls back to the single apiKey when the name is absent from apiKeys", () => {
    const ctx = { apiKeys: { headerKey: "k1" }, apiKey: "fallback" };
    expect(contextApiKeyFor(ctx, "otherKey")).toBe("fallback");
  });

  it("falls back to the single apiKey when no name is given", () => {
    const ctx = { apiKeys: { headerKey: "k1" }, apiKey: "fallback" };
    expect(contextApiKeyFor(ctx)).toBe("fallback");
  });

  it("falls back to the single apiKey when apiKeys is absent entirely", () => {
    expect(contextApiKeyFor({ apiKey: "fallback" }, "headerKey")).toBe("fallback");
  });

  it("returns empty when neither apiKeys nor apiKey resolves", () => {
    expect(contextApiKeyFor({}, "headerKey")).toBe("");
    expect(contextApiKeyFor(null, "headerKey")).toBe("");
    expect(contextApiKeyFor(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// contextSatisfies
// ---------------------------------------------------------------------------

// Carries a raw target URL; the resolver normalizes it to the
// "api.example.com" store key.
const BEARER_OR_APIKEY: ContextRequiredDetails = {
  target: "https://api.example.com/v1/users",
  alternatives: [
    { requirements: [{ type: "auth.bearer", durable: true }] },
    { requirements: [{ type: "auth.apiKey", durable: true }] },
  ],
};

describe("contextSatisfies", () => {
  it("satisfies via any one alternative (disjunctive)", () => {
    expect(contextSatisfies({ bearerToken: "t" }, BEARER_OR_APIKEY)).toBe(true);
    expect(contextSatisfies({ apiKey: "k" }, BEARER_OR_APIKEY)).toBe(true);
  });

  it("does not apply one flat credential to ambiguous named OR alternatives", () => {
    const details: ContextRequiredDetails = {
      target: "https://api.example.com",
      alternatives: [
        { requirements: [{ type: "auth.bearer", name: "schemeA" }] },
        { requirements: [{ type: "auth.bearer", name: "schemeB" }] },
      ],
    };
    expect(contextSatisfies({ bearerToken: "ambiguous" }, details)).toBe(false);
    expect(
      contextSatisfies({ credentials: { schemeB: "specific" } }, details),
    ).toBe(true);
  });

  it("requires every requirement within an alternative (conjunctive)", () => {
    const details: ContextRequiredDetails = {
      target: "k",
      alternatives: [
        {
          requirements: [
            { type: "auth.basic" },
            { type: "config.value", point: "server", path: "/url" },
          ],
        },
      ],
    };
    expect(contextSatisfies({ basic: { username: "u", password: "p" } }, details)).toBe(false);
    expect(
      contextSatisfies(
        {
          basic: { username: "u", password: "p" },
          configuration: { server: { url: "https://api.example.com" } },
        },
        details,
      ),
    ).toBe(true);
  });

  it("does not satisfy on empty or missing fields", () => {
    expect(contextSatisfies({}, BEARER_OR_APIKEY)).toBe(false);
    expect(contextSatisfies({ bearerToken: "" }, BEARER_OR_APIKEY)).toBe(false);
  });

  it("maps the standard auth families to their well-known fields", () => {
    expect(
      contextSatisfies({ accessToken: "a" }, {
        target: "k",
        alternatives: [{ requirements: [{ type: "auth.oauth2" }] }],
      }),
    ).toBe(true);
  });

  // An OAuth2 access token reaches the wire AS a Bearer credential, and
  // credential application already falls back to the flat bearer token when no
  // accessToken is present; the satisfaction check was the only half that
  // disagreed, which made every oauth2-declaring artifact a dead end.
  it("satisfies auth.oauth2 with a flat bearerToken, not only accessToken", () => {
    const details: ContextRequiredDetails = {
      target: "k",
      alternatives: [{ requirements: [{ type: "auth.oauth2", name: "oauth" }] }],
    };
    expect(contextSatisfies({ bearerToken: "t" }, details)).toBe(true);
    expect(contextSatisfies({ accessToken: "a" }, details)).toBe(true);
    expect(contextSatisfies({ bearerToken: "" }, details)).toBe(false);
    expect(contextSatisfies({}, details)).toBe(false);
  });

  it("does not apply a flat bearerToken to an ambiguous auth.oauth2 challenge", () => {
    // Same unambiguity gate the other auth families use: two named oauth2
    // schemes leave no way to tell which one the flat token belongs to.
    const details: ContextRequiredDetails = {
      target: "k",
      alternatives: [
        { requirements: [{ type: "auth.oauth2", name: "schemeA" }] },
        { requirements: [{ type: "auth.oauth2", name: "schemeB" }] },
      ],
    };
    expect(contextSatisfies({ bearerToken: "ambiguous" }, details)).toBe(false);
    expect(contextSatisfies({ accessToken: "ambiguous" }, details)).toBe(false);
    expect(
      contextSatisfies({ credentials: { schemeB: { accessToken: "specific" } } }, details),
    ).toBe(true);
  });

  it("requires distinct named credentials for repeated standard families in one alternative", () => {
    const details: ContextRequiredDetails = {
      target: "k",
      alternatives: [{ requirements: [
        { type: "auth.bearer", name: "first" },
        { type: "auth.bearer", name: "second" },
      ] }],
    };
    expect(contextSatisfies({ bearerToken: "one-token" }, details)).toBe(false);
    expect(contextSatisfies({ credentials: { first: "one", second: "two" } }, details)).toBe(true);
  });

  it("interprets an empty config.value path as the whole configuration point", () => {
    const details: ContextRequiredDetails = {
      target: "k",
      alternatives: [{ requirements: [
        { type: "config.value", point: "address", path: "" },
      ] }],
    };
    expect(contextSatisfies({ configuration: { address: "orders/{id}" } }, details)).toBe(true);
    expect(contextSatisfies({ configuration: { address: { value: "orders/{id}" } } }, details)).toBe(true);
  });

  // R2.d ruling: two ANDed auth.apiKey requirements are distinguished by
  // `name`, keying into the well-known `apiKeys` map rather than colliding
  // on the single `apiKey` field.
  it("satisfies two named auth.apiKey requirements via apiKeys, not the flat apiKey field", () => {
    const details: ContextRequiredDetails = {
      target: "k",
      alternatives: [
        {
          requirements: [
            { type: "auth.apiKey", name: "headerKey" },
            { type: "auth.apiKey", name: "queryKey" },
          ],
        },
      ],
    };
    expect(contextSatisfies({ apiKeys: { headerKey: "k1", queryKey: "k2" } }, details)).toBe(true);
    // Only one of the two named keys present: the AND is not satisfied.
    expect(contextSatisfies({ apiKeys: { headerKey: "k1" } }, details)).toBe(false);
    // No apiKeys map and no flat apiKey: unsatisfied.
    expect(contextSatisfies({}, details)).toBe(false);
  });

  // R2.c ruling: an unrecognized requirement type is unsatisfiable by the
  // built-in check — no resolver at this layer, no invented satisfaction
  // convention — so an alternative carrying one is never selectable here,
  // even though the invoker surfaces it (so the alternative stays
  // discoverable to a runtime that DOES have a resolver for it).
  it("never satisfies an unrecognized (surfaced-but-unmapped) requirement type", () => {
    const details: ContextRequiredDetails = {
      target: "k",
      alternatives: [{ requirements: [{ type: "auth.http.digest", name: "digestAuth" }] }],
    };
    expect(contextSatisfies({}, details)).toBe(false);
    // Even a context that happens to carry every other well-known
    // credential field cannot satisfy a family with no resolver.
    expect(
      contextSatisfies(
        { bearerToken: "t", apiKey: "k", basic: { username: "u", password: "p" }, accessToken: "a" },
        details,
      ),
    ).toBe(false);
    // The reserved auth namespace does not acquire an implicit satisfaction
    // convention merely because consumer context contains a same-named field.
    // A binding-specific resolver must understand the family before it can
    // select the alternative.
    expect(contextSatisfies({ "auth.http.digest": "present" }, details)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Anonymous invocation
// ---------------------------------------------------------------------------

describe("contextAnonymous", () => {
  it("reads only a literal boolean true", () => {
    expect(contextAnonymous({ anonymous: true })).toBe(true);
    expect(contextAnonymous({ anonymous: false })).toBe(false);
    // A truthy non-boolean is not the assertion: asserting anonymity is an
    // explicit act, so a stray string or number must not stand in for it.
    expect(contextAnonymous({ anonymous: "true" })).toBe(false);
    expect(contextAnonymous({ anonymous: 1 })).toBe(false);
    expect(contextAnonymous({})).toBe(false);
    expect(contextAnonymous(null)).toBe(false);
    expect(contextAnonymous(undefined)).toBe(false);
  });

  it("is a top-level field, not a configuration point", () => {
    // `anonymous` qualifies the whole invocation and sits beside
    // `configuration`; nesting it inside is not the assertion.
    expect(contextAnonymous({ configuration: { anonymous: true } })).toBe(false);
  });
});

describe("contextSatisfies under an anonymous invocation", () => {
  it("answers an auth requirement with no credential present", () => {
    expect(contextSatisfies({ anonymous: true }, BEARER_OR_APIKEY)).toBe(true);
  });

  it("answers every auth.* family, including one with no built-in resolver", () => {
    // The rule is the `auth.` prefix, not the standard family table: a
    // surfaced-but-unmapped credential family is still a credential family,
    // and "I have none" is a truthful answer to it.
    for (const type of ["auth.bearer", "auth.apiKey", "auth.basic", "auth.oauth2", "auth.http.digest"]) {
      expect(
        contextSatisfies({ anonymous: true }, {
          target: "k",
          alternatives: [{ requirements: [{ type, name: "scheme" }] }],
        }),
      ).toBe(true);
    }
  });

  it("answers ANDed named auth requirements one flat credential could not", () => {
    const details: ContextRequiredDetails = {
      target: "k",
      alternatives: [{ requirements: [
        { type: "auth.bearer", name: "first" },
        { type: "auth.bearer", name: "second" },
      ] }],
    };
    expect(contextSatisfies({ anonymous: true }, details)).toBe(true);
  });

  it("never answers a config.value requirement", () => {
    // Which server to talk to, which request media to send: not credentials,
    // and there is no anonymous reading of them.
    const details: ContextRequiredDetails = {
      target: "k",
      alternatives: [{ requirements: [{ type: "config.value", point: "server", path: "/url" }] }],
    };
    expect(contextSatisfies({ anonymous: true }, details)).toBe(false);
  });

  it("still has to answer the configuration half of a mixed alternative", () => {
    const details: ContextRequiredDetails = {
      target: "k",
      alternatives: [{ requirements: [
        { type: "auth.basic" },
        { type: "config.value", point: "server", path: "/url" },
      ] }],
    };
    expect(contextSatisfies({ anonymous: true }, details)).toBe(false);
    expect(
      contextSatisfies(
        { anonymous: true, configuration: { server: { url: "https://api.example.com" } } },
        details,
      ),
    ).toBe(true);
  });

  it("does not answer a non-auth extension requirement", () => {
    const details: ContextRequiredDetails = {
      target: "k",
      alternatives: [{ requirements: [{ type: "transport.session" }] }],
    };
    expect(contextSatisfies({ anonymous: true }, details)).toBe(false);
  });

  it("is not asserted by a merely truthy value", () => {
    expect(contextSatisfies({ anonymous: "yes" }, BEARER_OR_APIKEY)).toBe(false);
    expect(contextSatisfies({ anonymous: false }, BEARER_OR_APIKEY)).toBe(false);
  });
});

describe("buildAuthHeaders", () => {
  it("derives Authorization from the well-known credential fields", () => {
    expect(buildAuthHeaders({ bearerToken: "t" })["Authorization"]).toBe("Bearer t");
    expect(buildAuthHeaders({ apiKey: "k" })["Authorization"]).toBe("ApiKey k");
    expect(buildAuthHeaders({ basic: { username: "u", password: "p" } })["Authorization"])
      .toBe(`Basic ${btoa("u:p")}`);
  });

  // The security-relevant half of the anonymity assertion: it has to reach the
  // wire, not only the negotiation. A credential left in context by an earlier
  // call must not ride along on an invocation the caller declared anonymous.
  it("derives no credential at all under an anonymous invocation", () => {
    const stale = {
      anonymous: true,
      bearerToken: "left-over-from-an-earlier-call",
      apiKey: "left-over-key",
      accessToken: "left-over-access-token",
      basic: { username: "u", password: "p" },
    };
    const headers = buildAuthHeaders(stale);
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["Cookie"]).toBeUndefined();
    // Nothing derived from a credential field reaches any header, under any
    // name — not just the one Authorization slot.
    const emitted = JSON.stringify(headers);
    for (const secret of ["left-over-from-an-earlier-call", "left-over-key", "left-over-access-token", btoa("u:p")]) {
      expect(emitted).not.toContain(secret);
    }
  });

  it("still merges headers and cookies the caller placed by hand", () => {
    // Those are carriage the caller supplied explicitly, not credentials this
    // helper derived, so anonymity does not silently drop them.
    const headers = buildAuthHeaders({
      anonymous: true,
      bearerToken: "derived-and-suppressed",
      headers: { "X-Trace": "abc" },
      cookies: { session: "s1" },
    });
    expect(headers["X-Trace"]).toBe("abc");
    expect(headers["Cookie"]).toBe("session=s1");
    expect(headers["Authorization"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// storeContextResolver (binding-invoker ∘ context-store composition)
// ---------------------------------------------------------------------------

describe("storeContextResolver", () => {
  it("normalizes the challenge target to the store key and returns satisfying context", async () => {
    const store = new MemoryStore();
    // Stored under the normalized host; the raw target carries scheme + path.
    await store.set("api.example.com", { bearerToken: "stored-tok" });
    const resolve = storeContextResolver(store);
    await expect(resolve(BEARER_OR_APIKEY)).resolves.toEqual({ bearerToken: "stored-tok" });
  });

  it("declines when nothing is stored under the key", async () => {
    const resolve = storeContextResolver(new MemoryStore());
    await expect(resolve(BEARER_OR_APIKEY)).resolves.toBeNull();
  });

  it("declines when the stored context cannot satisfy any alternative", async () => {
    const store = new MemoryStore();
    await store.set("api.example.com", { unrelated: "field" });
    const resolve = storeContextResolver(store);
    await expect(resolve(BEARER_OR_APIKEY)).resolves.toBeNull();
  });

  it.each([undefined, false])(
    "does not reuse stored context when durable is %s",
    async (durable) => {
      const store = new MemoryStore();
      await store.set("api.example.com", { bearerToken: "stored-tok" });
      const resolve = storeContextResolver(store);
      const details: ContextRequiredDetails = {
        target: "https://api.example.com/v1",
        alternatives: [
          {
            requirements: [
              {
                type: "auth.bearer",
                ...(durable === undefined ? {} : { durable }),
              },
            ],
          },
        ],
      };
      await expect(resolve(details)).resolves.toBeNull();
    },
  );

  it("selects only a wholly durable alternative", async () => {
    const store = new MemoryStore();
    await store.set("api.example.com", {
      bearerToken: "must-not-reuse",
      apiKey: "reusable",
    });
    const resolve = storeContextResolver(store);
    const details: ContextRequiredDetails = {
      target: "https://api.example.com/v1",
      alternatives: [
        { requirements: [{ type: "auth.bearer", durable: false }] },
        { requirements: [{ type: "auth.apiKey", durable: true }] },
      ],
    };
    await expect(resolve(details)).resolves.toEqual({ apiKey: "reusable" });
  });

  it("does not partially reuse a mixed-durability AND-set", async () => {
    const store = new MemoryStore();
    await store.set("api.example.com", {
      bearerToken: "stored",
      configuration: { approval: { value: "yes" } },
    });
    const resolve = storeContextResolver(store);
    const details: ContextRequiredDetails = {
      target: "https://api.example.com/v1",
      alternatives: [
        {
          requirements: [
            { type: "auth.bearer", durable: true },
            {
              type: "config.value",
              durable: false,
              point: "approval",
              path: "",
            },
          ],
        },
      ],
    };
    await expect(resolve(details)).resolves.toBeNull();
  });

  // Integration-flavored proof: a credential stored under a target written
  // WITHOUT the scheme's default port must be found when the challenge
  // target is written WITH it (and vice versa), through the actual
  // store-backed resolution path — before this fix the two forms produced
  // different store keys and the credential was silently missed.
  it("resolves a credential stored without the port when challenged with the explicit default port", async () => {
    const store = new MemoryStore();
    // A different binding source once wrote the credential keyed off a
    // target with no explicit port.
    await store.set(normalizeEndpoint("https://api.example.com/v1/users"), {
      bearerToken: "stored-tok",
    });
    const resolve = storeContextResolver(store);
    const details: ContextRequiredDetails = {
      target: "https://api.example.com:443/v1/users",
      alternatives: [{ requirements: [{ type: "auth.bearer", durable: true }] }],
    };
    await expect(resolve(details)).resolves.toEqual({ bearerToken: "stored-tok" });
  });

  it("resolves a credential stored with the explicit default port when challenged without it", async () => {
    const store = new MemoryStore();
    // The reverse: the credential was written keyed off a target that
    // spelled out the default port explicitly.
    await store.set(normalizeEndpoint("https://api.example.com:443/v1/users"), {
      bearerToken: "stored-tok",
    });
    const resolve = storeContextResolver(store);
    const details: ContextRequiredDetails = {
      target: "https://api.example.com/v1/users",
      alternatives: [{ requirements: [{ type: "auth.bearer", durable: true }] }],
    };
    await expect(resolve(details)).resolves.toEqual({ bearerToken: "stored-tok" });
  });
});

// ---------------------------------------------------------------------------
// Context flow through the operation invoker
// ---------------------------------------------------------------------------

function echoContextInvoker(seen: (Record<string, unknown> | undefined)[]): BindingInvoker {
  return {
    bindingSpecs: () => [{ bindingSpec: "mock@1.0" }],
    invokeBinding<I, O>(args: BindingInvocationArgs): Invocation<I, O> {
      const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
      seen.push(args.context);
      queueMicrotask(async () => {
        void inv.closeInput();
        await inv.emitOutput({ ok: true });
        inv.closeOutput();
      });
      return inv as Invocation<I, O>;
    },
  };
}

const iface: OBInterface = {
  openbindings: "0.2.0",
  operations: { ping: {} },
  sources: { mock: { bindingSpec: "mock@1.0", location: "mem://" } },
  bindings: { "ping.main": { operation: "ping", source: "mock", ref: "ping" } },
};

describe("context flow", () => {
  it("per-call context reaches the binding invoker as-is", async () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    const op = new OperationInvoker([echoContextInvoker(seen)]);
    const ctx = { bearerToken: "tok", tenant: "acme" };
    await single(op.invoke(iface, operationSignature("ping"), { context: ctx }).outputs);
    expect(seen[0]).toEqual(ctx);
  });

  it("withRuntime swaps the resolver without re-combining invokers", async () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    const base = new OperationInvoker([echoContextInvoker(seen)]);
    const resolver = vi.fn(async () => null);
    const scoped = base.withRuntime(resolver);
    await single(scoped.invoke(iface, operationSignature("ping")).outputs);
    expect(scoped.contextResolver).toBe(resolver);
    expect(base.contextResolver).toBeUndefined();
    expect(seen).toHaveLength(1); // shared registry still routes
  });

  it("bindingSpecs() returns a defensive copy", () => {
    const op = new OperationInvoker([echoContextInvoker([])]);
    const a = op.bindingSpecs();
    a.push({ bindingSpec: "junk@0.0" });
    expect(op.bindingSpecs()).toHaveLength(1);
  });
});

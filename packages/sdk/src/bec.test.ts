/**
 * Binding execution context (BEC) tests: the context store, the well-known
 * context helpers, and the store-backed CONTEXT_REQUIRED resolver that
 * composes the binding-invoker and context-store roles.
 */
import { describe, it, expect, vi } from "vitest";
import {
  MemoryStore,
  normalizeContextKey,
  contextBearerToken,
  contextApiKey,
  contextBasicAuth,
  contextString,
  contextSatisfies,
  storeContextResolver,
  OperationInvoker,
  InvocationImpl,
  single,
} from "./index.js";
import type {
  BindingInvoker,
  BindingInvocationArgs,
  ContextRequiredDetails,
  Invocation,
  OBInterface,
} from "./index.js";

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

describe("MemoryStore", () => {
  it("get/set/delete basics", async () => {
    const store = new MemoryStore();

    expect(await store.get("missing")).toBeNull();

    await store.set("k1", { bearerToken: "abc" });
    expect(await store.get("k1")).toEqual({ bearerToken: "abc" });

    await store.delete("k1");
    expect(await store.get("k1")).toBeNull();
  });

  it("set null deletes", async () => {
    const store = new MemoryStore();
    await store.set("k1", { bearerToken: "abc" });
    await store.set("k1", null);
    expect(await store.get("k1")).toBeNull();
  });

  it("deep copy isolation — mutating returned value doesn't affect store", async () => {
    const store = new MemoryStore();
    await store.set("k1", { nested: { value: "original" } });

    const got = (await store.get("k1"))!;
    (got["nested"] as Record<string, unknown>)["value"] = "mutated";

    const fresh = (await store.get("k1"))!;
    expect((fresh["nested"] as Record<string, unknown>)["value"]).toBe("original");
  });

  it("deep copy isolation — mutating input after set doesn't affect store", async () => {
    const store = new MemoryStore();
    const input: Record<string, unknown> = { nested: { value: "original" } };
    await store.set("k1", input);
    (input["nested"] as Record<string, unknown>)["value"] = "mutated";

    const got = (await store.get("k1"))!;
    expect((got["nested"] as Record<string, unknown>)["value"]).toBe("original");
  });
});

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
});

// ---------------------------------------------------------------------------
// contextSatisfies
// ---------------------------------------------------------------------------

const BEARER_OR_APIKEY: ContextRequiredDetails = {
  key: "api.example.com",
  alternatives: [
    { requirements: [{ type: "auth.bearer" }] },
    { requirements: [{ type: "auth.apiKey" }] },
  ],
};

describe("contextSatisfies", () => {
  it("satisfies via any one alternative (disjunctive)", () => {
    expect(contextSatisfies({ bearerToken: "t" }, BEARER_OR_APIKEY)).toBe(true);
    expect(contextSatisfies({ apiKey: "k" }, BEARER_OR_APIKEY)).toBe(true);
  });

  it("requires every requirement within an alternative (conjunctive)", () => {
    const details: ContextRequiredDetails = {
      key: "k",
      alternatives: [
        { requirements: [{ type: "auth.basic" }, { type: "config.value" }] },
      ],
    };
    expect(contextSatisfies({ basic: { username: "u", password: "p" } }, details)).toBe(false);
    expect(
      contextSatisfies(
        { basic: { username: "u", password: "p" }, "config.value": "x" },
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
        key: "k",
        alternatives: [{ requirements: [{ type: "auth.oauth2" }] }],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// storeContextResolver (binding-invoker ∘ context-store composition)
// ---------------------------------------------------------------------------

describe("storeContextResolver", () => {
  it("returns stored context that satisfies the challenge", async () => {
    const store = new MemoryStore();
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
});

// ---------------------------------------------------------------------------
// Context flow through the operation invoker
// ---------------------------------------------------------------------------

function echoContextInvoker(seen: (Record<string, unknown> | undefined)[]): BindingInvoker {
  return {
    formats: () => [{ token: "mock@1.0" }],
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
  sources: { mock: { format: "mock@1.0", location: "mem://" } },
  bindings: { "ping.main": { operation: "ping", source: "mock", ref: "ping" } },
};

describe("context flow", () => {
  it("per-call context reaches the binding invoker as-is", async () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    const op = new OperationInvoker([echoContextInvoker(seen)]);
    const ctx = { bearerToken: "tok", tenant: "acme" };
    await single(op.invoke({ interface: iface, operation: "ping", context: ctx }).outputs);
    expect(seen[0]).toEqual(ctx);
  });

  it("withRuntime swaps the resolver without re-combining invokers", async () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    const base = new OperationInvoker([echoContextInvoker(seen)]);
    const resolver = vi.fn(async () => null);
    const scoped = base.withRuntime(resolver);
    await single(scoped.invoke({ interface: iface, operation: "ping" }).outputs);
    expect(scoped.contextResolver).toBe(resolver);
    expect(base.contextResolver).toBeUndefined();
    expect(seen).toHaveLength(1); // shared registry still routes
  });

  it("formats() returns a defensive copy", () => {
    const op = new OperationInvoker([echoContextInvoker([])]);
    const a = op.formats();
    a.push({ token: "junk@0.0" });
    expect(op.formats()).toHaveLength(1);
  });
});

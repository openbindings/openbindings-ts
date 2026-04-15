import { describe, it, expect, vi } from "vitest";
import {
  MemoryStore,
  normalizeContextKey,
  contextBearerToken,
  contextApiKey,
  contextBasicAuth,
  contextString,
  ContextInsufficientError,
  ResolutionUnavailableError,
  OperationExecutor,
  defaultBindingSelector,
  InterfaceClient,
  BindingNotFoundError,
} from "./index.js";
import type {
  BindingExecutor,
  ContextStore,
  PlatformCallbacks,
  BindingExecutionInput,
  ExecuteOutput,
  StreamEvent,
  OBInterface,
  FormatInfo,
} from "./index.js";

// ---------------------------------------------------------------------------
// Mock executor for BEC tests
// ---------------------------------------------------------------------------

interface MockExecutorOpts {
  formats?: FormatInfo[];
  executeFn?: (input: BindingExecutionInput) => AsyncIterable<StreamEvent>;
}

function createMockExecutor(opts: MockExecutorOpts = {}) {
  const executor: BindingExecutor = {
    formats() {
      return opts.formats ?? [{ token: "test@1.0" }];
    },
    async *executeBinding(input: BindingExecutionInput) {
      if (opts.executeFn) {
        yield* opts.executeFn(input);
        return;
      }
      yield { data: "ok" };
    },
  };
  return executor;
}

// ---------------------------------------------------------------------------
// MemoryStore tests
// ---------------------------------------------------------------------------

describe("MemoryStore", () => {
  it("get/set/delete basics", async () => {
    const store = new MemoryStore();

    expect(await store.get("missing")).toBeNull();

    await store.set("k1", { bearerToken: "abc" });
    const got = await store.get("k1");
    expect(got).toEqual({ bearerToken: "abc" });

    await store.delete("k1");
    expect(await store.get("k1")).toBeNull();
  });

  it("set null deletes", async () => {
    const store = new MemoryStore();
    await store.set("k", { x: 1 });
    await store.set("k", null);
    expect(await store.get("k")).toBeNull();
  });

  it("deep copy isolation — mutating returned value doesn't affect store", async () => {
    const store = new MemoryStore();
    await store.set("k", {
      basic: { username: "alice", password: "secret" },
    });

    const got = await store.get("k");
    (got!["basic"] as Record<string, string>)["password"] = "MUTATED";

    const got2 = await store.get("k");
    expect((got2!["basic"] as Record<string, string>)["password"]).toBe("secret");
  });

  it("deep copy isolation — mutating input after set doesn't affect store", async () => {
    const store = new MemoryStore();
    const original: Record<string, unknown> = {
      basic: { username: "alice", password: "secret" },
    };
    await store.set("k", original);

    (original["basic"] as Record<string, string>)["password"] = "MUTATED";

    const got = await store.get("k");
    expect((got!["basic"] as Record<string, string>)["password"]).toBe("secret");
  });
});

// ---------------------------------------------------------------------------
// normalizeContextKey tests
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
    basic: { username: "alice", password: "pass" },
    custom: "val",
  };

  it("extracts from populated context", () => {
    expect(contextBearerToken(ctx)).toBe("tok123");
    expect(contextApiKey(ctx)).toBe("key456");
    expect(contextBasicAuth(ctx)).toEqual({ username: "alice", password: "pass" });
    expect(contextString(ctx, "custom")).toBe("val");
  });

  it("returns empty/null from nil context", () => {
    expect(contextBearerToken(null)).toBe("");
    expect(contextApiKey(null)).toBe("");
    expect(contextBasicAuth(null)).toBeNull();
    expect(contextString(null, "x")).toBe("");
  });

  it("returns empty/null from undefined context", () => {
    expect(contextBearerToken(undefined)).toBe("");
    expect(contextApiKey(undefined)).toBe("");
    expect(contextBasicAuth(undefined)).toBeNull();
    expect(contextString(undefined, "x")).toBe("");
  });

  it("returns empty/null when fields are missing", () => {
    expect(contextBearerToken({})).toBe("");
    expect(contextBasicAuth({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OperationExecutor BEC tests
// ---------------------------------------------------------------------------

describe("OperationExecutor BEC", () => {
  it("propagates store and callbacks to executor via withRuntimeInput", async () => {
    let capturedStore: ContextStore | undefined;
    let capturedCallbacks: PlatformCallbacks | undefined;

    const executor = createMockExecutor({
      executeFn: async function* (input) {
        capturedStore = input.store;
        capturedCallbacks = input.callbacks;
        yield { data: "ok" };
      },
    });

    const store = new MemoryStore();
    const callbacks: PlatformCallbacks = {};

    const exec = new OperationExecutor([executor], {
      contextStore: store,
      platformCallbacks: callbacks,
    });

    for await (const _ of exec.executeBinding({
      source: { format: "test@1.0" },
      ref: "",
    })) { /* drain */ }

    expect(capturedStore).toBe(store);
    expect(capturedCallbacks).toBe(callbacks);
  });

  it("does not override existing store/callbacks on input", async () => {
    const existingStore = new MemoryStore();
    const existingCb: PlatformCallbacks = {};
    let capturedStore: ContextStore | undefined;
    let capturedCb: PlatformCallbacks | undefined;

    const executor = createMockExecutor({
      executeFn: async function* (input) {
        capturedStore = input.store;
        capturedCb = input.callbacks;
        yield { data: "ok" };
      },
    });

    const exec = new OperationExecutor([executor], {
      contextStore: new MemoryStore(),
      platformCallbacks: {},
    });

    for await (const _ of exec.executeBinding({
      source: { format: "test@1.0" },
      ref: "",
      store: existingStore,
      callbacks: existingCb,
    })) { /* drain */ }

    expect(capturedStore).toBe(existingStore);
    expect(capturedCb).toBe(existingCb);
  });

  it("context passes through as-is (executors resolve internally)", async () => {
    let capturedCtx: Record<string, unknown> | undefined;
    const executor = createMockExecutor({
      executeFn: async function* (input) {
        capturedCtx = input.context;
        yield { data: "ok" };
      },
    });

    const exec = new OperationExecutor([executor]);

    for await (const _ of exec.executeBinding({
      source: { format: "test@1.0" },
      ref: "",
      context: { custom: "value" },
    })) { /* drain */ }

    expect(capturedCtx).toEqual({ custom: "value" });
  });

  it("caller's input is never mutated (reusable across calls)", async () => {
    let capturedStore: ContextStore | undefined;
    const executor = createMockExecutor({
      executeFn: async function* (input) {
        capturedStore = input.store;
        yield { data: "ok" };
      },
    });

    const store = new MemoryStore();
    const exec = new OperationExecutor([executor], { contextStore: store });

    const input: BindingExecutionInput = {
      source: { format: "test@1.0" },
      ref: "",
    };

    for await (const _ of exec.executeBinding(input)) { /* drain */ }
    expect(capturedStore).toBe(store);
    expect(input.store).toBeUndefined();
    expect(input.callbacks).toBeUndefined();
  });

  it("input is reusable across multiple calls", async () => {
    let callCount = 0;
    const executor = createMockExecutor({
      executeFn: async function* (input) {
        callCount++;
        expect(input.store).toBeDefined();
        yield { data: callCount };
      },
    });

    const exec = new OperationExecutor([executor], {
      contextStore: new MemoryStore(),
    });

    const input: BindingExecutionInput = {
      source: { format: "test@1.0" },
      ref: "",
    };

    for (let i = 0; i < 3; i++) {
      for await (const _ of exec.executeBinding(input)) { /* drain */ }
    }
    expect(callCount).toBe(3);
  });

  it("formats() returns defensive copy", () => {
    const executor = createMockExecutor();
    const exec = new OperationExecutor([executor]);

    const fmts = exec.formats();
    fmts[0] = { token: "MUTATED" };

    expect(exec.formats()[0].token).toBe("test@1.0");
  });
});

// ---------------------------------------------------------------------------
// withRuntime tests
// ---------------------------------------------------------------------------

describe("OperationExecutor.withRuntime", () => {
  it("clones with overrides", () => {
    const executor = createMockExecutor();
    const orig = new OperationExecutor([executor]);
    const origStore = new MemoryStore();

    const origWithStore = new OperationExecutor([executor], {
      contextStore: origStore,
    });

    const newStore = new MemoryStore();
    const newCb: PlatformCallbacks = {};
    const clone = origWithStore.withRuntime(newStore, newCb);

    expect(clone.contextStore).toBe(newStore);
    expect(clone.platformCallbacks).toBe(newCb);
    expect(origWithStore.platformCallbacks).toBeUndefined();
    expect(clone.formats()).toEqual([{ token: "test@1.0" }]);
  });

  it("undefined inherits original", () => {
    const executor = createMockExecutor();
    const origStore = new MemoryStore();
    const origCb: PlatformCallbacks = {};
    const orig = new OperationExecutor([executor], {
      contextStore: origStore,
      platformCallbacks: origCb,
    });

    const clone = orig.withRuntime(undefined, undefined);
    expect(clone.contextStore).toBe(origStore);
    expect(clone.platformCallbacks).toBe(origCb);
  });
});

// ---------------------------------------------------------------------------
// executeBinding streaming BEC tests
// ---------------------------------------------------------------------------

describe("executeBinding streaming BEC", () => {
  it("propagates store and callbacks", async () => {
    let capturedStore: ContextStore | undefined;
    let capturedCb: PlatformCallbacks | undefined;

    const executor = createMockExecutor({
      executeFn: async function* (input) {
        capturedStore = input.store;
        capturedCb = input.callbacks;
        yield { data: "event" };
      },
    });

    const store = new MemoryStore();
    const cb: PlatformCallbacks = {};
    const exec = new OperationExecutor([executor], {
      contextStore: store,
      platformCallbacks: cb,
    });

    const iter = exec.executeBinding({
      source: { format: "test@1.0" },
      ref: "",
    });
    for await (const _ of iter) { break; }

    expect(capturedStore).toBe(store);
    expect(capturedCb).toBe(cb);
  });
});

// ---------------------------------------------------------------------------
// executeOperation BEC integration
// ---------------------------------------------------------------------------

describe("executeOperation BEC integration", () => {
  it("context flows through to executor", async () => {
    let capturedCtx: Record<string, unknown> | undefined;
    const executor = createMockExecutor({
      executeFn: async function* (input) {
        capturedCtx = input.context;
        yield { data: "ok" };
      },
    });

    const exec = new OperationExecutor([executor], { contextStore: new MemoryStore() });

    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: { getUser: { kind: "method" } },
      sources: { api: { format: "test@1.0", location: "https://api.example.com" } },
      bindings: {
        "getUser.api": { operation: "getUser", source: "api", ref: "#/paths/users/get" },
      },
    };

    for await (const _ev of exec.executeOperation({
      interface: iface,
      operation: "getUser",
      context: { bearerToken: "op-token" },
    })) { /* drain */ }

    expect(capturedCtx!["bearerToken"]).toBe("op-token");
  });
});

// ---------------------------------------------------------------------------
// InterfaceClient tests
// ---------------------------------------------------------------------------

describe("InterfaceClient", () => {
  it("close() resets state and is idempotent", () => {
    const executor = createMockExecutor();
    const exec = new OperationExecutor([executor]);

    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: {},
    };

    const client = new InterfaceClient(iface, exec);
    expect(client.state.kind).toBe("idle");

    // Resolve directly with a compatible interface
    client.resolve(iface);

    client.close();
    expect(client.state.kind).toBe("idle");
    expect(client.resolved).toBeUndefined();

    // Idempotent
    client.close();
    expect(client.state.kind).toBe("idle");
  });

  it("constructor clones executor when store/callbacks provided", async () => {
    let capturedStore: ContextStore | undefined;
    const executor = createMockExecutor({
      executeFn: async function* (input) {
        capturedStore = input.store;
        yield { data: "ok" };
      },
    });

    const origExec = new OperationExecutor([executor]);
    const store = new MemoryStore();

    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: { op: { kind: "method" } },
      sources: { s: { format: "test@1.0", location: "x" } },
      bindings: { "op.s": { operation: "op", source: "s", ref: "" } },
    };

    const client = new InterfaceClient(iface, origExec, {
      contextStore: store,
    });

    await client.resolve(iface);
    for await (const _ev of client.execute("op" as any)) { /* drain */ }

    expect(capturedStore).toBe(store);
    expect(origExec.contextStore).toBeUndefined();
  });

  it("merges default and per-call execution options", async () => {
    let capturedInput: BindingExecutionInput | undefined;
    const executor = createMockExecutor({
      executeFn: async function* (input) {
        capturedInput = input;
        yield { data: "ok" };
      },
    });

    const exec = new OperationExecutor([executor]);
    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: { op: { kind: "method" } },
      sources: { s: { format: "test@1.0", location: "x" } },
      bindings: { "op.s": { operation: "op", source: "s", ref: "" } },
    };

    const client = new InterfaceClient(iface, exec, {
      defaultOptions: {
        headers: { "X-Base": "base", "X-Override": "base" },
      },
    });

    await client.resolve(iface);
    for await (const _ev of client.execute("op" as any, undefined, {
      headers: { "X-Override": "call", "X-New": "new" },
    })) { /* drain */ }

    expect(capturedInput!.options).toEqual({
      headers: { "X-Base": "base", "X-Override": "call", "X-New": "new" },
    });
  });
});

// ---------------------------------------------------------------------------
// PlatformCallbacks tests
// ---------------------------------------------------------------------------

describe("PlatformCallbacks", () => {
  it("nil fields are graceful (no crash on check)", () => {
    const cb: PlatformCallbacks = {};
    expect(cb.prompt).toBeUndefined();
    expect(cb.confirmation).toBeUndefined();
    expect(cb.browserRedirect).toBeUndefined();
    expect(cb.fileSelect).toBeUndefined();
  });

  it("prompt integration", async () => {
    let called = false;
    const cb: PlatformCallbacks = {
      prompt: async (message, opts) => {
        called = true;
        expect(opts?.secret).toBe(true);
        return "user-input";
      },
    };

    const val = await cb.prompt!("Enter token", { label: "bearerToken", secret: true });
    expect(called).toBe(true);
    expect(val).toBe("user-input");
  });
});

// ---------------------------------------------------------------------------
// Error class tests
// ---------------------------------------------------------------------------

describe("BEC error classes", () => {
  it("ContextInsufficientError is instanceof-checkable", () => {
    const err = new ContextInsufficientError();
    expect(err).toBeInstanceOf(ContextInsufficientError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ContextInsufficientError");
    expect(err.message).toContain("context insufficient");
  });

  it("ResolutionUnavailableError is instanceof-checkable", () => {
    const err = new ResolutionUnavailableError();
    expect(err).toBeInstanceOf(ResolutionUnavailableError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ResolutionUnavailableError");
    expect(err.message).toContain("resolution not available");
  });

  it("custom messages are preserved", () => {
    const err = new ContextInsufficientError("custom msg");
    expect(err.message).toBe("custom msg");
  });
});

// ---------------------------------------------------------------------------
// defaultBindingSelector tests (BEC-adjacent)
// ---------------------------------------------------------------------------

describe("defaultBindingSelector", () => {
  it("prefers non-deprecated over deprecated", () => {
    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: { op: { kind: "method" } },
      sources: { s: { format: "test@1.0", location: "x" } },
      bindings: {
        "op.deprecated": { operation: "op", source: "s", deprecated: true, priority: 1 },
        "op.fresh": { operation: "op", source: "s", priority: 10 },
      },
    };
    const { key } = defaultBindingSelector(iface, "op");
    expect(key).toBe("op.fresh");
  });

  it("lower priority wins within same tier", () => {
    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: { op: { kind: "method" } },
      sources: { s: { format: "test@1.0", location: "x" } },
      bindings: {
        "op.high": { operation: "op", source: "s", priority: 10 },
        "op.low": { operation: "op", source: "s", priority: 1 },
      },
    };
    const { key } = defaultBindingSelector(iface, "op");
    expect(key).toBe("op.low");
  });

  it("throws BindingNotFoundError when no match", () => {
    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: { op: { kind: "method" } },
      sources: { s: { format: "test@1.0", location: "x" } },
      bindings: {
        "other.s": { operation: "other", source: "s" },
      },
    };
    expect(() => defaultBindingSelector(iface, "missing")).toThrow(BindingNotFoundError);
  });
});

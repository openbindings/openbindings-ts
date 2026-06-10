import { describe, it, expect, vi } from "vitest";
import {
  OperationInvoker,
  defaultBindingSelector,
} from "./operation-invoker.js";
import {
  InvocationImpl,
  InvocationError,
  contextRequiredError,
  single,
  type ContextRequiredDetails,
  type Invocation,
} from "./invocation.js";
import type {
  BindingInvoker,
  TransformEvaluator,
} from "./invokers.js";
import type { BindingInvocationArgs } from "./invoker-types.js";
import type { OBInterface } from "./types.js";
import {
  BindingNotFoundError,
  NoInvokerError,
  OperationNotFoundError,
  UnknownSourceError,
} from "./errors.js";
import {
  CONTEXT_REQUIRED,
  ERR_BINDING_NOT_FOUND,
  ERR_CANCELLED,
  ERR_MISSING_INPUT,
  ERR_RUNTIME,
  ERR_TRANSFORM_ERROR,
  ERR_VALIDATION_FAILED,
} from "./errcodes.js";

// ---------------------------------------------------------------------------
// Mock binding invoker (the design doc's reference mock, ref-dispatched)
// ---------------------------------------------------------------------------

const BEARER_DETAILS: ContextRequiredDetails = {
  key: "api.example.com",
  alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
};

interface MockOpts {
  token?: string;
  /** getUser challenges CONTEXT_REQUIRED when context lacks bearerToken (after reading its input). */
  requireBearer?: boolean;
  /** getUser challenges unconditionally, even with context (tests the retry cap). */
  challengeAlways?: boolean;
  /** Expose prepareBinding reporting the bearer requirement when missing. */
  preflight?: boolean;
}

class MockBindingInvoker implements BindingInvoker {
  attempts = 0;
  prepares = 0;
  /** Inputs read per attempt. */
  reads: unknown[][] = [];
  contexts: (Record<string, unknown> | undefined)[] = [];
  signals: AbortSignal[] = [];
  fetches: (typeof globalThis.fetch | undefined)[] = [];

  prepareBinding?: (args: BindingInvocationArgs) => Promise<ContextRequiredDetails | null>;

  constructor(private opts: MockOpts = {}) {
    if (opts.preflight) {
      this.prepareBinding = async (args) => {
        this.prepares++;
        return args.context?.["bearerToken"] ? null : BEARER_DETAILS;
      };
    }
  }

  formats() {
    return [{ token: this.opts.token ?? "mock@1.0" }];
  }

  invokeBinding<I, O>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    this.attempts++;
    this.contexts.push(args.context);
    this.signals.push(inv.signal);
    this.fetches.push(args.fetch);
    const reads: unknown[] = [];
    this.reads.push(reads);
    queueMicrotask(() =>
      this.run(args, inv, reads).catch((err) => {
        inv.fireError(
          err instanceof InvocationError
            ? err
            : new InvocationError(ERR_RUNTIME, err instanceof Error ? err.message : String(err)),
        );
      }),
    );
    return inv as Invocation<I, O>;
  }

  private async run(
    args: BindingInvocationArgs,
    h: InvocationImpl<unknown, unknown>,
    reads: unknown[],
  ): Promise<void> {
    switch (args.ref) {
      case "ping": {
        // No-input: close input immediately so the caller never has to.
        void h.closeInput();
        h.setHeader({ "x-mock": ["ping"] });
        await h.emitOutput({ ok: true });
        h.setTrailer({ "x-mock-trailer": ["done"] });
        h.closeOutput();
        return;
      }
      case "getUser": {
        // Unary: read first input, then (deliberately AFTER the read — the
        // "read ≠ consumed" case) check context.
        const first = await readFirst(h.inputs());
        if (first === undefined) {
          h.fireError(new InvocationError(ERR_MISSING_INPUT, "getUser requires input"));
          return;
        }
        reads.push(first);
        if (this.opts.challengeAlways ||
            (this.opts.requireBearer && !args.context?.["bearerToken"])) {
          h.fireError(contextRequiredError("bearer token required", BEARER_DETAILS));
          return;
        }
        void h.closeInput();
        const id = (first as Record<string, unknown>)["id"];
        await h.emitOutput({ id, name: "Ada" });
        h.closeOutput();
        return;
      }
      case "echoInput": {
        const first = await readFirst(h.inputs());
        reads.push(first);
        void h.closeInput();
        await h.emitOutput(first);
        h.closeOutput();
        return;
      }
      case "watchOrders": {
        const first = await readFirst(h.inputs());
        reads.push(first);
        void h.closeInput();
        for (const status of ["created", "paid", "shipped"]) {
          await h.emitOutput({ id: "ord_1", status });
        }
        h.closeOutput();
        return;
      }
      case "watchThenChallenge": {
        // Mid-stream challenge: observable progress happened, so the
        // operation layer must surface, not retry.
        void h.closeInput();
        await h.emitOutput({ id: "ord_1", status: "created" });
        h.fireError(contextRequiredError("token expired mid-stream", BEARER_DETAILS));
        return;
      }
      case "streamBadSecond": {
        void h.closeInput();
        await h.emitOutput({ n: 1 });
        await h.emitOutput({ bad: true });
        h.closeOutput();
        return;
      }
      case "badUser": {
        const first = await readFirst(h.inputs());
        reads.push(first);
        void h.closeInput();
        await h.emitOutput({ wrong: "shape" });
        h.closeOutput();
        return;
      }
      case "chat": {
        for await (const msg of h.inputs()) {
          reads.push(msg);
          await h.emitOutput({ ack: (msg as Record<string, unknown>)["text"] });
        }
        h.closeOutput();
        return;
      }
      case "uploadChunks": {
        let count = 0;
        for await (const chunk of h.inputs()) {
          reads.push(chunk);
          count++;
        }
        await h.emitOutput({ count });
        h.closeOutput();
        return;
      }
      default:
        h.fireError(new InvocationError(ERR_RUNTIME, `unknown ref: ${args.ref}`));
    }
  }
}

async function readFirst<T>(it: AsyncIterable<T>): Promise<T | undefined> {
  for await (const v of it) return v;
  return undefined;
}

async function collect<O>(it: AsyncIterable<O>): Promise<O[]> {
  const out: O[] = [];
  for await (const v of it) out.push(v);
  return out;
}

const evaluator: TransformEvaluator = {
  async evaluate(expr, data) {
    switch (expr) {
      case "idToUserId":
        return { userId: (data as Record<string, unknown>)["id"] };
      case "wrapValue":
        return { value: data };
      case "breakShape":
        return { broken: true };
      case "boom":
        throw new Error("transform exploded");
      default:
        throw new Error(`unknown expression: ${expr}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function testInterface(): OBInterface {
  return {
    openbindings: "0.2.0",
    schemas: {
      UserInput: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    operations: {
      ping: {},
      getUser: {
        aliases: ["fetchUser"],
        input: { $ref: "#/schemas/UserInput" },
        output: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
          required: ["id", "name"],
        },
      },
      echo: {},
      watchOrders: {
        output: {
          type: "object",
          properties: { id: { type: "string" }, status: { type: "string" } },
          required: ["id", "status"],
        },
      },
      watchTyped: {
        output: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      },
      chat: {},
      uploadChunks: {},
    },
    sources: {
      mock: { format: "mock@1.0", location: "mem://mock" },
    },
    bindings: {
      "ping.main": { operation: "ping", source: "mock", ref: "ping" },
      "getUser.main": { operation: "getUser", source: "mock", ref: "getUser", priority: 1 },
      "getUser.bad": { operation: "getUser", source: "mock", ref: "badUser", priority: 99 },
      "echo.transformed": {
        operation: "echo", source: "mock", ref: "echoInput", inputTransform: "idToUserId",
      },
      "watchOrders.main": { operation: "watchOrders", source: "mock", ref: "watchOrders", priority: 1 },
      "watchOrders.challenge": {
        operation: "watchOrders", source: "mock", ref: "watchThenChallenge", priority: 99,
      },
      "watchTyped.main": { operation: "watchTyped", source: "mock", ref: "streamBadSecond" },
      "chat.main": { operation: "chat", source: "mock", ref: "chat" },
      "uploadChunks.main": { operation: "uploadChunks", source: "mock", ref: "uploadChunks" },
    },
  };
}

function makeInvoker(
  mock: MockBindingInvoker = new MockBindingInvoker(),
  opts?: ConstructorParameters<typeof OperationInvoker>[1],
) {
  return new OperationInvoker([mock], { transformEvaluator: evaluator, ...opts });
}

// ---------------------------------------------------------------------------
// Wiring & resolution
// ---------------------------------------------------------------------------

describe("OperationInvoker wiring", () => {
  it("invokes a no-input operation: binding closes input, single yields the output [NI]", async () => {
    const op = makeInvoker();
    const call = op.invoke({ interface: testInterface(), operation: "ping" });
    await expect(single(call.outputs)).resolves.toEqual({ ok: true });
    await expect(call.closed).resolves.toBeUndefined();
  });

  it("resolves aliases against the flat namespace (OBI-T-12) and selects by canonical key", async () => {
    const mock = new MockBindingInvoker();
    const op = makeInvoker(mock);
    const call = op.invoke({ interface: testInterface(), operation: "fetchUser" });
    await call.write({ id: "u1" });
    await expect(single(call.outputs)).resolves.toEqual({ id: "u1", name: "Ada" });
  });

  it("throws OperationNotFoundError synchronously for an unknown operation", () => {
    const op = makeInvoker();
    expect(() => op.invoke({ interface: testInterface(), operation: "nope" }))
      .toThrow(OperationNotFoundError);
  });

  it("throws BindingNotFoundError synchronously for an unknown bindingKey", () => {
    const op = makeInvoker();
    expect(() => op.invoke({ interface: testInterface(), operation: "ping", bindingKey: "nope" }))
      .toThrow(BindingNotFoundError);
  });

  it("throws UnknownSourceError synchronously when the binding's source is missing", () => {
    const iface = testInterface();
    delete iface.sources!["mock"];
    const op = makeInvoker();
    expect(() => op.invoke({ interface: iface, operation: "ping", bindingKey: "ping.main" }))
      .toThrow(UnknownSourceError);
  });

  it("invokeBinding passthrough throws NoInvokerError for an unknown format", () => {
    const op = makeInvoker();
    expect(() =>
      op.invokeBinding({ source: { format: "unknown@1.0" }, ref: "x" }),
    ).toThrow(NoInvokerError);
  });

  it("surfaces a missing invoker as terminal ERR_BINDING_NOT_FOUND on the handle", async () => {
    const iface = testInterface();
    iface.sources!["mock"]!.format = "absent@1.0";
    // The default selector skips unavailable formats and throws; pin the
    // binding to force the wiring error onto the handle path.
    const op = makeInvoker();
    const call = op.invoke({ interface: iface, operation: "ping", bindingKey: "ping.main" });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_BINDING_NOT_FOUND });
  });

  it("routes by format token across multiple invokers", async () => {
    const a = new MockBindingInvoker({ token: "mock@1.0" });
    const b = new MockBindingInvoker({ token: "other@2.0" });
    const op = new OperationInvoker([a, b], { transformEvaluator: evaluator });
    const call = op.invoke({ interface: testInterface(), operation: "ping" });
    await call.closed;
    expect(a.attempts).toBe(1);
    expect(b.attempts).toBe(0);
  });

  it("fills fetch down to the binding layer", async () => {
    const fakeFetch = (() => Promise.reject(new Error("nope"))) as unknown as typeof globalThis.fetch;
    const mock = new MockBindingInvoker();
    const op = makeInvoker(mock, { fetch: fakeFetch });
    await op.invoke({ interface: testInterface(), operation: "ping" }).closed;
    expect(mock.fetches[0]).toBe(fakeFetch);
  });
});

// ---------------------------------------------------------------------------
// Cardinalities through one shape
// ---------------------------------------------------------------------------

describe("cardinalities", () => {
  it("server-streaming: one write, many outputs [SS]", async () => {
    const op = makeInvoker();
    const call = op.invoke({ interface: testInterface(), operation: "watchOrders" });
    await call.write({ accountId: "a1" });
    const out = await collect(call.outputs);
    expect(out.map((o) => (o as Record<string, unknown>)["status"])).toEqual([
      "created", "paid", "shipped",
    ]);
  });

  it("client-streaming: caller owns close() [CS]", async () => {
    const op = makeInvoker();
    const call = op.invoke({ interface: testInterface(), operation: "uploadChunks" });
    for (const c of ["a", "b", "c"]) await call.write({ chunk: c });
    await call.close();
    await expect(single(call.outputs)).resolves.toEqual({ count: 3 });
  });

  it("bidirectional: concurrent pump and drain [BD]", async () => {
    const op = makeInvoker();
    const call = op.invoke({ interface: testInterface(), operation: "chat" });
    const pump = (async () => {
      for (const text of ["hi", "there"]) await call.write({ text });
      await call.close();
    })();
    const [acks] = await Promise.all([collect(call.outputs), pump]);
    expect(acks).toEqual([{ ack: "hi" }, { ack: "there" }]);
  });

  it("caller cancel propagates to the binding's signal", async () => {
    const mock = new MockBindingInvoker();
    const op = makeInvoker(mock);
    const call = op.invoke({ interface: testInterface(), operation: "chat" });
    await call.write({ text: "hello" });
    await call.cancel();
    await expect(call.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
    expect(mock.signals[0]!.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OBI-T-07 — input validation (terminal + write rejects, before transform)
// ---------------------------------------------------------------------------

describe("OBI-T-07 — input validation", () => {
  it("an invalid write rejects AND terminates; the binding never sees the message", async () => {
    const mock = new MockBindingInvoker();
    const op = makeInvoker(mock);
    const call = op.invoke({ interface: testInterface(), operation: "getUser" });
    await expect(call.write({ id: 42 })).rejects.toMatchObject({ code: ERR_VALIDATION_FAILED });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_VALIDATION_FAILED });
    expect(mock.reads.flat()).toEqual([]);
  });

  it("accepts valid input (resolving $ref into #/schemas)", async () => {
    const op = makeInvoker();
    const call = op.invoke({ interface: testInterface(), operation: "getUser" });
    await call.write({ id: "u1" });
    await expect(single(call.outputs)).resolves.toEqual({ id: "u1", name: "Ada" });
  });

  it("rejects unknown fields under additionalProperties:false via $ref", async () => {
    const op = makeInvoker();
    const call = op.invoke({ interface: testInterface(), operation: "getUser" });
    await expect(call.write({ id: "u1", extra: true })).rejects.toMatchObject({
      code: ERR_VALIDATION_FAILED,
    });
  });

  it("skips validation when the operation declares no input schema", async () => {
    const op = makeInvoker();
    const call = op.invoke({ interface: testInterface(), operation: "uploadChunks" });
    await call.write("anything at all");
    await call.close();
    await expect(single(call.outputs)).resolves.toEqual({ count: 1 });
  });

  it("validates BEFORE the input transform; the binding receives the transformed message", async () => {
    const iface = testInterface();
    iface.operations["echo"]!.input = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    const mock = new MockBindingInvoker();
    const op = makeInvoker(mock);
    const call = op.invoke({ interface: iface, operation: "echo" });
    await call.write({ id: "u1" }); // validates against the PRE-transform shape
    await expect(single(call.outputs)).resolves.toEqual({ userId: "u1" });
    expect(mock.reads.flat()).toEqual([{ userId: "u1" }]);
  });

  it("a failing input transform is terminal ERR_TRANSFORM_ERROR", async () => {
    const iface = testInterface();
    iface.bindings!["echo.transformed"]!.inputTransform = "boom";
    const op = makeInvoker();
    const call = op.invoke({ interface: iface, operation: "echo" });
    await call.write({ id: "u1" });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_TRANSFORM_ERROR });
  });
});

// ---------------------------------------------------------------------------
// OBI-T-08 — output validation (terminal, value not emitted, per item)
// ---------------------------------------------------------------------------

describe("OBI-T-08 — output validation", () => {
  it("an invalid output is NOT emitted; the invocation terminates", async () => {
    const op = makeInvoker();
    const call = op.invoke({
      interface: testInterface(),
      operation: "getUser",
      bindingKey: "getUser.bad",
    });
    await call.write({ id: "u1" });
    const seen: unknown[] = [];
    let caught: unknown;
    try {
      for await (const v of call.outputs) seen.push(v);
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual([]);
    expect(caught).toMatchObject({ code: ERR_VALIDATION_FAILED });
  });

  it("applies per item for streaming: valid prefix delivered, then terminal [SS]", async () => {
    const op = makeInvoker();
    const call = op.invoke({ interface: testInterface(), operation: "watchTyped" });
    const seen: unknown[] = [];
    let caught: unknown;
    try {
      for await (const v of call.outputs) seen.push(v);
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual([{ n: 1 }]);
    expect(caught).toMatchObject({ code: ERR_VALIDATION_FAILED });
  });

  it("validates AFTER the output transform", async () => {
    const iface = testInterface();
    iface.bindings!["watchTyped.main"]!.outputTransform = "breakShape";
    const op = makeInvoker();
    const call = op.invoke({ interface: iface, operation: "watchTyped" });
    const seen: unknown[] = [];
    let caught: unknown;
    try {
      for await (const v of call.outputs) seen.push(v);
    } catch (err) {
      caught = err;
    }
    // The transform broke even the first (originally valid) item.
    expect(seen).toEqual([]);
    expect(caught).toMatchObject({ code: ERR_VALIDATION_FAILED });
  });

  it("skips validation when the operation declares no output schema", async () => {
    const op = makeInvoker();
    const call = op.invoke({ interface: testInterface(), operation: "ping" });
    await expect(single(call.outputs)).resolves.toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// CONTEXT_REQUIRED negotiation
// ---------------------------------------------------------------------------

describe("CONTEXT_REQUIRED", () => {
  it("surfaces to the caller when no resolver is configured", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true });
    const op = makeInvoker(mock);
    const call = op.invoke({ interface: testInterface(), operation: "getUser" });
    await call.write({ id: "u1" });
    await expect(call.closed).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      details: BEARER_DETAILS,
    });
  });

  it("resolve-and-retry replays the already-forwarded input (read ≠ consumed) [U]", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true });
    const resolver = vi.fn(async () => ({ bearerToken: "tok-123" }));
    const op = makeInvoker(mock, { contextResolver: resolver });
    const call = op.invoke({ interface: testInterface(), operation: "getUser" });
    await call.write({ id: "u1" }); // written ONCE
    await expect(single(call.outputs)).resolves.toEqual({ id: "u1", name: "Ada" });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(BEARER_DETAILS);
    expect(mock.attempts).toBe(2);
    // Both attempts read the same lone input: the prefix was replayed.
    expect(mock.reads).toEqual([[{ id: "u1" }], [{ id: "u1" }]]);
    expect(mock.contexts[1]).toMatchObject({ bearerToken: "tok-123" });
  });

  it("surfaces when the resolver declines", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true });
    const op = makeInvoker(mock, { contextResolver: async () => null });
    const call = op.invoke({ interface: testInterface(), operation: "getUser" });
    await call.write({ id: "u1" });
    await expect(call.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
    expect(mock.attempts).toBe(1);
  });

  it("caps resolve-and-retry rounds instead of looping forever", async () => {
    const mock = new MockBindingInvoker({ challengeAlways: true });
    const resolver = vi.fn(async () => ({ bearerToken: "never-enough" }));
    const op = makeInvoker(mock, { contextResolver: resolver });
    const call = op.invoke({ interface: testInterface(), operation: "getUser" });
    await call.write({ id: "u1" });
    await expect(call.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
    expect(resolver.mock.calls.length).toBeLessThanOrEqual(4);
    expect(mock.attempts).toBeLessThanOrEqual(5);
  });

  it("a mid-stream challenge surfaces (no retry after observable progress) [SS]", async () => {
    const mock = new MockBindingInvoker();
    const resolver = vi.fn(async () => ({ bearerToken: "tok" }));
    const op = makeInvoker(mock, { contextResolver: resolver });
    const call = op.invoke({
      interface: testInterface(),
      operation: "watchOrders",
      bindingKey: "watchOrders.challenge",
    });
    const seen: unknown[] = [];
    let caught: unknown;
    try {
      for await (const v of call.outputs) seen.push(v);
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual([{ id: "ord_1", status: "created" }]);
    expect(caught).toMatchObject({ code: CONTEXT_REQUIRED });
    expect(resolver).not.toHaveBeenCalled();
    expect(mock.attempts).toBe(1);
  });

  it("preflight resolves context before the first attempt (no challenge round-trip) [CS]", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true, preflight: true });
    const resolver = vi.fn(async () => ({ bearerToken: "tok-pre" }));
    const op = makeInvoker(mock, { contextResolver: resolver });
    const call = op.invoke({ interface: testInterface(), operation: "getUser" });
    await call.write({ id: "u1" });
    await expect(single(call.outputs)).resolves.toEqual({ id: "u1", name: "Ada" });

    expect(mock.prepares).toBe(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    // One attempt only: the challenge was collapsed by preflight.
    expect(mock.attempts).toBe(1);
    expect(mock.contexts[0]).toMatchObject({ bearerToken: "tok-pre" });
  });

  it("preflight with no resolver surfaces CONTEXT_REQUIRED before any attempt", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true, preflight: true });
    const op = makeInvoker(mock);
    const call = op.invoke({ interface: testInterface(), operation: "getUser" });
    await expect(call.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
    expect(mock.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Metadata pass-through
// ---------------------------------------------------------------------------

describe("metadata pass-through", () => {
  it("forwards binding header and trailer to the caller handle", async () => {
    const op = makeInvoker();
    const call = op.invoke({ interface: testInterface(), operation: "ping" });
    expect(await collect(call.outputs)).toEqual([{ ok: true }]);
    await expect(call.header).resolves.toEqual({ "x-mock": ["ping"] });
    expect(call.trailer()).toEqual({ "x-mock-trailer": ["done"] });
  });
});

// ---------------------------------------------------------------------------
// defaultBindingSelector (OBI-T-09)
// ---------------------------------------------------------------------------

describe("defaultBindingSelector", () => {
  it("selects the only matching binding", () => {
    const { key, binding } = defaultBindingSelector(testInterface(), "ping");
    expect(key).toBe("ping.main");
    expect(binding.ref).toBe("ping");
  });

  it("throws when no binding matches", () => {
    expect(() => defaultBindingSelector(testInterface(), "unbound"))
      .toThrow(BindingNotFoundError);
  });

  it("prefers non-deprecated over deprecated regardless of priority (tier rule)", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { op: {} },
      sources: { s: { format: "openapi@3.1", location: "x" } },
      bindings: {
        "op.deprecated": { operation: "op", source: "s", deprecated: true, priority: 1 },
        "op.fresh": { operation: "op", source: "s", priority: 10 },
      },
    };
    expect(defaultBindingSelector(iface, "op").key).toBe("op.fresh");
  });

  it("lower priority wins within a tier; binding priority overrides source priority", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { op: {} },
      sources: {
        cheap: { format: "f@1", location: "x", priority: 5 },
        costly: { format: "f@1", location: "y", priority: 1 },
      },
      bindings: {
        "op.a": { operation: "op", source: "cheap", priority: 0 }, // overrides source 5
        "op.b": { operation: "op", source: "costly" }, // inherits 1
      },
    };
    expect(defaultBindingSelector(iface, "op").key).toBe("op.a");
  });

  it("skips bindings whose source format no registered invoker can handle", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { op: {} },
      sources: {
        supported: { format: "mock@1.0", location: "x" },
        unsupported: { format: "exotic@9.9", location: "y" },
      },
      bindings: {
        "op.exotic": { operation: "op", source: "unsupported", priority: 0 },
        "op.plain": { operation: "op", source: "supported", priority: 10 },
      },
    };
    const { key } = defaultBindingSelector(iface, "op", new Set(["mock@1.0"]));
    expect(key).toBe("op.plain");
  });
});

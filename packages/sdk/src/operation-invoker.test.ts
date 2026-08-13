import { describe, it, expect, vi } from "vitest";
import {
  OperationInvoker,
  defaultBindingSelector,
} from "./operation-invoker.js";
import { operationSignature } from "./operation-signature.js";
import {
  InvocationImpl,
  InvocationError,
  contextRequiredError,
  configValueRequirement,
  single,
  type ContextRequiredDetails,
  type Invocation,
} from "./invocation.js";
import type {
  BindingInvoker,
  TransformEvaluator,
} from "./invokers.js";
import type { BindingInvocationArgs } from "./invoker-types.js";
import type { BindingEntry, OBInterface, Operation } from "./types.js";
import {
  BindingNotFoundError,
  BindingSelectionRequiredError,
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
  ERR_SCHEMA_UNRESOLVED,
  ERR_TRANSFORM_ERROR,
  ERR_OPERATION_VALIDATION_FAILED,
} from "./errcodes.js";

// ---------------------------------------------------------------------------
// Mock binding invoker (the design doc's reference mock, ref-dispatched)
// ---------------------------------------------------------------------------

const BEARER_DETAILS: ContextRequiredDetails = {
  target: "https://api.example.com",
  alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
};

interface MockOpts {
  bindingSpec?: string;
  /** ping returns one binding-native failure completion. */
  nativeFailure?: boolean;
  /** getUser challenges CONTEXT_REQUIRED when context lacks bearerToken (after reading its input). */
  requireBearer?: boolean;
  /** getUser challenges unconditionally, even with context (tests the retry cap). */
  challengeAlways?: boolean;
  /** getUser challenges config.value until context.configuration.server is present. */
  requireServerConfig?: boolean;
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

  bindingSpecs() {
    return [{ bindingSpec: this.opts.bindingSpec ?? "mock@1.0" }];
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
            : new InvocationError(ERR_RUNTIME),
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
        if (this.opts.nativeFailure) {
          h.fireError(
            new InvocationError("EXAMPLE_BINDING_FAILURE"),
          );
          return;
        }
        await h.emitOutput({ ok: true });
        h.closeOutput();
        return;
      }
      case "getUser": {
        // Unary: read first input, then (deliberately AFTER the read — the
        // "read ≠ consumed" case) check context.
        const first = await readFirst(h.inputs());
        if (first === undefined) {
          h.fireError(new InvocationError(ERR_MISSING_INPUT));
          return;
        }
        reads.push(first);
        if (this.opts.challengeAlways ||
            (this.opts.requireBearer && !args.context?.["bearerToken"])) {
          h.fireError(contextRequiredError(BEARER_DETAILS));
          return;
        }
        if (this.opts.requireServerConfig) {
          const cfg = args.context?.["configuration"] as Record<string, unknown> | undefined;
          if (!cfg?.["server"]) {
            h.fireError(
              contextRequiredError({
                target: "https://api.example.com",
                alternatives: [
                  { requirements: [configValueRequirement("server", "/url", "supply a connection URL")] },
                ],
              }),
            );
            return;
          }
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
        h.fireError(contextRequiredError(BEARER_DETAILS));
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
      case "collectThenChallenge": {
        // Client-streaming with a context gate: reads the WHOLE input stream
        // first, then challenges if unauthenticated (read ≠ consumed — the
        // streamed-prefix replay case). With context, acks per input AS READ,
        // so the retry's first output lands while the replay is in flight.
        if (!args.context?.["bearerToken"]) {
          for await (const chunk of h.inputs()) {
            reads.push(chunk);
          }
          h.fireError(contextRequiredError(BEARER_DETAILS));
          return;
        }
        for await (const chunk of h.inputs()) {
          reads.push(chunk);
          await h.emitOutput({ ack: (chunk as Record<string, unknown>)["n"] });
        }
        h.closeOutput();
        return;
      }
      default:
        h.fireError(new InvocationError(ERR_RUNTIME));
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

// The fixture with the members tests mutate typed as present, so tests can
// reach into them without per-site narrowing. Still a plain OBInterface to
// every consumer. `sources` keeps its plain Record shape because one test
// deletes the "mock" entry (delete needs an optional operand).
type TestInterface = OBInterface & {
  operations: { getUser: Operation; echo: Operation; watchTyped: Operation };
  bindings?: { "echo.transformed": BindingEntry; "watchTyped.main": BindingEntry };
};

function testInterface(): TestInterface {
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
      uploadAuth: {},
    },
    sources: {
      mock: { bindingSpec: "mock@1.0", location: "mem://mock" },
    },
    bindings: {
      "ping.main": { operation: "ping", source: "mock", ref: "ping" },
      "getUser.main": { operation: "getUser", source: "mock", ref: "getUser", preference: 99 },
      "getUser.bad": { operation: "getUser", source: "mock", ref: "badUser", preference: 1 },
      "echo.transformed": {
        operation: "echo", source: "mock", ref: "echoInput", inputTransform: "idToUserId",
      },
      "watchOrders.main": { operation: "watchOrders", source: "mock", ref: "watchOrders", preference: 99 },
      "watchOrders.challenge": {
        operation: "watchOrders", source: "mock", ref: "watchThenChallenge", preference: 1,
      },
      "watchTyped.main": { operation: "watchTyped", source: "mock", ref: "streamBadSecond" },
      "chat.main": { operation: "chat", source: "mock", ref: "chat" },
      "uploadChunks.main": { operation: "uploadChunks", source: "mock", ref: "uploadChunks" },
      "uploadAuth.main": { operation: "uploadAuth", source: "mock", ref: "collectThenChallenge" },
    },
  };
}

function makeInvoker(
  mock: MockBindingInvoker = new MockBindingInvoker(),
  opts?: ConstructorParameters<typeof OperationInvoker>[1],
) {
  // Most tests exercise validation, transforms, streaming, or context rather
  // than binding resolution. Give that test application an explicit policy
  // for its deliberately multi-bound fixtures; dedicated tests below exercise
  // the contract's policy-neutral default.
  const bindingSelector =
    opts?.bindingSelector ??
    ((iface: OBInterface, opKey: string) => {
      const key = `${opKey}.main`;
      const binding = iface.bindings?.[key];
      if (binding?.operation === opKey) return { key, binding };
      return defaultBindingSelector(iface, opKey);
    });
  return new OperationInvoker([mock], { transformEvaluator: evaluator, ...opts, bindingSelector });
}

// ---------------------------------------------------------------------------
// Wiring & resolution
// ---------------------------------------------------------------------------

describe("OperationInvoker wiring", () => {
  it("invokes a no-input operation: binding closes input, single yields the output [NI]", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("ping"));
    await expect(single(call.outputs)).resolves.toEqual({ ok: true });
    await expect(call.closed).resolves.toBeUndefined();
  });

  it("resolves aliases against the flat namespace (OBI-T-12) and selects by canonical key", async () => {
    const mock = new MockBindingInvoker();
    const op = makeInvoker(mock);
    const call = op.invoke(testInterface(), operationSignature("fetchUser"));
    await call.write({ id: "u1" });
    await expect(single(call.outputs)).resolves.toEqual({ id: "u1", name: "Ada" });
  });

  it("throws OperationNotFoundError synchronously for an unknown operation", () => {
    const op = makeInvoker();
    expect(() => op.invoke(testInterface(), operationSignature("nope")))
      .toThrow(OperationNotFoundError);
  });

  it("throws BindingNotFoundError synchronously for an unknown bindingKey", () => {
    const op = makeInvoker();
    expect(() => op.invoke(testInterface(), operationSignature("ping"), { bindingKey: "nope" }))
      .toThrow(BindingNotFoundError);
  });

  it("throws BindingNotFoundError when bindingKey names a binding for a different operation", () => {
    // getUser.main binds the getUser operation; pinning it under "ping" must be
    // refused, otherwise the wrong operation's schema/transforms would apply.
    const op = makeInvoker();
    expect(() => op.invoke(testInterface(), operationSignature("ping"), { bindingKey: "getUser.main" }))
      .toThrow(BindingNotFoundError);
  });

  it("names the missing binding spec in BindingNotFoundError when a binding's spec has no registered invoker", () => {
    // The operation HAS a binding, but its governing binding spec has no registered
    // invoker. The error must send the reader to their OperationInvoker
    // construction, not to auditing the OBI.
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { doThing: {} },
      sources: { svc: { bindingSpec: "grpc@1.0" } },
      bindings: { "doThing.svc": { operation: "doThing", source: "svc", ref: "x" } },
    };
    let msg: string;
    try {
      defaultBindingSelector(iface, "doThing", new Set(["openapi@3.1.0"]));
      throw new Error("expected BindingNotFoundError");
    } catch (e) {
      expect(e).toBeInstanceOf(BindingNotFoundError);
      msg = (e as Error).message;
    }
    expect(msg).toContain('"doThing.svc" requires binding spec grpc@1.0');
    expect(msg).toContain("registered binding specs: [openapi@3.1.0]");
    expect(msg).toContain("OperationInvoker constructor");
  });

  it("throws UnknownSourceError synchronously when the binding's source is missing", () => {
    const iface = testInterface();
    delete iface.sources!["mock"];
    const op = makeInvoker();
    expect(() => op.invoke(iface, operationSignature("ping"), { bindingKey: "ping.main" }))
      .toThrow(UnknownSourceError);
  });

  it("invokeBinding passthrough throws NoInvokerError for an unknown binding spec", () => {
    const op = makeInvoker();
    expect(() =>
      op.invokeBinding({ source: { bindingSpec: "unknown@1.0" }, ref: "x" }),
    ).toThrow(NoInvokerError);
  });

  it("surfaces a missing invoker as terminal ERR_BINDING_NOT_FOUND on the handle", async () => {
    const iface = testInterface();
    const mockSource = iface.sources?.["mock"];
    if (!mockSource) throw new Error("testInterface() always defines sources.mock");
    mockSource.bindingSpec = "absent@1.0";
    // The default selector skips unavailable binding specs and throws; pin the
    // binding to force the wiring error onto the handle path.
    const op = makeInvoker();
    const call = op.invoke(iface, operationSignature("ping"), { bindingKey: "ping.main" });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_BINDING_NOT_FOUND });
  });

  it("routes by exact binding-spec identifier across multiple invokers", async () => {
    const a = new MockBindingInvoker({ bindingSpec: "mock@1.0" });
    const b = new MockBindingInvoker({ bindingSpec: "other@2.0" });
    const op = new OperationInvoker([a, b], { transformEvaluator: evaluator });
    const call = op.invoke(testInterface(), operationSignature("ping"));
    await call.closed;
    expect(a.attempts).toBe(1);
    expect(b.attempts).toBe(0);
  });

  it("fills fetch down to the binding layer", async () => {
    const fakeFetch = (() => Promise.reject(new Error("nope"))) as unknown as typeof globalThis.fetch;
    const mock = new MockBindingInvoker();
    const op = makeInvoker(mock, { fetch: fakeFetch });
    await op.invoke(testInterface(), operationSignature("ping")).closed;
    expect(mock.fetches[0]).toBe(fakeFetch);
  });
});

// ---------------------------------------------------------------------------
// Cardinalities through one shape
// ---------------------------------------------------------------------------

describe("cardinalities", () => {
  it("server-streaming: one write, many outputs [SS]", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("watchOrders"));
    await call.write({ accountId: "a1" });
    const out = await collect(call.outputs);
    expect(out.map((o) => (o as Record<string, unknown>)["status"])).toEqual([
      "created", "paid", "shipped",
    ]);
  });

  it("client-streaming: caller owns close() [CS]", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("uploadChunks"));
    for (const c of ["a", "b", "c"]) await call.write({ chunk: c });
    await call.close();
    await expect(single(call.outputs)).resolves.toEqual({ count: 3 });
  });

  it("bidirectional: concurrent pump and drain [BD]", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("chat"));
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
    const call = op.invoke(testInterface(), operationSignature("chat"));
    await call.write({ text: "hello" });
    await call.cancel();
    await expect(call.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
    expect(mock.signals[0]?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OBI-T-07 — input validation (terminal + write rejects, before transform)
// ---------------------------------------------------------------------------

describe("OBI-T-07 — input validation", () => {
  it("an invalid write rejects AND terminates; the binding never sees the message", async () => {
    const mock = new MockBindingInvoker();
    const op = makeInvoker(mock);
    const call = op.invoke(testInterface(), operationSignature("getUser"));
    await expect(call.write({ id: 42 })).rejects.toMatchObject({ code: ERR_OPERATION_VALIDATION_FAILED });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_OPERATION_VALIDATION_FAILED });
    expect(mock.reads.flat()).toEqual([]);
  });

  it("accepts valid input (resolving $ref into #/schemas)", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("getUser"));
    await call.write({ id: "u1" });
    await expect(single(call.outputs)).resolves.toEqual({ id: "u1", name: "Ada" });
  });

  it("rejects unknown fields under additionalProperties:false via $ref", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("getUser"));
    await expect(call.write({ id: "u1", extra: true })).rejects.toMatchObject({
      code: ERR_OPERATION_VALIDATION_FAILED,
    });
  });

  it("fails closed when the input schema carries an external $ref it cannot resolve", async () => {
    // T-07 validates against the FULLY RESOLVED schema: an external $ref
    // with no fetcher is an invocation error, never a partial pass.
    const iface = testInterface();
    iface.operations.getUser.input = { $ref: "https://example.com/schemas/user-input.json" };
    const mock = new MockBindingInvoker();
    const op = makeInvoker(mock);
    const call = op.invoke(iface, operationSignature("getUser"));
    await expect(call.write({ id: "u1" })).rejects.toMatchObject({ code: ERR_SCHEMA_UNRESOLVED });
    expect(mock.reads.flat()).toEqual([]); // the binding never saw the message
  });

  it("format is annotation-only at the boundary; pattern is the assertion lane", async () => {
    // §6.2: a tool MUST NOT reject a value for violating `format`.
    const iface = testInterface();
    iface.operations.getUser.input = { type: "string", format: "email" };
    const op = makeInvoker();
    const call = op.invoke(iface, operationSignature("getUser"));
    await expect(call.write("not-an-email")).resolves.toBeUndefined();

    const iface2 = testInterface();
    iface2.operations.getUser.input = { type: "string", pattern: "^[^@]+@[^@]+$" };
    const op2 = makeInvoker();
    const call2 = op2.invoke(iface2, operationSignature("getUser"));
    await expect(call2.write("not-an-email")).rejects.toMatchObject({ code: ERR_OPERATION_VALIDATION_FAILED });
  });

  it("skips validation when the operation declares no input schema", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("uploadChunks"));
    await call.write("anything at all");
    await call.close();
    await expect(single(call.outputs)).resolves.toEqual({ count: 1 });
  });

  it("validates BEFORE the input transform; the binding receives the transformed message", async () => {
    const iface = testInterface();
    iface.operations["echo"].input = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    const mock = new MockBindingInvoker();
    const op = makeInvoker(mock);
    const call = op.invoke(iface, operationSignature("echo"));
    await call.write({ id: "u1" }); // validates against the PRE-transform shape
    await expect(single(call.outputs)).resolves.toEqual({ userId: "u1" });
    expect(mock.reads.flat()).toEqual([{ userId: "u1" }]);
  });

  it("a failing input transform is terminal ERR_TRANSFORM_ERROR", async () => {
    const iface = testInterface();
    iface.bindings!["echo.transformed"].inputTransform = "boom";
    const op = makeInvoker();
    const call = op.invoke(iface, operationSignature("echo"));
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
    const call = op.invoke(testInterface(), operationSignature("getUser"), {
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
    expect(caught).toMatchObject({ code: ERR_OPERATION_VALIDATION_FAILED });
  });

  it("applies per item for streaming: valid prefix delivered, then terminal [SS]", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("watchTyped"));
    const seen: unknown[] = [];
    let caught: unknown;
    try {
      for await (const v of call.outputs) seen.push(v);
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual([{ n: 1 }]);
    expect(caught).toMatchObject({ code: ERR_OPERATION_VALIDATION_FAILED });
  });

  it("validates AFTER the output transform", async () => {
    const iface = testInterface();
    iface.bindings!["watchTyped.main"].outputTransform = "breakShape";
    const op = makeInvoker();
    const call = op.invoke(iface, operationSignature("watchTyped"));
    const seen: unknown[] = [];
    let caught: unknown;
    try {
      for await (const v of call.outputs) seen.push(v);
    } catch (err) {
      caught = err;
    }
    // The transform broke even the first (originally valid) item.
    expect(seen).toEqual([]);
    expect(caught).toMatchObject({ code: ERR_OPERATION_VALIDATION_FAILED });
  });

  it("skips validation when the operation declares no output schema", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("ping"));
    await expect(single(call.outputs)).resolves.toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// CONTEXT_REQUIRED negotiation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OBI-T-16 — claim semantics: unresolvable graph is distinct from mismatch;
// `format` is an annotation, never an assertion
// ---------------------------------------------------------------------------

describe("OBI-T-16 claim semantics", () => {
  it("resolves an input $ref from the OBI document root", async () => {
    const iface = testInterface();
    iface.operations["getUser"].input = {
      type: "object",
      properties: {
        id: { $ref: "#/operations/getUser/input/$defs/Identifier" },
      },
      required: ["id"],
      additionalProperties: false,
      $defs: { Identifier: { type: "string" } },
    };

    const op = makeInvoker();
    const call = op.invoke(iface, operationSignature("getUser"));
    await call.write({ id: "u1" });
    await expect(single(call.outputs)).resolves.toEqual({ id: "u1", name: "Ada" });
  });

  it("resolves a streaming output $ref from the OBI document root before per-item validation", async () => {
    const iface = testInterface();
    iface.operations["watchTyped"].output = {
      type: "object",
      properties: {
        n: { $ref: "#/operations/watchTyped/output/$defs/Count" },
      },
      required: ["n"],
      $defs: { Count: { type: "number" } },
    };

    const op = makeInvoker();
    const call = op.invoke(iface, operationSignature("watchTyped"));
    const seen: unknown[] = [];
    let caught: unknown;
    try {
      for await (const v of call.outputs) seen.push(v);
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual([{ n: 1 }]);
    expect(caught).toMatchObject({ code: ERR_OPERATION_VALIDATION_FAILED });
  });

  it("an unresolvable output schema graph is ERR_SCHEMA_UNRESOLVED, never partial validation", async () => {
    const iface = testInterface();
    iface.operations["watchTyped"].output = { $ref: "#/schemas/DoesNotExist" };

    const op = makeInvoker();
    const call = op.invoke(iface, operationSignature("watchTyped"));
    await expect(collect(call.outputs)).rejects.toMatchObject({ code: "ERR_SCHEMA_UNRESOLVED" });
  });

  it("an unresolvable input schema graph is ERR_SCHEMA_UNRESOLVED on write", async () => {
    const iface = testInterface();
    iface.operations["getUser"].input = { $ref: "#/schemas/DoesNotExist" };

    const op = makeInvoker();
    const call = op.invoke(iface, operationSignature("getUser"));
    await expect(call.write({ id: "u1" })).rejects.toMatchObject({ code: "ERR_SCHEMA_UNRESOLVED" });
  });

  it("`format` annotates, never asserts: a failing format value still validates", async () => {
    const iface = testInterface();
    iface.operations["getUser"].input = {
      type: "object",
      properties: { id: { type: "string", format: "email" } },
      required: ["id"],
    };

    const op = makeInvoker();
    const call = op.invoke(iface, operationSignature("getUser"));
    await call.write({ id: "not-an-email" });
    await expect(single(call.outputs)).resolves.toMatchObject({ name: "Ada" });
  });
});

describe("CONTEXT_REQUIRED", () => {
  it("surfaces to the caller when no resolver is configured", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true });
    const op = makeInvoker(mock);
    const call = op.invoke(testInterface(), operationSignature("getUser"));
    await call.write({ id: "u1" });
    await expect(call.closed).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      data: BEARER_DETAILS,
    });
  });

  it("resolve-and-retry carries a config.value into configuration, preserving a sibling point (R1a)", async () => {
    const mock = new MockBindingInvoker({ requireServerConfig: true });
    const resolver = vi.fn(async () => ({
      configuration: { server: { url: "https://api.example.com" } },
    }));
    const op = makeInvoker(mock, { contextResolver: resolver });
    // The caller pre-supplies a DIFFERENT configuration point (decode); it must
    // survive the resolve-and-retry merge rather than being clobbered.
    const call = op.invoke(testInterface(), operationSignature("getUser"), {
      context: { configuration: { decode: { lane: "text" } } },
    });
    await call.write({ id: "u1" });
    await expect(single(call.outputs)).resolves.toEqual({ id: "u1", name: "Ada" });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(mock.attempts).toBe(2);
    const retryCfg = mock.contexts[1]?.["configuration"] as Record<string, unknown>;
    expect(retryCfg["server"]).toEqual({ url: "https://api.example.com" });
    // The caller's decode point was not clobbered by the merge.
    expect(retryCfg["decode"]).toEqual({ lane: "text" });
  });

  it("resolve-and-retry replays the already-forwarded input (read ≠ consumed) [U]", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true });
    const resolver = vi.fn(async () => ({ bearerToken: "tok-123" }));
    const op = makeInvoker(mock, { contextResolver: resolver });
    const call = op.invoke(testInterface(), operationSignature("getUser"));
    await call.write({ id: "u1" }); // written ONCE
    await expect(single(call.outputs)).resolves.toEqual({ id: "u1", name: "Ada" });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(BEARER_DETAILS);
    expect(mock.attempts).toBe(2);
    // Both attempts read the same lone input: the prefix was replayed.
    expect(mock.reads).toEqual([[{ id: "u1" }], [{ id: "u1" }]]);
    expect(mock.contexts[1]).toMatchObject({ bearerToken: "tok-123" });
  });

  it("resolve-and-retry replays a streamed multi-input prefix in full [CS]", async () => {
    // Regression: the retry attempt's own first output closes the retry
    // window mid-replay; the in-flight replay must still deliver the FULL
    // prefix (a live-rebound log truncated it to 3 items and closed clean).
    const mock = new MockBindingInvoker();
    const resolver = vi.fn(async () => ({ bearerToken: "tok" }));
    const op = makeInvoker(mock, { contextResolver: resolver });
    const call = op.invoke(testInterface(), operationSignature("uploadAuth"));
    const N = 6;
    for (let n = 1; n <= N; n++) await call.write({ n });
    await call.close();

    const acks = await collect(call.outputs);
    expect(acks).toEqual(Array.from({ length: N }, (_, i) => ({ ack: i + 1 })));
    expect(mock.attempts).toBe(2);
    // Attempt 1 read all N (then challenged); attempt 2 must replay all N.
    expect(mock.reads[0]).toHaveLength(N);
    expect(mock.reads[1]).toHaveLength(N);
    expect(mock.reads[1]).toEqual(Array.from({ length: N }, (_, i) => ({ n: i + 1 })));
  });

  it("a T-07 terminal tears down the in-flight binding attempt", async () => {
    // Regression: a caller-side terminal (T-07) previously left the inner
    // binding invocation stranded (its signal never aborted) — a permanent
    // connection leak per validation failure.
    const mock = new MockBindingInvoker();
    const op = makeInvoker(mock);
    const call = op.invoke(testInterface(), operationSignature("getUser"));
    await expect(call.write({ id: 42 })).rejects.toMatchObject({ code: ERR_OPERATION_VALIDATION_FAILED });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_OPERATION_VALIDATION_FAILED });
    // Give teardown propagation a few macrotasks.
    await new Promise((r) => setTimeout(r, 20));
    expect(mock.signals).toHaveLength(1);
    expect(mock.signals[0]?.aborted).toBe(true);
  });

  it("surfaces when the resolver declines", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true });
    const op = makeInvoker(mock, { contextResolver: async () => null });
    const call = op.invoke(testInterface(), operationSignature("getUser"));
    await call.write({ id: "u1" });
    await expect(call.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
    expect(mock.attempts).toBe(1);
  });

  it("surfaces resolver failures as local runtime errors", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true });
    const op = makeInvoker(mock, {
      contextResolver: async () => { throw new Error("credential store unavailable"); },
    });
    const call = op.invoke(testInterface(), operationSignature("getUser"));
    await call.write({ id: "u1" });
    await expect(call.closed).rejects.toMatchObject({ code: "ERR_RUNTIME" });
    expect(mock.attempts).toBe(1);
  });

  it("does not retry when resolution makes no structural context change", async () => {
    const mock = new MockBindingInvoker({ challengeAlways: true });
    const resolver = vi.fn(async () => ({ bearerToken: "same" }));
    const op = makeInvoker(mock, { contextResolver: resolver });
    const call = op.invoke(testInterface(), operationSignature("getUser"), {
      context: { bearerToken: "same" },
    });
    await call.write({ id: "u1" });
    await expect(call.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(mock.attempts).toBe(1);
  });

  it("caps resolve-and-retry rounds instead of looping forever", async () => {
    const mock = new MockBindingInvoker({ challengeAlways: true });
    const resolver = vi.fn(async () => ({ bearerToken: "never-enough" }));
    const op = makeInvoker(mock, { contextResolver: resolver });
    const call = op.invoke(testInterface(), operationSignature("getUser"));
    await call.write({ id: "u1" });
    await expect(call.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
    expect(resolver.mock.calls.length).toBeLessThanOrEqual(4);
    expect(mock.attempts).toBeLessThanOrEqual(5);
  });

  it("a mid-stream challenge surfaces (no retry after observable progress) [SS]", async () => {
    const mock = new MockBindingInvoker();
    const resolver = vi.fn(async () => ({ bearerToken: "tok" }));
    const op = makeInvoker(mock, { contextResolver: resolver });
    const call = op.invoke(testInterface(), operationSignature("watchOrders"), {
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
    const call = op.invoke(testInterface(), operationSignature("getUser"));
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
    const call = op.invoke(testInterface(), operationSignature("getUser"));
    await expect(call.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
    expect(mock.attempts).toBe(0);
  });

  it("rejects malformed preflight data before calling the resolver", async () => {
    const mock = new MockBindingInvoker();
    mock.prepareBinding = async () => ({
      target: "https://api.example.com",
      alternatives: [{ requirements: [] }],
    });
    const resolver = vi.fn(async () => ({ bearerToken: "must-not-run" }));
    const op = makeInvoker(mock, { contextResolver: resolver });
    const call = op.invoke(testInterface(), operationSignature("getUser"));

    await expect(call.closed).rejects.toMatchObject({ code: ERR_RUNTIME });
    expect(resolver).not.toHaveBeenCalled();
    expect(mock.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Abstract-boundary leak resistance
// ---------------------------------------------------------------------------

describe("abstract-boundary leak resistance", () => {
  it("does not relay binding-native failure evidence", async () => {
    const op = makeInvoker(new MockBindingInvoker({ nativeFailure: true }));
    const call = op.invoke(testInterface(), operationSignature("ping"));
    const error = await call.closed.catch((caught: unknown) => caught) as InvocationError;
    expect(error).toMatchObject({ code: "EXAMPLE_BINDING_FAILURE" });
    expect(Object.hasOwn(error, "diagnostics")).toBe(false);
  });

  it("does not expose a native metadata handle", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("ping"));
    expect(await collect(call.outputs)).toEqual([{ ok: true }]);
    expect(Object.hasOwn(call, "diagnostics")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// defaultBindingSelector (policy-neutral sole-candidate resolution)
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

  it("refuses several candidates despite deprecation and preference metadata", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { op: {} },
      sources: { s: { bindingSpec: "openapi@3.1", location: "x" } },
      bindings: {
        "op.deprecated": { operation: "op", source: "s", deprecated: true, preference: 10 },
        "op.fresh": { operation: "op", source: "s", preference: 1 },
      },
    };
    expect(() => defaultBindingSelector(iface, "op")).toThrow(
      BindingSelectionRequiredError,
    );
  });

  it("does not inherit source preference or use binding preference to choose", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { op: {} },
      sources: {
        plain: { bindingSpec: "f@1", location: "x" },
        // Source-level preference is retired core vocabulary and must be inert.
        boosted: { bindingSpec: "f@1", location: "y", preference: 100 },
      },
      bindings: {
        "op.declared": { operation: "op", source: "plain", preference: -5 },
        "op.undeclared": { operation: "op", source: "boosted" },
      },
    };
    expect(() => defaultBindingSelector(iface, "op")).toThrow(
      BindingSelectionRequiredError,
    );
  });

  it("does not use lexicographic binding-key order to choose", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { op: {} },
      sources: { s: { bindingSpec: "f@1", location: "x" } },
      bindings: {
        "op.b": { operation: "op", source: "s" },
        "op.a": { operation: "op", source: "s" },
      },
    };
    expect(() => defaultBindingSelector(iface, "op")).toThrow(
      BindingSelectionRequiredError,
    );
  });

  it("skips bindings whose binding spec no registered invoker can handle", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { op: {} },
      sources: {
        supported: { bindingSpec: "mock@1.0", location: "x" },
        unsupported: { bindingSpec: "exotic@9.9", location: "y" },
      },
      bindings: {
        "op.exotic": { operation: "op", source: "unsupported", preference: 10 },
        "op.plain": { operation: "op", source: "supported", preference: 0 },
      },
    };
    const { key } = defaultBindingSelector(iface, "op", new Set(["mock@1.0"]));
    expect(key).toBe("op.plain");
  });
});

// ---------------------------------------------------------------------------
// The consumer override: context.configuration.selection
// ---------------------------------------------------------------------------

describe("selection override (context.configuration.selection)", () => {
  it("the first invocable listed key supplies the caller's choice", async () => {
    const op = makeInvoker();
    // Default policy would pick getUser.main (declared 99 over declared 1);
    // the override routes to getUser.bad, whose wrong-shaped output proves
    // which binding ran.
    const call = op.invoke(testInterface(), operationSignature("getUser"), {
      context: { configuration: { selection: ["getUser.bad"] } },
    });
    await call.write({ id: "u1" });
    await expect(collect(call.outputs)).rejects.toMatchObject({ code: ERR_OPERATION_VALIDATION_FAILED });
  });

  it("skips undefined and wrong-operation keys; sole-candidate inference applies when none is invocable", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("getUser"), {
      context: { configuration: { selection: ["nope", "ping.main"] } },
    });
    await call.write({ id: "u1" });
    await expect(single(call.outputs)).resolves.toEqual({ id: "u1", name: "Ada" });
  });

  it("an explicit bindingKey bypasses the override entirely", async () => {
    const op = makeInvoker();
    const call = op.invoke(testInterface(), operationSignature("getUser"), {
      bindingKey: "getUser.main",
      context: { configuration: { selection: ["getUser.bad"] } },
    });
    await call.write({ id: "u1" });
    await expect(single(call.outputs)).resolves.toEqual({ id: "u1", name: "Ada" });
  });
});

describe("prepareOperation", () => {
  it("reports the resolved binding's requirements without invoking", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true, preflight: true });
    const op = makeInvoker(mock);
    const details = await op.prepareOperation(testInterface(), "getUser");
    expect(details).toEqual(BEARER_DETAILS);
    expect(mock.prepares).toBe(1);
    expect(mock.attempts).toBe(0);
  });

  it("narrows to satisfied when context is supplied", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true, preflight: true });
    const op = makeInvoker(mock);
    const details = await op.prepareOperation(testInterface(), "getUser", {
      context: { bearerToken: "tok" },
    });
    expect(details).toBeNull();
  });

  it("yields null when the format exposes no preparer", async () => {
    const op = makeInvoker(new MockBindingInvoker());
    await expect(op.prepareOperation(testInterface(), "getUser")).resolves.toBeNull();
  });

  it("shares invoke's resolution: alias-aware and pinned binding", async () => {
    const mock = new MockBindingInvoker({ requireBearer: true, preflight: true });
    const op = makeInvoker(mock);
    const details = await op.prepareOperation(testInterface(), "fetchUser", {
      bindingKey: "getUser.main",
    });
    expect(details).toEqual(BEARER_DETAILS);
  });

  it("throws synchronously on wiring failures, like invoke", () => {
    const op = makeInvoker(new MockBindingInvoker());
    expect(() => op.prepareOperation(testInterface(), "nope")).toThrow();
  });
});

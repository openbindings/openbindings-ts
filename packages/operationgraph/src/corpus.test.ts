/**
 * Conformance corpus adapter: runs this engine against the spec repository's
 * operation-graph corpus unmodified (execution fixtures with mocked
 * per-invocation operation behavior, and the OG-V validation fixtures).
 *
 * The corpus ROOT is located via OB_SPEC_CORPUS (the spec repo's
 * conformance/ directory, the convention shared by every other format
 * harness) or the local-dev sibling path (openbindings/spec next to
 * openbindings/openbindings-ts); this engine's fixtures live under the
 * operation-graph subcorpus, which the adapter appends. The suite skips
 * when it is absent.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import jsonata from "jsonata";
import type { BindingSpecInfo, OBInterface } from "@openbindings/core";
import type { BindingHandle, BindingInvocationArgs, Invocation, TransformEvaluatorWithBindings } from "@openbindings/invoke";
import {
  ERR_OPERATION_GRAPH_EXIT,
  ERR_SOURCE_LOAD_FAILED,
  InvocationError,
  InvocationImpl,
  OperationInvoker,
  single,
} from "@openbindings/invoke";
import { BINDING_SPEC } from "./constants.js";
import { OperationGraphInvoker } from "./invoker.js";
import { validate } from "./validate.js";
import type { Graph } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function corpusDir(): string | null {
  // OB_SPEC_CORPUS names the conformance corpus ROOT (the convention shared
  // by every other format harness); this engine's fixtures live under the
  // operation-graph subcorpus, which the adapter appends. Tolerate an env var
  // that already points at the subpath (an older invocation) so both resolve.
  const root =
    process.env.OB_SPEC_CORPUS ??
    resolve(__dirname, "..", "..", "..", "..", "spec", "conformance");
  const dir = basename(root) === "operation-graph" ? root : join(root, "operation-graph");
  return existsSync(dir) ? dir : null;
}

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

interface MockResponse {
  whenInput?: unknown;
  whenInputs?: unknown[];
  emit?: unknown[];
  fail?: string;
  failData?: unknown;
}

interface MockOp {
  onOpen?: { emit?: unknown[]; fail?: string; failData?: unknown };
  closesAfter?: number;
  responses: MockResponse[];
}

interface ExecFixture {
  id: string;
  name: string;
  operations?: Record<string, MockOp>;
  graph: Graph;
  writes: unknown[];
  awaitOutputsBeforeWrites?: number;
  expected: {
    output?: unknown[];
    ordering?: "exact" | "set";
    /**
     * "set" compares ARRAY-VALUED output events as multisets (element
     * order inside the array is implementation-defined — a buffer fed by
     * concurrent each invocations), while the event stream itself still
     * honors `ordering`. This engine's serial each produces array order
     * today, but the harness honors the corpus schema regardless.
     */
    arrayOrdering?: "set";
    error?: boolean;
    errorDetail?: unknown;
    refusedWrites?: number;
  };
}

interface ValidationRule {
  rule: string;
  title: string;
  tests: Array<{
    description: string;
    graph: Graph;
    valid: boolean;
    operations?: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Mock binding invoker: the fixtures' per-invocation operation model
// ---------------------------------------------------------------------------

const MOCK_FORMAT = "corpus-mock@1";

const canon = (v: unknown): string => JSON.stringify(sortKeys(v));

/**
 * Normalizes array-valued output events for arrayOrdering:set comparison:
 * each top-level array event's elements sort by canonical encoding
 * (multiset semantics); the event stream's own order is untouched.
 */
const sortArraysCanonically = (events: unknown[]): unknown[] =>
  events.map((ev) =>
    Array.isArray(ev) ? [...ev].sort((a, b) => (canon(a) < canon(b) ? -1 : 1)) : ev,
  );

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v ?? null;
}

/**
 * Serves fixture operations: an invocation collects writes (closing its
 * input from below after closesAfter reads, when set), then responds per the
 * first matching response rule.
 */
class MockBindingInvoker {
  constructor(private readonly ops: Record<string, MockOp>) {}

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: MOCK_FORMAT }];
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const opKey = args.binding?.operation ?? "";
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    const op = this.ops[opKey];
    if (!op) {
      inv.fireError(new InvocationError("ERR_NO_MOCK"));
      return inv as Invocation<I, O>;
    }
    // The controlled no-input mock closes from below as part of invocation
    // opening, before the caller can race a write. This is the direct-binding
    // behavior OG-EX-42 asks the graph wrapper to preserve.
    if (op.closesAfter === 0) void inv.closeInput();
    void this.serve(inv, op);
    return inv as Invocation<I, O>;
  }

  private async serve(
    handle: BindingHandle<unknown, unknown>,
    op: MockOp,
  ): Promise<void> {
    if (op.onOpen?.emit) {
      try {
        for (const value of op.onOpen.emit) await handle.emitOutput(value);
      } catch {
        return;
      }
    }
    if (op.onOpen?.fail !== undefined) {
      handle.fireError(
        Object.hasOwn(op.onOpen, "failData")
          ? new InvocationError(op.onOpen.fail, op.onOpen.failData)
          : new InvocationError(op.onOpen.fail),
      );
      return;
    }

    const writes: unknown[] = [];
    const limit = op.closesAfter ?? -1;
    if (limit !== 0) {
      try {
        for await (const v of handle.inputs()) {
          writes.push(v);
          if (limit > 0 && writes.length >= limit) break;
        }
      } catch {
        return; // invocation terminal
      }
    }
    if (limit >= 0) await handle.closeInput(); // the binding closes from below

    const resp = matchResponse(op, writes);
    if (!resp) {
      handle.fireError(
        new InvocationError("ERR_NO_MOCK"),
      );
      return;
    }
    // Emit any events first, so emit-then-fail fixtures (e.g. OG-EX-36)
    // produce their outputs before the terminal error — matching the Go
    // corpus mock and the JS reference runner.
    if (resp.emit) {
      try {
        for (const v of resp.emit) await handle.emitOutput(v);
      } catch {
        return;
      }
    }
    if (resp.fail !== undefined) {
      handle.fireError(
        Object.hasOwn(resp, "failData")
          ? new InvocationError(resp.fail, resp.failData)
          : new InvocationError(resp.fail),
      );
      return;
    }
    handle.closeOutput();
  }
}

function matchResponse(op: MockOp, writes: unknown[]): MockResponse | null {
  for (const r of op.responses) {
    if (r.whenInputs !== undefined) {
      if (canon(r.whenInputs) === canon(writes)) return r;
    } else if (r.whenInput !== undefined) {
      if (writes.length === 1 && canon(r.whenInput) === canon(writes[0])) return r;
    } else {
      return r; // wildcard
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSONata evaluator (the reference jsonata package; undefined results stay
// undefined, which the engine maps to TRANSFORM_UNDEFINED)
// ---------------------------------------------------------------------------

const jsonataEvaluator: TransformEvaluatorWithBindings = {
  evaluate(expression, data) {
    return this.evaluateWithBindings(expression, data, {});
  },
  async evaluateWithBindings(expression, data, bindings) {
    return jsonata(expression).evaluate(data, bindings);
  },
};

// ---------------------------------------------------------------------------
// Execution fixtures
// ---------------------------------------------------------------------------

const dir = corpusDir();

// OB_CORPUS_REQUIRED (set in CI) turns a missing corpus into a hard failure
// so a mis-wired path or missing checkout turns CI red instead of silently
// green; unset (local dev) the suites still skip.
if (!dir && process.env.OB_CORPUS_REQUIRED) {
  throw new Error(
    "operation-graph conformance corpus required (OB_CORPUS_REQUIRED is set) but not located; " +
      "set OB_SPEC_CORPUS to the spec repo's conformance dir",
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!dir)("conformance corpus: execution", () => {
  if (!dir) return;
  const execDir = join(dir, "execution");
  const fixtures: ExecFixture[] = readdirSync(execDir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .flatMap((n) => JSON.parse(readFileSync(join(execDir, n), "utf8")).fixtures as ExecFixture[]);

  for (const fx of fixtures) {
    it(`${fx.id} ${fx.name}`, async () => {
      const ops = fx.operations ?? {};

      // Synthetic OBI: one schema-less operation per mocked key, each bound
      // to the mock source, so conduit/each nodes route through the real
      // OperationInvoker (name resolution, binding selection) into the mock.
      const iface = {
        openbindings: "0.2.0",
        operations: {} as Record<string, object>,
        sources: { mock: { bindingSpec: MOCK_FORMAT, content: {} } },
        bindings: {} as Record<string, { operation: string; source: string }>,
      };
      for (const opKey of Object.keys(ops)) {
        iface.operations[opKey] = {};
        iface.bindings[`${opKey}.mock`] = { operation: opKey, source: "mock" };
      }

      const opInvoker = new OperationInvoker([new MockBindingInvoker(ops)], {
        transformEvaluator: jsonataEvaluator,
      });
      opInvoker.addBindingInvoker(new OperationGraphInvoker(opInvoker));

      const call = opInvoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: { graphs: { g: fx.graph } } },
        selector: "#/graphs/g",
        interface: iface as unknown as OBInterface,
      });

      const outputs: unknown[] = [];
      let refusedWrites = 0;

      // The fixture's caller. Writes are paced: after each write the caller
      // yields until either the graph back-closes the input side (then
      // remaining writes are refused at the boundary, per the spec) or a
      // short settle window passes. A write rejection IS the boundary
      // refusal, not a failure.
      const writer = (async () => {
        let closed = false;
        const watchClosed = call.inputClosed.then(() => {
          closed = true;
        });
        // The corpus schedule begins writes after graph startup. Yield through
        // the adapter's asynchronous source/selector/validation startup so an
        // immediately non-accepting inner session can back-close first.
        await Promise.race([watchClosed, sleep(0)]);
        while (
          fx.awaitOutputsBeforeWrites !== undefined &&
          outputs.length < fx.awaitOutputsBeforeWrites &&
          !closed
        ) {
          await Promise.race([watchClosed, sleep(1)]);
        }
        for (let i = 0; i < fx.writes.length; i++) {
          if (i > 0) await Promise.race([watchClosed, sleep(50)]);
          if (closed) {
            refusedWrites += fx.writes.length - i;
            return;
          }
          try {
            await call.write(fx.writes[i]);
          } catch {
            refusedWrites += fx.writes.length - i;
            return; // input closed from below (back-closure) or terminal
          }
        }
        try {
          await call.close();
        } catch {
          /* already terminal */
        }
      })();

      // Collect outputs to clean end or terminal.
      let terminal: InvocationError | undefined;
      try {
        for await (const out of call.outputs) outputs.push(out);
      } catch (err) {
        terminal = err as InvocationError;
      }
      await writer;

      if (fx.expected.refusedWrites !== undefined) {
        expect(refusedWrites).toBe(fx.expected.refusedWrites);
      }

      if (fx.expected.error) {
        expect(terminal, `expected terminal error, completed normally with ${canon(outputs)}`).toBeDefined();
        const detail = fx.expected.errorDetail;
        if (isAbstractTerminalRecord(detail)) {
          // An unhandled conduit terminal error preserves the complete
          // abstract record, including absent versus explicit-null data.
          expect(terminal!.code).toBe(detail.code);
          expect(Object.hasOwn(terminal!, "data")).toBe(Object.hasOwn(detail, "data"));
          if (Object.hasOwn(detail, "data")) expect(canon(terminal!.data)).toBe(canon(detail.data));
        } else {
          // An exit node with error:true: the event is the error detail.
          expect(terminal!.code).toBe(ERR_OPERATION_GRAPH_EXIT);
          expect(canon(terminal!.data)).toBe(canon(detail));
        }
      } else {
        expect(
          terminal,
          `graph terminated with ${terminal?.code}: ${terminal?.message}`,
        ).toBeUndefined();
      }

      let expected = fx.expected.output ?? [];
      let got = outputs;
      if (fx.expected.arrayOrdering === "set") {
        got = sortArraysCanonically(got);
        expected = sortArraysCanonically(expected);
      }
      if (fx.expected.ordering === "set") {
        expect(got.map(canon).sort()).toEqual(expected.map(canon).sort());
      } else {
        expect(canon(got)).toBe(canon(expected));
      }
    });
  }
});

function isAbstractTerminalRecord(value: unknown): value is { code: string; data?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string"
    && Object.keys(record).every((key) => key === "code" || key === "data");
}

// ---------------------------------------------------------------------------
// Validation fixtures
// ---------------------------------------------------------------------------

describe.skipIf(!dir)("conformance corpus: validation", () => {
  if (!dir) return;
  const rules: ValidationRule[] = JSON.parse(
    readFileSync(join(dir, "validation", "OG-VR.json"), "utf8"),
  ).rules;

  for (const rule of rules) {
    for (const test of rule.tests) {
      it(`${rule.rule}: ${test.description}`, () => {
        const opKeys = test.operations ? new Set(test.operations) : undefined;
        if (test.valid) {
          expect(() => validate(test.graph, opKeys)).not.toThrow();
        } else {
          expect(() => validate(test.graph, opKeys), rule.title).toThrow();
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Location-only source loading (FIX 6 / Go loadLocation parity)
// ---------------------------------------------------------------------------

describe("loadDocument: location-only sources", () => {
  // A minimal input -> operation -> output graph (mirrors corpus OG-EX-13).
  const GRAPH = {
    "openbindings.operation-graph": "0.2.0",
    nodes: {
      in: { type: "input" },
      get: { type: "operation", operation: "users.get" },
      out: { type: "output" },
    },
    edges: [
      { from: "in", to: "get" },
      { from: "get", to: "out" },
    ],
  } as unknown as Graph;

  const HOST_DOC = JSON.stringify({ graphs: { g: GRAPH } });

  // An interface that resolves the inner users.get operation to the mock.
  function makeInvoker(ops: Record<string, MockOp>) {
    const iface = {
      openbindings: "0.2.0",
      operations: {} as Record<string, unknown>,
      sources: { mock: { bindingSpec: MOCK_FORMAT, content: {} } },
      bindings: {} as Record<string, { operation: string; source: string }>,
    };
    for (const opKey of Object.keys(ops)) {
      iface.operations[opKey] = {};
      iface.bindings[`${opKey}.mock`] = { operation: opKey, source: "mock" };
    }
    const opInvoker = new OperationInvoker([new MockBindingInvoker(ops)]);
    opInvoker.addBindingInvoker(new OperationGraphInvoker(opInvoker));
    return { opInvoker, iface: iface as unknown as OBInterface };
  }

  const USERS_GET: Record<string, MockOp> = {
    "users.get": { closesAfter: 1, responses: [{ emit: [{ id: "u1", name: "Alice" }] }] },
  };

  function httpResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }

  it("fetches a graph document from an http location via args.fetch and runs it", async () => {
    const { opInvoker, iface } = makeInvoker(USERS_GET);
    const location = "https://graphs.example.com/host.json";
    const fetch = vi.fn(async () => httpResponse(HOST_DOC));

    const call = opInvoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC, location },
      selector: "#/graphs/g",
      interface: iface,
      fetch: fetch,
    });
    await call.write({ id: "u1" });
    await call.close();
    const out = await single(call.outputs);
    expect(out).toEqual({ id: "u1", name: "Alice" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe(location);
  });

  it("caches the fetched document by location (second invocation does not refetch)", async () => {
    const { opInvoker, iface } = makeInvoker(USERS_GET);
    const location = "https://graphs.example.com/cached.json";
    const fetch = vi.fn(async () => httpResponse(HOST_DOC));
    const ogInvoker = new OperationGraphInvoker(opInvoker);
    // Use a dedicated invoker instance so the docCache is observable in isolation.
    const args = (): Parameters<typeof ogInvoker.invokeBinding>[0] => ({
      source: { bindingSpec: BINDING_SPEC, location },
      selector: "#/graphs/g",
      interface: iface,
      fetch: fetch,
    });

    const run = async () => {
      const call = ogInvoker.invokeBinding(args());
      await call.write({ id: "u1" });
      await call.close();
      return single(call.outputs);
    };
    expect(await run()).toEqual({ id: "u1", name: "Alice" });
    expect(await run()).toEqual({ id: "u1", name: "Alice" });
    expect(fetch).toHaveBeenCalledTimes(1); // second run served from docCache
  });

  it("rejects a non-2xx response as ERR_SOURCE_LOAD_FAILED", async () => {
    const { opInvoker, iface } = makeInvoker(USERS_GET);
    const fetch = vi.fn(async () => httpResponse("not found", 404));
    const call = opInvoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC, location: "https://graphs.example.com/missing.json" },
      selector: "#/graphs/g",
      interface: iface,
      fetch: fetch,
    });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_SOURCE_LOAD_FAILED });
  });

  it("rejects a document exceeding the size bound as ERR_SOURCE_LOAD_FAILED", async () => {
    const { opInvoker, iface } = makeInvoker(USERS_GET);
    const huge = "x".repeat((8 << 20) + 1); // one byte past the 8 MiB bound
    const fetch = vi.fn(async () => httpResponse(huge));
    const call = opInvoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC, location: "https://graphs.example.com/huge.json" },
      selector: "#/graphs/g",
      interface: iface,
      fetch: fetch,
    });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_SOURCE_LOAD_FAILED });
  });

  it("rejects a source with neither location nor content as ERR_SOURCE_LOAD_FAILED", async () => {
    const { opInvoker, iface } = makeInvoker(USERS_GET);
    const call = opInvoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC },
      selector: "#/graphs/g",
      interface: iface,
    });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_SOURCE_LOAD_FAILED });
  });
});

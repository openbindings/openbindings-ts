import { describe, it, expect } from "vitest";
import {
  OperationInvoker,
  InvocationImpl,
  InvocationError,
  single,
  ERR_CANCELLED,
  ERR_MAP_NOT_ARRAY,
  ERR_OPERATION_GRAPH_EXIT,
  ERR_REF_NOT_FOUND,
  ERR_RUNTIME,
  ERR_SOURCE_LOAD_FAILED,
  ERR_VALIDATION_FAILED,
  type BindingInvocationArgs,
  type BindingInvoker,
  type Invocation,
  type OBInterface,
  type TransformEvaluator,
  type TransformEvaluatorWithBindings,
} from "@openbindings/sdk";
import { OperationGraphInvoker } from "./invoker.js";
import { FORMAT_TOKEN } from "./constants.js";
import { validate } from "./validate.js";
import type { Graph } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface GraphResult {
  outputs: unknown[];
  error?: InvocationError;
}

/**
 * Drives a graph invocation handle: writes the initial input (when defined),
 * closes input, and collects outputs. A terminal failure is returned rather
 * than thrown so tests can assert on both outputs and the error.
 */
async function drive(call: Invocation<unknown, unknown>, input: unknown): Promise<GraphResult> {
  try {
    if (input !== undefined) await call.write(input);
    await call.close();
  } catch {
    /* terminal failures surface on the outputs iteration */
  }
  const outputs: unknown[] = [];
  try {
    for await (const v of call.outputs) outputs.push(v);
  } catch (err) {
    return { outputs, error: err as InvocationError };
  }
  return { outputs };
}

function freshInvoker(
  transform?: TransformEvaluator,
  extra: BindingInvoker[] = [],
): OperationInvoker {
  const op = new OperationInvoker(extra, { transformEvaluator: transform });
  op.addBindingInvoker(new OperationGraphInvoker(op));
  return op;
}

async function invokeGraph(
  graphJSON: string,
  ref: string,
  input: unknown,
  invoker?: OperationInvoker,
): Promise<GraphResult> {
  const op = invoker ?? freshInvoker();
  const call = op.invokeBinding({
    source: { format: FORMAT_TOKEN, content: graphJSON },
    ref,
  });
  return drive(call, input);
}

async function invokeGraphWithTransform(
  graphJSON: string,
  ref: string,
  input: unknown,
  te: TransformEvaluator,
): Promise<GraphResult> {
  return invokeGraph(graphJSON, ref, input, freshInvoker(te));
}

async function readFirst<T>(it: AsyncIterable<T>): Promise<T | undefined> {
  for await (const v of it) return v;
  return undefined;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Mock JSONata-like evaluator used in the Go tests. With one bare-field
 * expression like `"items"`, returns `data.items`. With `"$input.foo"`,
 * returns `bindings.input.foo`.
 */
class MockTransformEvaluator implements TransformEvaluatorWithBindings {
  async evaluate(expression: string, data: unknown): Promise<unknown> {
    if (typeof data !== "object" || data === null) throw new Error("data is not a map");
    return (data as Record<string, unknown>)[expression];
  }
  async evaluateWithBindings(
    expression: string,
    data: unknown,
    bindings: Record<string, unknown>,
  ): Promise<unknown> {
    if (expression.startsWith("$input.")) {
      const field = expression.slice("$input.".length);
      const input = bindings.input;
      if (input && typeof input === "object") {
        return (input as Record<string, unknown>)[field];
      }
      return undefined;
    }
    return this.evaluate(expression, data);
  }
}

// ---------------------------------------------------------------------------
// Simple flow tests
// ---------------------------------------------------------------------------

describe("OperationGraphInvoker", () => {
  it("simple passthrough emits the input as output", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          pass: {
            nodes: {
              in: { type: "input" },
              out: { type: "output" },
            },
            edges: [{ from: "in", to: "out" }],
          },
        },
      }),
      "pass",
      { hello: "world" },
    );
    expect(res.error).toBeUndefined();
    expect(res.outputs.length).toBe(1);
    expect((res.outputs[0] as Record<string, unknown>).hello).toBe("world");
  });

  it("fails with ERR_REF_NOT_FOUND for an unknown graph key", async () => {
    const res = await invokeGraph(
      JSON.stringify({ "openbindings.operation-graph": "0.2.0", graphs: {} }),
      "missing",
      null,
    );
    expect(res.outputs.length).toBe(0);
    expect(res.error?.code).toBe(ERR_REF_NOT_FOUND);
  });

  it("fails with ERR_SOURCE_LOAD_FAILED for unparseable content", async () => {
    const res = await invokeGraph("{not json", "g", { x: 1 });
    expect(res.outputs.length).toBe(0);
    expect(res.error?.code).toBe(ERR_SOURCE_LOAD_FAILED);
  });

  it("validates the graph before reading input: an invalid graph fails without a write", async () => {
    const op = freshInvoker();
    const call = op.invokeBinding({
      source: {
        format: FORMAT_TOKEN,
        content: JSON.stringify({
          "openbindings.operation-graph": "0.2.0",
          // Invalid: no output node.
          graphs: { bad: { nodes: { in: { type: "input" } }, edges: [] } },
        }),
      },
      ref: "bad",
    });

    // The caller never writes nor closes; validation must terminate the
    // call anyway instead of parking on the input read.
    await expect(call.closed).rejects.toMatchObject({ code: ERR_VALIDATION_FAILED });
  });
});

// ---------------------------------------------------------------------------
// Exit semantics
// ---------------------------------------------------------------------------

describe("exit node", () => {
  it("emits the event and short-circuits on success", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          early: {
            nodes: {
              in: { type: "input" },
              check: { type: "filter", schema: { required: ["stop"] } },
              stop: { type: "exit" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "check" },
              { from: "check", to: "stop" },
              { from: "in", to: "out" },
            ],
          },
        },
      }),
      "early",
      { stop: true },
    );
    // At minimum one output carries the exit data — there may also be a
    // normal output depending on scheduling.
    expect(res.error).toBeUndefined();
    const hasStopEvent = res.outputs.some(
      (v) => typeof v === "object" && v !== null && (v as Record<string, unknown>).stop === true,
    );
    expect(hasStopEvent).toBe(true);
  });

  it("fails with ERR_OPERATION_GRAPH_EXIT when error: true", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          fail: {
            nodes: {
              in: { type: "input" },
              check: { type: "filter", schema: { required: ["fail"] } },
              die: { type: "exit", error: true },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "check" },
              { from: "check", to: "die" },
              { from: "in", to: "out" },
            ],
          },
        },
      }),
      "fail",
      { fail: true },
    );
    expect(res.error?.code).toBe(ERR_OPERATION_GRAPH_EXIT);
  });
});

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

describe("filter node", () => {
  it("passes events matching a schema", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          f: {
            nodes: {
              in: { type: "input" },
              check: { type: "filter", schema: { required: ["name"] } },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "check" },
              { from: "check", to: "out" },
            ],
          },
        },
      }),
      "f",
      { name: "Alice" },
    );
    expect(res.error).toBeUndefined();
    expect(res.outputs.length).toBe(1);
  });

  it("drops events that fail the schema", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          f: {
            nodes: {
              in: { type: "input" },
              check: { type: "filter", schema: { required: ["name"] } },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "check" },
              { from: "check", to: "out" },
            ],
          },
        },
      }),
      "f",
      { age: 30 },
    );
    expect(res.error).toBeUndefined();
    expect(res.outputs.length).toBe(0);
  });

  it("runs full JSON Schema (not just required) — minimum passes", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          f: {
            nodes: {
              in: { type: "input" },
              check: {
                type: "filter",
                schema: {
                  type: "object",
                  properties: { age: { type: "number", minimum: 18 } },
                  required: ["age"],
                },
              },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "check" },
              { from: "check", to: "out" },
            ],
          },
        },
      }),
      "f",
      { age: 25 },
    );
    expect(res.outputs.length).toBe(1);
  });

  it("runs full JSON Schema — minimum fails", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          f: {
            nodes: {
              in: { type: "input" },
              check: {
                type: "filter",
                schema: {
                  type: "object",
                  properties: { age: { type: "number", minimum: 18 } },
                  required: ["age"],
                },
              },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "check" },
              { from: "check", to: "out" },
            ],
          },
        },
      }),
      "f",
      { age: 12 },
    );
    expect(res.outputs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error routing
// ---------------------------------------------------------------------------

describe("onError", () => {
  it("silently drops errors when no onError is set", async () => {
    // Transform with no evaluator fails; no onError, so the error vanishes.
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              t: { type: "transform", transform: "x" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "t" },
              { from: "t", to: "out" },
            ],
          },
        },
      }),
      "g",
      { x: 1 },
    );
    expect(res.error).toBeUndefined();
    expect(res.outputs.length).toBe(0);
  });

  it("routes a failing event to the onError target", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              t: { type: "transform", transform: "x", onError: "out" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "t" },
              { from: "t", to: "out" },
            ],
          },
        },
      }),
      "g",
      { x: 1 },
    );
    expect(res.outputs.length).toBe(1);
    const data = res.outputs[0] as Record<string, unknown>;
    expect(data.error).toBeDefined();
    expect(data.input).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

describe("transform node", () => {
  it("applies the evaluator and emits the result", async () => {
    const res = await invokeGraphWithTransform(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              t: { type: "transform", transform: "name" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "t" },
              { from: "t", to: "out" },
            ],
          },
        },
      }),
      "g",
      { name: "Alice", age: 30 },
      new MockTransformEvaluator(),
    );
    expect(res.outputs.length).toBe(1);
    expect(res.outputs[0]).toBe("Alice");
  });

  it("provides $input via TransformEvaluatorWithBindings", async () => {
    const res = await invokeGraphWithTransform(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              t: { type: "transform", transform: "$input.original" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "t" },
              { from: "t", to: "out" },
            ],
          },
        },
      }),
      "g",
      { original: "from-input", other: "data" },
      new MockTransformEvaluator(),
    );
    expect(res.outputs.length).toBe(1);
    expect(res.outputs[0]).toBe("from-input");
  });
});

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

describe("buffer node", () => {
  it("drains a single event into a one-element array on completion", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              buf: { type: "buffer" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "buf" },
              { from: "buf", to: "out" },
            ],
          },
        },
      }),
      "g",
      { hello: "world" },
    );
    expect(res.outputs.length).toBe(1);
    expect(Array.isArray(res.outputs[0])).toBe(true);
    expect((res.outputs[0] as unknown[]).length).toBe(1);
  });

  it("flushes every `limit` events with a final partial batch", async () => {
    const res = await invokeGraphWithTransform(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              unpack: { type: "map", transform: "items" },
              buf: { type: "buffer", limit: 2 },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "unpack" },
              { from: "unpack", to: "buf" },
              { from: "buf", to: "out" },
            ],
          },
        },
      }),
      "g",
      { items: [1, 2, 3, 4, 5] },
      new MockTransformEvaluator(),
    );
    expect(res.outputs.length).toBe(3);
    const arrs = res.outputs.map((v) => v as unknown[]);
    expect(arrs[0].length).toBe(2);
    expect(arrs[1].length).toBe(2);
    expect(arrs[2].length).toBe(1);
  });

  it("flushes on `until` (excluding the matching event)", async () => {
    const res = await invokeGraphWithTransform(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              unpack: { type: "map", transform: "items" },
              buf: { type: "buffer", until: { required: ["stop"] } },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "unpack" },
              { from: "unpack", to: "buf" },
              { from: "buf", to: "out" },
            ],
          },
        },
      }),
      "g",
      {
        items: [{ v: 1 }, { v: 2 }, { stop: true }, { v: 3 }],
      },
      new MockTransformEvaluator(),
    );
    expect(res.outputs.length).toBe(2);
    expect((res.outputs[0] as unknown[]).length).toBe(2);
    expect((res.outputs[1] as unknown[]).length).toBe(1);
  });

  it("flushes on `through` (including the matching event)", async () => {
    const res = await invokeGraphWithTransform(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              unpack: { type: "map", transform: "items" },
              buf: { type: "buffer", through: { required: ["stop"] } },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "unpack" },
              { from: "unpack", to: "buf" },
              { from: "buf", to: "out" },
            ],
          },
        },
      }),
      "g",
      {
        items: [{ v: 1 }, { v: 2 }, { stop: true }, { v: 3 }],
      },
      new MockTransformEvaluator(),
    );
    expect(res.outputs.length).toBe(2);
    expect((res.outputs[0] as unknown[]).length).toBe(3);
    expect((res.outputs[1] as unknown[]).length).toBe(1);
  });

  it("propagates completion through filter to buffer", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              f: { type: "filter", schema: { required: ["name"] } },
              buf: { type: "buffer" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "f" },
              { from: "f", to: "buf" },
              { from: "buf", to: "out" },
            ],
          },
        },
      }),
      "g",
      { name: "Alice" },
    );
    expect(res.outputs.length).toBe(1);
    expect((res.outputs[0] as unknown[]).length).toBe(1);
  });

  it("emits nothing for an empty drain", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              f: { type: "filter", schema: { required: ["nope"] } },
              buf: { type: "buffer" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "f" },
              { from: "f", to: "buf" },
              { from: "buf", to: "out" },
            ],
          },
        },
      }),
      "g",
      { hello: "world" },
    );
    expect(res.error).toBeUndefined();
    expect(res.outputs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Combine (combineLatest semantics)
// ---------------------------------------------------------------------------

describe("combine node", () => {
  it("emits each time any source produces a new event", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              pathA: { type: "filter", schema: { required: ["a"] } },
              pathB: { type: "filter", schema: { required: ["b"] } },
              join: { type: "combine" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "pathA" },
              { from: "in", to: "pathB" },
              { from: "pathA", to: "join" },
              { from: "pathB", to: "join" },
              { from: "join", to: "out" },
            ],
          },
        },
      }),
      "g",
      { a: 1, b: 2 },
    );
    expect(res.outputs.length).toBe(2);
    const last = res.outputs[res.outputs.length - 1] as Record<string, unknown>;
    expect(last.pathA).not.toBeNull();
    expect(last.pathB).not.toBeNull();
  });

  it("leaves missing sources as null", async () => {
    const res = await invokeGraph(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              pathA: { type: "filter", schema: { required: ["a"] } },
              pathB: { type: "filter", schema: { required: ["b"] } },
              join: { type: "combine" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "pathA" },
              { from: "in", to: "pathB" },
              { from: "pathA", to: "join" },
              { from: "pathB", to: "join" },
              { from: "join", to: "out" },
            ],
          },
        },
      }),
      "g",
      { a: 1 },
    );
    expect(res.outputs.length).toBe(1);
    const result = res.outputs[0] as Record<string, unknown>;
    expect(result.pathA).not.toBeNull();
    expect(result.pathB).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

describe("map node", () => {
  it("unpacks an array into individual events", async () => {
    const res = await invokeGraphWithTransform(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              unpack: { type: "map", transform: "items" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "unpack" },
              { from: "unpack", to: "out" },
            ],
          },
        },
      }),
      "g",
      { items: ["a", "b", "c"] },
      new MockTransformEvaluator(),
    );
    expect(res.outputs.length).toBe(3);
    expect(res.outputs[0]).toBe("a");
    expect(res.outputs[1]).toBe("b");
    expect(res.outputs[2]).toBe("c");
  });

  it("routes ERR_MAP_NOT_ARRAY via onError when the result isn't an array", async () => {
    const res = await invokeGraphWithTransform(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              unpack: { type: "map", transform: "name", onError: "out" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "unpack" },
              { from: "unpack", to: "out" },
            ],
          },
        },
      }),
      "g",
      { name: "notanarray" },
      new MockTransformEvaluator(),
    );
    expect(res.outputs.length).toBe(1);
    const data = res.outputs[0] as Record<string, unknown>;
    expect(data.error).toBe(ERR_MAP_NOT_ARRAY);
  });
});

// ---------------------------------------------------------------------------
// Multi-stage composition
// ---------------------------------------------------------------------------

describe("multi-stage composition", () => {
  it("threads transform → buffer completion correctly", async () => {
    const res = await invokeGraphWithTransform(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              t: { type: "transform", transform: "name" },
              buf: { type: "buffer" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "t" },
              { from: "t", to: "buf" },
              { from: "buf", to: "out" },
            ],
          },
        },
      }),
      "g",
      { name: "Alice" },
      new MockTransformEvaluator(),
    );
    expect(res.outputs.length).toBe(1);
    const arr = res.outputs[0] as unknown[];
    expect(arr.length).toBe(1);
    expect(arr[0]).toBe("Alice");
  });

  it("threads map → buffer → combine across two paths", async () => {
    const res = await invokeGraphWithTransform(
      JSON.stringify({
        "openbindings.operation-graph": "0.2.0",
        graphs: {
          g: {
            nodes: {
              in: { type: "input" },
              mapA: { type: "map", transform: "a" },
              mapB: { type: "map", transform: "b" },
              bufA: { type: "buffer" },
              bufB: { type: "buffer" },
              join: { type: "combine" },
              out: { type: "output" },
            },
            edges: [
              { from: "in", to: "mapA" },
              { from: "in", to: "mapB" },
              { from: "mapA", to: "bufA" },
              { from: "mapB", to: "bufB" },
              { from: "bufA", to: "join" },
              { from: "bufB", to: "join" },
              { from: "join", to: "out" },
            ],
          },
        },
      }),
      "g",
      { a: [1, 2], b: [3, 4, 5] },
      new MockTransformEvaluator(),
    );
    expect(res.outputs.length).toBe(2);
    const result = res.outputs[res.outputs.length - 1] as Record<string, unknown>;
    expect((result.bufA as unknown[]).length).toBe(2);
    expect((result.bufB as unknown[]).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Operation nodes (sub-operation invocation through the OperationInvoker)
// ---------------------------------------------------------------------------

/**
 * Mock format invoker for sub-operations, built exactly like the SDK's
 * reference mock: the handle is constructed inert, the work is scheduled on
 * a microtask, inputs are read from the handle, outputs are emitted on it.
 */
class MockSubInvoker implements BindingInvoker {
  signals: AbortSignal[] = [];
  reads: unknown[] = [];

  formats() {
    return [{ token: "mock@1.0" }];
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    this.signals.push(inv.signal);
    queueMicrotask(() =>
      this.run(args, inv).catch((err) =>
        inv.fireError(
          err instanceof InvocationError
            ? err
            : new InvocationError(ERR_RUNTIME, err instanceof Error ? err.message : String(err)),
        ),
      ),
    );
    return inv as Invocation<I, O>;
  }

  private async run(
    args: BindingInvocationArgs,
    h: InvocationImpl<unknown, unknown>,
  ): Promise<void> {
    switch (args.ref) {
      case "double": {
        const first = await readFirst(h.inputs());
        void h.closeInput();
        this.reads.push(first);
        const v = (first as Record<string, unknown>)?.value as number;
        await h.emitOutput({ value: v * 2 });
        h.closeOutput();
        return;
      }
      case "stream3": {
        await readFirst(h.inputs());
        void h.closeInput();
        for (const n of [1, 2, 3]) await h.emitOutput({ n });
        h.closeOutput();
        return;
      }
      case "boom": {
        await readFirst(h.inputs());
        void h.closeInput();
        h.fireError(new InvocationError(ERR_RUNTIME, "sub-op exploded"));
        return;
      }
      case "hang": {
        // Emits nothing and never terminates on its own; the external
        // signal (graph cancellation) fires ERR_CANCELLED via the impl.
        return;
      }
      default:
        h.fireError(new InvocationError(ERR_RUNTIME, `unknown ref: ${args.ref}`));
    }
  }
}

function subOpsDoc(callNode: Record<string, unknown>): Record<string, unknown> {
  return {
    "openbindings.operation-graph": "0.2.0",
    graphs: {
      g: {
        nodes: {
          in: { type: "input" },
          call: callNode,
          out: { type: "output" },
        },
        edges: [
          { from: "in", to: "call" },
          { from: "call", to: "out" },
        ],
      },
    },
  };
}

function subOpsInterface(graphDoc: unknown): OBInterface {
  return {
    openbindings: "0.2.0",
    operations: {
      double: {},
      stream3: {},
      boom: {},
      hang: {},
      unbound: {},
    },
    sources: {
      mock: { format: "mock@1.0", location: "mem://mock" },
      graphs: { format: FORMAT_TOKEN, content: graphDoc },
    },
    bindings: {
      "double.main": { operation: "double", source: "mock", ref: "double" },
      "stream3.main": { operation: "stream3", source: "mock", ref: "stream3" },
      "boom.main": { operation: "boom", source: "mock", ref: "boom" },
      "hang.main": { operation: "hang", source: "mock", ref: "hang" },
      // "unbound" deliberately has no binding: invoke() throws synchronously.
    },
  };
}

function invokeSubOpsGraph(
  doc: Record<string, unknown>,
  op: OperationInvoker,
): Invocation<unknown, unknown> {
  return op.invokeBinding({
    source: { format: FORMAT_TOKEN, content: doc },
    ref: "g",
    interface: subOpsInterface(doc),
  });
}

describe("operation node", () => {
  it("invokes a unary sub-operation and routes its output downstream", async () => {
    const doc = subOpsDoc({ type: "operation", operation: "double" });
    const mock = new MockSubInvoker();
    const res = await drive(invokeSubOpsGraph(doc, freshInvoker(undefined, [mock])), { value: 21 });
    expect(res.error).toBeUndefined();
    expect(res.outputs).toEqual([{ value: 42 }]);
    expect(mock.reads).toEqual([{ value: 21 }]);
  });

  it("fans a streaming sub-operation out as individual events", async () => {
    const doc = subOpsDoc({ type: "operation", operation: "stream3" });
    const res = await drive(invokeSubOpsGraph(doc, freshInvoker(undefined, [new MockSubInvoker()])), { go: true });
    expect(res.error).toBeUndefined();
    expect(res.outputs).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("routes a sub-operation terminal failure to onError", async () => {
    const doc = subOpsDoc({ type: "operation", operation: "boom", onError: "out" });
    const res = await drive(invokeSubOpsGraph(doc, freshInvoker(undefined, [new MockSubInvoker()])), { value: 1 });
    expect(res.error).toBeUndefined();
    expect(res.outputs.length).toBe(1);
    const data = res.outputs[0] as Record<string, unknown>;
    expect(data.error).toBe("sub-op exploded");
    expect(data.input).toEqual({ value: 1 });
  });

  it("routes a synchronous invoke error (no binding) to onError", async () => {
    const doc = subOpsDoc({ type: "operation", operation: "unbound", onError: "out" });
    const res = await drive(invokeSubOpsGraph(doc, freshInvoker(undefined, [new MockSubInvoker()])), { value: 1 });
    expect(res.error).toBeUndefined();
    expect(res.outputs.length).toBe(1);
    const data = res.outputs[0] as Record<string, unknown>;
    expect(typeof data.error).toBe("string");
    expect(data.error as string).toContain("unbound");
  });

  it("cancelling the graph cancels in-flight sub-operations", async () => {
    const doc = subOpsDoc({ type: "operation", operation: "hang" });
    const mock = new MockSubInvoker();
    const call = invokeSubOpsGraph(doc, freshInvoker(undefined, [mock]));
    await call.write({});
    // Let the engine start the sub-invocation.
    await tick();
    expect(mock.signals.length).toBe(1);
    expect(mock.signals[0].aborted).toBe(false);
    await call.cancel();
    await expect(call.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
    expect(mock.signals[0].aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Input semantics through the operation layer
// ---------------------------------------------------------------------------

describe("operation-layer input semantics", () => {
  const passthroughDoc = {
    "openbindings.operation-graph": "0.2.0",
    graphs: {
      g: {
        nodes: { in: { type: "input" }, out: { type: "output" } },
        edges: [{ from: "in", to: "out" }],
      },
    },
  };

  function graphInterface(operation: Record<string, unknown>): OBInterface {
    return {
      openbindings: "0.2.0",
      operations: { run: operation },
      sources: { graphs: { format: FORMAT_TOKEN, content: passthroughDoc } },
      bindings: { "run.main": { operation: "run", source: "graphs", ref: "g" } },
    };
  }

  it("closes input on entry for a no-input operation (caller never writes)", async () => {
    const op = freshInvoker();
    const call = op.invoke({ interface: graphInterface({}), operation: "run" });
    // No write, no close — the binding closes input itself.
    await expect(single(call.outputs)).resolves.toBeUndefined();
    await expect(call.closed).resolves.toBeUndefined();
  });

  it("reads one caller input when the operation declares input", async () => {
    const op = freshInvoker();
    const call = op.invoke({
      interface: graphInterface({ input: { type: "object" } }),
      operation: "run",
    });
    await call.write({ hello: "graph" });
    // No close — the binding closes input after the first read.
    await expect(single(call.outputs)).resolves.toEqual({ hello: "graph" });
    await expect(call.closed).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validate()", () => {
  it("accepts a minimal valid graph", () => {
    const g: Graph = {
      nodes: { in: { type: "input" }, out: { type: "output" } },
      edges: [{ from: "in", to: "out" }],
    };
    expect(() => validate(g)).not.toThrow();
  });

  it("rejects a graph with no input", () => {
    const g: Graph = { nodes: { out: { type: "output" } }, edges: [] };
    expect(() => validate(g)).toThrow();
  });

  it("rejects an unguarded cycle", () => {
    const g: Graph = {
      nodes: {
        in: { type: "input" },
        op: { type: "operation", operation: "test.op" },
        out: { type: "output" },
      },
      edges: [
        { from: "in", to: "op" },
        { from: "op", to: "op" },
        { from: "op", to: "out" },
      ],
    };
    expect(() => validate(g)).toThrow();
  });

  it("accepts a cycle with maxIterations on an operation node", () => {
    const g: Graph = {
      nodes: {
        in: { type: "input" },
        op: { type: "operation", operation: "test.op", maxIterations: 10 },
        out: { type: "output" },
      },
      edges: [
        { from: "in", to: "op" },
        { from: "op", to: "op" },
        { from: "op", to: "out" },
      ],
    };
    expect(() => validate(g)).not.toThrow();
  });

  it("rejects orphan nodes", () => {
    const g: Graph = {
      nodes: {
        in: { type: "input" },
        out: { type: "output" },
        orphan: { type: "filter", schema: { required: ["x"] } },
      },
      edges: [{ from: "in", to: "out" }],
    };
    expect(() => validate(g)).toThrow();
  });

  it("rejects exit nodes with outgoing edges", () => {
    const g: Graph = {
      nodes: {
        in: { type: "input" },
        stop: { type: "exit" },
        out: { type: "output" },
        bad: { type: "output" },
      },
      edges: [
        { from: "in", to: "stop" },
        { from: "stop", to: "out" },
      ],
    };
    expect(() => validate(g)).toThrow();
  });
});

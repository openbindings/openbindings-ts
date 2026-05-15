import { describe, it, expect } from "vitest";
import { OperationInvoker, type TransformEvaluator, type TransformEvaluatorWithBindings, type InvocationOutput } from "@openbindings/sdk";
import { OperationGraphInvoker, FORMAT_TOKEN } from "./invoker.js";
import { validate } from "./validate.js";
import type { Graph } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function collect(stream: AsyncIterable<InvocationOutput>): Promise<InvocationOutput[]> {
  const out: InvocationOutput[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

function freshInvoker(transform?: TransformEvaluator): OperationInvoker {
  const op = new OperationInvoker([], { transformEvaluator: transform });
  op.addBindingInvoker(new OperationGraphInvoker(op));
  return op;
}

async function invokeGraph(
  graphJSON: string,
  ref: string,
  input: unknown,
  invoker?: OperationInvoker,
): Promise<InvocationOutput[]> {
  const op = invoker ?? freshInvoker();
  const stream = op.invokeBinding({
    source: { format: FORMAT_TOKEN, content: graphJSON },
    ref,
    input,
  });
  return collect(stream);
}

async function invokeGraphWithTransform(
  graphJSON: string,
  ref: string,
  input: unknown,
  te: TransformEvaluator,
): Promise<InvocationOutput[]> {
  return invokeGraph(graphJSON, ref, input, freshInvoker(te));
}

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
    const events = await invokeGraph(
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
    expect(events.length).toBe(1);
    expect(events[0].error).toBeUndefined();
    expect((events[0].output as Record<string, unknown>).hello).toBe("world");
  });

  it("returns ref_not_found for an unknown graph key", async () => {
    const events = await invokeGraph(
      JSON.stringify({ "openbindings.operation-graph": "0.2.0", graphs: {} }),
      "missing",
      null,
    );
    expect(events.length).toBe(1);
    expect(events[0].error?.code).toBe("ref_not_found");
  });
});

// ---------------------------------------------------------------------------
// Exit semantics
// ---------------------------------------------------------------------------

describe("exit node", () => {
  it("emits the event and short-circuits on success", async () => {
    const events = await invokeGraph(
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
    // At minimum one event has the exit data — there may also be a normal
    // output event depending on scheduling.
    const hasStopEvent = events.some(
      (ev) => !ev.error && typeof ev.output === "object" && ev.output !== null && (ev.output as Record<string, unknown>).stop === true,
    );
    expect(hasStopEvent).toBe(true);
  });

  it("emits operation_graph_exit when error: true", async () => {
    const events = await invokeGraph(
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
    const hasErrorExit = events.some((ev) => ev.error?.code === "operation_graph_exit");
    expect(hasErrorExit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

describe("filter node", () => {
  it("passes events matching a schema", async () => {
    const events = await invokeGraph(
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
    expect(events.length).toBe(1);
  });

  it("drops events that fail the schema", async () => {
    const events = await invokeGraph(
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
    expect(events.length).toBe(0);
  });

  it("runs full JSON Schema (not just required) — minimum passes", async () => {
    const events = await invokeGraph(
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
    expect(events.length).toBe(1);
  });

  it("runs full JSON Schema — minimum fails", async () => {
    const events = await invokeGraph(
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
    expect(events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error routing
// ---------------------------------------------------------------------------

describe("onError", () => {
  it("silently drops errors when no onError is set", async () => {
    // Transform with no evaluator fails; no onError, so the error vanishes.
    const events = await invokeGraph(
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
    expect(events.length).toBe(0);
  });

  it("routes a failing event to the onError target", async () => {
    const events = await invokeGraph(
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
    expect(events.length).toBe(1);
    const data = events[0].output as Record<string, unknown>;
    expect(data.error).toBeDefined();
    expect(data.input).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

describe("transform node", () => {
  it("applies the evaluator and emits the result", async () => {
    const events = await invokeGraphWithTransform(
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
    expect(events.length).toBe(1);
    expect(events[0].output).toBe("Alice");
  });

  it("provides $input via TransformEvaluatorWithBindings", async () => {
    const events = await invokeGraphWithTransform(
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
    expect(events.length).toBe(1);
    expect(events[0].output).toBe("from-input");
  });
});

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

describe("buffer node", () => {
  it("drains a single event into a one-element array on completion", async () => {
    const events = await invokeGraph(
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
    expect(events.length).toBe(1);
    expect(Array.isArray(events[0].output)).toBe(true);
    expect((events[0].output as unknown[]).length).toBe(1);
  });

  it("flushes every `limit` events with a final partial batch", async () => {
    const events = await invokeGraphWithTransform(
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
    expect(events.length).toBe(3);
    const arrs = events.map((ev) => ev.output as unknown[]);
    expect(arrs[0].length).toBe(2);
    expect(arrs[1].length).toBe(2);
    expect(arrs[2].length).toBe(1);
  });

  it("flushes on `until` (excluding the matching event)", async () => {
    const events = await invokeGraphWithTransform(
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
    expect(events.length).toBe(2);
    expect((events[0].output as unknown[]).length).toBe(2);
    expect((events[1].output as unknown[]).length).toBe(1);
  });

  it("flushes on `through` (including the matching event)", async () => {
    const events = await invokeGraphWithTransform(
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
    expect(events.length).toBe(2);
    expect((events[0].output as unknown[]).length).toBe(3);
    expect((events[1].output as unknown[]).length).toBe(1);
  });

  it("propagates completion through filter to buffer", async () => {
    const events = await invokeGraph(
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
    expect(events.length).toBe(1);
    expect((events[0].output as unknown[]).length).toBe(1);
  });

  it("emits nothing for an empty drain", async () => {
    const events = await invokeGraph(
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
    expect(events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Combine (combineLatest semantics)
// ---------------------------------------------------------------------------

describe("combine node", () => {
  it("emits each time any source produces a new event", async () => {
    const events = await invokeGraph(
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
    expect(events.length).toBe(2);
    const last = events[events.length - 1].output as Record<string, unknown>;
    expect(last.pathA).not.toBeNull();
    expect(last.pathB).not.toBeNull();
  });

  it("leaves missing sources as null", async () => {
    const events = await invokeGraph(
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
    expect(events.length).toBe(1);
    const result = events[0].output as Record<string, unknown>;
    expect(result.pathA).not.toBeNull();
    expect(result.pathB).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

describe("map node", () => {
  it("unpacks an array into individual events", async () => {
    const events = await invokeGraphWithTransform(
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
    expect(events.length).toBe(3);
    expect(events[0].output).toBe("a");
    expect(events[1].output).toBe("b");
    expect(events[2].output).toBe("c");
  });

  it("routes map_not_array via onError when the result isn't an array", async () => {
    const events = await invokeGraphWithTransform(
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
    expect(events.length).toBe(1);
    const data = events[0].output as Record<string, unknown>;
    expect(data.error).toBe("map_not_array");
  });
});

// ---------------------------------------------------------------------------
// Multi-stage composition
// ---------------------------------------------------------------------------

describe("multi-stage composition", () => {
  it("threads transform → buffer completion correctly", async () => {
    const events = await invokeGraphWithTransform(
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
    expect(events.length).toBe(1);
    const arr = events[0].output as unknown[];
    expect(arr.length).toBe(1);
    expect(arr[0]).toBe("Alice");
  });

  it("threads map → buffer → combine across two paths", async () => {
    const events = await invokeGraphWithTransform(
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
    expect(events.length).toBe(2);
    const result = events[events.length - 1].output as Record<string, unknown>;
    expect((result.bufA as unknown[]).length).toBe(2);
    expect((result.bufB as unknown[]).length).toBe(3);
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

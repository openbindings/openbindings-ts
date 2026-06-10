# @openbindings/operationgraph

Operation-graph binding invoker for OpenBindings. Composes existing operations on the same OBI into a graph: a new operation whose binding is a graph of nodes that fan-in, fan-out, filter, transform, and combine results from other operations.

Implements the `openbindings.operation-graph` companion format, currently at `@0.2.0`. See [`spec/formats/operation-graph/`](https://github.com/openbindings/spec/tree/main/formats/operation-graph) for the full format specification.

## Install

```bash
npm install @openbindings/operationgraph
```

## What it does

An operation-graph binding lets you define a new operation in terms of existing ones, declaratively:

```
input ── transform ── operation A
                 └─── operation B ── filter ── exit
```

Each node has a type (`input`, `output`, `operation`, `transform`, `filter`, `buffer`, `map`, `combine`, `exit`), an optional schema or JSONata expression, and edges to downstream nodes. The engine drives the graph mailbox-style: each node runs in its own async loop, processing events from upstream and emitting events downstream, until the `output` node yields the final stream or an `exit` node terminates the graph.

This is what powers "I want one OBI operation that calls three underlying operations and stitches their results together" without writing imperative orchestration code in your service.

## Usage

The invoker needs a reference to the `OperationInvoker` so its `operation` nodes can recurse into other operations on the same OBI. Because the dependency is mutual, register it after construction:

```typescript
import { OperationInvoker } from "@openbindings/sdk";
import { OperationGraphInvoker } from "@openbindings/operationgraph";
import { OpenAPIInvoker } from "@openbindings/openapi";

const operationInvoker = new OperationInvoker([new OpenAPIInvoker()]);
const operationGraph = new OperationGraphInvoker(operationInvoker);
operationInvoker.addBindingInvoker(operationGraph);
```

After that, the operation-graph invoker behaves like any other format invoker. Operations whose bindings reference an `openbindings.operation-graph@0.2.0` source route to it; that source's `graphs` map is keyed by ref.

```typescript
const call = operationInvoker.invoke({
  interface: iface,
  operation: "summarizeOrder",
});
await call.write({ orderId: "abc123" }); // the binding closes input after the first read

for await (const event of call.outputs) {
  console.log(event);
}
// Terminal failures (including exit-node errors) throw from the iteration
// as InvocationError, e.g. with code ERR_OPERATION_GRAPH_EXIT.
```

## Conventions

- **Format token**: `openbindings.operation-graph@0.2.0`
- **Source `location`**: usually empty; graphs are typically inline in `content`
- **Source `content`**: a JSON document with a top-level `graphs` map keyed by graph name
- **Binding `ref`**: the key of the graph within `source.content.graphs`

## Source shape

```json
{
  "graphs": {
    "summarizeOrder": {
      "nodes": {
        "in": { "type": "input" },
        "fetch": {
          "type": "operation",
          "operation": "getOrder",
          "input": "{ \"id\": orderId }"
        },
        "summarize": {
          "type": "transform",
          "transform": "{ \"id\": id, \"total\": items.price ~> $sum() }"
        },
        "out": { "type": "output" }
      },
      "edges": [
        { "from": "in", "to": "fetch" },
        { "from": "fetch", "to": "summarize" },
        { "from": "summarize", "to": "out" }
      ]
    }
  }
}
```

`transform` fields are bare JSONata expression strings, matching the core OpenBindings spec v0.2.

## Engine invariants

- **`MAX_EVENTS = 100_000`** events per invocation. Prevents runaway graphs (recursive operation nodes, unbounded buffers) from consuming unbounded memory.
- **`MAX_ERROR_DEPTH = 32`** for `onError` chains. Errors in error-handling paths are bounded so a misconfigured graph cannot loop forever.
- **Per-node mailboxes**: each node consumes from its own AsyncQueue; caller-facing backpressure comes from the engine awaiting `emitOutput` on the invocation handle.

These match the Go reference invoker's invariants and are validated by the same conformance corpus.

## How it works

1. The invoker receives `BindingInvocationArgs` with a source whose format is `openbindings.operation-graph@0.2.0` and returns an `Invocation` handle synchronously; the graph's work is scheduled on a microtask.
2. It parses the source's `content` as a `Document`, validates against the format schema, and looks up the graph by `ref`.
3. The graph's initial event is the first message written to the handle (the invoker closes the input side after reading it; for operations that declare no input it closes input on entry and seeds `undefined`).
4. An `Engine` instance is constructed with the graph plus the parent `OperationInvoker` (for recursing into `operation` nodes) and the OBI's transform evaluator. The engine seeds the `input` node, then spins up an async loop per node. Each loop reads from its mailbox, applies its node-type logic, and pushes events to downstream mailboxes.
5. Events flowing into the `output` node are emitted on the handle (`emitOutput`, with backpressure). An event flowing into an `exit` node terminates the graph: normally on success, or with a terminal `InvocationError` of code `ERR_OPERATION_GRAPH_EXIT` when the node sets `error: true`. Cancelling the handle aborts the engine and any in-flight sub-operations.

## License

Apache-2.0

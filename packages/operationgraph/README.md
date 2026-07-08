# @openbindings/operationgraph

Operation-graph binding invoker for OpenBindings. Composes existing operations on the same OBI into a graph: a new operation whose binding is a graph of nodes that fan-in, fan-out, filter, transform, and combine results from other operations.

Implements the `openbindings.operation-graph` companion format at `@0.2.0` (the transparency rewrite), governed by the identity law: `input → operation(y) → output` is observationally indistinguishable from invoking `y` directly. See [`spec/formats/operation-graph/`](https://github.com/openbindings/spec/tree/main/formats/operation-graph) for the full format specification.

## Install

```bash
npm install @openbindings/operationgraph
```

## What it does

An operation-graph binding lets you define a new operation in terms of existing ones, declaratively:

```
input ── operation A ── map ── each B ── buffer ── output
```

Each node has a type (`input`, `output`, `operation`, `each`, `transform`, `filter`, `buffer`, `map`, `combine`, `exit`), an optional schema or JSONata expression, and edges to downstream nodes. Two node types invoke operations, reflecting the two liftings of an operation over a stream:

- **`operation`** is the conduit: one held invocation per graph invocation, fed every arriving event in order — the node that makes the trivial wrapper transparent at every cardinality (no-input, unary, streaming, bidirectional).
- **`each`** opens one invocation per arriving event — the per-item node; `maxIterations` lives here and bounds cycles per event lineage.

The engine drives the graph mailbox-style: each node runs in its own async loop, processing events from upstream and emitting events downstream, until the graph completes or an `exit` node terminates it.

## Usage

The invoker needs a reference to the `OperationInvoker` so its `operation` and `each` nodes can recurse into other operations on the same OBI. Because the dependency is mutual, register it after construction:

```typescript
import { OperationInvoker, operationSignature } from "@openbindings/sdk";
import { OperationGraphInvoker } from "@openbindings/operationgraph";
import { OpenAPIInvoker } from "@openbindings/openapi";

const operationInvoker = new OperationInvoker([new OpenAPIInvoker()]);
const operationGraph = new OperationGraphInvoker(operationInvoker);
operationInvoker.addBindingInvoker(operationGraph);
```

After that, the operation-graph invoker behaves like any other format invoker. Caller writes stream into the graph (each write becomes one event at the `input` node, rooting a lineage); the graph back-closes the caller's input side when its contents stop accepting input (e.g. the trivial unary wrapper closes after the first write, exactly like direct invocation):

```typescript
const call = operationInvoker.invoke(iface, operationSignature("summarizeOrder"));
await call.write({ orderId: "abc123" }); // a unary wrapper back-closes input here

for await (const event of call.outputs) {
  console.log(event);
}
// Terminal failures throw from the iteration as InvocationError: an exit
// node with error:true (code ERR_OPERATION_GRAPH_EXIT, details = the event),
// or an unhandled terminal error on an operation conduit, surfaced verbatim.
```

## Conventions

- **Format token**: `openbindings.operation-graph@0.2.0`
- **Binding `ref`**: a REQUIRED JSON Pointer fragment addressing the graph definition within the source document (`"#/graphs/summarizeOrder"`, or `"#"` for a document whose root is a graph). Bare graph keys are rejected.
- **Source document**: any JSON document; the conventional shape is a top-level `graphs` map. Each graph declares its own `openbindings.operation-graph` version, refused per OG-T-02 when unsupported.

## Source shape

```json
{
  "graphs": {
    "summarizeOrder": {
      "openbindings.operation-graph": "0.2.0",
      "nodes": {
        "in": { "type": "input" },
        "fetch": { "type": "operation", "operation": "getOrder" },
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

`transform` fields are bare JSONata expression strings; `$` is the current event and `$input` the lineage's root input.

## Error model

Per the spec, error policy follows the two liftings:

- **Per-event failures** (`each` invocation errors, `WRITE_REJECTED` at a non-accepting conduit, `MAP_NOT_ARRAY`, `TRANSFORM_UNDEFINED`) route an `{error, event}` event via `onError`, or drop silently.
- **Conduit terminal errors** are fatal by default: an unhandled terminal error on an `operation` node terminates the graph invocation with the inner error verbatim (the identity law's terminal-status clause); `onError` on the node opts it into in-graph handling instead (the error event then carries no `event` member).

## Engine invariants

- **`MAX_EVENTS = 100_000`** events per invocation (the spec's amplification backstop).
- **`MAX_ERROR_DEPTH = 32`** for `onError` chains, as defense in depth; the normative bound is lineage (`onError` routes count as cycle edges).
- **Per-node mailboxes**: each node consumes from its own AsyncQueue; backpressure comes from the engine awaiting `emitOutput` on the invocation handle.
- **Quiescence completion**: cyclic (and error-route-fed) completion resolves once nothing is in flight, per the spec's implementation-defined drain detection.

## Conformance

The test suite runs the spec repository's conformance corpus unmodified — 19 execution fixtures (including the identity-law suite across no-input, unary, client-streaming, and terminal-error scenarios) plus the OG-V validation fixtures — through the real `OperationInvoker` against a mock binding invoker. Point `OB_SPEC_CORPUS` at `spec/conformance/operation-graph` (or keep the local-dev sibling layout) and run `pnpm test`.

## License

Apache-2.0

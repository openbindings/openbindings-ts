# @openbindings/sdk

Core TypeScript SDK for the [OpenBindings](https://openbindings.com) specification. Parse, validate, resolve, and invoke OpenBindings interfaces.

OpenBindings is an open standard: one interface, limitless bindings. An OBI (OpenBindings Interface) document describes what operations a service offers and how to reach them, independent of protocol. See the [spec](https://github.com/openbindings/spec) and [guides](https://github.com/openbindings/spec/tree/main/guides) for details.

**Spec version:** implements OpenBindings 0.2. Exact range is exported as `MIN_SUPPORTED_VERSION` / `MAX_TESTED_VERSION`; check programmatically via `isSupportedVersion(version)`.

**Conformance:** `parseDocument(data)` rejects malformed JSON and duplicate object keys (OBI-D-01), then `validateInterface(iface)` enforces OBI-D-02 through OBI-D-13 and OBI-T-04. OBI-D-02 (document validates against `openbindings.schema.json`) and OBI-D-12 (examples validate against their operation's input/output schemas) are enforced via [@cfworker/json-schema](https://github.com/cfworker/cfworker/tree/main/packages/json-schema) (JSON Schema 2020-12). The schema is embedded at build time (synced via `scripts/sync-schema.sh`). In this monorepo, run `pnpm conformance` with the spec repo checked out at `./spec` or `../spec` to exercise the core conformance corpus.

## Install

```
npm install @openbindings/sdk
```

## What this package does

- **Core types** for OpenBindings interface documents: operations, bindings, sources, transforms, schemas, roles
- **Validation** with shape-level checks, strict mode for unknown fields, and format token validation
- **Schema compatibility** checking (reference-tooling profile, not part of the spec) with covariant/contravariant directionality and diagnostic reasons
- **`fetchInterface`** for resolving OBIs from URLs (well-known discovery, then synthesis from raw OpenAPI / AsyncAPI / etc. via supplied creators)
- **`OperationInvoker`** that dispatches operations to per-format binding invokers and applies transforms
- **`ContextStore`** for per-host credential persistence with scheme-agnostic key normalization

The SDK defines the contracts that binding invokers implement but does not contain any format-specific logic. Format support is added by installing invoker packages like [`@openbindings/openapi`](https://www.npmjs.com/package/@openbindings/openapi) or [`@openbindings/asyncapi`](https://www.npmjs.com/package/@openbindings/asyncapi).

## Quick start

```typescript
import { OperationInvoker, MemoryStore, fetchInterface } from "@openbindings/sdk";
import { OpenAPIInvoker, OpenAPICreator } from "@openbindings/openapi";

const opInvoker = new OperationInvoker(
  [new OpenAPIInvoker()],
  { contextStore: new MemoryStore() },
);

const { iface } = await fetchInterface("https://api.example.com", {
  creators: [new OpenAPICreator()],
});

for await (const event of opInvoker.invoke({
  interface: iface,
  operation: "listItems",
  input: { limit: 10 },
})) {
  if (event.error) {
    console.error(event.error.message);
    break;
  }
  console.log(event.output);
}
```

For typed methods per operation, run `ob codegen <obi> --lang typescript` to produce a `<Name>Invoker` class that wraps an `OperationInvoker` and provides one method per operation.

See the [monorepo README](https://github.com/openbindings/openbindings-ts#readme) for full documentation.

## Transforms (invoking tools only)

OpenBindings 0.2.0 mandates JSONata 2.0 as the transform language for tools that evaluate `inputTransform`/`outputTransform` (OBI-T-10). This SDK does not bundle a JSONata runtime; tools that only parse, validate, inspect, or generate code do not need one, and shipping it as a hard dependency would tax those callers. To evaluate transforms when invoking, install `jsonata` separately and pass an adapter implementing the `TransformEvaluator` interface:

```typescript
import jsonata from "jsonata";
import { OperationInvoker, type TransformEvaluator } from "@openbindings/sdk";

const transformEvaluator: TransformEvaluator = {
  evaluate: (expression, data) => jsonata(expression).evaluate(data),
};

const invoker = new OperationInvoker([/* invokers */], { transformEvaluator });
```

OBIs that declare no transforms require no runtime; calls to operations whose bindings carry transforms will surface `NoTransformEvaluatorError` if no evaluator is configured.

## License

Apache-2.0

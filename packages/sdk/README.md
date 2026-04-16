# @openbindings/sdk

Core TypeScript SDK for the [OpenBindings](https://openbindings.com) specification. Parse, validate, resolve, and execute OpenBindings interfaces.

OpenBindings is an open standard: one interface, limitless bindings. An OBI (OpenBindings Interface) document describes what operations a service offers and how to reach them, independent of protocol. See the [spec](https://github.com/openbindings/spec) and [guides](https://github.com/openbindings/spec/tree/main/guides) for details.

**Spec version:** implements OpenBindings 0.1. Exact range is exported as `MIN_SUPPORTED_VERSION` / `MAX_TESTED_VERSION`; check programmatically via `isSupportedVersion(version)`.

## Install

```
npm install @openbindings/sdk
```

## What this package does

- **Core types** for OpenBindings interface documents: operations, bindings, sources, transforms, schemas, roles
- **Validation** with shape-level checks, strict mode for unknown fields, and format token validation
- **Schema compatibility** checking (Profile v0.1) with covariant/contravariant directionality and diagnostic reasons
- **InterfaceClient** for resolving OBIs from URLs, well-known discovery, or synthesis from raw specs
- **OperationExecutor** for routing operations to binding executors by format, with transform support
- **Context store** for per-host credential persistence with scheme-agnostic key normalization

The SDK defines the contracts that binding executors implement but does not contain any format-specific logic. Format support is added by installing executor packages like [`@openbindings/openapi`](https://www.npmjs.com/package/@openbindings/openapi) or [`@openbindings/asyncapi`](https://www.npmjs.com/package/@openbindings/asyncapi).

## Quick start

```typescript
import { InterfaceClient, OperationExecutor, MemoryStore } from "@openbindings/sdk";
import { OpenAPIExecutor, OpenAPICreator } from "@openbindings/openapi";

const exec = new OperationExecutor([new OpenAPIExecutor(), new OpenAPICreator()]);
const client = new InterfaceClient(null, exec, {
  contextStore: new MemoryStore(),
});

await client.resolve("https://api.example.com");

for await (const event of client.execute("listItems", { limit: 10 })) {
  if (event.error) {
    console.error(event.error.message);
    break;
  }
  console.log(event.data);
}
```

See the [monorepo README](https://github.com/openbindings/openbindings-ts#readme) for full documentation.

## License

Apache-2.0

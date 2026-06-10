# openbindings-ts

TypeScript SDK for the [OpenBindings](https://openbindings.com) specification. Parse, validate, resolve, and invoke OpenBindings interfaces from TypeScript and JavaScript.

OpenBindings is an open standard: one interface, limitless bindings. An OBI (OpenBindings Interface) document describes what operations a service offers and how to reach them, independent of protocol. See the [spec](https://github.com/openbindings/spec) and [guides](https://github.com/openbindings/spec/tree/main/guides) for details.

## Packages

| Package | Description | Install |
|---------|-------------|---------|
| `@openbindings/sdk` | Core types, validation, compatibility, invocation | `npm install @openbindings/sdk` |
| `@openbindings/openapi` | OpenAPI 3.x binding invoker and interface creator | `npm install @openbindings/openapi` |
| `@openbindings/asyncapi` | AsyncAPI 3.x binding invoker and interface creator | `npm install @openbindings/asyncapi` |
| `@openbindings/mcp` | MCP binding invoker and interface creator | `npm install @openbindings/mcp` |
| `@openbindings/graphql` | GraphQL binding invoker and interface creator | `npm install @openbindings/graphql` |
| `@openbindings/operationgraph` | Operation-graph binding invoker (compose operations) | `npm install @openbindings/operationgraph` |
| `@openbindings/workers-rpc` | Cloudflare Workers RPC binding invoker | `npm install @openbindings/workers-rpc` |

## What the SDK does

- **Core types** for the OpenBindings interface document: operations, bindings, sources, transforms, schemas, roles
- **Validation** with shape-level checks, strict mode for unknown fields, and format token validation
- **Schema compatibility** checking under the OpenBindings Profile v0.1 (covariant outputs, contravariant inputs) with diagnostic reasons
- **`fetchInterface`** for resolving OBIs from URLs (well-known discovery, follows redirects, validates the result)
- **`OperationInvoker`** for routing operations to binding invokers by format, with transform support
- **Context store** for per-host credential persistence with scheme-agnostic key normalization

The SDK defines the contracts that binding invokers implement but does not contain any format-specific logic itself. Format support is added by installing format packages.

## Conformance

The core SDK is tested against the OpenBindings 0.2 conformance corpus. With the spec repo checked out at `./spec` or `../spec`, run:

```bash
pnpm conformance
```

## Quick start

### Parse and validate an OBI

```typescript
import { parseDocument } from "@openbindings/sdk";

const iface = parseDocument(data); // rejects duplicate JSON keys and throws ValidationError if invalid

console.log(iface.name, iface.version);
for (const [name, op] of Object.entries(iface.operations)) {
  console.log(name, op.description);
}
```

### Resolve and invoke operations

```typescript
import { OperationInvoker, MemoryStore, storeContextResolver, fetchInterface } from "@openbindings/sdk";
import { OpenAPIInvoker } from "@openbindings/openapi";

// Create an operation invoker with format support
const operationInvoker = new OperationInvoker(
  [new OpenAPIInvoker()],
  { contextResolver: storeContextResolver(new MemoryStore()) },
);

// Fetch the live OBI from the target's well-known endpoint
const iface = await fetchInterface("https://api.example.com");

// Invoke an operation — one handle shape for every cardinality
const call = operationInvoker.invoke({ interface: iface, operation: "listItems" });
await call.write({ limit: 10 });
for await (const item of call.outputs) {
  console.log(item);
}
```

For typed methods per operation, run `ob codegen <interface> --lang typescript` to produce a `<Name>Invoker` class with one method per operation. The generated class wraps `OperationInvoker` and takes the live OBI per call. See the [consumer guide](https://github.com/openbindings/spec/blob/main/guides/consuming-an-interface.md) for the full pattern.

### Check compatibility

```typescript
import { checkInterfaceCompatibility } from "@openbindings/sdk";

const issues = await checkInterfaceCompatibility(required, provided);
for (const issue of issues) {
  console.log(`${issue.operation}: ${issue.kind} — ${issue.detail}`);
}
```

## Invocation model

Every operation returns a cardinality-agnostic `Invocation<I, O>` handle: the
caller writes input messages until done; the invocation yields output messages
until done. One shape serves unary, server-streaming, client-streaming, and
bidirectional bindings — cardinality is a property of the selected binding,
never of the call signature:

```typescript
const call = operationInvoker.invoke({ interface: iface, operation: "listItems" });
await call.write({ limit: 10 }); // unary: the binding closes input after one read

for await (const item of call.outputs) {
  console.log(item); // bare output values; terminal failures throw InvocationError
}
```

For an operation you are confident yields exactly one output, the one blessed
terminal is `single` — strict and short-circuiting (`ERR_EXPECTED_SINGLE` on
zero or more than one):

```typescript
import { single } from "@openbindings/sdk";

const call = operationInvoker.invoke({ interface: iface, operation: "getItem" });
await call.write({ id: "item_1" });
const item = await single(call.outputs);
```

Client-streaming and bidirectional callers own `close()` (and drive input and
output from separate async contexts); lifecycle is observable via `closed`,
leading/trailing metadata via `header`/`trailer()`, and termination via
`cancel()`. Missing runtime context (credentials, configuration) surfaces as a
`CONTEXT_REQUIRED` terminal error raised before any side effect, resolved by
the operation invoker's `contextResolver` when one is configured.

## Binding invokers

The SDK routes operations to binding invokers by format token. Invokers declare what formats they handle (including semver ranges like `openapi@^3.0.0`) and the SDK matches OBI source formats against those declarations:

```typescript
const operationInvoker = new OperationInvoker([
  new OpenAPIInvoker(),    // handles openapi@^3.0.0
  new AsyncAPIInvoker(),   // handles asyncapi@^3.0.0
]);
```

Invokers implement `BindingInvoker`. Interface creators (which synthesize OBIs from raw specs) implement `InterfaceCreator`. Source inspectors (which enumerate refs in a source) implement `SourceInspector`. A single class may implement any combination. See [Implementing a Binding Format](https://github.com/openbindings/spec/blob/main/guides/implementing-a-binding-format.md) for the full pattern.

## Context store

Context is stored per host, not per request. The context key is `host[:port]` — scheme-agnostic, so `http://`, `https://`, and `ws://` for the same host share context:

```typescript
import { MemoryStore, normalizeContextKey, storeContextResolver } from "@openbindings/sdk";

const store = new MemoryStore();
const key = normalizeContextKey("https://api.example.com/v1/users");
// key = "api.example.com"
await store.set(key, { bearerToken: "tok_123" });
```

A binding that needs context it wasn't given raises a `CONTEXT_REQUIRED`
challenge before any side effect; the operation invoker resolves challenges
through its configured `contextResolver` and re-drives the binding.
`storeContextResolver(store)` is the store-backed resolver — the composition
of the binding-invoker and context-store roles. Apps that resolve
interactively (prompts, browser redirects, keychains) supply their own
resolver instead.

## Schema compatibility profile

The SDK includes the OpenBindings Schema Compatibility Profile v0.1 for deterministic schema comparison:

```typescript
import { outputCompatible } from "@openbindings/sdk";

const result = outputCompatible(targetSchema, candidateSchema);
if (!result.compatible) {
  console.log("Incompatible:", result.reason);
  // e.g. "type: candidate allows \"array\" but target does not"
}
```

The profile handles: type sets, const/enum, object properties and required fields, additionalProperties, array items, numeric bounds, string/array length bounds, oneOf/anyOf unions, and allOf flattening.

## Platform support

The SDK works in Node.js, Deno, Bun, and modern browsers. It uses standard APIs (`fetch`, `AbortSignal`, `structuredClone`) with no platform-specific dependencies. A custom `fetch` implementation can be injected via `OperationInvokerOptions` for environments where the global is unavailable.

## License

Apache-2.0

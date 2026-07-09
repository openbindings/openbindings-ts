# openbindings-ts

TypeScript SDK for the [OpenBindings](https://openbindings.com) specification. Parse, validate, resolve, and invoke OpenBindings interfaces from TypeScript and JavaScript.

OpenBindings is an open standard: one interface, limitless bindings. An OBI (OpenBindings Interface) document describes what operations a service offers and how to reach them, independent of protocol. See the [spec](https://github.com/openbindings/spec) and [openbindings.com](https://openbindings.com) for details.

**Spec version:** implements OpenBindings 0.2. The exact range is exported as `MIN_SUPPORTED_VERSION` / `MAX_TESTED_VERSION`; check programmatically via `isSupportedVersion(version)`.

## Packages

| Package | Description | Install |
|---------|-------------|---------|
| `@openbindings/sdk` | Core types, validation, compatibility, invocation | `npm install @openbindings/sdk` |
| `@openbindings/openapi` | OpenAPI 3.x binding invoker and interface synthesizer | `npm install @openbindings/openapi` |
| `@openbindings/asyncapi` | AsyncAPI 3.x binding invoker and interface synthesizer | `npm install @openbindings/asyncapi` |
| `@openbindings/mcp` | MCP binding invoker and interface synthesizer | `npm install @openbindings/mcp` |
| `@openbindings/graphql` | GraphQL binding invoker and interface synthesizer | `npm install @openbindings/graphql` |
| `@openbindings/operationgraph` | Operation-graph binding invoker (compose operations) | `npm install @openbindings/operationgraph` |
| `@openbindings/workers-rpc` | Cloudflare Workers RPC binding invoker | `npm install @openbindings/workers-rpc` |

## What the SDK does

- **Core types** for the OpenBindings interface document: operations, bindings, sources, transforms, schemas
- **Validation** with shape-level checks, strict mode for unknown fields, and format token validation
- **Schema compatibility** checking under the OpenBindings Schema Compatibility Profile v0.1 (covariant outputs, contravariant inputs) with diagnostic reasons
- **`fetchInterface`** for resolving OBIs from URLs: well-known discovery, then synthesis from raw OpenAPI / AsyncAPI / etc. via supplied synthesizers
- **`OperationInvoker`** for routing operations to binding invokers by format, with transform support
- **Context contracts** for per-origin invocation context (credentials and non-secret configuration), resolved at call time with least-privilege scoping

The SDK defines the contracts that binding invokers implement but does not contain any format-specific logic itself. Format support is added by installing format packages.

## Conformance

The core SDK is tested against the OpenBindings 0.2 conformance corpus. With the spec repo checked out alongside the workspace (at `../spec`, or `./spec` inside it), run:

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
import { OperationInvoker, operationSignature, fetchInterface } from "@openbindings/sdk";
import { OpenAPIInvoker, OpenAPISynthesizer } from "@openbindings/openapi";

// Create an operation invoker with format support
const invoker = new OperationInvoker([new OpenAPIInvoker()]);

// Resolve an OBI from a URL (well-known discovery, with synthesis as the
// fallback when the target only exposes a raw spec such as an OpenAPI doc)
const { iface } = await fetchInterface("https://api.example.com", {
  synthesizers: [new OpenAPISynthesizer()],
});

// Invoke an operation — one handle shape for every cardinality
const call = invoker.invoke(iface, operationSignature("listItems"));
await call.write({ limit: 10 });
for await (const item of call.outputs) {
  console.log(item);
}
```

For compile-time-typed operations, run `ob codegen <obi> --lang typescript` to generate an `OperationSignatures` namespace, one typed `OperationSignature<I, O>` per operation, that you pass to this same `invoke` for fully-typed input and output:

```typescript
const call = invoker.invoke(iface, OperationSignatures.listItems);
```

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
bidirectional bindings. Cardinality is a property of the selected binding,
never of the call signature:

```typescript
const call = invoker.invoke(iface, operationSignature("listItems"));
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

const call = invoker.invoke(iface, operationSignature("getItem"));
await call.write({ id: "item_1" });
const item = await single(call.outputs);
```

`write`'s error contract makes both styles above safe: every rejection is
truthful — a flow signal or, when a terminal has already fired, the terminal
error itself — and the output side always carries the authoritative verdict.
Handling a write rejection is optional fast-fail, never required for
correctness, and `close()` never rejects.

Client-streaming and bidirectional callers own `close()` (and drive input and
output from separate async contexts); lifecycle is observable via `closed`,
leading/trailing metadata via `header`/`trailer()`, and termination via
`cancel()`. Missing runtime context (credentials, configuration) surfaces as a
`CONTEXT_REQUIRED` terminal error raised before any side effect, resolved by
the operation invoker's `contextResolver` when one is configured.

## Binding invokers

The SDK routes operations to binding invokers by format token. Invokers declare what formats they handle (including semver ranges like `openapi@^3.0.0`) and the SDK matches OBI source formats against those declarations:

```typescript
const invoker = new OperationInvoker([
  new OpenAPIInvoker(),    // handles openapi@^3.0.0
  new AsyncAPIInvoker(),   // handles asyncapi@^3.0.0
]);
```

| Package | Format token | Synthesizes OBIs? |
|---------|--------------|-------------------|
| `@openbindings/openapi` | `openapi@^3.0.0` | yes |
| `@openbindings/asyncapi` | `asyncapi@^3.0.0` | yes |
| `@openbindings/mcp` | `mcp@2025-11-25` | yes |
| `@openbindings/graphql` | `graphql` | yes |
| `@openbindings/operationgraph` | `openbindings.operation-graph@0.2.0` | no (graphs are authored, then composed at invoke time) |
| `@openbindings/workers-rpc` | `workers-rpc@^1.0.0` | no (hand-authored OBIs; runs inside the Workers runtime) |

Invokers implement `BindingInvoker`. Interface synthesizers (which synthesize OBIs from raw specs) implement `InterfaceSynthesizer`. Source inspectors (which enumerate refs in a source) implement `SourceInspector`. A single class may implement any combination.

## Context and authentication

Context is never part of an OBI document. Credentials and other runtime
configuration are supplied per call or resolved at invocation time, keyed by
normalized origin. The context key is `host[:port]` and is scheme-agnostic, so
`http://`, `https://`, and `ws://` for the same origin share context:

```typescript
import { normalizeContextKey } from "@openbindings/sdk";

const key = normalizeContextKey("https://api.example.com/v1/users");
// key = "api.example.com"
```

The SDK defines the `ContextStore` contract (async `get`/`set`/`delete` keyed
by origin; values are opaque records the SDK never inspects) and leaves
storage to the app: IndexedDB in a browser, a keychain-backed file on a
server, an in-memory map in tests.

A binding that needs context it wasn't given raises a `CONTEXT_REQUIRED`
challenge before any side effect; the operation invoker resolves challenges
through its configured `contextResolver` and re-drives the binding.
`storeContextResolver(store)` is the store-backed resolver, the composition of
the published binding-invoker and context-store interfaces. It treats a
challenge as a scope, not a hint: via `scopeContext` it returns only the
credential fields the satisfied requirement-alternative needs, plus non-secret
configuration, never other stored credentials.

```typescript
import { storeContextResolver } from "@openbindings/sdk";
import type { ContextStore } from "@openbindings/sdk";

const store: ContextStore = myStore; // your get/set/delete implementation
const invoker = new OperationInvoker([new OpenAPIInvoker()], {
  contextResolver: storeContextResolver(store),
});
```

Apps that resolve interactively (prompts, browser redirects, keychains) supply
their own resolver instead.

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

The SDK works in Node.js, Deno, Bun, and modern browsers. It uses standard APIs (`fetch`, `AbortSignal`, `structuredClone`) with no platform-specific dependencies. A custom `fetch` implementation can be injected via `OperationInvokerOptions` (and `fetchInterface`'s options) for environments where the global is unavailable.

## License

Apache-2.0

# openbindings-ts

TypeScript SDK for the [OpenBindings](https://openbindings.com) specification. Parse, validate, resolve, and execute OpenBindings interfaces from TypeScript and JavaScript.

OpenBindings is an open standard: one interface, limitless bindings. An OBI (OpenBindings Interface) document describes what operations a service offers and how to reach them, independent of protocol. See the [spec](https://github.com/openbindings/spec) and [guides](https://github.com/openbindings/spec/tree/main/guides) for details.

## Packages

| Package | Description | Install |
|---------|-------------|---------|
| `@openbindings/sdk` | Core types, validation, compatibility, execution | `npm install @openbindings/sdk` |
| `@openbindings/openapi` | OpenAPI 3.x binding executor and interface creator | `npm install @openbindings/openapi` |
| `@openbindings/asyncapi` | AsyncAPI 3.x binding executor and interface creator | `npm install @openbindings/asyncapi` |
| `@openbindings/mcp` | MCP binding executor and interface creator | `npm install @openbindings/mcp` |
| `@openbindings/graphql` | GraphQL binding executor and interface creator | `npm install @openbindings/graphql` |

## What the SDK does

- **Core types** for the OpenBindings interface document: operations, bindings, sources, transforms, schemas, roles
- **Validation** with shape-level checks, strict mode for unknown fields, and format token validation
- **Schema compatibility** checking under the OpenBindings Profile v0.1 (covariant outputs, contravariant inputs) with diagnostic reasons
- **InterfaceClient** for resolving OBIs from URLs, well-known discovery, or synthesis from raw specs
- **OperationExecutor** for routing operations to binding executors by format, with transform support
- **Context store** for per-host credential persistence with scheme-agnostic key normalization

The SDK defines the contracts that binding executors implement but does not contain any format-specific logic itself. Format support is added by installing executor packages.

## Quick start

### Parse and validate an OBI

```typescript
import { validateInterface, type OBInterface } from "@openbindings/sdk";

const iface: OBInterface = JSON.parse(data);
validateInterface(iface); // throws ValidationError if invalid

console.log(iface.name, iface.version);
for (const [name, op] of Object.entries(iface.operations)) {
  console.log(name, op.description);
}
```

### Resolve and execute operations

```typescript
import { InterfaceClient, OperationExecutor, MemoryStore } from "@openbindings/sdk";
import { OpenAPIExecutor } from "@openbindings/openapi";

// Create an executor with format support
const exec = new OperationExecutor([new OpenAPIExecutor()]);

// Create a client and resolve an OBI from a URL
const client = new InterfaceClient(null, exec, {
  contextStore: new MemoryStore(),
});
await client.resolve("https://api.example.com");

// Execute an operation — everything is a stream
for await (const event of client.execute("listItems", { limit: 10 })) {
  if (event.error) {
    console.error(event.error.message);
    break;
  }
  console.log(event.data);
}
```

### Check compatibility

```typescript
import { checkInterfaceCompatibility } from "@openbindings/sdk";

const issues = await checkInterfaceCompatibility(required, provided);
for (const issue of issues) {
  console.log(`${issue.operation}: ${issue.kind} — ${issue.detail}`);
}
```

## Execution model

Every operation returns an `AsyncIterable<StreamEvent>`. A unary operation yields one event. A streaming operation yields many. The consumer code is the same for both:

```typescript
for await (const event of executor.executeOperation(input)) {
  if (event.error) { /* handle */ }
  console.log(event.data);
}
```

## Binding executors

The SDK routes operations to binding executors by format token. Executors declare what formats they handle (including semver ranges like `openapi@^3.0.0`) and the SDK matches OBI source formats against those declarations:

```typescript
const exec = new OperationExecutor([
  new OpenAPIExecutor(),   // handles openapi@^3.0.0
  new AsyncAPIExecutor(),  // handles asyncapi@^3.0.0
]);
```

Executors implement `BindingExecutor`. Interface creators (which synthesize OBIs from raw specs) implement `InterfaceCreator`. A single class may implement both.

## Typed interface clients

The `InterfaceClient` supports a generic type parameter for compile-time operation typing:

```typescript
type MyAPI = {
  listItems: { input: { limit: number }; output: { items: Item[] } };
  getItem: { input: { id: string }; output: Item };
};

const client = new InterfaceClient<MyAPI>(requiredInterface, exec);
await client.resolve("https://api.example.com");

// 'operation' is constrained to "listItems" | "getItem"
// 'input' is typed per operation
for await (const event of client.execute("listItems", { limit: 10 })) {
  // event.data is typed
}
```

## Context store

Credentials are stored per host, not per request. The context key is `host[:port]` — scheme-agnostic, so `http://`, `https://`, and `ws://` for the same host share credentials:

```typescript
import { MemoryStore, normalizeContextKey } from "@openbindings/sdk";

const store = new MemoryStore();
const key = normalizeContextKey("https://api.example.com/v1/users");
// key = "api.example.com"
await store.set(key, { bearerToken: "tok_123" });
```

Executors read from the context store automatically when it's configured on the `OperationExecutor` or `InterfaceClient`.

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

The SDK works in Node.js, Deno, Bun, and modern browsers. It uses standard APIs (`fetch`, `AbortSignal`, `structuredClone`) with no platform-specific dependencies. A custom `fetch` implementation can be injected via `InterfaceClientOptions` for environments where the global is unavailable.

## License

Apache-2.0

# @openbindings/graphql

GraphQL binding invoker and interface synthesizer for the [OpenBindings](https://openbindings.com) TypeScript SDK.

This package enables OpenBindings to invoke operations against GraphQL endpoints and synthesize OBI documents from GraphQL schemas via introspection. It builds queries, mutations, and subscriptions from operation refs, applies credentials, and delivers results through the SDK's cardinality-agnostic `Invocation` handle. Subscriptions stream over the `graphql-transport-ws` WebSocket protocol.

See the [spec](https://github.com/openbindings/spec) and the [invocation pattern](https://openbindings.com/spec/invocation-pattern) for how binding invokers and interface synthesizers fit into the OpenBindings architecture.

## Install

```
npm install @openbindings/graphql
```

Requires [@openbindings/sdk](https://www.npmjs.com/package/@openbindings/sdk) (the core SDK).

## Usage

### Register with OperationInvoker

```typescript
import { OperationInvoker } from "@openbindings/sdk";
import { GraphQLInvoker } from "@openbindings/graphql";

const invoker = new OperationInvoker([new GraphQLInvoker()]);
```

The invoker declares the versionless `graphql` format token — it handles any GraphQL endpoint.

### Invoke a binding

`invokeBinding` returns an `Invocation` handle synchronously. The GraphQL variables object is the operation's single input message, written to the handle; outputs are bare data values.

```typescript
import { single } from "@openbindings/sdk";

const invoker = new GraphQLInvoker();

const call = invoker.invokeBinding({
  source: {
    format: "graphql",
    location: "https://api.example.com/graphql",
  },
  ref: "Query/users",
  context: { bearerToken: "tok_123" },
});

await call.write({ limit: 10 });
const users = await single(call.outputs);
```

Fields that take no arguments need no `write` (the binding closes the input side on entry). Subscriptions consume the same handle with `for await`:

```typescript
const call = invoker.invokeBinding({
  source: { format: "graphql", location: "https://api.example.com/graphql" },
  ref: "Subscription/onOrder",
});

for await (const event of call.outputs) {
  console.log(event);
}
```

Failures surface as a rejected `call.closed` (and a throwing output iterator) carrying an `InvocationError` with a stable `code` — e.g. `ERR_AUTH_REQUIRED` for an HTTP 401, `ERR_EXECUTION_FAILED` for GraphQL `errors`, `ERR_STREAM_ERROR` for a dropped subscription transport.

Refs follow the convention `Query/<field>`, `Mutation/<field>`, or `Subscription/<field>`.

The invoker caches the introspected schema per endpoint on the invoker instance. Inline schemas are also supported via `Source.content` (full introspection response, `__schema` wrapper, or bare schema object).

### Synthesize an interface from a GraphQL endpoint

```typescript
import { GraphQLSynthesizer } from "@openbindings/graphql";

const synth = new GraphQLSynthesizer();

const iface = await synth.synthesizeInterface({
  sources: [{
    format: "graphql",
    location: "https://api.example.com/graphql",
  }],
});
```

The synthesizer runs a standard introspection query against the endpoint and synthesizes an OBI with one operation per root field. Each operation's input schema embeds a `_query` const containing the pre-built GraphQL query string, so the invoker can reuse it without re-introspecting.

## How it works

### Execution flow

1. Parses the ref as `<RootType>/<field>` (rejects anything other than `Query`, `Mutation`, `Subscription`) — pre-dispatch failures terminate the invocation before any network I/O
2. Resolves the GraphQL document: a `_query` const in the operation's input schema is used directly (no schema loading); otherwise the schema is loaded (inline `Source.content`, or network introspection cached per endpoint) and a query with an auto-generated selection set is built (cycle-safe, depth-limited to 3 levels)
3. Reads the variables object from the handle: fields with arguments read the first input message; no-argument fields close the input side on entry and dispatch with empty variables
4. Applies credentials from the invocation context to HTTP headers (or to the WebSocket `connection_init` payload for subscriptions)
5. Dispatches:
   - **Query / Mutation:** HTTP POST; response headers become the handle's leading metadata, the field's data is emitted as the single output
   - **Subscription:** opens a WebSocket using the `graphql-transport-ws` protocol, sends `connection_init` → `subscribe`, then emits each `next` payload as an output until `complete` (clean close) or a transport failure (terminal error)

HTTP error statuses map to terminal error codes (`401` → `ERR_AUTH_REQUIRED`, `403` → `ERR_PERMISSION_DENIED`, otherwise `ERR_EXECUTION_FAILED`) with `{ status, body }` details. Cancellation (`call.cancel()` or an aborted `signal`) aborts the in-flight request or closes the subscription transport.

### Credential application

GraphQL has no native security scheme declarations, so headers are derived directly from the binding context in this fallback order:

1. **`bearerToken`** → `Authorization: Bearer <token>`
2. **`apiKey`** → `Authorization: ApiKey <token>`
3. **`basic.username` + `basic.password`** → `Authorization: Basic <base64>`

Context's `headers` field merges on top, and `cookies` join as a sorted `Cookie:` header.

For subscriptions, browsers cannot set custom headers on a WebSocket upgrade, so the `Authorization` header is forwarded inside the `connection_init` payload as `{ authorization: "Bearer ..." }` instead.

### Interface synthesis

Converts a GraphQL schema (via introspection) into an OBI by:
- Walking the root types in fixed order: `Query`, then `Mutation`, then `Subscription`
- Iterating fields within each root type alphabetically (skipping introspection fields prefixed with `__`) — deterministic output: the same schema synthesizes an identical OBI, matching the Go SDK
- Building input schemas from field arguments, with each operation's input also containing a `_query` const string holding the pre-built query
- Building output schemas from field return types, recursively converted to JSON Schema with cycle protection (no `$ref` pointers — types are inlined directly)
- Generating `<RootType>/<field>` refs for each binding

## License

Apache-2.0

## Runtime support

On Node, the WebSocket lane constructs the global `WebSocket`, which ships unflagged in Node 22+ — hence `engines.node >= 22`. The HTTP and SSE lanes have no such dependency; browsers and edge runtimes are unaffected.

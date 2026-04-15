# @openbindings/graphql

GraphQL binding executor and interface creator for the [OpenBindings](https://openbindings.com) TypeScript SDK.

This package enables OpenBindings to execute operations against GraphQL endpoints and synthesize OBI documents from GraphQL schemas via introspection. It builds queries, mutations, and subscriptions from operation refs, applies credentials, and returns results as a stream of events. Subscriptions stream over the `graphql-transport-ws` WebSocket protocol.

See the [spec](https://github.com/openbindings/spec) and [pattern documentation](https://github.com/openbindings/spec/tree/main/patterns) for how executors and creators fit into the OpenBindings architecture.

## Install

```
npm install @openbindings/graphql
```

Requires [@openbindings/sdk](https://www.npmjs.com/package/@openbindings/sdk) (the core SDK).

## Usage

### Register with OperationExecutor

```typescript
import { OperationExecutor } from "@openbindings/sdk";
import { GraphQLExecutor, GraphQLCreator } from "@openbindings/graphql";

const exec = new OperationExecutor([new GraphQLExecutor(), new GraphQLCreator()]);
```

The executor declares the versionless `graphql` format token — it handles any GraphQL endpoint.

### Execute a binding

```typescript
const executor = new GraphQLExecutor();

for await (const event of executor.executeBinding({
  source: {
    format: "graphql",
    location: "https://api.example.com/graphql",
  },
  ref: "Query/users",
  input: { limit: 10 },
  context: { bearerToken: "tok_123" },
})) {
  if (event.error) console.error(event.error.message);
  else console.log(event.data);
}
```

Refs follow the convention `Query/<field>`, `Mutation/<field>`, or `Subscription/<field>`.

The executor caches the introspected schema per endpoint on the executor instance. Inline schemas are also supported via `Source.content` (full introspection response, `__schema` wrapper, or bare schema object).

### Create an interface from a GraphQL endpoint

```typescript
const creator = new GraphQLCreator();

const iface = await creator.createInterface({
  sources: [{
    format: "graphql",
    location: "https://api.example.com/graphql",
  }],
});
```

The creator runs a standard introspection query against the endpoint and synthesizes an OBI with one operation per root field. Each operation's input schema embeds a `_query` const containing the pre-built GraphQL query string, so the executor can reuse it without re-introspecting.

## How it works

### Execution flow

1. Loads the schema (inline `Source.content`, or network introspection cached per endpoint)
2. Parses the ref as `<RootType>/<field>` (rejects anything other than `Query`, `Mutation`, `Subscription`)
3. Builds the GraphQL document: uses the `_query` const from the operation's input schema if present, otherwise auto-generates a query and selection set from introspection (cycle-safe, depth-limited to 3 levels)
4. Applies credentials to HTTP headers (or to the WebSocket `connection_init` payload for subscriptions)
5. Sends the request:
   - **Query / Mutation:** HTTP POST, returns one stream event
   - **Subscription:** opens a WebSocket using the `graphql-transport-ws` protocol, sends `connection_init` → `subscribe`, then forwards each `next` message as a stream event until `complete` or close

On a 401/403, if the binding declares security entries and a credential callback is configured, the executor calls `resolveSecurity` and retries once.

### Credential application

GraphQL has no native security scheme declarations, so headers are derived directly from the binding context in this fallback order:

1. **`bearerToken`** → `Authorization: Bearer <token>`
2. **`apiKey`** → `Authorization: ApiKey <token>`
3. **`basic.username` + `basic.password`** → `Authorization: Basic <base64>`

`ExecutionOptions.headers` are merged in after, and `ExecutionOptions.cookies` are joined as a sorted `Cookie:` header.

For subscriptions, browsers cannot set custom headers on a WebSocket upgrade, so the `Authorization` header is forwarded inside the `connection_init` payload as `{ authorization: "Bearer ..." }` instead.

### Interface creation

Converts a GraphQL schema (via introspection) into an OBI by:
- Walking the root types in fixed order: `Query`, then `Mutation`, then `Subscription`
- Iterating fields within each root type alphabetically (skipping introspection fields prefixed with `__`)
- Building input schemas from field arguments, with each operation's input also containing a `_query` const string holding the pre-built query
- Building output schemas from field return types, recursively converted to JSON Schema with cycle protection (no `$ref` pointers — types are inlined directly)
- Generating `<RootType>/<field>` refs for each binding

## License

Apache-2.0

# `@openbindings/graphql`

TypeScript reference implementation of the unreleased first
`openbindings.graphql@1` candidate. The package binds GraphQL queries and
mutations as protocol-blind application operations. Introspection inventories
root fields; the caller supplies the exact executable document because a
schema cannot choose a selection set.

No GraphQL binding specification has been published, and this package does not
implement an older compatibility meaning for `@1`.

## Install and register

```sh
npm install @openbindings/sdk @openbindings/graphql
```

```ts
import { OperationInvoker } from "@openbindings/sdk";
import { GraphQLInvoker } from "@openbindings/graphql";

const invoker = new OperationInvoker([new GraphQLInvoker()]);
```

## Invoke

Every invocation needs the exact executable GraphQL document at
`context.configuration.document`, as source text or an object with `source`
and optional `operationName`:

```ts
import { BINDING_SPEC, GraphQLInvoker } from "@openbindings/graphql";

const call = new GraphQLInvoker().invokeBinding({
  source: {
    bindingSpec: BINDING_SPEC,
    location: "https://api.example.com/graphql",
  },
  ref: "query/viewer",
  inputSchema: { type: "object" },
  context: {
    configuration: {
      document: {
        source: "query Viewer($id: ID!) { viewer(id: $id) { id name } }",
        operationName: "Viewer",
      },
      protocolFields: {
        httpHeaders: { Authorization: "Bearer tok_123" },
      },
    },
  },
});

await call.write({ id: "user_1" });
for await (const viewer of call.outputs) console.log(viewer);
```

The optional caller input, when present, must be an object and becomes the
variables map wholesale. `_query` is an ordinary variable name; the binding
never consumes it as metadata or generates a document.

On success, the output is `data[responseKey]`, including root aliases. The
GraphQL envelope and HTTP facts do not become ordinary output fields. If a
trusted response contains GraphQL `errors`, any selected partial application
value is emitted first and the invocation then completes unsuccessfully
without retracting it. Native response evidence is available only through the
explicit diagnostics surface.

The candidate's interpretation points live under `context.configuration`:

- `document`: GraphQL source text, or `{ source, operationName? }`.
- `protocolFields`: optional explicitly named HTTP headers and cookies.

Generic credentials do not identify a GraphQL protocol location, so the
invoker refuses them rather than inventing an Authorization scheme.

Present `content` must be one successful introspection execution-result object
with no `errors` member and an object at `data.__schema`. It is authoritative
and displaces live introspection.

## Synthesis and coverage

```ts
import { BINDING_SPEC, GraphQLSynthesizer } from "@openbindings/graphql";

const result = await new GraphQLSynthesizer().synthesizeInterfaceWithCoverage({
  sources: [{
    bindingSpec: BINDING_SPEC,
    location: "https://api.example.com/graphql",
  }],
});
```

Synthesis creates one operation for each non-introspection query or mutation
root field. The input is an object variables boundary. The output schema is
derived from the root field's GraphQL type; composite result objects remain
open because nested selection names depend on the executable document.

Subscriptions are excluded with reason
`graphql.subscription_lifecycle_not_representable` and rule `GQL-P-04`.
Their partial-data-plus-error events may continue the native stream, so the
candidate refuses them rather than approximating their lifecycle.

## Resource bounds

The delivery-unit limit applies to each HTTP response and introspection body.
Omission uses the SDK default.

## License

Apache-2.0

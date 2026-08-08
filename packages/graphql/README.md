# `@openbindings/graphql`

TypeScript reference implementation of
[`openbindings.graphql@2`](https://openbindings.com/binding-specs/graphql/2),
plus the immutable
[`openbindings.graphql@1`](https://openbindings.com/binding-specs/graphql/1)
compatibility revision.

Revision 2 binds GraphQL queries and mutations as protocol-blind application
operations. Introspection inventories root fields; the caller supplies the
exact executable document because the schema cannot choose a selection set.

## Install and register

```sh
npm install @openbindings/sdk @openbindings/graphql
```

```ts
import { OperationInvoker } from "@openbindings/sdk";
import { GraphQLInvoker } from "@openbindings/graphql";

const invoker = new OperationInvoker([new GraphQLInvoker()]);
```

The implementation advertises both exact identifiers, latest first:

| Revision | Refs | Ordinary output |
| --- | --- | --- |
| `openbindings.graphql@2` | `query/<field>`, `mutation/<field>` | selected root-field application value |
| `openbindings.graphql@1` | those refs plus `subscription/<field>` | complete GraphQL response envelope |

## Invoke revision 2

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
explicit diagnostics surface; correct application use does not depend on it.

## Runtime configuration

Revision 2 carries these interpretation points under
`context.configuration`:

- `document`: GraphQL source text, or
  `{ source: "...", operationName: "..." }`.
- `protocolFields`: optional explicitly named HTTP headers and cookies.

Generic credentials do not identify a GraphQL protocol location, so the
invoker refuses them rather than inventing an Authorization scheme.
Processor-owned fields and duplicate destinations are likewise refused before
dispatch.

Present `content` must be one successful introspection execution-result object
with no `errors` member and an object at `data.__schema`. It is authoritative
and displaces live introspection; wrapper-stripped, bare, stringified, and SDL
representations are not accepted.

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

Revision-2 synthesis creates one operation for each non-introspection query or
mutation root field. The input is an object variables boundary. The output
schema is derived from the root field's GraphQL type; composite result objects
remain open because nested selection names depend on the executable document.

Subscription fields are reported as excluded with reason
`graphql.subscription_lifecycle_not_representable` and rule `GQL-P-04`.
Their partial-data-plus-error events may continue the native stream, so
revision 2 refuses them rather than approximating their lifecycle.

## Revision 1 compatibility

Use `LEGACY_BINDING_SPEC` only when compatibility requires the published
revision-1 contract. Revision 1 emits complete response envelopes and supports
`graphql-transport-ws` subscriptions with `subscriptionTarget` and the
WebSocket protocol fields. `graphQLFailureEvidence(error)` reads its native
HTTP or WebSocket failure evidence from diagnostics.

## Resource bounds

The delivery-unit limit applies to each HTTP response body, introspection
response, and revision-1 subscription message. Omission uses the SDK default.

## License

Apache-2.0

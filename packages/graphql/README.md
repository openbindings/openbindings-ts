# `@openbindings/graphql`

TypeScript reference implementation of the published
[`openbindings.graphql@1`](https://openbindings.com/binding-specs/graphql/1)
binding specification.

The package invokes GraphQL queries and mutations over GraphQL-over-HTTP,
invokes subscriptions over the pinned `graphql-transport-ws` protocol,
inspects GraphQL schemas, and synthesizes OpenBindings interfaces. It keeps
schema discovery and document authorship separate: introspection can inventory
root fields, but it cannot choose a caller's selection set.

## Install and register

```sh
npm install @openbindings/sdk @openbindings/graphql
```

```ts
import { OperationInvoker } from "@openbindings/sdk";
import { GraphQLInvoker } from "@openbindings/graphql";

const invoker = new OperationInvoker([new GraphQLInvoker()]);
```

The implementation advertises the exact identifier
`openbindings.graphql@1`. Refs are exact and lower-case:

```text
query/<field>
mutation/<field>
subscription/<field>
```

The prefix names the GraphQL operation kind, not a schema type. Resolution
uses the schema's actual query, mutation, or subscription root type.

## Invoke

Every invocation needs the exact executable GraphQL document. Supply it at
`context.configuration.document` as source text or as an object with `source`
and optional `operationName`:

```ts
import { GraphQLInvoker } from "@openbindings/graphql";

const call = new GraphQLInvoker().invokeBinding({
  source: {
    bindingSpec: "openbindings.graphql@1",
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
for await (const response of call.outputs) {
  console.log(response);
}
```

The one caller input value, when present, must be an object and becomes the
GraphQL variables map wholesale. `_query` is an ordinary variable name; this
implementation never consumes it as metadata and never generates a document
or selection set.

Each output is the complete GraphQL response envelope, including `data`,
`errors`, and `extensions`. GraphQL errors remain in-band. Use an OBI
`outputTransform` such as `data.viewer` when an operation intentionally
exposes only the selected field.

Legacy `application/json` non-2xx responses and `graphql-transport-ws`
protocol errors are failure completions. `graphQLFailureEvidence(error)`
recovers their exact HTTP bytes and headers or complete WebSocket error/close
evidence. Earlier subscription outputs remain visible after a later failure;
local SDK and document-validation errors carry no invented native evidence.

## Runtime configuration

The TypeScript implementation carries the specification's interpretation
points below under `context.configuration`:

- `document`: GraphQL source text, or
  `{ source: "...", operationName: "..." }`.
- `subscriptionTarget`: required absolute `ws` or `wss` URI for a
  subscription. It is never derived from the HTTP endpoint.
- `protocolFields`: optional `httpHeaders`, `httpCookies`,
  `websocketHeaders`, `websocketCookies`, and
  `connectionInitPayload`.

Header and cookie names identify their exact protocol locations. Generic
`bearerToken`, `apiKey`, `basic`, and OAuth context do not, so the invoker
refuses them rather than inventing an Authorization scheme. Processor-owned
fields and duplicate destinations are likewise refused before dispatch.

`content`, when present, must be one successful introspection execution-result
object with no `errors` member and an object at `data.__schema`. It is a pin
and completely displaces live introspection; wrapper-stripped, bare,
stringified, and SDL representations are not accepted by revision 1.

## Subscriptions and WebSocket factories

```ts
const call = new GraphQLInvoker().invokeBinding({
  source,
  ref: "subscription/orderUpdates",
  context: {
    configuration: {
      document: "subscription { orderUpdates { id status } }",
      subscriptionTarget: "wss://api.example.com/graphql",
      protocolFields: {
        connectionInitPayload: { token: "tok_123" },
      },
    },
  },
});
```

The default WHATWG `WebSocket` path can carry the target, subprotocol, and
`connection_init` payload. If explicit upgrade headers or cookies are needed,
construct `GraphQLInvoker` with a `GraphQLWebSocketFactory` whose runtime can
carry those headers. Supplying such fields without a capable factory is
refused before the socket opens.

Each `next.payload` is emitted as one complete output envelope. A protocol
`error` is terminal without retracting previous outputs; cancellation attempts
the protocol's `complete` exchange.

## Synthesis and coverage

```ts
import { GraphQLSynthesizer } from "@openbindings/graphql";

const result = await new GraphQLSynthesizer().synthesizeInterfaceWithCoverage({
  sources: [{
    bindingSpec: "openbindings.graphql@1",
    location: "https://api.example.com/graphql",
  }],
});
```

Synthesis inventories every non-introspection root field and creates one
binding per field. Operations intentionally use broad schemas: an object
variables boundary for input and a complete GraphQL response envelope for
output. Projecting GraphQL arguments or return types into a fixed JSON shape
would falsely imply a selection set that introspection cannot choose.

Coverage is exhaustive for the observed root-field inventory. Each represented
entry records the runtime requirement `document`; subscription entries also
record `subscriptionTarget`. Pinned content is inspected without network
access and displaces live schema acquisition.

## Resource bounds

The invocation delivery-unit limit applies to each HTTP response body,
introspection response, and subscription message. Supply the limit through
the SDK's binding or operation invocation options; omission uses the SDK
default.

## License

Apache-2.0

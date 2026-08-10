# @openbindings/openapi

Thin OpenBindings adapter and interface synthesizer over the standalone
[`@openbindings/openapi-client`](https://github.com/openbindings/openapi-client)
OpenAPI 3.x document-driven client and execution engine.

This package enables OpenBindings to invoke operations against OpenAPI specs and synthesize OBI documents from them. It reads OpenAPI 3.x documents, constructs HTTP requests, applies credentials via security schemes, and delivers results through the SDK's cardinality-agnostic `Invocation` handle.

Applications that need faithful OpenAPI artifact invocation without an OBI
can use `@openbindings/openapi-client` directly. This package owns OBI source,
binding-invoker, context/frame, coverage, and synthesis adaptation; the runtime
owns OpenAPI loading, operation resolution, HTTP request/response behavior,
and SSE lifecycle.

See the [spec](https://github.com/openbindings/spec) and the [invocation pattern](https://openbindings.com/spec/invocation-pattern) for how binding invokers and interface synthesizers fit into the OpenBindings architecture.

## Install

```
npm install @openbindings/openapi
```

Requires [@openbindings/sdk](https://www.npmjs.com/package/@openbindings/sdk)
(the Core SDK) and uses `@openbindings/openapi-client` as its artifact engine.

## Usage

### Register with OperationInvoker

```typescript
import { OperationInvoker } from "@openbindings/sdk";
import { OpenAPIInvoker } from "@openbindings/openapi";

const invoker = new OperationInvoker([new OpenAPIInvoker()]);
```

The invoker declares current `openbindings.openapi@7` and immutable
`openbindings.openapi@6`/`openbindings.openapi@5`/`openbindings.openapi@4`/`openbindings.openapi@3`/`openbindings.openapi@2`/`openbindings.openapi@1`
compatibility. All seven
handle exactly OpenAPI 3.0.0–3.0.4 and 3.1.0–3.1.2 documents, discriminated by
the artifact's own `openapi` field. The current
[`openbindings.openapi@7`](https://github.com/openbindings/spec/blob/main/binding-specs/openapi/openbindings.openapi.md)
document is normative for routed input mapping, OAS serialization,
request/response media selection and byte carriage, server resolution,
interaction shape, and
channel assembly.

### Invoke a binding

Typically you don't call the invoker directly — the `OperationInvoker` routes operations to it based on the OBI source's binding specification. But direct use is straightforward:

```typescript
import { single } from "@openbindings/sdk";

const invoker = new OpenAPIInvoker();

const call = invoker.invokeBinding({
  source: {
    bindingSpec: "openbindings.openapi@7",
    location: "https://api.example.com/openapi.json",
  },
  ref: "#/paths/~1users~1{id}/get",
  context: { bearerToken: "tok_123" },
});

await call.write({ id: "42" }); // input flows through the handle
const user = await single(call.outputs); // unary: expect exactly one output
```

Operations that take no input (no parameters, no request body) dispatch
immediately — don't `write`. Error outcomes terminate the handle:

```typescript
try {
  await call.closed;
} catch (err) {
  console.error(err.code, err.message); // e.g. "ERR_EXECUTION_FAILED", "HTTP 401 Unauthorized"
}
```

An unsuccessful HTTP response is a failure completion, not an operation
output. `openAPIFailureEvidence(err)` recovers the native status, headers,
final URL/status text where the Fetch runtime exposes them, exact response
bytes, and the OpenAPI Response Object key/media that governed the response:

```typescript
import { openAPIFailureEvidence } from "@openbindings/openapi";

try {
  await call.closed;
} catch (err) {
  const evidence = openAPIFailureEvidence(err);
  if (evidence) {
    console.error(evidence.httpResponse.status, evidence.openapi.responseKey);
    // evidence.httpResponse.body is the exact Uint8Array when captured.
  }
}
```

An absent `body` is distinct from an exact empty `Uint8Array`. Non-2xx SSE
responses use the same bounded exact-byte capture as unary failures.

When an operation requires credentials the document declares but the context
lacks, the invocation terminates with `CONTEXT_REQUIRED` before any request
is dispatched; the error's details carry the requirement alternatives derived
from the spec's `securitySchemes`. `prepareBinding(args)` runs the same
derivation as a side-effect-free preflight (it never fetches the source
document; it uses inline content or a previously cached document).

### Synthesize an interface from an OpenAPI spec

```typescript
import { OpenAPISynthesizer } from "@openbindings/openapi";

const synth = new OpenAPISynthesizer();

const iface = await synth.synthesizeInterface({
  sources: [
    {
      bindingSpec: "openbindings.openapi@7",
      location: "https://api.example.com/openapi.json",
    },
  ],
});
// iface is a fully-formed OBInterface with operations, bindings, and sources
```

The package uses web-platform APIs and has no Node import. HTTP(S) locations
are fetched directly. Process-local paths are intentionally not a synthesizer
capability: a Node-based CLI or build step can read the file and pass the
result as `content`, while browsers and Workers keep the same package graph.

## How it works

### Execution flow

1. Loads and caches the OpenAPI document (JSON or YAML, from embedded content
   or an absolute URI), discriminating the exact accepted 3.0.0–3.0.4 and
   3.1.0–3.1.2 editions (OAPI-P-01)
2. Parses the ref as a JSON Pointer (`#/paths/~1users/get` -> path `/users`, method `get`); the method is lowercase exactly as the artifact spells it — an uppercase method is refused, never case-folded (OAPI-D-03)
3. Resolves the server (the OAS effective list + variables + the `server` configuration point, OAPI-P-05)
4. Derives auth requirements from the operation's (or document's) `security` and challenges `CONTEXT_REQUIRED` when the context can't satisfy them — before any request is dispatched
5. Reads the input message from the handle and routes parameters and finite named body properties per OAPI-P-03; explicitly dynamic objects and declaration-complex exact JSON bodies remain one complete application value below a protocol-neutral field and use a binding-private whole-body route. Parameters serialize per the OAS style/explode rules (OAPI-P-02), and the configured `requestMedia` candidate or any faithfully supported declared candidate governs body carriage (OAPI-P-04).
6. Selects one complete, satisfiable Security Requirement alternative and applies only that alternative's credentials with the artifact-declared placement, refusing credential/parameter and processor-owned-channel collisions before dispatch (OAPI-P-09/P-10)
7. Makes the HTTP request; the governing success declaration and actual concrete media select unary or server-streaming framing (OAPI-P-06); classifies the outcome (success iff status is 2xx, OAPI-P-08); then emits strict JSON, charset-aware text/SSE, or canonical Base64 for artifact-authorized raw bytes (OAPI-P-07). Native headers/status/body evidence and hook provenance are available only through explicit diagnostics and never become operation values.

### Server selection

The OAS effective server list comes from operation `servers`, else the path
item's, else the document's, else the implied `/`. A sole entry is selected
with server-variable defaults substituted; more than one requires the named
`server` configuration point because the artifact declares alternatives but
no preference. A relative server URL resolves against the source `location`.
Set `configuration.server` in the invocation context to select a declared
entry (`url` or `index`), supply `variables`, or supply a complete `baseUrl`
outright (OAPI-P-05):

```typescript
context: {
  configuration: {
    server: { baseUrl: "https://staging.example.com" },
  },
  bearerToken: "tok_123",
}
```

The legacy `metadata.baseURL` override still works, below the configuration point.

### Consumer hooks

HTTP leaves wire questions the OpenAPI document does not settle: which bytes-to-value rule to apply and whether a given response counts as success. This format **consults the consumer hooks seam** for both:

- **Decode** — the builtin rule is chosen from the response `Content-Type` header; an `outputDecoder` hook may override it.
- **Classify** — the builtin verdict is HTTP status (2xx success; declared `responses` refine failure details, never classification); a `resultClassifier` hook may reclassify (a 200 envelope carrying an application error, say).

Hooks are configured per invocation (`InvokeOptions`) or invoker-level (`OperationInvokerOptions`); a hook declines to the next tier by returning `USE_DEFAULT`. Each invocation records how each axis was decided in its explicit diagnostic trailing metadata (`x-ob-decode`: `header/content-type` or `hook`; `x-ob-classify`: `assumption/2xx` or `hook`).

### Credential application

Credentials are applied based on the OpenAPI spec's security configuration:

- **`http` + `bearer`**: Sets `Authorization: Bearer <token>` from `bearerToken` context field
- **`http` + `basic`**: Sets `Authorization: Basic <encoded>` from `basic.username`/`basic.password` context fields
- **`apiKey`**: Places the `apiKey` context field in the header, query param, or cookie as the spec declares
- **`oauth2` / `openIdConnect`**: Sets `Authorization: Bearer <token>` from the `accessToken` (or `bearerToken`) context field

Credentials are never volunteered when the effective operation declares no
security. Security Requirement Objects are OR alternatives and the schemes
within one object are an AND set; invocation selects exactly one complete,
channel-safe alternative and never combines credential fragments from
different alternatives.

When declared security is unsatisfied by the context, the invoker challenges `CONTEXT_REQUIRED` before any input is read or network touched, deriving the challenge from the artifact's `securitySchemes` (the negotiation surface is the [binding-invoker interface](https://openbindings.com/interfaces/binding-invoker); the challenge's `target` is the resolved base URL):

| Scheme            | Requirement type | Carried fields                                                           |
| ----------------- | ---------------- | ------------------------------------------------------------------------ |
| `http` / `basic`  | `auth.basic`     | —                                                                        |
| `http` / `bearer` | `auth.bearer`    | —                                                                        |
| `apiKey`          | `auth.apiKey`    | —                                                                        |
| `oauth2`          | `auth.oauth2`    | `grantType`, `authorizeUrl`, `tokenUrl` from each usable flow; `scopes` required by the Security Requirement |
| `openIdConnect`   | `auth.oauth2`    | `openIdConnectUrl`; `scopes` required by the Security Requirement        |

An `oauth2` scheme declaring several usable flows surfaces each as a separate
context alternative; it does not invent a flow preference. `grantType` names
each flow in its RFC 6749 spelling (`authorization_code`, `implicit`,
`password`, `client_credentials`). Every requirement carries the scheme's
declared name (its `securitySchemes` key), which disambiguates ANDed
requirements of one type and keys the scheme-scoped credential lookup: an
API-key scheme named `N` resolves `apiKeys[N]` first, falling back to the
single `apiKey` convenience.

A scheme outside this table is **surfaced, never dropped**: it emits a requirement typed from the artifact's own scheme (`http`/`digest` → `auth.http.digest`; any other type `T` → `auth.<T>`, e.g. `auth.mutualTLS`) that this package cannot itself apply. The alternative stays discoverable — unselectable only for runtimes without a resolver for that family — and a document whose every alternative is unmapped produces a readable challenge instead of an unauthenticated dispatch into a blind 401.

Install an artifact-scheme handler when the host has an implementation for one
of those mechanisms. This is invoker configuration below the protocol-neutral
operation boundary; it neither adds HTTP fields to the OBI nor changes the
built-in schemes' Core context resolution:

```typescript
const invoker = new OpenAPIInvoker({
  securityHandlers: {
    digestAuth(request, { schemeName }) {
      request.headers.set("authorization", buildDigest(request, credentialFor(schemeName)));
    },
  },
});
```

Handlers are keyed by the name authored in `securitySchemes`, run after the
built-in request is finalized, and may return a replacement `Request`. Without
a matching installed handler, the existing artifact-derived
`CONTEXT_REQUIRED` challenge remains authoritative and dispatch stays
fail-closed. Installing one declares that the handler is the complete,
configured implementation for that scheme; the handler therefore owns any
scheme-specific credential or transport resolution it requires.

### Interface synthesis

Deterministic generation of OBI documents is a synthesis concern outside the binding specification (`openbindings.openapi@7` §10); these are this package's conventions, chosen so both reference SDKs emit an identical OBI for the same artifact:

- **Operation keys** come from `operationId` when present, sanitized to the OBI key grammar (non-key characters become `_`, leading/trailing `_` trimmed, a leading non-letter gets an `_` prefix). An `operationId` whose sanitized key is already taken falls through to path+method derivation: template segments (`{id}`) dropped, remaining segments joined with `.`, the lowercased method appended (`/users/{id}` + `GET` → `users.get`), then deduplicated deterministically with `_2`, `_3`, … suffixes.
- **Iteration order is fixed**: paths alphabetically, methods in the order get, put, post, delete, options, head, patch, trace.
- **Input schemas** merge effective path-level and operation-level parameters from every supported location (path, query, header, cookie) with each realizable request-media candidate's own body surface. Distinct finite declarations keep their application names when unique; collisions receive deterministic neutral suffixes and a binding-private `inputTransform` carries the exact protocol route. An explicitly dynamic object or declaration-complex exact JSON body is preserved as one full schema under a protocol-neutral `payload` property and privately routed whole, so runtime members cannot collide with independent parameters and no schema branch is selected by the binding. Distinct candidate surfaces are preserved with `anyOf`; parameter-only and non-JSON surfaces are closed against fields the invoker would refuse, while flattened JSON object candidates remain open for the binding's declared passthrough rule.
- **Output schemas** conservatively union every value-bearing success lane that can govern a 2xx response: exact 2xx entries, `2XX`, and an unshadowed `default`. Exact and ranged JSON declarations contribute their schemas, text/SSE declarations contribute strings, artifact-authorized raw-byte lanes contribute canonical Base64 strings, and a schema-less JSON lane leaves output unspecified rather than inventing a shape.
- **Schema projection** targets JSON Schema 2020-12 (spec OBI-D-06), keyed on the artifact's declared `openapi` version and operation direction. OpenAPI 3.0.x schemas are translated from their subset dialect and ignore Reference Object siblings; 3.1.x Schema Object `$ref` siblings compose under JSON Schema semantics, while non-schema Reference Objects apply only their legal site-local `summary`/`description` overrides. External resources retain their own retrieval base even when a schema target is discovered after that resource was cached; late `$id` and anchor scopes are reindexed before projection. Request contracts omit `readOnly` properties and response contracts omit `writeOnly` properties, with required lists repaired through nested and recursive graphs. Unknown annotations remain annotations rather than being assigned invented validation meaning. An operation whose projected contract inherits a custom 3.1 schema dialect that cannot be losslessly projected to 2020-12 is excluded by tolerant synthesis and fails strict synthesis explicitly; schema-free operations and supported per-schema overrides remain available, and the dialect does not by itself prevent artifact-native invocation.
- **Unrealizable targets fail synthesis**: declaration-complex form, multipart, text, raw, and media-range schemas without one artifact-defined carriage; case-colliding HTTP header declarations; and required bodies with no supported media candidate make the whole strict synthesis call fail. Exact JSON-family declaration-complex bodies use whole-value carriage. An optional body may be omitted with a warning only when the remaining no-body operation is still faithfully invocable.
- **No security metadata is written to the OBI**; `securitySchemes` are honored at invocation time via context negotiation (`CONTEXT_REQUIRED` challenges and the `prepareBinding` preflight).

## License

Apache-2.0

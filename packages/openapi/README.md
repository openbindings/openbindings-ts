# @openbindings/openapi

OpenAPI 3.x binding invoker and interface synthesizer for the [OpenBindings](https://openbindings.com) TypeScript SDK.

This package enables OpenBindings to invoke operations against OpenAPI specs and synthesize OBI documents from them. It reads OpenAPI 3.x documents, constructs HTTP requests, applies credentials via security schemes, and delivers results through the SDK's cardinality-agnostic `Invocation` handle.

See the [spec](https://github.com/openbindings/spec) and the [invocation pattern](https://openbindings.com/spec/invocation-pattern) for how binding invokers and interface synthesizers fit into the OpenBindings architecture.

## Install

```
npm install @openbindings/openapi
```

Requires [@openbindings/sdk](https://www.npmjs.com/package/@openbindings/sdk) (the core SDK).

## Usage

### Register with OperationInvoker

```typescript
import { OperationInvoker } from "@openbindings/sdk";
import { OpenAPIInvoker } from "@openbindings/openapi";

const invoker = new OperationInvoker([new OpenAPIInvoker()]);
```

The invoker declares the binding specification `openbindings.openapi@1` — it handles exactly OpenAPI 3.0.0–3.0.4 and 3.1.0–3.1.2 documents, discriminated by the artifact's own `openapi` field. This package implements the published [`openbindings.openapi@1`](https://github.com/openbindings/spec/blob/main/binding-specs/openapi/openbindings.openapi.md) binding specification; that document is normative for input mapping (the flattened model, OAS style/explode serialization), request media selection, server resolution, interaction shape, and channel assembly.

### Invoke a binding

Typically you don't call the invoker directly — the `OperationInvoker` routes operations to it based on the OBI source's binding specification. But direct use is straightforward:

```typescript
import { single } from "@openbindings/sdk";

const invoker = new OpenAPIInvoker();

const call = invoker.invokeBinding({
  source: {
    bindingSpec: "openbindings.openapi@1",
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
  console.error(err.code, err.message); // e.g. "ERR_AUTH_REQUIRED", "HTTP 401 Unauthorized"
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

An absent `body` is distinct from an exact empty `Uint8Array`. It currently
occurs for a non-2xx SSE response, which is classified and cancelled without
waiting for a possibly unbounded stream to end.

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
      bindingSpec: "openbindings.openapi@1",
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
5. Reads the input message from the handle and routes its fields per the flattened model (OAPI-P-03) — parameters serialize per the OAS style/explode rules (OAPI-P-02); unmatched fields pass into a declared request body and refuse loudly otherwise — and selects the request media type per the specification's preference order (OAPI-P-04)
6. Applies credentials from the context using the spec's `securitySchemes` (bearer, basic, apiKey, oauth2 with correct placement), refusing credential/parameter channel collisions pre-dispatch (OAPI-P-10)
7. Makes the HTTP request, sets the response headers as leading metadata; the declared success media bound the interaction shape (unary, or server-streaming for a declared `text/event-stream` response, OAPI-P-06); classifies the outcome (success iff status is 2xx, OAPI-P-08; error statuses preserve lossless native response evidence on the failure completion), decodes successful bodies by the response's `Content-Type` header (strict JSON for `application/json` and `+json` suffixes, the charset-honoring text lane otherwise, OAPI-P-07), and emits the value — classification and decode both run through the consumer hooks seam, and the trailer metadata carries `x-ob-decode`/`x-ob-classify` provenance stamps

### Server selection

By default the request target is the OAS effective server list's first entry (operation `servers`, else the path item's, else the document's, else the implied `/`), with server-variable defaults substituted; a relative server URL resolves against the source `location`. Server resolution is the specification's named configuration point (OAPI-P-05): set `configuration.server` in the invocation context to select another declared entry (`url` or `index`), supply `variables`, or supply a complete `baseUrl` outright:

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

Hooks are configured per invocation (`InvokeOptions`) or invoker-level (`OperationInvokerOptions`); a hook declines to the next tier by returning `USE_DEFAULT`. Each invocation records how each axis was decided in its trailer metadata (`x-ob-decode`: `header/content-type` or `hook`; `x-ob-classify`: `assumption/2xx` or `hook`), so a caller can see whether their hook fired.

### Credential application

Credentials are applied based on the OpenAPI spec's security configuration:

- **`http` + `bearer`**: Sets `Authorization: Bearer <token>` from `bearerToken` context field
- **`http` + `basic`**: Sets `Authorization: Basic <encoded>` from `basic.username`/`basic.password` context fields
- **`apiKey`**: Places the `apiKey` context field in the header, query param, or cookie as the spec declares
- **`oauth2` / `openIdConnect`**: Sets `Authorization: Bearer <token>` from the `accessToken` (or `bearerToken`) context field

When no security schemes are defined, falls back to bearer -> basic -> apiKey in that order.

When declared security is unsatisfied by the context, the invoker challenges `CONTEXT_REQUIRED` before any input is read or network touched, deriving the challenge from the artifact's `securitySchemes` (the negotiation surface is the [binding-invoker interface](https://openbindings.com/interfaces/binding-invoker); the challenge's `target` is the resolved base URL):

| Scheme            | Requirement type | Carried fields                                                           |
| ----------------- | ---------------- | ------------------------------------------------------------------------ |
| `http` / `basic`  | `auth.basic`     | —                                                                        |
| `http` / `bearer` | `auth.bearer`    | —                                                                        |
| `apiKey`          | `auth.apiKey`    | —                                                                        |
| `oauth2`          | `auth.oauth2`    | `grantType`, `authorizeUrl`, `tokenUrl`, `scopes` from the selected flow |
| `openIdConnect`   | `auth.oauth2`    | `openIdConnectUrl`                                                       |

An `oauth2` scheme declaring several flows selects one by fixed preference — `authorizationCode`, then `implicit`, then `password`, then `clientCredentials` — and `grantType` names the selection in its RFC 6749 spelling (`authorization_code`, `implicit`, `password`, `client_credentials`). Every requirement carries the scheme's declared name (its `securitySchemes` key), which disambiguates ANDed requirements of one type and keys the scheme-scoped credential lookup: an API-key scheme named `N` resolves `apiKeys[N]` first, falling back to the single `apiKey` convenience.

A scheme outside this table is **surfaced, never dropped**: it emits a requirement typed from the artifact's own scheme (`http`/`digest` → `auth.http.digest`; any other type `T` → `auth.<T>`, e.g. `auth.mutualTLS`) that this package cannot itself apply. The alternative stays discoverable — unselectable only for runtimes without a resolver for that family — and a document whose every alternative is unmapped produces a readable challenge instead of an unauthenticated dispatch into a blind 401.

### Interface synthesis

Deterministic generation of OBI documents is a synthesis concern outside the binding specification (`openbindings.openapi@1` §10); these are this package's conventions, chosen so both reference SDKs emit an identical OBI for the same artifact:

- **Operation keys** come from `operationId` when present, sanitized to the OBI key grammar (non-key characters become `_`, leading/trailing `_` trimmed, a leading non-letter gets an `_` prefix). An `operationId` whose sanitized key is already taken falls through to path+method derivation: template segments (`{id}`) dropped, remaining segments joined with `.`, the lowercased method appended (`/users/{id}` + `GET` → `users.get`), then deduplicated deterministically with `_2`, `_3`, … suffixes.
- **Iteration order is fixed**: paths alphabetically, methods in the order get, put, post, delete, options, head, patch, trace.
- **Input schemas** merge effective path-level and operation-level parameters from every supported location (path, query, header, cookie) with each realizable request-media candidate's own body surface. Distinct candidate surfaces are preserved with `anyOf`; parameter-only and non-JSON surfaces are closed against fields the invoker would refuse, while JSON object candidates remain open for the binding's declared passthrough rule.
- **Output schemas** conservatively union every value-bearing success lane that can govern a 2xx response: exact 2xx entries, `2XX`, and an unshadowed `default`. JSON declarations contribute their schemas, non-JSON/SSE declarations contribute strings, and a schema-less JSON lane leaves output unspecified rather than inventing a shape.
- **Schema translation** targets JSON Schema 2020-12 (spec OBI-D-06), keyed on the artifact's declared `openapi` version: 3.0.x schemas are normalized out of the Draft-4 subset dialect; 3.1.x schemas pass through unchanged.
- **Unrealizable targets fail synthesis**: cross-location parameter collisions and required bodies with no non-colliding, supported media candidate make the whole synthesis call fail. An optional body may be omitted with a warning only when the remaining no-body operation is still faithfully invocable.
- **No security metadata is written to the OBI**; `securitySchemes` are honored at invocation time via context negotiation (`CONTEXT_REQUIRED` challenges and the `prepareBinding` preflight).

## License

Apache-2.0

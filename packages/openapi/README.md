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

The invoker declares the binding specification `openbindings.openapi@1` — it handles OpenAPI 3.0.x and 3.1.x documents, discriminated by the artifact's own `openapi` field. This package implements the published [`openbindings.openapi@1`](https://github.com/openbindings/spec/blob/main/binding-specs/openapi/openbindings.openapi.md) binding specification; that document is normative for input mapping (the flattened model, OAS style/explode serialization), request media selection, server resolution, interaction shape, and channel assembly.

### Invoke a binding

Typically you don't call the invoker directly — the `OperationInvoker` routes operations to it based on the OBI's source format. But direct use is straightforward:

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
  sources: [{
    bindingSpec: "openbindings.openapi@1",
    location: "https://api.example.com/openapi.json",
  }],
});
// iface is a fully-formed OBInterface with operations, bindings, and sources
```

## How it works

### Execution flow

1. Loads and caches the OpenAPI document (JSON or YAML, local or remote), discriminating the accepted 3.0.x/3.1.x lines (OAPI-P-01)
2. Parses the ref as a JSON Pointer (`#/paths/~1users/get` -> path `/users`, method `get`); the method is lowercase exactly as the artifact spells it — an uppercase method is refused, never case-folded (OAPI-D-03)
3. Resolves the server (the OAS effective list + variables + the `server` configuration point, OAPI-P-05)
4. Derives auth requirements from the operation's (or document's) `security` and challenges `CONTEXT_REQUIRED` when the context can't satisfy them — before any request is dispatched
5. Reads the input message from the handle and routes its fields per the flattened model (OAPI-P-03) — parameters serialize per the OAS style/explode rules (OAPI-P-02); unmatched fields pass into a declared request body and refuse loudly otherwise — and selects the request media type per the specification's preference order (OAPI-P-04)
6. Applies credentials from the context using the spec's `securitySchemes` (bearer, basic, apiKey, oauth2 with correct placement), refusing credential/parameter channel collisions pre-dispatch (OAPI-P-10)
7. Makes the HTTP request, sets the response headers as leading metadata; the declared success media bound the interaction shape (unary, or server-streaming for a declared `text/event-stream` response, OAPI-P-06); classifies the outcome (success iff status is 2xx, OAPI-P-08; error statuses terminate the handle with `{ status, body }` details), decodes the body by the response's `Content-Type` header (strict JSON for `application/json` and `+json` suffixes, the charset-honoring text lane otherwise, OAPI-P-07), and emits the value — classification and decode both run through the consumer hooks seam, and the trailer metadata carries `x-ob-decode`/`x-ob-classify` provenance stamps

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

### Interface synthesis

Converts an OpenAPI 3.x document into an OBI by:
- Resolving all `$ref` pointers for fully inlined schemas
- Extracting operations from each path + method combination, paths sorted alphabetically for deterministic output (same artifact → identical OBI, matching the Go SDK)
- Building input schemas from parameters and request bodies
- Building output schemas from success responses (200, 201, 202)
- Generating JSON Pointer refs for each binding
- Deriving operation keys from `operationId` or path + method

## License

Apache-2.0

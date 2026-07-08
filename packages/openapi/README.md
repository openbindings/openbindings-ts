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

The invoker declares `openapi@^3.0.0` — it handles any OpenAPI 3.x spec.

### Invoke a binding

Typically you don't call the invoker directly — the `OperationInvoker` routes operations to it based on the OBI's source format. But direct use is straightforward:

```typescript
import { single } from "@openbindings/sdk";

const invoker = new OpenAPIInvoker();

const call = invoker.invokeBinding({
  source: {
    format: "openapi@3.1.0",
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
    format: "openapi@3.1.0",
    location: "https://api.example.com/openapi.json",
  }],
});
// iface is a fully-formed OBInterface with operations, bindings, and sources
```

## How it works

### Execution flow

1. Loads and caches the OpenAPI document (JSON or YAML, local or remote)
2. Parses the ref as a JSON Pointer (`#/paths/~1users/get` -> path `/users`, method `get`)
3. Resolves the base URL from the spec's `servers` array
4. Derives auth requirements from the operation's (or document's) `security` and challenges `CONTEXT_REQUIRED` when the context can't satisfy them — before any request is dispatched
5. Reads the input message from the handle and classifies its fields as path, query, header, or body parameters based on the OpenAPI parameter definitions
6. Applies credentials from the context using the spec's `securitySchemes` (bearer, basic, apiKey, oauth2 with correct placement)
7. Makes the HTTP request, sets the response headers as leading metadata, and emits the parsed response body (HTTP error statuses terminate the handle with `{ status, body }` details)

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
- Extracting operations from each path + method combination
- Building input schemas from parameters and request bodies
- Building output schemas from success responses (200, 201, 202)
- Generating JSON Pointer refs for each binding
- Deriving operation keys from `operationId` or path + method

## License

Apache-2.0

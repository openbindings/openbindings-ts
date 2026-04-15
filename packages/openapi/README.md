# @openbindings/openapi

OpenAPI 3.x binding executor and interface creator for the [OpenBindings](https://openbindings.com) TypeScript SDK.

This package enables OpenBindings to execute operations against OpenAPI specs and synthesize OBI documents from them. It reads OpenAPI 3.x documents, constructs HTTP requests, applies credentials via security schemes, and returns results as a stream of events.

See the [spec](https://github.com/openbindings/spec) and [pattern documentation](https://github.com/openbindings/spec/tree/main/patterns) for how executors and creators fit into the OpenBindings architecture.

## Install

```
npm install @openbindings/openapi
```

Requires [@openbindings/sdk](https://www.npmjs.com/package/@openbindings/sdk) (the core SDK).

## Usage

### Register with OperationExecutor

```typescript
import { OperationExecutor } from "@openbindings/sdk";
import { OpenAPIExecutor, OpenAPICreator } from "@openbindings/openapi";

const exec = new OperationExecutor([new OpenAPIExecutor(), new OpenAPICreator()]);
```

The executor declares `openapi@^3.0.0` — it handles any OpenAPI 3.x spec.

### Execute a binding

Typically you don't call the executor directly — the `OperationExecutor` routes operations to it based on the OBI's source format. But direct use is straightforward:

```typescript
const executor = new OpenAPIExecutor();

for await (const event of executor.executeBinding({
  source: {
    format: "openapi@3.1",
    location: "https://api.example.com/openapi.json",
  },
  ref: "#/paths/~1users/get",
  context: { bearerToken: "tok_123" },
})) {
  if (event.error) console.error(event.error.message);
  else console.log(event.data);
}
```

### Create an interface from an OpenAPI spec

```typescript
const creator = new OpenAPICreator();

const iface = await creator.createInterface({
  sources: [{
    format: "openapi@3.1",
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
4. Classifies input fields as path, query, header, or body parameters based on the OpenAPI parameter definitions
5. Applies credentials from the context using the spec's `securitySchemes` (bearer, basic, apiKey with correct placement)
6. Makes the HTTP request and returns the result as a stream event

### Credential application

Credentials are applied based on the OpenAPI spec's security configuration:

- **`http` + `bearer`**: Sets `Authorization: Bearer <token>` from `bearerToken` context field
- **`http` + `basic`**: Sets `Authorization: Basic <encoded>` from `basic.username`/`basic.password` context fields
- **`apiKey`**: Places the `apiKey` context field in the header, query param, or cookie as the spec declares

When no security schemes are defined, falls back to bearer -> basic -> apiKey in that order.

### Interface creation

Converts an OpenAPI 3.x document into an OBI by:
- Resolving all `$ref` pointers for fully inlined schemas
- Extracting operations from each path + method combination
- Building input schemas from parameters and request bodies
- Building output schemas from success responses (200, 201, 202)
- Generating JSON Pointer refs for each binding
- Deriving operation keys from `operationId` or path + method

## License

Apache-2.0

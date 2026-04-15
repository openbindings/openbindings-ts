# @openbindings/asyncapi

AsyncAPI 3.x binding executor and interface creator for the [OpenBindings](https://openbindings.com) TypeScript SDK.

This package enables OpenBindings to execute operations against AsyncAPI specs and synthesize OBI documents from them. It supports HTTP/SSE for event streaming, HTTP POST for sending messages, and WebSocket for bidirectional communication. Documents are parsed with `js-yaml` and `$ref` pointers resolved with `@openbindings/sdk`'s built-in dereferencer (browser-safe, no Node.js dependencies). Credentials are applied via the spec's security schemes.

See the [spec](https://github.com/openbindings/spec) and [pattern documentation](https://github.com/openbindings/spec/tree/main/patterns) for how executors and creators fit into the OpenBindings architecture.

## Install

```
npm install @openbindings/asyncapi
```

Requires [@openbindings/sdk](https://www.npmjs.com/package/@openbindings/sdk) (the core SDK).

## Usage

### Register with OperationExecutor

```typescript
import { OperationExecutor } from "@openbindings/sdk";
import { AsyncAPIExecutor, AsyncAPICreator } from "@openbindings/asyncapi";

const exec = new OperationExecutor([new AsyncAPIExecutor(), new AsyncAPICreator()]);
```

The executor declares `asyncapi@^3.0.0` — it handles any AsyncAPI 3.x spec.

### Execute a binding

```typescript
const executor = new AsyncAPIExecutor();

for await (const event of executor.executeBinding({
  source: {
    format: "asyncapi@3.0",
    location: "https://api.example.com/asyncapi.json",
  },
  ref: "#/operations/sendMessage",
  input: { text: "hello" },
  context: { bearerToken: "tok_123" },
})) {
  if (event.error) console.error(event.error.message);
  else console.log(event.data);
}
```

### Create an interface from an AsyncAPI spec

```typescript
const creator = new AsyncAPICreator();

const iface = await creator.createInterface({
  sources: [{
    format: "asyncapi@3.0",
    location: "https://api.example.com/asyncapi.json",
  }],
});
```

## How it works

### Execution flow

1. Parses the AsyncAPI document (YAML or JSON) and resolves all `$ref` pointers
2. Resolves the operation by ref, determines server URL and protocol
3. Dispatches based on action and protocol:
   - **receive + http/https**: SSE event stream
   - **receive + ws/wss**: WebSocket stream
   - **send + http/https**: HTTP POST (unary)
   - **send + ws/wss**: WebSocket stream (bidirectional)

### Credential application

Credentials are applied based on the AsyncAPI spec's security configuration:

- **`http` + `bearer`**: Sets `Authorization: Bearer <token>` from `bearerToken` context field
- **`http` + `basic`**: Sets `Authorization: Basic <encoded>` from `basic.username`/`basic.password` context fields
- **`apiKey`**: Places the `apiKey` context field in the header, query param, or cookie as the spec declares
- **`httpBearer`**: Same as http+bearer
- **`userPassword`**: Maps to basic auth

When no security schemes are defined, falls back to bearer -> basic -> apiKey in that order.

For WebSocket connections, the bearer token is sent in the first message body (browsers cannot set headers on WebSocket upgrades). Query-param apiKeys are appended to the WebSocket URL.

### Interface creation

Converts an AsyncAPI 3.x document into an OBI by:
- Parsing YAML/JSON and resolving all `$ref` pointers
- Iterating operations sorted alphabetically for deterministic output
- Extracting input schemas from send operation payloads
- Extracting output schemas from receive operation payloads and reply payloads
- Generating `#/operations/<id>` refs for each binding

## Supported protocols

| Protocol | Receive (subscribe) | Send (publish) |
|----------|-------------------|----------------|
| HTTP/HTTPS | SSE streaming | POST (unary) |
| WS/WSS | WebSocket streaming | WebSocket streaming |

## License

Apache-2.0

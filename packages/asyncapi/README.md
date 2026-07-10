# @openbindings/asyncapi

AsyncAPI 3.x binding invoker and interface synthesizer for the [OpenBindings](https://openbindings.com) TypeScript SDK.

This package enables OpenBindings to invoke operations against AsyncAPI specs and synthesize OBI documents from them. It supports HTTP/SSE for event streaming, HTTP POST for sending messages, and WebSocket for bidirectional communication. Documents are parsed with `js-yaml` and `$ref` pointers resolved with `@openbindings/sdk`'s built-in dereferencer (browser-safe, no Node.js dependencies). Credentials are applied via the spec's security schemes.

See the [spec](https://github.com/openbindings/spec) and the [invocation pattern](https://openbindings.com/spec/invocation-pattern) for how binding invokers and interface synthesizers fit into the OpenBindings architecture.

## Install

```
npm install @openbindings/asyncapi
```

Requires [@openbindings/sdk](https://www.npmjs.com/package/@openbindings/sdk) (the core SDK).

## Usage

### Register with OperationInvoker

```typescript
import { OperationInvoker } from "@openbindings/sdk";
import { AsyncAPIInvoker } from "@openbindings/asyncapi";

const invoker = new OperationInvoker([new AsyncAPIInvoker()]);
```

The invoker declares `asyncapi@^3.0.0` — it handles any AsyncAPI 3.x spec.

### Invoke a binding

`invokeBinding` returns a cardinality-agnostic `Invocation` handle: inputs go
in through `write`, outputs come out of the `outputs` async iterable, and
terminal failures reject `closed` (and the iteration) with an
`InvocationError`.

```typescript
import { single } from "@openbindings/sdk";

const invoker = new AsyncAPIInvoker();
const source = {
  format: "asyncapi@3.0.0",
  location: "https://api.example.com/asyncapi.json",
};

// send over HTTP (unary): one input message, one response output
const call = invoker.invokeBinding({
  source,
  ref: "#/operations/sendMessage",
  context: { bearerToken: "tok_123" },
});
await call.write({ text: "hello" });
const out = await single(call.outputs);

// receive (SSE or WebSocket subscribe): iterate the outputs
const sub = invoker.invokeBinding({
  source,
  ref: "#/operations/receiveEvents",
  context: { bearerToken: "tok_123" },
});
for await (const event of sub.outputs) {
  console.log(event);
}

// send over WebSocket (client-streaming publish): write N frames, then close
const pub = invoker.invokeBinding({ source, ref: "#/operations/publishTicks" });
await pub.write({ tick: 1 });
await pub.write({ tick: 2 });
await pub.close();
await pub.closed;
```

When the AsyncAPI document declares security the provided context cannot
satisfy, the invocation terminates with a `CONTEXT_REQUIRED` challenge before
any connection is opened; `prepareBinding` performs the same check
side-effect-free.

### Synthesize an interface from an AsyncAPI spec

```typescript
import { AsyncAPISynthesizer } from "@openbindings/asyncapi";

const synth = new AsyncAPISynthesizer();

const iface = await synth.synthesizeInterface({
  sources: [{
    format: "asyncapi@3.0.0",
    location: "https://api.example.com/asyncapi.json",
  }],
});
```

## How it works

### Execution flow

1. Parses the AsyncAPI document (YAML or JSON) and resolves all `$ref` pointers
2. Resolves the operation by ref, determines server URL and protocol
3. Checks declared security against the provided context; challenges
   `CONTEXT_REQUIRED` before any connection when it cannot be satisfied
4. Dispatches based on action and protocol:
   - **receive + http/https**: SSE subscribe — each event is one output
   - **receive + ws/wss**: WebSocket subscribe — each frame is one output;
     caller inputs are forwarded to the socket as control/subscription frames
   - **send + http/https**: HTTP POST (unary) — the first input is the
     message body; a 202/204 acknowledgment yields zero outputs, otherwise
     the decoded response body is the single output
   - **send + ws/wss**: client-streaming publish — each input is one frame;
     closing input completes the call

### Consumer hooks

Each message's bytes-to-value rule is chosen from its declared content type (the message `contentType` on the operation's messages, then its reply messages): strict JSON for `application/json` and `+json` suffixes (a declared-JSON payload that fails to parse is a loud error), text otherwise — decided by the declaration, never sniffed from the payload. This format **consults the consumer hooks seam**: an `outputDecoder` hook (per-invocation `InvokeOptions` or invoker-level `OperationInvokerOptions`) may override the builtin rule for a message. The HTTP send lane records decode provenance in its trailer metadata (`x-ob-decode`: `spec/content-type` or `hook`). Classification is not consulted (`x-ob-classify`: `not-consulted`) — message-oriented transports have no per-message success status the way HTTP does, so this format runs no result classifier; transport-level HTTP errors terminate the handle as transport failures.

### Credential application

Credentials are read from the well-known context fields and applied per the
AsyncAPI spec's security configuration:

- **`http` + `bearer`** / **`httpBearer`**: Sets `Authorization: Bearer <token>` from `bearerToken` context field
- **`http` + `basic`** / **`userPassword`**: Sets `Authorization: Basic <encoded>` from `basic.username`/`basic.password` context fields
- **`apiKey`** / **`httpApiKey`**: Places the `apiKey` context field in the header, query param, or cookie as the spec declares
- **`oauth2`**: Sets `Authorization: Bearer <token>` from `bearerToken` or `accessToken`

When no security schemes are defined, falls back to bearer -> basic -> apiKey in that order.

For WebSocket connections, the bearer token is sent in the first message body (browsers cannot set headers on WebSocket upgrades). Query-param apiKeys are appended to the WebSocket URL.

### Interface synthesis

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
| WS/WSS | WebSocket streaming (bidi-capable) | WebSocket client-streaming |

## License

Apache-2.0

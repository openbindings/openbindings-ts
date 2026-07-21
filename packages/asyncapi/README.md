# @openbindings/asyncapi

AsyncAPI 3.x binding invoker and interface synthesizer for the [OpenBindings](https://openbindings.com) TypeScript SDK.

This package enables OpenBindings to invoke operations against AsyncAPI documents and synthesize OBI documents from them. It supports HTTP/SSE for event streaming, HTTP POST for sending messages, and WebSocket for bidirectional communication. Documents are parsed with `js-yaml` and `$ref` pointers resolved with `@openbindings/sdk`'s built-in dereferencer (browser-safe, no Node.js dependencies). Credentials are applied via the document's security schemes.

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

The invoker declares the binding-spec identifier `openbindings.asyncapi@1` — exact and opaque, never a version range; the operation invoker routes a source to it by string equality on the source's `bindingSpec`. Accepted artifacts are the AsyncAPI **3.0.x** line only, discriminated by the document's own `asyncapi` field (ASYNC-P-01).

### Invoke a binding

`invokeBinding` returns a cardinality-agnostic `Invocation` handle: inputs go
in through `write`, outputs come out of the `outputs` async iterable, and
terminal failures reject `closed` (and the iteration) with an
`InvocationError`.

Dispatch follows the complementary perspective (ASYNC-P-02): the AsyncAPI
document describes the application, and the invocation is the counterparty —
invoking a `receive` operation publishes to the application; invoking a
`send` operation subscribes to what it sends.

```typescript
import { single } from "@openbindings/sdk";

const invoker = new AsyncAPIInvoker();
const source = {
  bindingSpec: "openbindings.asyncapi@1",
  location: "https://api.example.com/asyncapi.json",
};

// Publish over HTTP (unary POST): `receiveOrder` has action `receive` — the
// application receives, so invoking it publishes. The one input is the
// message; the decoded reply body is the single output (an empty-body
// 202/204 acknowledgment yields zero outputs instead).
const call = invoker.invokeBinding({
  source,
  ref: "#/operations/receiveOrder",
  context: { bearerToken: "tok_123" },
});
await call.write({ item: "tea" });
const out = await single(call.outputs);

// Subscribe (SSE over http/https, a streaming socket over ws/wss):
// `sendOrderUpdates` has action `send` — the application sends, so invoking
// it subscribes. Iterate the outputs.
const sub = invoker.invokeBinding({
  source,
  ref: "#/operations/sendOrderUpdates",
  context: { bearerToken: "tok_123" },
});
for await (const event of sub.outputs) {
  console.log(event);
}

// Publish over WebSocket (client-streaming): `receiveTicks` has action
// `receive` on a ws server — write N frames, then close.
const pub = invoker.invokeBinding({ source, ref: "#/operations/receiveTicks" });
await pub.write({ tick: 1 });
await pub.write({ tick: 2 });
await pub.close();
await pub.closed;
```

When the AsyncAPI document declares security the provided context cannot
satisfy, the invocation terminates with a `CONTEXT_REQUIRED` challenge before
any connection is opened; `prepareBinding` performs the same check
side-effect-free.

### Synthesize an interface from an AsyncAPI document

```typescript
import { AsyncAPISynthesizer } from "@openbindings/asyncapi";

const synth = new AsyncAPISynthesizer();

const iface = await synth.synthesizeInterface({
  sources: [{
    bindingSpec: "openbindings.asyncapi@1",
    location: "https://api.example.com/asyncapi.json",
  }],
});
```

## How it works

### Execution flow

1. Parses the AsyncAPI document (YAML or JSON) and resolves all `$ref` pointers
2. Resolves the operation by ref (`#/operations/<id>` is the only accepted
   spelling), determines server URL and protocol (consumer
   `configuration.server` carries one of the two §9.2-pinned value shapes —
   `{"key": "<server-name>"}` selects a member of the effective server set,
   xor `{"url": "<connection-url>"}` supplies a complete connection URL; any
   other spelling is refused with a teaching error)
3. Checks declared security against the provided context — conjunctive
   (ASYNC-P-07): the targeted server's `security` applies and the operation's
   applies in addition; within each list any one entry suffices. Challenges
   `CONTEXT_REQUIRED` before any connection when it cannot be satisfied
4. Dispatches based on action and protocol under the complementary
   perspective (ASYNC-P-02: the artifact describes the application; invoking
   `receive` publishes, invoking `send` subscribes):
   - **receive + http/https**: HTTP POST (unary publish) — the first input is
     the message body; an empty response body (202/204 acknowledgments
     included) yields zero outputs, otherwise the decoded response body is
     the single output
   - **receive + ws/wss**: client-streaming publish — each input is one
     frame; closing input after at least one message completes the call with
     zero outputs (closing with none sent is a refusal)
   - **send + http/https**: SSE subscribe — each event is one output;
     transport close completes the subscription (no reconnection in
     revision 1)
   - **send + ws/wss**: WebSocket subscribe (bidi-capable) — each frame is
     one output; caller inputs are forwarded to the socket as ordinary frames
     (closing input does not end the subscription)

### Consumer hooks

Each message's bytes-to-value rule is chosen from the governing declared content type: per message, its own `contentType`, else the document's `defaultContentType`; the governing set is the operation's `messages` (else its channel's), and the reply-side declarations govern a publish's response (direction-correct decode, ASYNC-P-05). Exactly one distinct effective type selects the lane — strict JSON for `application/json` and `+json` suffixes (a declared-JSON payload that fails to parse is a loud error), text otherwise; an ambiguous set falls to the text lane — decided by the declaration, never sniffed from the payload. This format **consults the consumer hooks seam**: an `outputDecoder` hook (per-invocation `InvokeOptions` or invoker-level `OperationInvokerOptions`) may override the builtin rule for a message. The unary publish lane records decode provenance in its trailer metadata (`x-ob-decode`: `spec/content-type` or `hook`). Classification is not consulted (`x-ob-classify`: `not-consulted`) — message-oriented transports have no per-message success status the way HTTP does, so this format runs no result classifier; transport-level HTTP errors terminate the handle as transport failures.

### Credential application

Credentials are read from the well-known context fields and applied per the
AsyncAPI document's security configuration:

- **`http` + `bearer`** / **`httpBearer`**: Sets `Authorization: Bearer <token>` from `bearerToken` context field
- **`http` + `basic`** / **`userPassword`**: Sets `Authorization: Basic <encoded>` from `basic.username`/`basic.password` context fields
- **`apiKey`** / **`httpApiKey`**: Places the key in the header, query param, or cookie as the spec declares, from the `apiKeys[<scheme name>]` context field, falling back to the single `apiKey`
- **`oauth2`**: Sets `Authorization: Bearer <token>` from `bearerToken` or `accessToken`

When no security schemes are defined, falls back to bearer -> basic -> apiKey (as `Authorization: ApiKey <key>`) in that order.

WebSocket credentials ride the upgrade request: headers, plus spec-declared query-param apiKeys appended to the dialed URL. No credential ever rides a message body or a first frame — in-band auth is excluded by the binding specification (§9.5, ASYNC-P-07). On Node the upgrade headers ride undici's non-standard `headers` init option; a WHATWG-only runtime (browsers) cannot set upgrade headers, so header-borne credentials there fail loudly rather than being silently rerouted in-band.

### Interface synthesis

Converts an AsyncAPI 3.x document into an OBI by:
- Parsing YAML/JSON and resolving all `$ref` pointers
- Iterating operations sorted alphabetically for deterministic output
- Following the complementary perspective for schema direction: a `receive` operation's payload becomes the OBI operation's input (invoking it publishes) and its declared reply becomes the output; a `send` operation's payload becomes the output (invoking it subscribes)
- Generating `#/operations/<id>` refs for each binding

## Supported protocols

The cell comes from the operation's action under the complementary perspective — invoking `receive` publishes, invoking `send` subscribes:

| Protocol | Invoking `receive` (publish) | Invoking `send` (subscribe) |
|----------|------------------------------|-----------------------------|
| HTTP/HTTPS | POST (unary) | SSE streaming |
| WS/WSS | WebSocket client-streaming | WebSocket streaming (bidi-capable) |

## License

Apache-2.0

## Runtime support

On Node, the WebSocket lane constructs the global `WebSocket`, which ships unflagged in Node 22+ — hence `engines.node >= 22`. The HTTP and SSE lanes have no such dependency; browsers and edge runtimes are unaffected.

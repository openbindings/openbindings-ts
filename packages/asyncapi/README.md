# `@openbindings/asyncapi`

Thin OpenBindings adapter and interface synthesizer over the standalone
[`@openbindings/asyncapi-client`](https://github.com/openbindings/asyncapi-client)
artifact runtime.

The package implements the unreleased first `openbindings.asyncapi@1`
candidate. No AsyncAPI binding specification has been published, and there is
no older compatibility meaning for `@1`.

The layering is deliberate:

- this package owns OBI source/ref validation, invocation-frame bridging,
  protocol-independent errors and diagnostics, synthesis, and coverage;
- the standalone runtime owns AsyncAPI loading, normalization, target and
  message resolution, security interpretation, and execution;
- protocol drivers own concrete transport and nested AsyncAPI protocol-binding
  behavior.

Under `openbindings.asyncapi@1`, AsyncAPI Core and the artifact's nested
protocol binding are deliberately incorporated as authorities. The
OpenBindings layer does not recreate their semantics or restrict synthesis to
an allowlist of installed protocols.

## Install and register

```sh
npm install @openbindings/sdk @openbindings/asyncapi
```

```ts
import { OperationInvoker } from "@openbindings/sdk";
import { AsyncAPIInvoker } from "@openbindings/asyncapi";

const invoker = new OperationInvoker([new AsyncAPIInvoker()]);
```

The candidate accepts exact AsyncAPI editions 2.0.0–2.6.0, 3.0.0, and 3.1.0.
It normalizes authored operations without rewriting the source artifact:

- v2 `publish` becomes a caller-input/publish interaction and is addressed as
  `#/channels/<escaped-channel>/publish`;
- v2 `subscribe` becomes a caller-output/subscribe interaction and is
  addressed as `#/channels/<escaped-channel>/subscribe`;
- v3 `receive` becomes a caller-input/publish interaction;
- v3 `send` becomes a caller-output/subscribe interaction;
- v3 refs are `#/operations/<escaped-operation-key>`.

The complementary perspective is intentional: AsyncAPI describes the
application, while an OpenBindings invocation acts as its counterparty.

## Invoke

```ts
import { AsyncAPIInvoker } from "@openbindings/asyncapi";

const call = new AsyncAPIInvoker().invokeBinding({
  source: {
    bindingSpec: "openbindings.asyncapi@1",
    location: "https://api.example.com/asyncapi.yaml",
  },
  ref: "#/operations/receiveOrder",
  context: { bearerToken: "tok_123" },
});

await call.write({ item: "tea" });
await call.close();
for await (const value of call.outputs) console.log(value);
await call.closed;
```

`Invocation` remains cardinality-neutral. Ordering, half-close, cancellation,
partial output, and completion behavior emerge from the selected AsyncAPI
operation and protocol driver; they are not written into the OBI document.

Ordinary inputs and outputs are message payload application values. AsyncAPI
message envelopes, protocol-binding objects, headers, status, framing, and
transport facts do not become operation fields or ordinary values. Native
evidence may be retained only through the explicit diagnostics surface.

Message headers are currently an explicit abstraction-boundary exclusion.
JSON-family and UTF-8 text payloads have built-in value carriage; binary and
codec-specific payloads require a faithful value mapping and are otherwise
excluded rather than guessed.

## Protocol drivers

The standalone engine contains the current HTTP and WebSocket execution
drivers. A host can install another protocol driver in the standalone engine
and inject that engine into `AsyncAPIInvoker`:

```ts
import {
  AsyncAPIEngine,
  type AsyncAPIProtocolDriver,
} from "@openbindings/asyncapi-client";
import { AsyncAPIInvoker } from "@openbindings/asyncapi";

const mqtt: AsyncAPIProtocolDriver = {
  protocols: ["mqtt", "mqtts"],
  async execute(request, session) {
    // Interpret request.document and its MQTT binding with ordinary
    // AsyncAPI/MQTT machinery, then exchange application values on session.
  },
};

const invoker = new AsyncAPIInvoker(
  new AsyncAPIEngine({ drivers: [mqtt] }),
);
```

A missing driver is a local pre-dispatch capability error. Driver availability
does not alter synthesis: the OBI describes the artifact's operations, not the
protocols installed in the process that happened to synthesize it.

## Synthesis and coverage

```ts
import { AsyncAPISynthesizer } from "@openbindings/asyncapi";

const result = await new AsyncAPISynthesizer().synthesizeInterfaceWithCoverage({
  sources: [{
    bindingSpec: "openbindings.asyncapi@1",
    location: "https://api.example.com/asyncapi.yaml",
  }],
});
```

Synthesis is deterministic and protocol-independent. It preserves the source
artifact and exact native ref, derives input/output schemas only from authored
payload contracts, and reports every target as represented, excluded, lossy,
or failed. It does not emit protocol names, channel addresses, headers,
methods, status codes, or driver requirements into operation schemas.

Present `content` is authoritative. HTTP(S) locations use web-platform
`fetch`; a filesystem-owning host reads process-local files and supplies their
text or parsed value as `content`.

When declared security cannot be satisfied, invocation reports
`CONTEXT_REQUIRED` before dispatch. `prepareBinding` performs the same
side-effect-free check when the artifact is inline or already cached.

## Qualification

The Go and TypeScript adapters produce exactly equal OBI and exhaustive
coverage results for all 247 independently adjudicated valid artifacts in the
sealed 250-repository AsyncAPI corpus. The sole raw parser mismatch is an
invalid external YAML document and is retained outside the supported-artifact
denominator rather than normalized with corpus-specific behavior.

## License

Apache-2.0

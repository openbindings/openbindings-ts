# @openbindings/sdk

Core TypeScript SDK for the [OpenBindings](https://openbindings.com) specification. Parse, validate, resolve, and invoke OpenBindings interfaces.

OpenBindings is an open standard: one interface, limitless bindings. An OBI (OpenBindings Interface) document describes what operations a service offers and how to reach them, independent of protocol. See the [spec](https://github.com/openbindings/spec) and [openbindings.com](https://openbindings.com) for details.

**Spec version:** implements OpenBindings 0.2. Exact range is exported as `MIN_SUPPORTED_VERSION` / `MAX_TESTED_VERSION`; check programmatically via `isSupportedVersion(version)`.

**Conformance:** `parseDocument(data)` rejects malformed JSON and duplicate object keys (OBI-D-01), then `validateInterface(iface)` enforces OBI-D-02 through OBI-D-12, OBI-D-16, and OBI-T-04 (OBI-D-13/D-14/D-15 take per-format knowledge; see §14.2's partial-verification posture). OBI-D-02 (document validates against `openbindings.schema.json`) and OBI-D-11 (examples validate against their operation's input/output schemas) are enforced via [@cfworker/json-schema](https://github.com/cfworker/cfworker/tree/main/packages/json-schema) (JSON Schema 2020-12). The schema is embedded at build time (synced via `scripts/sync-schema.sh`). In this monorepo, run `pnpm conformance` with the spec repo checked out alongside the workspace (at `../spec`, or `./spec` inside it) to exercise the core conformance corpus.

## Install

```
npm install @openbindings/sdk
```

## What this package does

- **Core types** for OpenBindings interface documents: operations, bindings, sources, transforms, schemas
- **Validation** with shape-level checks, strict mode for unknown fields, and format token validation
- **Schema compatibility** checking under the OpenBindings Schema Compatibility Profile v0.1 (reference tooling, not part of the spec) with covariant/contravariant directionality and diagnostic reasons
- **`fetchInterface`** for resolving OBIs from URLs (well-known discovery, then synthesis from raw OpenAPI / AsyncAPI / etc. via supplied synthesizers)
- **`OperationInvoker`** that dispatches operations to per-format binding invokers and applies transforms
- **Preflight** via `prepareOperation`/`prepareBinding`: a side-effect-free report of the context an invocation would require (`ContextRequiredDetails` or `null`). Invokers implement `prepareBinding` only when they can derive requirements from their source (e.g. OpenAPI `securitySchemes`); the reactive `CONTEXT_REQUIRED` error remains authoritative
- **`SourceInspector`** for discovering the bindable targets in a raw artifact before an OBI exists; format synthesizer classes implement both `InterfaceSynthesizer` and `SourceInspector`
- **`ContextStore`** contract for per-origin invocation context (credentials and non-secret configuration) with scheme-agnostic key normalization

The SDK defines the contracts that binding invokers implement but does not contain any format-specific logic. Format support is added by installing invoker packages like [`@openbindings/openapi`](https://www.npmjs.com/package/@openbindings/openapi) or [`@openbindings/asyncapi`](https://www.npmjs.com/package/@openbindings/asyncapi).

## Quick start

```typescript
import { OperationInvoker, operationSignature, fetchInterface } from "@openbindings/sdk";
import { OpenAPIInvoker, OpenAPISynthesizer } from "@openbindings/openapi";

const invoker = new OperationInvoker([new OpenAPIInvoker()]);

const { iface } = await fetchInterface("https://api.example.com", {
  synthesizers: [new OpenAPISynthesizer()],
});

const call = invoker.invoke(iface, operationSignature("listItems"));
await call.write({ limit: 10 });
for await (const item of call.outputs) {
  console.log(item); // bare output values; terminal failures throw InvocationError
}
```

For compile-time-typed operations, run `ob codegen <obi> --lang typescript` to generate an `OperationSignatures` namespace, one typed `OperationSignature<I, O>` per operation, that you pass to this same `invoke` for fully-typed input and output. (`ob` is the OpenBindings CLI, shipped separately: `brew install --cask openbindings/tap/ob` or `go install github.com/openbindings/ob/cmd/ob@latest`. The dynamic `operationSignature("...")` path needs no codegen.)

See the [monorepo README](https://github.com/openbindings/openbindings-ts#readme) for full documentation.

## Results, errors, and idioms

Outputs stream as bare values; a terminal failure rejects the output iteration (and `call.closed`) with an `InvocationError`:

```typescript
import { InvocationError, ERR_AUTH_REQUIRED, isContextRequired } from "@openbindings/sdk";

try {
  const call = invoker.invoke(iface, operationSignature("listItems"));
  await call.write({ limit: 10 });
  for await (const item of call.outputs) console.log(item);
} catch (err) {
  if (isContextRequired(err)) {
    // A negotiation signal, not a failure: err.details names the target and
    // which context fields satisfy it, and err.message already carries that
    // summary. Resolve context and retry.
    console.error(err.message);
  } else if (err instanceof InvocationError && err.code === ERR_AUTH_REQUIRED) {
    // The service rejected the credentials — refresh and retry.
  } else {
    throw err;
  }
}
```

`InvocationError.code` is typed `InvocationErrorCode | (string & {})`: the canonical codes autocomplete while a third-party invoker's own code still type-checks.

Two idioms worth knowing:

- **No-input operations** — call `close()`, or nothing at all (a binding that needs no input dispatches without one).
- **Operations that require input** — forgetting to `write()` parks the binding until cancellation (`cancel()` or an aborted `AbortSignal`), whose terminal error diagnoses the never-written input. Calling `close()` with no prior `write()` fails fast with `ERR_MISSING_INPUT` naming the missing parameter.

Client-streaming and bidirectional callers own `close()` (and drive `write()` and `outputs` concurrently); `cancel()` tears the invocation down. `close()` is idempotent and never rejects.

## Running in the browser

The core SDK is isomorphic (standard `fetch`, `AbortSignal`, `structuredClone` — no Node built-ins). But the format packages that reach a service — gRPC, Connect, the CLI/usage lane — are not portable to the browser, and a same-origin policy blocks a page from calling most third-party APIs directly. So the browser story is delegation, not native invocation:

- Run `ob start` (the OpenBindings CLI) as a local companion. It exposes a served OBI whose bindings the browser invokes over HTTP against `localhost`, and `ob` performs the real protocol work (gRPC, Connect, MCP, credentials) out of the page.
- For OpenAPI/AsyncAPI targets that send permissive CORS headers, `@openbindings/openapi` and `@openbindings/asyncapi` invoke directly from the page; inject a `fetch` via `OperationInvokerOptions` if you need to route through a proxy for the ones that do not.

This is deliberate: format parity with the Go SDK is a non-goal (see [CONTRIBUTING](../../CONTRIBUTING.md)). A browser consumer delegates to `ob` rather than reimplementing every wire protocol in the page.

## Consumer configuration (hooks)

Where a binding format's specification doesn't answer a wire question, the consumer configures the answer — the SDK never guesses from payload bytes. Three hook axes cover the three wire questions:

- **Decode** (`outputDecoder`) — how raw bytes become an output value when the format doesn't say (e.g. which lane a CLI's stdout carries).
- **Classify** (`resultClassifier`) — which outcomes are success when the format doesn't say (e.g. diff(1)-style exit codes).
- **Route** (`fieldRouter`) — which channel an input field rides; included for cross-SDK parity (no TS-native format consults it today).

A hook declines by returning the `USE_DEFAULT` sentinel, falling through the chain: per-invocation (`InvokeOptions`) → invoker-level (`OperationInvokerOptions`) → the format's content-independent built-in assumption. Formats over HTTP (OpenAPI, AsyncAPI) consult the seam because the transport leaves decode and success genuinely open — a `Content-Type`-less body, a 200 that wraps an application error — and ship decidable built-ins a hook may override. Self-describing formats (gRPC, MCP, Connect, GraphQL) never consult: message type and status determine everything, so there is nothing to override. The configuration burden is the honest signal of a format's completeness. See the [invocation-configuration guide](https://openbindings.com/spec/invocation-configuration) for the full model.

## Transforms (invoking tools only)

OpenBindings 0.2.0 mandates JSONata 2.0 as the transform language for tools that evaluate `inputTransform`/`outputTransform` (OBI-T-10). This SDK does not bundle a JSONata runtime; tools that only parse, validate, inspect, or generate code do not need one, and shipping it as a hard dependency would tax those callers. To evaluate transforms when invoking, install `jsonata` separately and pass an adapter implementing the `TransformEvaluator` interface:

```typescript
import jsonata from "jsonata";
import { OperationInvoker, type TransformEvaluator } from "@openbindings/sdk";

const transformEvaluator: TransformEvaluator = {
  evaluate: (expression, data) => jsonata(expression).evaluate(data),
};

const invoker = new OperationInvoker([/* invokers */], { transformEvaluator });
```

OBIs that declare no transforms require no runtime; calls to operations whose bindings carry transforms will surface `NoTransformEvaluatorError` if no evaluator is configured.

## License

Apache-2.0

# @openbindings/sdk

TypeScript SDK for the [OpenBindings](https://openbindings.com) specification. Parse, validate, resolve, and invoke OpenBindings interfaces.

This package provides an optional protocol-neutral `OpenBindingsRuntime` and
re-exports the layered packages that own the underlying contracts —
[`@openbindings/core`](https://www.npmjs.com/package/@openbindings/core)
(the spec-defined document model),
[`@openbindings/invoke`](https://www.npmjs.com/package/@openbindings/invoke)
(the binding-invoker / operation-invoker pattern),
[`@openbindings/synthesize`](https://www.npmjs.com/package/@openbindings/synthesize)
(the interface-synthesizer / source-inspector pattern), and
[`@openbindings/compare`](https://www.npmjs.com/package/@openbindings/compare)
(schema comparison under the OB-2020-12 profile). Import from here for one
dependency and one import path, or depend on the specific layers you use.

OpenBindings is an open standard. **One interface. Any binding.** Describe what a service does separately from how you access it. An OBI (OpenBindings Interface) document describes what operations a service offers and how to reach them, independent of protocol. See the [spec](https://github.com/openbindings/spec) and [guides](https://github.com/openbindings/spec/tree/main/guides) for details.

**Spec version:** implements OpenBindings 0.2. To ask whether this SDK will accept a document of a given version, call `isSupportedVersion(version)` — the OBI-T-04 acceptance oracle: it returns true exactly when `validateInterface` / `parseDocument` would process (not refuse) that version, so it is patch-lenient within a supported minor line (a 0.2.0 SDK accepts 0.2.1, 0.2.99, …) and refuses a different major, a pre-1.0 different minor, and unsupported prereleases. `MIN_SUPPORTED_VERSION` / `MAX_TESTED_VERSION` / `supportedRange()` are a distinct, narrower notion — the maintainer-*tested* range — and a version can be accepted without falling inside it.

**Conformance:** `parseDocument(data)` rejects malformed JSON and duplicate object keys (OBI-D-01), then `validateInterface(iface)` enforces OBI-D-02 through OBI-D-12 and OBI-D-16 through OBI-D-18, plus the OBI-T-04 version-refusal rule. OBI-D-13 and the binding-specification-defined address cases of OBI-D-05 require knowledge of the exact governing binding specification; a core-only validator leaves those conclusions unverified rather than claiming conformity or non-conformity, per [§10.5](https://github.com/openbindings/spec/blob/main/openbindings.md#105-verification-conclusions). OBI-D-14 and OBI-D-15 are retired identifiers. OBI-D-02, OBI-D-11, and OBI-D-17 use [json-schema-library](https://github.com/sagold/json-schema-library); the core schema and locally required JSON Schema 2020-12 meta-schemas are embedded at build time. In this monorepo, run `pnpm conformance` with the spec repo checked out alongside the workspace (at `../spec`, or `./spec` inside it) to exercise the core conformance corpus.

## Install

```
npm install @openbindings/sdk
```

## What this package does

- **Core types** for OpenBindings interface documents: operations, bindings, sources, transforms, schemas
- **Validation** with shape-level checks, strict mode for unknown fields, and binding-spec identifier validation
- **Schema compatibility** checking under the OpenBindings Schema Compatibility Profile v0.1 (reference tooling, not part of the spec) with covariant/contravariant directionality and diagnostic reasons
- **`fetchInterface`** for resolving OBIs from URLs (well-known discovery, then synthesis from raw OpenAPI / AsyncAPI / etc. via supplied synthesizers)
- **`OperationInvoker`** that dispatches operations to binding-spec implementations and applies transforms
- **Preflight** via `prepareOperation`/`prepareBinding`: a side-effect-free report of the context an invocation would require (`ContextRequiredDetails` or `null`). Invokers implement `prepareBinding` only when they can derive requirements from their source (e.g. OpenAPI `securitySchemes`); the reactive `CONTEXT_REQUIRED` error remains authoritative
- **`SourceInspector`** for discovering the bindable targets in a raw artifact before an OBI exists; format synthesizer classes implement both `InterfaceSynthesizer` and `SourceInspector`
- **`CoverageSynthesizer`** for returning a creation-time-sound OBI together with durable dispositions and an explicit claim about whether the observed upstream-interaction inventory is exhaustive
- **`ContextStore`** as an optional caller-keyed storage seam, plus requirement-scoped resolution and an opt-in origin-normalization helper

The SDK defines the contracts that binding invokers implement but does not contain any binding-spec-specific logic. Binding support is added by installing packages like [`@openbindings/openapi`](https://www.npmjs.com/package/@openbindings/openapi) or [`@openbindings/asyncapi`](https://www.npmjs.com/package/@openbindings/asyncapi).

The named binding specification—not an artifact format inferred from its
contents—is the semantic authority for a source. A binding package can complete
an underdefined specification locally, but that behavior is
implementation-defined and does not become portable meaning under the
identifier. Applications evaluating support for such a specification should
consult the package's documented completion profile rather than infer
cross-implementation agreement.

## Quick start

```typescript
import { OpenBindingsRuntime } from "@openbindings/sdk";
import { OpenAPIAdapter } from "@openbindings/openapi";

const openapi = new OpenAPIAdapter();
const runtime = new OpenBindingsRuntime({ providers: [openapi] });
const { iface } = await runtime.resolve("https://api.example.com");
const call = runtime.invoke(iface, "listItems");
await call.write({ limit: 10 });
for await (const item of call.outputs) {
  console.log(item); // bare output values; terminal failures throw InvocationError
}
```

For compile-time-typed operations, run `ob codegen <obi> --lang typescript` to generate an `OperationSignatures` namespace, one typed `OperationSignature<I, O>` per operation, that you pass to this same `invoke` for fully-typed input and output. (`ob` is the OpenBindings CLI, shipped separately: `brew install --cask openbindings/tap/ob` or `go install github.com/openbindings/ob/cmd/ob@latest`. The dynamic `operationSignature("...")` path needs no codegen.)

See the [monorepo README](https://github.com/openbindings/openbindings-ts#readme) for full documentation.

## Satisfying named interface dependencies

An OBI's `dependencies` map names its consumption slots. Prepare the consumer
and each actionable provider once, then resolve a generated dependency
signature through an application-scoped composition session:

```typescript
import {
  CompositionSession,
  OperationInvoker,
  prepareInterface,
  prepareProvider,
  single,
} from "@openbindings/sdk";
import { OpenAPIInvoker } from "@openbindings/openapi";
import { DependencySignatures } from "./component.generated.js";

const consumer = await prepareInterface(componentInterface);
const provider = await prepareProvider({
  key: "tasks-api",
  interface: tasksAPI,
  runtime: new OperationInvoker([new OpenAPIInvoker()]),
});
const session = new CompositionSession({
  consumer,
  providers: [{ provider, preference: 10 }],
});
const resolution = await session.resolve(DependencySignatures.creation);

if (resolution.status === "available") {
  const invocation = resolution.route.invoke();
  await invocation.write({ title: "Ship it" });
  const task = await single(invocation.outputs);
}
```

The generated signature derives its I/O types from the operation referenced by
the dependency, so the safe path cannot assert an unrelated contract. Dynamic
lookup returns `unknown`; the separately named unsafe constructor is the only
manual generic assertion. Resolution distinguishes provider ambiguity from
within-provider realization ambiguity, returns serializable refusal evidence,
and never performs live network or credential preflight. Call
`route.preflight()` explicitly when current context matters.

For in-process implementations, `prepareLocalProvider` maps native handlers by
exact OBI binding key. It uses the same prepared provider, policy, validation,
transform, and invocation path as a protocol provider; generic JSON-domain
values are passed by reference without serialization:

```typescript
const local = await prepareLocalProvider({
  key: "local-tasks",
  interface: tasksAPI,
  implementations: {
    "tasks.create.local": localUnary(input => repository.create(input)),
  },
});
```

For repeated calls that do not involve dependency matching, prepare the same
immutable executable artifact directly:

```typescript
const prepared = invoker.compileOperationHandle(
  await prepareInterface(iface),
  OperationSignatures.createTask,
  { bindingKey: "createTask.primary" },
);

const invocation = prepared.invoke({ context: requestContext });
await invocation.write({ title: "Ship it" });
```

## Transitional operation requirements

An operation requirement pairs one typed signature with the ordinary,
typically unbound OBI contract a consumer expects. Candidate implementations
remain application state: each supplies a concrete OBI, the operation invoker
configured with exactly the binding packages that application installed, and
an optional caller-owned preference.

```typescript
import {
  OperationInvoker,
  operationRequirement,
  resolveOperationRequirement,
  single,
} from "@openbindings/sdk";
import { OperationSignatures } from "./requirements.generated.js";

// requiredInterface is the consumer's unbound OBI contract.
// tasksAPI is a resolved, actionable OBI supplied by the application.
const requirement = operationRequirement(
  requiredInterface,
  OperationSignatures.createTask,
);

const resolution = await resolveOperationRequirement(requirement, [{
  interface: tasksAPI,
  invoker: new OperationInvoker([openapiInvoker]),
  label: "tasks-api",
}]);

if (resolution.status === "available") {
  const invocation = resolution.match.invoke();
  await invocation.write({ title: "Ship it" });
  const task = await single(invocation.outputs);
}
```

Resolution is per operation and alias-aware. It checks directional schema
compatibility and side-effect-free invocability; it never treats an
identifier claim as proof. A unique highest preference is selected for the
common route-to-one case, an equal tie is `ambiguous`, and no match is
`unavailable`. For aggregate, fan-out, race, or fallback behavior,
`matchOperationRequirement` returns every compatible, invocable match in
preference order and selects nothing.

This older surface remains available while the named-dependency model is
proved in Go and adopted downstream. New work should prefer dependencies
declared by the consumer OBI.

`knownContextRequirements` on a match is advisory preflight. A null value
means no requirement was knowable at resolution time; live
`CONTEXT_REQUIRED` remains authoritative. The SDK owns no implementation or
delegate registry—applications re-run matching whenever their own state
changes, and reactive UI adapters can render a transient resolving state while
that promise is pending.

Nothing in this surface imports a binding package. An OpenAPI-only application
installs and registers only `@openbindings/openapi`; a browser using `ob start`
can register only the binding implementation needed to reach that host and
leave the upstream protocol implementations outside its bundle entirely.

Matching accepts an `AbortSignal` and forwards it into binding preflight. A
reactive adapter should abort stale resolution when its candidate collection
changes and cancel active invocation handles when its consumer unmounts. See
the runnable
[React](../../examples/react-operation-dependencies) and
[Svelte](../../examples/svelte-operation-dependencies) proofs.

## Results, errors, and idioms

Outputs stream as bare values; a terminal failure rejects the output iteration (and `call.closed`) with an `InvocationError`:

```typescript
import { InvocationError, isContextRequired } from "@openbindings/sdk";

try {
  const call = invoker.invoke(iface, operationSignature("listItems"));
  await call.write({ limit: 10 });
  for await (const item of call.outputs) console.log(item);
} catch (err) {
  if (isContextRequired(err)) {
    // A negotiation signal: err.data names the target and which context
    // fields satisfy it. Resolve context and retry.
    console.error(err.data);
  } else if (err instanceof InvocationError) {
    // Unsuccessful completion. The abstract record is exactly code plus
    // optional data; do not infer retry or protocol meaning from an open code.
    throw err;
  } else {
    throw err;
  }
}
```

`InvocationError.code` is typed `InvocationErrorCode | (string & {})`: the canonical codes autocomplete while a third-party invoker's own code still type-checks.
The interoperable record has no `message`, `details`, or `diagnostics` member.
The inherited JavaScript `Error.message` is process-local presentation only;
it is not serialized or part of cross-implementation behavior. Native binding
evidence belongs in the standalone artifact client, logs, traces, or protocol
tooling, not on the abstract invocation.

Two idioms worth knowing:

- **No-input operations** — call `close()`, or nothing at all (a binding that needs no input dispatches without one).
- **Operations that require input** — forgetting to `write()` parks the binding until cancellation (`cancel()` or an aborted `AbortSignal`). Calling `close()` with no prior `write()` fails fast with `ERR_MISSING_INPUT`.

Client-streaming and bidirectional callers own `close()` (and drive `write()` and `outputs` concurrently); `cancel()` tears the invocation down. `close()` is idempotent and never rejects.

## Running in the browser

The core SDK is web-platform plumbing: `fetch`, `AbortSignal`,
`structuredClone`, streams, and no Node built-ins. The same package graph is
bundle-tested as a Cloudflare Worker entry. Applications install only the
binding implementations they actually use:

- For OpenAPI/AsyncAPI targets reachable from the runtime, install the
  corresponding Node-free binding package and invoke directly. Browser CORS
  still applies; Workers are not subject to browser CORS but retain their own
  network and WebSocket capabilities.
- For gRPC, local CLI, or another host-specific implementation, run `ob start`
  or an application backend as a companion. The UI or Worker invokes that
  HTTP-facing OBI while the companion performs the upstream protocol work.

Synthesis follows the same boundary. HTTP(S) artifacts use standard `fetch`.
Process-local paths are not a portable SDK capability: Node-based tooling may
read a file and pass its text as source `content`, while UI code need never
ship filesystem access.

## Consumer configuration (hooks)

Where a binding specification exposes a consumer choice because its upstream
authority does not answer a wire question, the consumer configures that
choice — the SDK never guesses from payload bytes. Three hook axes cover the
three wire questions:

- **Decode** (`outputDecoder`) — how raw bytes become an output value when the
  binding specification leaves that choice configurable.
- **Classify** (`resultClassifier`) — which outcomes are success when the
  binding specification leaves that choice configurable.
- **Route** (`fieldRouter`) — which channel an input field rides; included for
  cross-SDK parity (no TS binding package consults it today).

A hook declines by returning the `USE_DEFAULT` sentinel, falling through the
chain: per-invocation (`InvokeOptions`) → invoker-level
(`OperationInvokerOptions`) → the governing binding specification's
explicitly documented fallback, if one exists. OpenAPI and AsyncAPI expose
choices where their upstream authorities leave decode or success open.
Self-describing protocols (gRPC, MCP, Connect, GraphQL) determine those
answers from their own message and status semantics, so there is no choice to
override. See the [invocation-configuration
guide](https://openbindings.com/spec/invocation-configuration) for the full
model.

## Transforms (invoking tools only)

OpenBindings 0.2.0 mandates JSONata 2.1 as the transform language for tools that evaluate `inputTransform`/`outputTransform` (OBI-T-10). Document validation bundles the pinned `jsonata` 2.1 library to parse-check every transform expression for syntactic validity (OBI-D-18) — a validate-time check only. The SDK does **not** configure a transform *evaluation* path for you: to actually evaluate a transform when invoking, pass an adapter implementing the `TransformEvaluator` interface (the bundled `jsonata` serves both roles here — it parse-checks during validation, and you wire it to evaluate):

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

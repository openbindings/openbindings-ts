# openbindings-ts

TypeScript SDK for the [OpenBindings](https://openbindings.com) specification. Parse, validate, resolve, and invoke OpenBindings interfaces from TypeScript and JavaScript.

OpenBindings is an open standard. **One interface. Any binding.** Describe what a service does separately from how you access it. An OBI (OpenBindings Interface) document describes what operations a service offers and how to reach them, independent of protocol. See the [spec](https://github.com/openbindings/spec) and [guides](https://github.com/openbindings/spec/tree/main/guides) for details.

**Spec version:** implements OpenBindings 0.2. To ask whether this SDK will accept a document of a given version, call `isSupportedVersion(version)` — the OBI-T-04 acceptance oracle: it returns true exactly when `validateInterface` / `parseDocument` would process (not refuse) that version, so it is patch-lenient within a supported minor line (a 0.2.0 SDK accepts 0.2.1, 0.2.99, …) and refuses a different major, a pre-1.0 different minor, and unsupported prereleases. `MIN_SUPPORTED_VERSION` / `MAX_TESTED_VERSION` / `supportedRange()` are a distinct, narrower notion — the maintainer-_tested_ range — and a version can be accepted without falling inside it.

> **Draft status:** this branch implements the unreleased 0.2 working draft.
> Package versions are staged at `0.2.0` but are not available from npm until
> the coordinated release workflow succeeds. The install commands below are
> the post-release package paths. To evaluate the draft, clone this repository
> and use the pnpm workspace.

## Packages

| Package                                             | Description                                                                                              | Install                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `@openbindings/core`                                | The spec-defined core: document model, parse, validate, resolve, verify                                  | `npm install @openbindings/core`           |
| `@openbindings/invoke`                              | Binding-invoker / operation-invoker pattern: invocation handles, context, hooks, operation requirements  | `npm install @openbindings/invoke`         |
| `@openbindings/synthesize`                          | Interface synthesis, coverage accounting, source inspection, `fetchInterface`                            | `npm install @openbindings/synthesize`     |
| `@openbindings/compare`                             | Schema comparison under the published OB-2020-12 profile                                                 | `npm install @openbindings/compare`        |
| `@openbindings/sdk`                                 | Facade re-exporting core + invoke + synthesize + compare                                                 | `npm install @openbindings/sdk`            |
| [`@openbindings/openapi-client`](../openapi-client) | Standalone Swagger 2.0 and OpenAPI 3.x document-driven client and execution engine (separate repository) | `npm install @openbindings/openapi-client` |
| `@openbindings/openapi`                             | Swagger 2.0 and OpenAPI 3.x binding invoker and interface synthesizer                                    | `npm install @openbindings/openapi`        |
| `@openbindings/asyncapi`                            | AsyncAPI 3.x binding invoker and interface synthesizer                                                   | `npm install @openbindings/asyncapi`       |
| `@openbindings/mcp`                                 | MCP binding invoker and interface synthesizer                                                            | `npm install @openbindings/mcp`            |
| `@openbindings/grpc`                                | gRPC binding invoker and interface synthesizer                                                           | `npm install @openbindings/grpc`           |
| `@openbindings/connect`                             | Connect binding invoker and interface synthesizer                                                        | `npm install @openbindings/connect`        |
| `@openbindings/usage`                               | jdx usage binding invoker and interface synthesizer                                                      | `npm install @openbindings/usage`          |
| `@openbindings/graphql`                             | GraphQL binding invoker and exhaustive root-field interface synthesizer                                  | `npm install @openbindings/graphql`        |
| `@openbindings/operationgraph`                      | Operation-graph binding invoker (compose operations)                                                     | `npm install @openbindings/operationgraph` |

The SDK is layered along the project's authority graph: `@openbindings/core`
carries everything `openbindings.md` defines and never requires invocation;
`@openbindings/invoke`, `@openbindings/synthesize`, and `@openbindings/compare`
realize the published binding-invoker/operation-invoker,
interface-synthesizer/source-inspector, and schema-comparison interfaces on
top of it. `@openbindings/sdk` is a facade re-exporting all four, so existing
consumers keep one import path; new consumers may depend on the specific
layers they use.

For draft development:

```bash
pnpm install
pnpm check
pnpm test
```

Applications should not publish dependencies on the local workspace or assume
the staged `0.2.0` versions are registry-visible before the release.

## What the SDK does

- **Core types** for the OpenBindings interface document: operations, bindings, sources, transforms, schemas
- **Validation** with shape-level checks, strict mode for unknown fields, and exact binding-specification identifier validation
- **Schema compatibility** checking under the OpenBindings Schema Compatibility Profile v0.1 (covariant outputs, contravariant inputs) with diagnostic reasons
- **`fetchInterface`** for resolving OBIs from URLs: well-known discovery, then synthesis from raw OpenAPI / AsyncAPI / etc. via supplied synthesizers
- **Exhaustiveness-qualified synthesis accounting** through `CoverageSynthesizer`, pairing a creation-time-sound OBI with durable dispositions and an explicit claim about whether the upstream interaction inventory is complete
- **`OperationInvoker`** for routing operations to binding invokers by binding-spec identifier, with transform support
- **Context contracts** for caller-supplied or resolved invocation context, with requirement-scoped provisioning and no assumption that non-credential fields are public

The SDK defines the contracts that binding invokers implement but does not contain any binding-spec-specific logic itself. Binding support is added by installing binding packages.

The exact binding specification named by a source is the semantic authority for
that binding. A binding package may implement a specification that incorporates
an upstream standard, deliberately diverges from one, or defines its own
domain. If the specification leaves behavior open, package code may complete
the gap locally, but that completion is implementation-defined and must not be
presented as portable meaning of the identifier. The project binding packages
instead treat such gaps in their unreleased `openbindings.*@1` candidates as
specification work to close before publication.

## Conformance

The core SDK is tested against the OpenBindings 0.2 conformance corpus. With the spec repo checked out alongside the workspace (at `../spec`, or `./spec` inside it), run:

```bash
pnpm conformance
```

The Go/TypeScript equivalence policy and corresponding public names are in
[`IMPLEMENTATION_PARITY.md`](IMPLEMENTATION_PARITY.md). Run `pnpm correspondence`
to verify the seven-family public correspondence matrix. The same seven families
also execute the spec repository's portable synthesis corpus, so operation
identity and coverage evidence are compared across languages rather than
asserted only in mirrored package tests.

## Quick start

### Parse and validate an OBI

```typescript
import { parseDocument } from "@openbindings/core";

const iface = parseDocument(data); // rejects duplicate JSON keys and throws ValidationError if invalid

console.log(iface.name, iface.version);
for (const [name, op] of Object.entries(iface.operations)) {
  console.log(name, op.description);
}
```

### Resolve and invoke operations

```typescript
import { OperationInvoker, operationSignature } from "@openbindings/invoke";
import { fetchInterface } from "@openbindings/synthesize";
import { OpenAPIInvoker, OpenAPISynthesizer } from "@openbindings/openapi";

// Create an operation invoker with the binding implementation you need
const invoker = new OperationInvoker([new OpenAPIInvoker()]);

// Resolve an OBI from a URL (well-known discovery, with synthesis as the
// fallback when the target only exposes a raw spec such as an OpenAPI doc)
const { iface } = await fetchInterface("https://api.example.com", {
  synthesizers: [new OpenAPISynthesizer()],
});

// Invoke an operation — one handle shape for every cardinality
const call = invoker.invoke(iface, operationSignature("listItems"));
await call.write({ limit: 10 });
for await (const item of call.outputs) {
  console.log(item);
}
```

For compile-time-typed operations, run `ob codegen <obi> --lang typescript` to generate an `OperationSignatures` namespace, one typed `OperationSignature<I, O>` per operation, that you pass to this same `invoke` for fully-typed input and output:

```typescript
const call = invoker.invoke(iface, OperationSignatures.listItems);
```

### Check compatibility

```typescript
import { checkInterfaceCompatibility } from "@openbindings/compare";

const issues = await checkInterfaceCompatibility(required, provided);
for (const issue of issues) {
  console.log(`${issue.operation}: ${issue.kind} — ${issue.detail}`);
}
```

### Consume an operation contract

An operation requirement is one typed signature paired with the ordinary,
typically unbound OBI contract a consumer expects. The application supplies
concrete, invocable interfaces; the consumer does not choose their protocols:

```typescript
import {
  OperationInvoker,
  operationRequirement,
  resolveOperationRequirement,
  single,
} from "@openbindings/invoke";
import { OpenAPIInvoker } from "@openbindings/openapi";

const requirement = operationRequirement(
  requiredInterface,
  OperationSignatures.createTask,
);
const resolution = await resolveOperationRequirement(requirement, [
  {
    interface: tasksAPI,
    invoker: new OperationInvoker([new OpenAPIInvoker()]),
    label: "tasks-api",
  },
]);

if (resolution.status === "available") {
  const invocation = resolution.match.invoke();
  await invocation.write({ title: "Ship it" });
  const task = await single(invocation.outputs);
}
```

Matching is per operation, alias-aware, schema-checked, and verifies that the
supplied invoker can resolve a binding without side effects. Route-to-one
resolution uses only caller-owned preference and refuses an equal tie as
`ambiguous`. `matchOperationRequirement` returns every match without imposing
route, aggregate, race, fan-out, or fallback semantics. The SDK owns no
registry; applications retain and refresh their own interface/delegate state.

The SDK packages import no binding package. An OpenAPI-only application ships
only the SDK layers it uses (or the `@openbindings/sdk` facade) and
`@openbindings/openapi`; other binding implementations are neither installed
nor bundled.

Runnable framework proofs live in
[`examples/react-operation-dependencies`](examples/react-operation-dependencies)
and
[`examples/svelte-operation-dependencies`](examples/svelte-operation-dependencies).
The React example performs actual OpenAPI-backed reads and writes and exercises
reactive replacement, ambiguity, streams, cancellation, unmount/remount, and
SSR. The Svelte example implements the same lifecycle contract as a thin
component, guarding the framework-neutral boundary rather than proposing an
official UI package.

## Invocation model

Every operation returns a cardinality-agnostic `Invocation<I, O>` handle: the
caller writes input messages until done; the invocation yields output messages
until done. One shape serves unary, server-streaming, client-streaming, and
bidirectional bindings. Cardinality is a property of the selected binding,
never of the call signature:

```typescript
const call = invoker.invoke(iface, operationSignature("listItems"));
await call.write({ limit: 10 }); // unary: the binding closes input after one read

for await (const item of call.outputs) {
  console.log(item); // bare output values; terminal failures throw InvocationError
}
```

For an operation you are confident yields exactly one output, the one blessed
terminal is `single` — strict and short-circuiting (`ERR_EXPECTED_SINGLE` on
zero or more than one):

```typescript
import { single } from "@openbindings/invoke";

const call = invoker.invoke(iface, operationSignature("getItem"));
await call.write({ id: "item_1" });
const item = await single(call.outputs);
```

`write`'s error contract makes both styles above safe: every rejection is
truthful — a flow signal or, when a terminal has already fired, the terminal
error itself — and the output side always carries the authoritative verdict.
Handling a write rejection is optional fast-fail, never required for
correctness, and `close()` never rejects.

Client-streaming and bidirectional callers own `close()` (and drive input and
output from separate async contexts); lifecycle is observable via `closed`,
and termination via `cancel()`. Binding-native evidence remains below the
abstract invocation boundary in artifact runtimes, logs, and protocol tooling.
Missing runtime context surfaces as a
`CONTEXT_REQUIRED` terminal error raised before any side effect, resolved by
the operation invoker's `contextResolver` when one is configured.

## Binding invokers

The SDK routes operations to binding invokers by exact, opaque `bindingSpec`
identifier. Invokers declare the identifiers they implement, and the SDK uses
exact equality—never semver range matching:

`BindingInvoker` is the intended adapter boundary. General OBI processing and
the protocol-independent invocation surface remain in the SDK; a binding
package adds only the translation and behavior owned by its binding
specification. Beneath that boundary, implementations should use separately
testable, ordinary domain-native machinery where an independent source domain
exists. Binding-defined domains such as Operation Graph may instead depend
directly on OpenBindings concepts. See the binding-specification guide's
[implementation-layering doctrine](https://github.com/openbindings/spec/blob/main/binding-specs/README.md#implementation-layering).

```typescript
const invoker = new OperationInvoker([
  new OpenAPIInvoker(), // four exact OpenAPI sibling candidates
  new AsyncAPIInvoker(), // openbindings.asyncapi@1
]);
```

| Package                        | Binding specification              | Synthesizes OBIs?                                      |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------ |
| `@openbindings/openapi`        | `openbindings.openapi-2.0@1`       | yes                                                    |
| `@openbindings/openapi`        | `openbindings.openapi-3.0@1`       | yes                                                    |
| `@openbindings/openapi`        | `openbindings.openapi-3.1@1`       | yes                                                    |
| `@openbindings/openapi`        | `openbindings.openapi-3.2@1`       | yes                                                    |
| `@openbindings/asyncapi`       | `openbindings.asyncapi@1`          | yes                                                    |
| `@openbindings/mcp`            | `openbindings.mcp@1` candidate     | yes                                                    |
| `@openbindings/grpc`           | `openbindings.grpc@1`              | yes                                                    |
| `@openbindings/connect`        | `openbindings.connect@1`           | yes                                                    |
| `@openbindings/usage`          | `openbindings.usage@1`             | yes                                                    |
| `@openbindings/graphql`        | `openbindings.graphql@1` candidate | yes                                                    |
| `@openbindings/operationgraph` | `openbindings.operation-graph@1`   | no (graphs are authored, then composed at invoke time) |

Every listed binding specification is an unreleased first `@1` candidate.
None has an older published meaning or compatibility revision. Exact opaque
identifier routing is already exercised during development so the candidate
implementation and conformance evidence can be qualified before publication.

The four OpenAPI siblings govern Swagger 2.0, OpenAPI 3.0.0–3.0.4,
3.1.0–3.1.2, and 3.2.0 respectively; one source names exactly one sibling.
`@openbindings/openapi` adapts the standalone
[`@openbindings/openapi-client`](https://github.com/openbindings/openapi-client)
engine to OpenBindings. Synthesis emits ordinary Core JSONata
`inputTransform` expressions that map operation input to the public
`{parameters?, body?}` caller envelope.

Invokers implement `BindingInvoker`. Interface synthesizers implement
`InterfaceSynthesizer`; synthesizers that can return durable, explicitly
exhaustiveness-qualified source accounting implement `CoverageSynthesizer`.
Source inspectors implement `SourceInspector`.
A single class may implement any combination.

## Context and authentication

Context is never part of an OBI document. Credentials and other runtime
configuration are supplied per call or resolved at invocation time. The
contract does not prescribe storage or keying. For applications that choose
origin-scoped reuse, the SDK provides a scheme-agnostic normalization helper:

```typescript
import { normalizeContextKey } from "@openbindings/invoke";

const key = normalizeContextKey("https://api.example.com/v1/users");
// key = "api.example.com"
```

The SDK defines an optional `ContextStore` seam (async `get`/`set`/`delete`
over a caller-chosen key) and leaves storage to the app: IndexedDB in a
browser, a keychain-backed file on a server, an in-memory map in tests. It is
not required by binding invocation.

A binding that needs context it wasn't given raises a `CONTEXT_REQUIRED`
challenge before any side effect; the operation invoker resolves challenges
through its configured `contextResolver` and re-drives the binding.
`storeContextResolver(store)` is an optional store-backed realization of the
published binding-invoker challenge. It treats a challenge as a scope, not a
hint: via `scopeContext` it returns only the fields the satisfied
requirement-alternative names. It does not forward unrelated headers, cookies,
environment values, metadata, configuration, or credentials from the stored
record; any of those can be sensitive. Context the caller explicitly supplied
for the invocation is preserved separately. Because this resolver is backed by
a reusable store, it declines every alternative unless all of its requirements
explicitly carry `durable: true`; omission means one-shot and cannot authorize
stored-context release or persistence.

```typescript
import { storeContextResolver } from "@openbindings/invoke";
import type { ContextStore } from "@openbindings/invoke";

const store: ContextStore = myStore; // your get/set/delete implementation
const invoker = new OperationInvoker([new OpenAPIInvoker()], {
  contextResolver: storeContextResolver(store),
});
```

Apps that resolve interactively (prompts, browser redirects, keychains) supply
their own resolver instead.

## Schema compatibility profile

The SDK includes the OpenBindings Schema Compatibility Profile v0.1 for deterministic schema comparison:

```typescript
import { outputCompatible } from "@openbindings/compare";

const result = outputCompatible(targetSchema, candidateSchema);
if (!result.compatible) {
  console.log("Incompatible:", result.reason);
  // e.g. "type: candidate allows \"array\" but target does not"
}
```

The profile handles: type sets, const/enum, object properties and required fields, additionalProperties, array items, numeric bounds, string/array length bounds, oneOf/anyOf unions, and allOf flattening.

## Platform support

The SDK packages — `@openbindings/core`, `@openbindings/invoke`,
`@openbindings/synthesize`, `@openbindings/compare`, and the
`@openbindings/sdk` facade — use web-platform APIs and import no Node
built-ins. They are intended for Cloudflare Workers and comparable edge runtimes
as well as browsers, Node.js, Deno, and Bun. The workspace build bundles a
Worker entry that imports the core and OpenAPI packages and rejects any Node
dependency in that graph.

Binding packages remain modular and may have narrower runtime requirements.
`@openbindings/openapi` is web-platform-only and can invoke directly wherever
the target is reachable and permits the request. `@openbindings/asyncapi` also
has a Node-free import graph, although individual WebSocket credential
carriers depend on host capabilities. `@openbindings/grpc` uses a Node gRPC
transport and `@openbindings/usage` spawns local processes; use a companion
such as `ob start` when a browser or Worker needs those implementations.

Portable synthesizers do not read process-local paths. A host that has a
filesystem reads the artifact itself and passes `content`; HTTP(S) artifact
locations use standard `fetch`. This keeps filesystem policy in the
application or tooling that chose it.

## License

Apache-2.0

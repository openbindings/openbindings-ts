# Changelog

## 0.2.0 (working draft)

### Changed

- **Renamed binding "executor" terminology to "invoker" / "invoke"** to align with the OpenBindings spec 0.2.0 rename. Pre-1.0 hard rename, no deprecated aliases. Both layers — the per-format component and the orchestrator — use the `Invoker` class name, with the verb `invoke` shared across them.
  - Classes: `BindingExecutor` (interface) → `BindingInvoker`; `OperationExecutor` → `OperationInvoker`; per-format `*Executor` classes → `*Invoker` (e.g., `OpenAPIExecutor` → `OpenAPIInvoker`, `MCPExecutor` → `MCPInvoker`, `AsyncAPIExecutor` → `AsyncAPIInvoker`, `WorkersRpcExecutor` → `WorkersRpcInvoker`, `GraphQLExecutor` → `GraphQLInvoker`); `OperationExecutorOptions` → `OperationInvokerOptions`; `WorkersRpcExecutorOptions` → `WorkersRpcInvokerOptions`.
  - Types: `BindingExecutionInput` → `BindingInvocationInput`; `OperationExecutionInput` → `OperationInvocationInput`; `ExecuteOutput`/`ExecuteError`/`ExecuteSource`/`ExecutionOptions` → `InvocationOutput`/`InvocationError`/`InvocationSource`/`InvocationOptions`.
  - Methods: `executeBinding(...)` → `invokeBinding(...)`; `executeOperation(...)` / `client.execute(...)` → `invoke(...)` (orchestrator / `InterfaceClient.invoke(...)`); `addBindingExecutor` → `addBindingInvoker`; `combineExecutors`/`CombinedExecutor` → `combineInvokers`/`CombinedInvoker`.
  - Errors: `NoExecutorError` → `NoInvokerError`.
  - File renames: `packages/sdk/src/executor.ts` → `operation-invoker.ts`; `executors.ts` → `invokers.ts`; `executor-types.ts` → `invoker-types.ts`. Per-format `executor.ts` → `invoker.ts`; `execute.ts` → `invoke.ts`.

- **Format packages bumped** to `0.2.0` to match the SDK and to reflect the
  type-name and method-name breakages introduced by the rename:
  `@openbindings/openapi`, `@openbindings/asyncapi`, `@openbindings/mcp`,
  `@openbindings/graphql`, `@openbindings/workers-rpc`. The `@openbindings/sdk`
  package was already at 0.2.0. Pre-1.0 SemVer cadence; the version number
  matching the spec version is incidental.

- **Input/output schema validation tightened** at the operation invoker
  boundary (OBI-T-07 / OBI-T-08). Caller-supplied input is now always
  validated against the operation's `input` schema before any
  `inputTransform` is applied; results are validated against the `output`
  schema after `outputTransform`. Previously these guards were skipped when
  the values were `null`, which silently bypassed contract checks.

- **Combiner format-token lookup** now prefers exact token equality before
  falling back to range matching, so a source pinned to `openapi@3.1` no
  longer accidentally selects an invoker advertising `openapi@^3.0.0` when
  an exact match is available.

- **`satisfies` deduplication** now joins role and operation with a NUL
  byte (U+0000) instead of a space when keying the seen-pairs map, so
  values containing whitespace cannot collide.

- **Examples are validated unconditionally** per OBI-D-15 (strengthened
  to MUST in spec 0.2.0). The `validateExamples` field on `ValidateOptions`
  has been removed; only `rejectUnknownTypedFields` remains.

- **Schema-compatibility profile reframed** in the SDK README from
  "Profile v0.1" to "reference-tooling profile (not part of the spec)".
  Spec 0.2.0 removed the schema comparison rules from the spec body and
  made comparison a tool concern; the package's `Normalizer` and
  `inputCompatible`/`outputCompatible` helpers are now openbindings
  reference tooling, not spec primitives.

### Removed

- **`InterfaceClient`.** The class and its associated
  `InterfaceClientOptions`/`OperationEntry` types are gone. Generated typed
  invokers (from `ob codegen`) wrap an `OperationInvoker` directly and
  take the OBI per method call. Direct callers use
  `OperationInvoker.invoke({ interface, operation, input, context })`.

- **`InvocationOptions`.** Folded into `BindingContext`. Transport fields
  (`headers`, `cookies`, `environment`, `metadata`) are well-known keys
  inside the context map; helpers `contextHeaders`/`contextCookies`/
  `contextEnvironment`/`contextMetadata` read them. `InvokeBindingInput`
  no longer carries a separate `options` field.

- **`ParseDocumentOptions`.** Empty interface reserved for future flags;
  dropped per YAGNI. `parseDocument(input)` takes no options.

### Added

- **URI helpers** in `@openbindings/sdk`: `canonicalizeLocation(uri)` and
  `resolveRef(base, ref)` per spec §10 (Location Equality) and §12
  (Reference Resolution). `canonicalizeLocation` lifts bare absolute paths
  to `file://`, lowercases scheme and host, IDN-punycodes via WHATWG URL,
  strips the default port and fragment, and normalizes percent-encoding
  of unreserved characters. `resolveRef` returns absolute references
  unchanged and resolves relative references directory-relative per
  RFC 3986 §5.

- **`unknownFields(obj, known)` helper**: surfaces extension keys
  (typically `x-` fields) on a typed OpenBindings object at runtime.
  TypeScript's nominal types hide them but JavaScript naturally preserves
  them across `JSON.parse → mutate → JSON.stringify`; this helper makes
  them explicit when callers need to inspect.

- **JSONata wiring snippet** in `@openbindings/sdk/README.md`. The SDK does
  not bundle JSONata; Invoking-class consumers wire in the `jsonata` npm
  package as a `TransformEvaluator`. The README now shows the canonical
  3-line adapter.

- **MCP `CLIENT_VERSION`** synced to `0.2.0` across `@openbindings/mcp`
  (used in the MCP `Client` constructor advertised to servers).

## 0.1.0 — 2026-03-31

Initial public release.

### @openbindings/sdk

- Core types for OpenBindings interface documents
- Interface validation with strict mode for unknown fields and format token validation
- Schema compatibility checking (Profile v0.1) with covariant/contravariant directionality and diagnostic reasons
- InterfaceClient with generic type parameter for typed operation invocation
- OperationInvoker with format token range matching (caret, exact, versionless)
- Unified stream invocation model — every operation returns `AsyncIterable<StreamEvent>`
- BindingKey support for explicit binding selection bypassing the default selector
- Context store with scheme-agnostic key normalization (`host[:port]`)
- Transform pipeline (input + output) with per-event error propagation
- Schema profile: normalization, allOf flattening, directional comparison

### @openbindings/openapi

- OpenAPI 3.x binding invoker and interface creator
- HTTP request construction from OpenAPI specs (path, query, header, body parameter routing)
- Security scheme-driven credential application (bearer, basic, apiKey)
- Interface synthesis from OpenAPI documents

### @openbindings/asyncapi

- AsyncAPI 3.x binding invoker and interface creator
- SSE and WebSocket streaming support
- Protocol detection (http, https, ws, wss) with action-based routing
- Interface synthesis from AsyncAPI documents

### @openbindings/graphql

- GraphQL binding invoker and interface creator
- HTTP POST invocation for queries and mutations
- WebSocket subscriptions via graphql-transport-ws protocol
- Introspection-driven query construction with depth-limited selection sets
- `_query` constant support for pre-built queries in input schemas

### @openbindings/mcp

- MCP binding invoker and interface creator
- Streamable HTTP transport via @modelcontextprotocol/sdk
- Three entity types: tools, resources, prompts
- Fresh session per invocation for stateless operation
- Date-versioned format token (mcp@2025-11-25)

### @openbindings/workers-rpc

- Cloudflare Workers RPC binding invoker
- Direct method invocation on service binding objects
- Structured-clone serialization (preserves Date, Map, Uint8Array, etc.)
- Cloudflare ServiceStub Proxy-compatible dispatch

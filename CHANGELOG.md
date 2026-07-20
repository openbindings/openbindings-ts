# Changelog

## 0.2.0 (working draft)

### Changed

- **A mid-stream deadline is now classified `ERR_TIMEOUT` (transient / effects:
  possible), deterministically and uniformly across formats, rather than
  `ERR_CANCELLED` — restoring the retry-safety signal.** An explicit caller
  cancel remains `ERR_CANCELLED`. The invocation handle now distinguishes an
  `AbortSignal.timeout()` abort (whose reason is a `DOMException` named
  `"TimeoutError"`) from a manual `cancel()`/abort: a timeout-reason abort fires
  `ERR_TIMEOUT` (a deadline may fire after outputs have flowed, so retry-safety
  is "may have executed"), any other abort fires `ERR_CANCELLED`. This mirrors
  the Go SDK's `ctx.Err()` branch (`DeadlineExceeded` → `ERR_TIMEOUT`,
  `Canceled` → `ERR_CANCELLED`) for cross-SDK parity of code, category, and
  effects.

- **`isSupportedVersion` now answers OBI-T-04 acceptance (patch-lenient within a
  supported minor line), matching `validateInterface`/`parseDocument`;
  previously it was the strict tested-range check.** A 0.2.0 SDK now returns
  `true` for `0.2.1`, `0.2.99`, etc. — the versions `validateInterface`/
  `parseDocument` actually process — and continues to return `false` for a
  different major, a pre-1.0 different minor, and unsupported prereleases. The
  oracle now shares the single refusal predicate the validation paths use, so it
  cannot drift from them. `MIN_SUPPORTED_VERSION`/`MAX_TESTED_VERSION`/
  `supportedRange()` are unchanged and remain the maintainer-*tested* range — a
  distinct, narrower notion (a version can be accepted without being inside the
  tested range).

- **BREAKING: `@openbindings/openapi` conformance to the published
  `openbindings.openapi@1` binding specification** (parity with the Go SDK's
  `formats/openapi` conformance change). The invoker now implements the
  normative rules end to end; behavior that predated the specification and
  diverged from it changed:
  - **Input mapping (OAPI-P-02/P-03).** Parameter serialization follows the
    OAS `style`/`explode`/`allowReserved` rules wholesale (matrix/label/simple,
    form/spaceDelimited/pipeDelimited/deepObject, per-location defaults,
    `content`-form parameters). Cross-location same-name declarations refuse as
    unflattenable; unmatched input fields refuse loudly when no request body is
    declared (previously silently sent as a body); a missing declared path
    parameter refuses pre-dispatch; non-object body schemas ride the synthetic
    `body` property, unwrapped at the wire. Synthesis emits a free-form object
    body as an OPEN flattened surface (`{"type":"object"}`), never a synthetic
    `body` wrap — the wrap is reserved for non-object schemas.
  - **Request/response media (OAPI-P-04).** Request media selection follows
    the declared preference order (exact JSON → least `+json` → multipart →
    urlencoded → `text/plain` for string bodies) with pre-dispatch refusal of
    out-of-family-only declarations. Multipart parts are binary-signaled per
    edition (3.0 `format: binary`; 3.1 `contentMediaType`/`contentEncoding`),
    with caller strings decoded per declared `contentEncoding` or Base64 (the
    boundary encoding; in-process `Blob`/`Uint8Array` values still pass
    through raw as a convenience). urlencoded bodies serialize per the OAS
    `encoding` rules. The `Accept` header advertises the declared
    success-response media (previously a fixed
    `application/json, text/event-stream`).
  - **Servers (OAPI-P-05).** The OAS effective server list (operation → path
    item → document → implied `/`) with variable substitution;
    `context.configuration.server` is the named configuration point (entry
    selection by url/index, variable values, outright `baseUrl`); relative
    server URLs resolve against the source's location per RFC 3986.
    `metadata.baseURL` still works, below the configuration point.
  - **Ref (OAPI-D-03).** `#/paths/<escaped-path>/<method>` is enforced
    exactly: lowercase method (an uppercase method is refused, never
    case-folded), `#/paths/` prefix required, single escaped path token.
  - **Interaction shape (OAPI-P-06).** Streaming capability is static —
    declared `text/event-stream` on a success response — and the response's
    `Content-Type` framing selects among declared shapes; an undeclared
    event-stream response is an `ERR_PROTOCOL` failure (previously any 2xx SSE
    response silently streamed). SSE extraction is WHATWG-exact:
    empty-data/fields-only events emit nothing, incomplete final events are
    discarded, CR/CRLF/LF line endings and the leading BOM are handled, `id`
    follows lastEventId semantics, `retry` is digits-only.
  - **Decode (OAPI-P-07).** The text lane honors the `charset` parameter
    (UTF-8 default, us-ascii/latin-1 supported) and refuses invalid sequences
    and undecodable charsets loudly.
  - **Channel assembly (OAPI-P-10).** Declared cookie parameters and
    cookie-riding credentials merge into one `Cookie` header (parameters in
    declaration order, credentials appended); credential/parameter name
    collisions on a channel refuse pre-dispatch.
  - **Loading (OAPI-P-01, §3–§6).** The artifact's `openapi` field
    discriminates the accepted 3.0.x/3.1.x lines (Swagger 2.0 and other
    versions refuse loudly); duplicate mapping keys refuse (string content
    parses through the YAML layer in both spellings); embedded content
    without a location must be self-contained (relative external `$ref`s fail
    with a readable error).

- **The consumer hook seam (specification + configuration = complete
  invocation).** New core types `OutputDecoder`, `ResultClassifier`, and
  `FieldRouter` — generic callbacks consulted by format invokers for the wire
  questions a source artifact cannot answer, mirroring the Go SDK.
  Consultation decline-chains per axis: per-invocation `InvokeOptions`
  (`outputDecoder`/`resultClassifier`/`fieldRouter`) → invoker-level fields on
  `OperationInvoker` (also constructible via `OperationInvokerOptions`) → the
  format built-in, with the `USE_DEFAULT` sentinel as the uniform decline.
  Hooks see an `InvokeSite` and a `RawResult`; failures carry tier provenance.
  `snapshotHooks` exposes the both-tier snapshot to direct binding-layer
  callers (`args.hooks`); `withRuntime` carries the hook fields. Success
  stamps (`x-ob-decode`/`x-ob-classify`) and the unvalidated-assumption
  warning (`x-ob-warning`) ride invocation metadata.

- **BREAKING: content-independent decode/classify in the openapi and asyncapi
  invokers (de-sniffed).** openapi now decodes by the response's Content-Type
  HEADER (strict JSON for `application/json`/`+json` — a declared-JSON body
  that fails to parse is a loud `ERR_RESPONSE_ERROR` — text otherwise) and
  classifies success as 2xx through the seam; asyncapi decodes HTTP responses,
  SSE events, and WebSocket frames by the operation's declared message
  `contentType`, and no longer unwraps `{error}`/`{data}` convention envelopes
  in the builtin (attach an `outputDecoder` for convention lanes). The
  `maybeJSON` helper (payload sniffing) is REMOVED from the package surface —
  `isJSONContentType` (header framing) replaces it; error details carry the
  raw capture, never a parsed value.

- **Operations are invoked through signatures.** Added `OperationSignature<I, O>`
  (an inert `{ key }` carrying its input/output types as a phantom brand,
  mirroring `TypedDocumentNode`) and the `operationSignature<I, O>(key)`
  constructor. `OperationInvoker.invoke` now takes
  `invoke<I, O>(obi, signature, opts?)` returning `Invocation<I, O>`: the
  interface is a runtime argument (never part of the signature, so one signature
  works against any interface that declares the key), and per-call `context` /
  `bindingKey` / `signal` move to an `InvokeOptions` bag. The old
  `invoke(args: OperationInvocationArgs)` form and the `OperationInvocationArgs`
  type are removed. TypeScript ships the method form (generic methods are
  expressible); Go uses a free `Invoke` function for the same model.

- **Invocation is now a cardinality-agnostic handle.** `BindingInvoker.invokeBinding`
  and `OperationInvoker.invoke` return an `Invocation<I, O>` synchronously instead
  of an `AsyncIterable<InvocationOutput>`: the caller writes input messages
  (`write`/`close`), consumes `outputs` (a standard single-consumer
  `AsyncIterable<O>`), and observes lifecycle via `closed`, `header`, `trailer()`,
  and `cancel()`. One call shape serves unary, server-streaming, client-streaming,
  and bidirectional bindings; cardinality lives in the binding, never in the
  signature. Bindings implement the push-side `BindingHandle` (`inputs()`,
  `closeInput`, `emitOutput`, `closeOutput`, `fireError`, `signal`,
  `setHeader`/`setTrailer`) over the shared `InvocationImpl`, which owns bounded
  buffers with block-on-full backpressure in both directions, lossless in-order
  exactly-once delivery, drain-before-terminal ordering, and acquire-once output
  consumption (`ERR_ALREADY_CONSUMED`). The one blessed terminal is the free
  function `single(outputs)` — strict, short-circuiting "exactly one"
  (`ERR_EXPECTED_SINGLE`). The `InvocationOutput` envelope and its
  `status`/`durationMs` fields are gone: outputs are bare values of the
  operation's output type; transport facts surface via `header` metadata and
  error `details`.
  - `BindingInvocationInput` → `BindingInvocationArgs` (`{source, ref, binding?,
    context?, interface?, inputSchema?, signal?, fetch?}`; no `input`, no
    `security`, no `store`, no `callbacks`); `OperationInvocationInput` is
    removed (input flows through the handle; invocation goes through
    `invoke(obi, signature, opts?)`, see above).
  - OBI-T-07 failures are terminal AND reject the offending `write` with the same
    `InvocationError`; OBI-T-08 failures are terminal and the invalid value is
    not emitted (previously surfaced data-alongside-error). Transforms evaluate
    per message in both directions.
  - `invoke` throws synchronously on wiring errors (unknown operation, binding
    key, or source); runtime outcomes travel on the handle.
  - `InvocationError` is now a class extending `Error`.

- **Error-code wire values are now SCREAMING_SNAKE with the `ERR_` prefix**
  (`"cancelled"` → `"ERR_CANCELLED"`, etc.), plus the un-prefixed negotiation
  signal `CONTEXT_REQUIRED`, matching the `openbindings.binding-invoker` role and
  the Go SDK in lockstep. New codes: `ERR_ALREADY_CONSUMED`, `ERR_EXPECTED_SINGLE`,
  `ERR_INPUT_CLOSED`, `ERR_INVOCATION_CLOSED`, `ERR_TOO_MANY_INPUTS`,
  `ERR_MISSING_INPUT`, `ERR_PROTOCOL`, `ERR_TRANSPORT_CLOSED`, `ERR_RUNTIME`.
  Consumers switching on `code` values must update.

- **Authentication is negotiated context, not a document field.** Bindings that
  need missing runtime context terminate with `CONTEXT_REQUIRED` (details:
  `ContextRequiredDetails` — `key` + disjunctive `alternatives` over conjunctive
  `requirements`, families `auth.bearer`/`auth.apiKey`/`auth.basic`/`auth.oauth2`)
  BEFORE any observable side effect. The operation invoker resolves challenges
  via a composition-time `contextResolver`, re-driving the binding against the
  same input buffer (the already-forwarded prefix is replayed; once a binding
  shows observable progress the challenge surfaces instead). Invokers that can
  derive requirements from their source implement the side-effect-free
  `prepareBinding` preflight; `storeContextResolver(store)` composes the
  binding-invoker and context-store roles. `OperationInvoker.withRuntime` now
  takes `(contextResolver?, fetch?)`.

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

- **The `security` surface, per spec 0.2.0**: the OBI `security` section,
  `BindingEntry.security`, `SecurityMethod`, `resolveSecurity`,
  `AuthCancelledError`, and the security-reference validation. Credentials are
  never part of an OBI document; they are context, supplied per call or resolved
  through the `CONTEXT_REQUIRED` protocol. Format invokers derive auth
  requirements from their source artifacts (e.g. OpenAPI `securitySchemes`) and
  read credentials from context's well-known fields. `PlatformCallbacks`/
  `ContextStore` are no longer threaded through binding invocations; interactive
  resolution lives in the app's `contextResolver`.

- **`ERR_INVALID_INPUT`** (use `ERR_VALIDATION_FAILED`) and the lowercase
  error-code wire values.

- **Stale conformance rule IDs**: validation messages and docs now cite the
  spec's numbering (`OBI-D-16` → `OBI-D-13`, `OBI-T-13` → `OBI-T-12`), and the
  bundled `openbindings.schema.json` is synced from the spec repo's 0.2.0
  schema.

- **`InterfaceClient`.** The class and its associated
  `InterfaceClientOptions`/`OperationEntry` types are gone. `ob codegen` emits an
  `OperationSignatures` namespace; callers pass a signature and the OBI to
  `OperationInvoker.invoke(obi, signature, opts?)`.

- **`InvocationOptions`.** Folded into `BindingContext`. Transport fields
  (`headers`, `cookies`, `environment`, `metadata`) are well-known keys
  inside the context map; helpers `contextHeaders`/`contextCookies`/
  `contextEnvironment`/`contextMetadata` read them. `InvokeBindingInput`
  no longer carries a separate `options` field.

- **`ParseDocumentOptions`.** Empty interface reserved for future flags;
  dropped per YAGNI. `parseDocument(input)` takes no options.

### Added

- **`Invocation.inputClosed`** in `@openbindings/sdk` — a promise resolved
  once the invocation's input side has closed: by the caller's `close()`, by
  the binding from below (a unary binding after its first read), or by a
  terminal transition. Lets consumers that pipe a stream into an invocation
  (the operation-graph conduit) observe non-acceptance without probing with
  a failing `write`.

- **`@openbindings/operationgraph` rewritten for the transparency rewrite**
  of `openbindings.operation-graph@0.2.0`: `operation` is the held-invocation
  conduit and `each` the per-event node (`maxIterations` moved there; cycles
  forbid conduits); caller input is a write stream with back-closure;
  `$input` is the lineage root; combine readiness, lineage-max merges, and
  buffer flush precedence corrected; spec error identifiers
  (`TIMEOUT_EXCEEDED`, `WRITE_REJECTED`, `MAP_NOT_ARRAY`,
  `TRANSFORM_UNDEFINED`); unhandled conduit terminal errors are fatal to the
  graph invocation (the identity law's terminal-status clause); refs are
  JSON Pointer fragments against unconstrained host documents; per-graph
  version refusal (OG-T-02, `ERR_UNSUPPORTED_FORMAT_VERSION`, which replaces
  `ERR_MAP_NOT_ARRAY` in the SDK's error codes); validation implements
  OG-V-01..17. `validateGraph` returns structured
  `GraphValidationIssue[]` (`{rule?, message, nodeKeys?}`) so editors can
  attribute failures to nodes; `validate` remains the throwing OG-T-01 form.
  The test suite runs the spec repository's conformance corpus unmodified
  (19 execution fixtures including the identity-law suite, plus the OG-V
  validation fixtures).

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

*This date reflects the content freeze; the `v0.1.0` tag was created 2026-04-15. From 0.2.0 on, entry dates are tag dates.*

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

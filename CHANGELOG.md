# Changelog

## 0.2.0 (working draft)

### Changed

- **Invocation failures now use the minimal abstract record `{code,data?}`.**
  Portable `message`, `details`, and `diagnostics` members were removed;
  `data` is JSON-domain data defined by the code-owning rule or opaque
  application-authored failure data admitted by the governing binding
  specification, with absent data distinct from explicit JSON null.
  `CONTEXT_REQUIRED` retains its closed OR-of-AND challenge in `data` and is
  validated before resolution. Frame and operation-schema mechanics now use
  the collision-resistant owned codes `ERR_FRAME_PROTOCOL` and
  `ERR_OPERATION_VALIDATION_FAILED`; binding-specific `ERR_PROTOCOL` and
  `ERR_VALIDATION_FAILED` remain open identifiers. Caller aborts, including
  `AbortSignal.timeout()`, uniformly produce `ERR_CANCELLED`; native timeout
  evidence remains below the bridge. `config.value` now addresses nested
  configuration through a relative JSON Pointer `path`, durable context is
  reused only when every requirement of the selected alternative explicitly
  permits it, and named credentials remain scheme-scoped. The Core OBI
  document model is unchanged.

- **OpenAPI invocation is now exposed as a standalone document-driven client.**
  `@openbindings/openapi-client` invokes a directly selected OpenAPI 3.0/3.1
  operation without an OBI document, while `@openbindings/openapi` is the thin
  binding-invoker and synthesis adapter over its SDK-neutral execution engine.
  The client lives in its own repository and can be adopted without OpenBindings.
  The extraction preserves the complete unreleased first `@1` candidate
  behavior. Swagger Client remains
  a differential-test witness: focused qualification found value-shape and
  media-range gaps, a higher Node floor, and a larger dependency footprint, so
  no incomplete production substitution was introduced.

- **`@openbindings/openapi` now defaults to `openbindings.openapi@1` for exact
  schema-omitted OAS 3.0 byte carriage.** Exact non-JSON request and response
  octets cross the protocol-independent boundary as canonical Base64. Media
  ranges and artifact-defined codecs remain unchanged. No binding
  specification has been published; this is part of the first `@1`
  candidate. The Core OBI document model is unchanged.

- **`@openbindings/openapi` now defaults to `openbindings.openapi@1` for
  whole-JSON carriage.** Exact JSON-family request schemas whose top-level
  declarations require combinators, conditionals, dependent schemas, or
  explicit `unevaluatedProperties` remain one protocol-neutral application
  value. Binding-private routing preserves the complete value without
  choosing a schema branch or exposing HTTP concepts. Dynamic-object
  carriage remains part of the same first candidate. The Core OBI document
  model is unchanged.

- **`openbindings.openapi@1` added media-faithful request carriage.** The
  candidate adds canonical Base64 boundary
  values for artifact-declared raw request bytes, preserves OpenAPI 3.1
  `contentEncoding` strings as artifact-encoded wire text, and admits concrete
  `requestMedia` choices governed by OpenAPI media ranges without exposing
  HTTP concepts in operation schemas. Required range-only bodies participate
  in side-effect-free preflight before input consumption. The Core OBI
  document model is unchanged. Form and multipart carriage follows each
  accepted OAS edition's own rules, including the older 3.0.0–3.0.3 urlencoded defaults;
  multipart binary parts retain author-declared non-default media types; and
  underdefined form candidates fail closed rather than inferring routes or
  byte conversions from caller values.

- **OpenAPI security and request-channel handling now preserves complete
  artifact alternatives.** Invocation selects one satisfiable,
  collision-free Security Requirement Object instead of unioning OR
  alternatives; OAuth requirements retain their authored scopes and usable
  flow choices; undefined scheme references fail closed, unmapped reserved
  auth families cannot be selected by same-named context fields, and ambient
  credentials are never volunteered for an anonymous
  operation; and processor-owned `Host`, `Content-Length`, and conflicting
  raw/structured cookie sources refuse before dispatch. Synthesis excludes
  parameter-content media the candidate cannot faithfully carry. The generic
  context helper now also enforces its existing reserved-`auth.*` rule, and
  the generic dereferencer exposes an adapter-scoped sibling-merge hook; the
  core OBI document model is unchanged.

- **OpenAPI synthesis now projects schemas by data direction and source
  edition.** Request contracts omit `readOnly` properties, response contracts
  omit `writeOnly` properties, and nested, composed, and recursive required
  sets remain coherent. OpenAPI 3.1 Schema Object `$ref` siblings compose with
  the referenced schema, while 3.0 Reference Object siblings are ignored and
  3.1 non-schema Reference Objects apply only their legal site-local
  `summary`/`description` overrides; data-shaped references, IDs, and anchors
  remain opaque. Unsupported custom schema dialects fail portable synthesis
  honestly without globally disabling artifact-native invocation. The removed
  3.0 `nullable` keyword widens types only in 3.0—under 3.1 it remains an inert
  annotation instead of invented null acceptance. These are binding-local
  projection and artifact-loader changes, not changes to the OBI model.

- **OpenAPI invocation and synthesis now resolve complete multi-document
  descriptions through an injectable artifact resolver.** External Path Item,
  parameter, request-body, response, security, and schema references retain
  their own document scope; JSON Schema `$id` resources and anchors are
  indexed before traversal; targets discovered after a shared external
  resource was cached are prepared and reindexed in that resource's own scope;
  redirects contribute their final retrieval URI; retrieval is cached and
  abortable; and dangling references fail loudly instead of producing a
  partially dereferenced contract. Resolver configuration remains
  binding-private and does not alter the protocol-blind OBI document model.

- **`@openbindings/openapi` introduced collision-preserving routed inputs and
  preserves same-named application inputs.** Synthesis retains unique author
  names, assigns deterministic neutral suffixes only for collisions, and uses
  a binding-private core `inputTransform` for the exact OpenAPI route. The
  operation schema remains protocol-blind. This is part of the unreleased
  first `@1` candidate.

- **Per-operation dependencies compose compatibility, invocability, and
  caller policy without introducing a registry.** The core SDK now exposes
  `OperationRequirement`, `checkOperationCompatibility`,
  `matchOperationRequirement`, and `resolveOperationRequirement`. A consumer
  pairs an ordinary required OBI with a typed operation signature; an
  application supplies concrete interfaces and its explicitly installed
  `OperationInvoker`s. Matching is alias-aware, checks only the requested
  operation against both complete schema graphs, performs side-effect-free
  binding preflight, and carries advisory context requirements. The neutral
  matcher returns every invocable match; the route-to-one convenience selects
  a unique highest caller preference and refuses a tie as `ambiguous`.
  Binding packages remain optional and separately installed. Matching also
  accepts an `AbortSignal` and forwards it through side-effect-free preflight,
  allowing reactive consumers to abandon stale candidate sets.

- **Browser and edge-runtime suitability is now an executable build
  contract.** The core, OpenAPI, and AsyncAPI ESM graphs contain no Node
  imports; the workspace rejects regressions and bundles a Cloudflare
  Worker-shaped core + OpenAPI entry. Portable OpenAPI and AsyncAPI
  synthesizers fetch HTTP(S) artifacts and refuse process-local paths unless
  the host reads the artifact and supplies `content`. Runnable React and
  Svelte examples prove reactive operation availability without publishing a
  framework or registry abstraction.

- **`fetchInterface` retains synthesis coverage.** A synthesized
  `FetchedInterface` now carries the durable `SynthesisCoverage` emitted by a
  coverage-capable synthesizer instead of discarding it at acquisition. A
  synthesizer without that optional surface still falls back to strict
  synthesis. Direct and well-known OBI fetches leave coverage absent, matching
  Go.

- **MCP synthesis and invocation now support the same fidelity-tested native
  round-trip contract as Go.** Synthesized tool output schemas describe the
  complete `CallToolResult`, scope upstream `outputSchema` to
  `structuredContent`, and admit solicited progress; resource operations
  describe complete `ReadResourceResult` values. Live embedding retains the
  pagination-exhausted listing, discovery gates the negotiated revision,
  native `isError` results retain the application-authored MCP payload as
  `InvocationError.data`, and
  `bearerToken` uses the declared `Authorization: Bearer` carrier.

- **Portable synthesis conformance now proves refusal as well as successful
  coverage.** The shared version-2 corpus requires loud whole-source failure
  where faithful synthesis is impossible, and records runtime configuration
  prerequisites on represented targets. The resulting loop fixed gRPC and
  Connect authoring paths that accepted source target spellings their
  invokers would refuse; OpenAPI coverage now identifies unresolved server
  selection, and gRPC coverage identifies the transport election required by
  bare `host:port`.

- **BREAKING: the experimental `@openbindings/workers-rpc` package was
  removed.** Its legacy token had no published binding specification, its
  runtime-local behavior could not participate in the Go/TypeScript
  equivalence proof, and the adapter did not implement the withdrawn
  candidate contract. The TypeScript workspace now publishes only complete
  first-party binding implementations.

- **`@openbindings/graphql` now implements the published
  `openbindings.graphql@1` specification end to end.** The legacy versionless
  token, generated selection sets, `_query` metadata, type projection,
  implicit WebSocket target, generic credential placement, and response
  unwrapping are removed. Invocation requires the exact executable document
  (and an explicit subscription target), verifies its selected kind and
  one-root-field correspondence, passes caller input wholesale as variables,
  and emits complete GraphQL response envelopes with errors in-band.
  Synthesis inventories every observed root field using deliberately broad
  boundary schemas and exhaustive coverage evidence. A
  `GraphQLWebSocketFactory` carries explicit upgrade fields on runtimes that
  support them; the default WebSocket path refuses such fields rather than
  dropping them.

- **BREAKING: `@openbindings/asyncapi`: `configuration.server` accepts
  exactly the §9.2-pinned value shapes** — `{"key": "<server-name>",
  "variables": {"<variable-name>": "<string-value>"}?}` selecting a member
  of the effective server set, the optional `variables` member supplying
  values for the selected server's own declared variables, xor
  `{"url": "<connection-url>"}` overriding with a complete connection URL;
  the two mutually exclusive, `variables` composing only with `key`. The
  previously tolerated spellings — a bare string (member name or URL) and
  `{"name": ...}` — are refused loudly with a teaching error naming the two
  pinned forms (byte-identical to the Go SDK's; the pin exists so two
  implementations carry the value identically, and silent tolerance of
  extra spellings defeats it). Server variables substitute
  supplied-else-default-else-refusal: an undeclared supplied name is
  refused, never ignored, and a supplied value outside the variable's
  declared `enum` is refused (upstream SHOULD, hardened per the spec's
  2026-07-21 §9.2 amendment). The `variables` member restores the
  pre-alignment capability the 2026-07-20 pin briefly removed — it rode the
  unpinned `{"name", "variables"}` spelling — now under the sanctioned
  spelling; AsyncAPI declares Server Variable defaults OPTIONAL, so an
  undefaulted variable is satisfiable only by supply. The below-the-point
  `metadata.baseURL` legacy override is unchanged.

- **Comparison-engine cross-SDK canon (three rulings, 2026-07-20).**
  (1) `checkInterfaceCompatibility` now emits issues in sorted
  required-operation-key order (output before input within an operation)
  instead of the document's declaration order, matching the Go SDK's
  pinned contract. (2) Property/`required` member names in reason strings
  now interpolate in JCS (RFC 8785) rendering — the same rendering values
  already get — instead of raw interpolation; visible only for names
  carrying quotes, backslashes, or control characters; plain names render
  byte-identically to before. (3) The free `inputCompatible` /
  `outputCompatible` now throw the new `NotNormalizedError` (`not
  normalized at <path>: keyword "<kw>" must be <requirement>`) on
  tell-tale non-normalized inputs instead of risking silently divergent
  verdicts: a scalar `type` (previously read as constraining where the Go
  SDK read it as unconstrained), an unresolved `$ref`, or an unflattened
  `allOf`, anywhere the comparison would recurse. Normalized-path callers
  (`Normalizer` methods, `checkInterfaceCompatibility`) are unaffected.
  All three are pinned byte-for-byte against the Go SDK in the mirrored
  alignment tables (`packages/sdk/src/schema-profile/reasons.test.ts` ↔
  `schemaprofile/reasons_test.go`).

- **Type names in compatibility reason strings join the JCS canon**
  (direct extension of the 2026-07-20 member-name escaping ruling). The
  `type: candidate does not allow …` / `type: candidate allows … but target
  does not` reasons now render each type name in the same JCS (RFC 8785)
  string rendering member names and values get, instead of raw interpolation
  inside literal quotes. For legitimate lowercase type names the output is
  byte-identical to before; the difference is visible only for pathological
  names carrying quotes, backslashes, or control characters. Pinned
  byte-for-byte against the Go SDK in the mirrored alignment tables.

- **`engines.node >= 22` on `@openbindings/asyncapi` and `@openbindings/graphql`**
  (honest floors: their WebSocket lanes construct the global `WebSocket`,
  unflagged in Node 22+; Node 18/20 are EOL). Other packages stay `>= 18`;
  browsers and edge runtimes are unaffected.

- **OBI-D-05 literal form is enforced** (percent-encoded same-document
  fragments fail validation; the resolver no longer percent-decodes) and
  **`validateInterface` accepts leading-digit identifiers** (`2fa.verify`) per
  the committed OBI-D-03 grammar.

- **One endpoint-key derivation.** `normalizeContextKey` strips URL userinfo
  and case-folds the host, unifying the SDK's two normalizers; derived
  context-store keys now match the Go SDK byte-for-byte.

- **`@openbindings/mcp`: multi-block tool content returns the verbatim content
  array (MCP-P-05)** instead of a `"\n"`-joined string.
  **`@openbindings/asyncapi`: unary publish success is strict 2xx
  (ASYNC-P-06)** — a 3xx final status is now a failure, matching the SSE path.

- **Format packages declare `@openbindings/sdk` as a `^0.2.0` peer
  dependency** (workspace devDependency for development), so a consumer
  install dedupes to one SDK copy (`instanceof` safety across the invoker
  boundary). Exports maps carry per-condition `types` (`.d.cts` for
  `require`), and every package is `sideEffects: false`.

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
  Decode/classify provenance and unvalidated-assumption warnings remain below
  the abstract invocation boundary as binding-interpretation evidence.

- **BREAKING: content-independent decode/classify in the openapi and asyncapi
  invokers (de-sniffed).** openapi now decodes by the response's Content-Type
  HEADER (strict JSON for `application/json`/`+json` — a declared-JSON body
  that fails to parse is a loud `ERR_RESPONSE_ERROR` — text otherwise) and
  classifies success as 2xx through the seam; asyncapi decodes HTTP responses,
  SSE events, and WebSocket frames by the operation's declared message
  `contentType`, and no longer unwraps `{error}`/`{data}` convention envelopes
  in the builtin (attach an `outputDecoder` for convention lanes). The
  `maybeJSON` helper (payload sniffing) is REMOVED from the package surface —
  `isJSONContentType` (header framing) replaces it. Raw captures remain below
  the abstract invocation boundary and never become failure data.

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
  `AsyncIterable<O>`), and observes lifecycle via `closed` and `cancel()`. One
  call shape serves unary, server-streaming, client-streaming,
  and bidirectional bindings; cardinality lives in the binding, never in the
  signature. Bindings implement the push-side `BindingHandle` (`inputs()`,
  `closeInput`, `emitOutput`, `closeOutput`, `fireError`, `signal`) over the
  shared `InvocationImpl`, which owns bounded
  buffers with block-on-full backpressure in both directions, lossless in-order
  exactly-once delivery, drain-before-terminal ordering, and acquire-once output
  consumption (`ERR_ALREADY_CONSUMED`). The one blessed terminal is the free
  function `single(outputs)` — strict, short-circuiting "exactly one"
  (`ERR_EXPECTED_SINGLE`). The `InvocationOutput` envelope and its
  `status`/`durationMs` fields are gone: outputs are bare values of the
  operation's output type. Unsuccessful completion is exactly `code` plus
  optional `data`; transport facts remain below the abstract boundary.
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
  need missing runtime context terminate with `CONTEXT_REQUIRED` (data:
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

### Fixed

- **Operation-boundary schema validation now preserves the OBI document as
  the same-document reference root.** Input, output, and example validation
  compile schemas at their canonical `#/operations/...` addresses instead of
  extracting them into a synthetic root, so operation-local recursive
  `$defs`, cross-operation pointers, escaped operation keys, named schemas,
  and embedded absolute `$id` resources retain their JSON Schema meaning.
  Schema-shaped unknown fields at the OBI root remain ignored rather than
  accidentally constraining operation values.
  `compileOperationSchema` exposes the same interface-aware boundary to
  applications that drive binding invokers directly.

- **Every binding-family candidate now runs its shared D-rule corpus through
  the TypeScript package's own family lanes.** Connect, gRPC, and Usage gained
  the missing adapters, GraphQL rejoined the core corpus inventory, and the
  stale Go-only skips were removed. The new proof exposed and fixed two real
  runtime divergences: Connect no longer normalizes binding-spec-excluded
  trailing-slash, query, fragment, or userinfo base URLs into dispatchable
  targets; gRPC now accepts the specified bracketed IPv6 dial-address form.
  Connect and gRPC refs also enforce their incorporated exactly-one-`/`,
  byte-exact grammar before dispatch.

- **Synthesis and inspection order names by Unicode code point in all four
  format packages (`@openbindings/openapi`, `@openbindings/mcp`,
  `@openbindings/graphql`, `@openbindings/asyncapi`), never by host-locale
  collation.** Entity ordering — MCP tools/resources/templates/prompts,
  GraphQL fields, OpenAPI paths, AsyncAPI operation ids, and sorted
  `required` arrays — used `localeCompare`, which collates under the host
  machine's default locale and ICU data: the same source synthesized on
  differently-configured machines could emit operations in different
  order, and — because processing order decides which of two names
  colliding after sanitization wins the bare operation key — could assign
  different keys outright (ICU English collation orders `"a b"`/`"a_b"`
  and mixed-case pairs differently than byte order does). All ordering now
  routes through a per-package `codePointCompare` (Go parity: Go compares
  strings byte-wise, and UTF-8 byte order is code point order); a plain
  UTF-16 `<` comparator would not have been enough, since it ranks
  astral-plane code points below U+E000..U+FFFF. The AsyncAPI inspection
  lane also sorted with a different comparator than the synthesis lane
  whose key assignment it promises to preview; both now share one
  ordering. Pinned by mixed-case, astral-plane, and collision-assignment
  fixtures in each package.

- **`sanitizeKey` replaces an astral-plane character with one underscore,
  not one per surrogate half.** The non-key character class lacked the `u`
  flag, so a name like `t-😀-a` sanitized to `t-__-a` in TypeScript but
  `t-_-a` in Go (whose `regexp` operates on runes), yielding different
  operation keys across SDKs for the same source. All four format packages
  now use Unicode-mode classes.

- **`@openbindings/graphql`: a subscription `next` frame whose `errors`
  array carries a malformed element settles as a structured error, never a
  TypeError.** A broken or hostile graphql-transport-ws server sending
  `{"type": "next", "payload": {"errors": [null]}}` (any non-object first
  element) crashed the WebSocket message handler with an uncaught
  `TypeError: Cannot read properties of null (reading 'message')`, stranding
  the invocation with no settled error until the socket happened to close.
  The frame now surfaces as the same `ERR_EXECUTION_FAILED` a well-formed
  errors array gets. The malformed native envelope remains below the abstract
  invocation boundary (Go parity: a `null` element unmarshals to the zero
  `graphqlError`). Red-proven in the subscription suite.

- **`@openbindings/openapi`: a typeless request-body schema rides the
  synthetic `body` property on the wire, matching the published contract**
  (`openbindings.openapi@1` §9.1's declaration-only object determination:
  a body schema is object iff it declares `properties` or an explicit
  `object` type). The synthesizer wrapped a typeless body (a bare `{}` or
  a description-only schema) under the synthetic `body` property while the
  invoker treated it as flattened, so a caller following the published
  contract got `{"body": X}` on the wire instead of `X` — and the §9.1
  unmatched-field refusal for non-object bodies did not fire. Both sites
  now route through one shared predicate (`bodySchemaFlattens`), so the
  contract and the wire cannot diverge; a 3.1 two-element
  `type: ["object", "null"]` body (not an *explicit* object type) is
  likewise synthetic on both sides. Red-proven in the mirrored §9.1
  conformance tests; behavior matches the Go SDK.

- **Schema-comparison `allOf` normalization is sound** (mirrors the Go
  engine): branches normalize fully before merging, sibling keywords merge as
  one additional branch, union spellings are refused inline, ref-carried, or
  alongside `allOf`. False-`compatible` verdicts on these shapes are gone;
  red-proven against the seven new comparison-corpus fixture families.

- **`redactContext` redacts scheme-scoped `apiKeys`.** Redaction and scoping
  single-source the (now exported) `CREDENTIAL_FIELDS` registry, pinned by a
  per-field sentinel drift-guard test.

- **Document-keyed lookups are own-property-safe** (`Object.hasOwn`): a
  document using `"constructor"` as an operation/source/transform key
  validates and resolves correctly (OBI-D-08/09/10 corpus fixtures pin it).

- **`@openbindings/asyncapi`: the effective server set resolves by own-key
  lookup** (`Object.hasOwn`, Go-map parity). A malformed artifact carrying
  an inline (non-`$ref`) channel `servers` entry whose name tag matched an
  `Object.prototype` member (`"constructor"`, `"toString"`, ...) surfaced
  that prototype member as a "server", and default selection then crashed
  with a `TypeError` instead of refusing. Such an entry now contributes
  nothing to the effective set, leaving the structured
  `no resolvable server` pre-dispatch refusal (red-proven in
  `target.test.ts`).

- **The invocation handle removes its external-`AbortSignal` listener on
  terminal** (`{ once, signal }` registration), so completed invocations are
  no longer retained by a long-lived shared signal.

- **`dereference()` no longer mutates its input**: internal refs resolve
  against the clone, and the output never aliases the input document.

- **`@openbindings/asyncapi`: the response reader is cancelled when the size
  cap trips** (no pinned body stream). **`@openbindings/mcp`: pagination is
  bounded** — repeated/endless `nextCursor` refuses with `ERR_PROTOCOL`.
  **`@openbindings/operationgraph`: OG-V-11 pre-execution refusal** for an
  operation-node graph invoked without an interface.

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

- **`@openbindings/openapi`: degenerate media/schema combinations refuse
  pre-dispatch** (`openbindings.openapi@1` §9.2, amended 2026-07-21): a
  request-media selection landing on `multipart/form-data` or
  `application/x-www-form-urlencoded` while the declared body schema does
  not flatten (§9.1's declaration-only determination — no `properties` and
  no explicit `object` type), or on `text/plain` while it does, has no
  OAS-defined wire form and now refuses loudly before dispatch
  (`ERR_SOURCE_CONFIG_ERROR`, zero I/O) instead of inventing carriage
  (previously an invented multipart part or urlencoded field named `body`
  rode the wire, and the text lane misfired the §9.1 unmatched-field
  refusal against the contract's own flattened fields). Reachable only for
  operations declaring no JSON-family request media — a co-declared JSON
  media type is selected first and carries any shape. Synthesis emits the
  new **`openapi.media_schema_mismatch`** warning (`onWarning`) when the
  produced contract's only declared request media cannot carry it, so
  authors hear at synthesis time what a conformant invoker refuses at
  dispatch. Mirrors the Go SDK (byte-identical refusal messages and
  warning).

- **Configurable delivery-unit bound.** `BindingInvocationArgs.maxDeliveryUnitBytes`
  bounds ONE DELIVERY UNIT — the bytes materialized to produce one emitted
  output value; undefined or `<= 0` selects the default, and
  effectively-unlimited is an explicitly huge value (no magic sentinel).
  `OperationInvokerOptions.maxDeliveryUnitBytes` stamps it into per-invocation
  args exactly where `fetch` is stamped (args that already carry a value win).
  The SDK exports `DEFAULT_MAX_DELIVERY_UNIT_BYTES` (10485760 — equal to the
  Go SDK's default) and `resolveDeliveryUnitLimit(args)`, the single semantics
  point format packages call. Wired lanes: openapi response body, openapi
  SSE per-event (each event is one delivery unit, bounded per emission —
  never cumulatively — with the same `SSE event exceeds N byte limit`
  identity as asyncapi's; previously the lane had no per-event bound, only
  the fixed line-scanner guard), graphql
  response body (introspection loads included — one bounded reader), graphql
  subscription WebSocket messages (graphql-transport-ws frames; previously
  unbounded), asyncapi unary reply, asyncapi SSE per-event, and asyncapi
  WebSocket messages. The
  WebSocket lane enforces the bound **post-receive** — the browser/undici
  WebSocket API has no pre-delivery read-limit seam (Go uses the socket
  library's connection-level `SetReadLimit`), so each message's byte size is
  checked against the resolved bound before decode; a language-platform
  idiom, not a behavioral divergence: same bound, same `ERR_STREAM_ERROR`.
  Overflow error code is unchanged per lane (`ERR_RESPONSE_ERROR`,
  graphql's `ERR_EXECUTION_FAILED`, WS `ERR_STREAM_ERROR`). Named exclusion:
  `@openbindings/mcp` delegates
  response reading to the official MCP SDK, which exposes no read-limit seam
  — the bound is not enforced on that lane (see the package README);
  operationgraph's 8 MiB graph-document guard is an artifact-fetch bound, not
  a delivery-unit bound, and stays fixed.

- **CI corpus gating (`OB_CORPUS_REQUIRED`)**: CI checks out both corpus roots
  (spec + interfaces; the interface corpora previously ran in no TS CI) and
  corpus suites fail loudly when required-and-absent; local skip-if-absent
  behavior is unchanged.

- **Conformance-runner `requiresSupports` gate**: the corpus test annotation
  `requiresSupports: "X.Y.Z"` administers a fixture test only to tools whose
  OBI-T-04 version-acceptance predicate accepts X.Y.Z — for this SDK,
  `isSupportedVersion` — and otherwise reports the test as skipped, separately
  from pass/fail (skips are never failures). Joins the existing
  `requiresMaxTested`/`requiresMinSupported` annotations with the same skip
  mechanism and reporting.

- **README**: the SDK bundles the `jsonata` parser (2.1) for OBI-D-18
  parse-checks — the "no bundled runtime" claim was stale.

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

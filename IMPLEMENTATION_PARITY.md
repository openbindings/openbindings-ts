# Go/TypeScript implementation parity

OpenBindings 0.2.0 treats the Go and TypeScript SDKs as two idiomatic
implementations of one observable contract. They run the same core, binding
processor, and Operation Graph corpora. The checked-in
[`reference-sdk-correspondence.json`](../spec/conformance/reference-sdk-correspondence.json)
also guards the public role and family correspondence.

| Concept                                                        | Go                                                         | TypeScript                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| binding implementation                                         | `BindingInvoker`                                           | `BindingInvoker`                                           |
| supported identifiers                                          | `BindingSpecs()`                                           | `bindingSpecs()`                                           |
| invoke one binding                                             | `InvokeBinding(...)`                                       | `invokeBinding(...)`                                       |
| side-effect-free context preflight                             | `PrepareBinding(...)`                                      | `prepareBinding(...)`                                      |
| artifact → OBI                                                 | `InterfaceSynthesizer.SynthesizeInterface(...)`            | `InterfaceSynthesizer.synthesizeInterface(...)`            |
| artifact → OBI + exhaustiveness-qualified disposition evidence | `CoverageSynthesizer.SynthesizeInterfaceWithCoverage(...)` | `CoverageSynthesizer.synthesizeInterfaceWithCoverage(...)` |
| inspect bindable targets                                       | `SourceInspector.InspectSource(...)`                       | `SourceInspector.inspectSource(...)`                       |
| source-less scaffold                                           | `SynthesisSkeleton(...)`                                   | `synthesisSkeleton(...)`                                   |
| shared authoring directives + validation                       | `FinalizeSynthesis(...)`                                   | `finalizeSynthesis(...)`                                   |
| one consumed operation contract                                | `NewOperationRequirement(...)`                             | `operationRequirement(...)`                                |
| per-operation compatibility check                              | `CheckOperationCompatibility(...)`                         | `checkOperationCompatibility(...)`                         |
| all compatible, invocable matches                              | `MatchOperationRequirement(...)`                           | `matchOperationRequirement(...)`                           |
| conservative route-to-one resolution                           | `ResolveOperationRequirement(...)`                         | `resolveOperationRequirement(...)`                         |

All seven artifact/protocol families implement invocation, synthesis, and
source inspection in both SDKs: OpenAPI, AsyncAPI, MCP, gRPC, Connect, usage,
and GraphQL. The OpenAPI family declares four exact sibling tokens:
`openbindings.openapi-2.0@1`, `openbindings.openapi-3.0@1`,
`openbindings.openapi-3.1@1`, and `openbindings.openapi-3.2@1`. They govern
Swagger 2.0, OpenAPI 3.0.0–3.0.4, 3.1.0–3.1.2, and 3.2.0 respectively.

Parity means the same behavior at the OpenBindings boundary: exact
`bindingSpec` support, resolution and refusal decisions, input/output values,
stream cardinality and ordering, pre-dispatch context challenges,
classification, cancellation effects, and conformance outcomes. It does not
mean identical class/type casing, goroutines versus promises and async
iterables, stack traces, incidental error prose, caches, connection pools, or
other details that the OpenBindings contract does not expose.

Names intentionally remain recognizable across languages whenever idiom
allows: `GrpcInvoker` corresponds to `grpc.Invoker`, `synthesizeInterface` to
`SynthesizeInterface`, and so on. A user moving between SDKs should recognize
the role before learning its language-specific mechanics.

Operation-requirement parity includes per-operation alias correspondence,
directional schema comparison, side-effect-free invocability preflight,
advisory context requirements, higher-preference ordering, stable input order
across equal preferences when returning all matches, and refusal of a
route-to-one tie as ambiguous. Go cancellation uses `context.Context`;
TypeScript matching accepts `AbortSignal` and forwards it to preflight.
Neither SDK owns a registry or infers route-versus-aggregate semantics.

## Implementation proof

Every family is checked at five boundaries. Its `corpus.test.ts` adapter runs
the shared D-rule fixtures from `spec/conformance/binding-specs/<family>/`
through the package's own artifact, location, and selector lanes. Family authoring
tests then exercise artifact loading, inspection, synthesis, and
synthesized-document validation. Both SDKs execute the same portable synthesis
scenarios from `spec/conformance/binding-specs/synthesis/`, comparing exact
emitted target identities, input transforms, and exhaustive artifact
dispositions. The current shared battery contains 105 synthesis scenarios,
529 processor scenarios, and 10 OpenAPI native-fidelity scenarios, all
executed by both SDKs under the strict verifier. Protocol integration tests
exercise actual request framing and response decoding. Passing only one
boundary is not sufficient release evidence.

| Family   | Go authoring evidence                                             | TypeScript authoring evidence                                     | Shared synthesis evidence | Shared invocation evidence |
| -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- | -------------------------- |
| OpenAPI  | `formats/openapi/synthesize_test.go`, `list_refs_test.go`         | `packages/openapi/src/synthesize.test.ts`, `invoker.test.ts`      | `synthesis/openapi.json`  | `processor/openapi.json`   |
| AsyncAPI | `formats/asyncapi/synthesize_test.go`, `list_refs_test.go`        | `packages/asyncapi/src/invoker.test.ts`, `inspect-source.test.ts` | `synthesis/asyncapi.json` | `processor/asyncapi.json`  |
| MCP      | `formats/mcp/synthesize_test.go`, `list_refs_test.go`             | `packages/mcp/src/invoker.test.ts`                                | `synthesis/mcp.json`      | `processor/mcp.json`       |
| gRPC     | `formats/grpc/synthesize_test.go`, `list_refs_test.go`            | `packages/grpc/src/authoring.test.ts`                             | `synthesis/grpc.json`     | `processor/grpc.json`      |
| Connect  | `formats/connect/synthesize_test.go`, `list_refs_test.go`         | `packages/connect/src/authoring.test.ts`                          | `synthesis/connect.json`  | `processor/connect.json`   |
| usage    | `formats/usage/synthesize_interface_test.go`, `list_refs_test.go` | `packages/usage/src/authoring.test.ts`                            | `synthesis/usage.json`    | `processor/usage.json`     |
| GraphQL  | `formats/graphql/synthesize_test.go`, `list_refs_test.go`         | `packages/graphql/src/synthesize.test.ts`, `invoker.test.ts`      | `synthesis/graphql.json`  | `processor/graphql.json`   |

Both OpenAPI adapters sit over the standalone OpenAPI client for their
language. Synthesized bindings expose ordinary Core JSONata `inputTransform`
expressions that map operation input into the public `{parameters?, body?}`
caller envelope; engine-private routing does not enter an OBI document.

The authoring invariant is creation-time soundness plus explicit completeness:
inspection and synthesis apply the same target eligibility used by invocation;
no emitted operation is statically guaranteed to refuse; every observed
interaction and independently selectable artifact alternative receives a
durable disposition; and direct synthesis fails as a whole when an accepted
target cannot be represented faithfully. It is not a promise that a live
source or peer will never change after synthesis.

## Intentional revision-1 boundaries

These are specification boundaries, not SDK parity gaps:

| Family   | Deliberately outside revision 1                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI  | webhooks, callbacks, NDJSON/other streaming framings, and operations whose effective parameter/body alternatives cannot be represented without collision or loss                                                                            |
| AsyncAPI | protocols without a qualified installed driver; MQTT and Kafka cells outside their checked-in authority matrices; standalone HTTP `send`; message-header carriage; and arbitrary byte values without an artifact-declared boundary encoding |
| MCP      | stdio and deprecated HTTP+SSE transports, required task augmentation, and server-initiated subscriptions/sampling/elicitation/roots/log streams                                                                                             |
| gRPC     | schemas outside the canonical ProtoJSON-compatible bound closure; metadata is not promoted into operation values                                                                                                                            |
| Connect  | binary protobuf, gRPC-Web, GET dispatch, descriptorless streaming, and full-duplex use where the selected transport cannot provide HTTP/2                                                                                                   |
| usage    | includes, mounts, config-file/external-parse lanes, interactive/PTY/streaming commands, and binary output without a configured decoder                                                                                                      |
| GraphQL  | batching, multipart incremental delivery, uploads, live queries, GET, persisted-query extensions, multi-root documents, and subscription protocols other than the pinned `graphql-transport-ws` revision                                    |

Within those boundaries, an implementation refuses rather than inventing a
private approximation. Runtime capability limitations are declared and refuse
before dispatch; they do not rewrite the binding specification's interaction
shape.

AsyncAPI protocol-driver evidence is independently release-qualified below
the SDK adapter: MQTT 3.1.1 and Kafka have matching TypeScript and Go authority
matrices, standalone live tests, and real OpenBindings bridge tests. Kafka
wire behavior is delegated to mature native clients; the adapter supplies the
artifact interpretation and protocol-blind boundary conversion.

Authoring directives follow the same rule. Both SDKs honor source naming,
description, `outputLocation`, and complete `embed` requests. OpenAPI,
AsyncAPI, and usage artifacts can be embedded losslessly when the host can
read their locations. The portable TypeScript OpenAPI and AsyncAPI packages
fetch HTTP(S) locations; a filesystem-owning caller reads a process-local
artifact and supplies `content`, keeping Node out of the package graph. Live
MCP discovery and gRPC reflection currently refuse `embed` because their
internal discovery views do not retain every member needed to publish a
complete pinned listing or descriptor closure; silently emitting a partial
artifact would be less conformant than the refusal.

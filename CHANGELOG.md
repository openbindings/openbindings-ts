# Changelog

## 0.2.0 (working draft)

### Changed

- **Renamed binding "executor" terminology to "invoker" / "invoke"** to align with the OpenBindings spec 0.2.0 rename. Pre-1.0 hard rename, no deprecated aliases. Both layers — the per-format component and the orchestrator — use the `Invoker` class name, with the verb `invoke` shared across them.
  - Classes: `BindingExecutor` (interface) → `BindingInvoker`; `OperationExecutor` → `OperationInvoker`; per-format `*Executor` classes → `*Invoker` (e.g., `OpenAPIExecutor` → `OpenAPIInvoker`, `MCPExecutor` → `MCPInvoker`, `AsyncAPIExecutor` → `AsyncAPIInvoker`, `WorkersRpcExecutor` → `WorkersRpcInvoker`, `GraphQLExecutor` → `GraphQLInvoker`); `OperationExecutorOptions` → `OperationInvokerOptions`; `WorkersRpcExecutorOptions` → `WorkersRpcInvokerOptions`.
  - Types: `BindingExecutionInput` → `BindingInvocationInput`; `OperationExecutionInput` → `OperationInvocationInput`; `ExecuteOutput`/`ExecuteError`/`ExecuteSource`/`ExecutionOptions` → `InvocationOutput`/`InvocationError`/`InvocationSource`/`InvocationOptions`.
  - Methods: `executeBinding(...)` → `invokeBinding(...)`; `executeOperation(...)` / `client.execute(...)` → `invoke(...)` (orchestrator / `InterfaceClient.invoke(...)`); `addBindingExecutor` → `addBindingInvoker`; `combineExecutors`/`CombinedExecutor` → `combineInvokers`/`CombinedInvoker`.
  - Errors: `NoExecutorError` → `NoInvokerError`.
  - File renames: `packages/sdk/src/executor.ts` → `operation-invoker.ts`; `executors.ts` → `invokers.ts`; `executor-types.ts` → `invoker-types.ts`. Per-format `executor.ts` → `invoker.ts`; `execute.ts` → `invoke.ts`.

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

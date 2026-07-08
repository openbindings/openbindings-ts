# @openbindings/mcp

Model Context Protocol (MCP) binding invoker and interface synthesizer for the [OpenBindings](https://openbindings.com) TypeScript SDK.

This package enables OpenBindings to invoke operations against MCP servers and synthesize OBI documents from them. It connects to MCP servers via the Streamable HTTP transport, dispatches calls to tools, resources, resource templates, and prompts, and delivers results through the SDK's cardinality-agnostic `Invocation` handle. Built on `@modelcontextprotocol/sdk`.

See the [spec](https://github.com/openbindings/spec) and the [invocation pattern](https://openbindings.com/spec/invocation-pattern) for how binding invokers and interface synthesizers fit into the OpenBindings architecture.

## Install

```
npm install @openbindings/mcp
```

Requires [@openbindings/sdk](https://www.npmjs.com/package/@openbindings/sdk) (the core SDK).

## Usage

### Register with OperationInvoker

```typescript
import { OperationInvoker } from "@openbindings/sdk";
import { MCPInvoker } from "@openbindings/mcp";

const invoker = new OperationInvoker([new MCPInvoker()]);
```

The invoker declares the date-versioned format token `mcp@2025-11-25`, matching the MCP protocol revision it implements. The MCP server must support the **Streamable HTTP** transport — stdio and the legacy SSE transport are not supported.

### Invoke a binding

`invokeBinding` returns an `Invocation` handle synchronously. Tool and prompt arguments are the operation's single input message, written to the handle; outputs are bare values.

```typescript
import { single } from "@openbindings/sdk";

const invoker = new MCPInvoker();

const call = invoker.invokeBinding({
  source: {
    format: "mcp@2025-11-25",
    location: "https://mcp.example.com",
  },
  ref: "tools/search",
  context: { bearerToken: "tok_123" },
});

await call.write({ query: "openbindings" });
const result = await single(call.outputs);
```

Resource reads take no input, so they need no `write` (the binding closes the input side on entry). Tools that report progress emit each progress notification as an output ahead of the final result; consume the same handle with `for await`:

```typescript
const call = invoker.invokeBinding({
  source: { format: "mcp@2025-11-25", location: "https://mcp.example.com" },
  ref: "tools/long_job",
});

await call.write({ target: "all" });
for await (const output of call.outputs) {
  console.log(output); // progress notifications, then the result
}
```

Failures surface as a rejected `call.closed` (and a throwing output iterator) carrying an `InvocationError` with a stable `code` — e.g. `ERR_AUTH_REQUIRED` for an HTTP 401, `ERR_EXECUTION_FAILED` for a JSON-RPC error or a tool `isError` result.

Refs follow MCP entity conventions:

- `tools/<name>` — invoke a tool (input must be an object)
- `resources/<uri>` — read a resource (or a resource template `uriTemplate`)
- `prompts/<name>` — render a prompt (input fields are stringified before being sent)

### Synthesize an interface from an MCP server

```typescript
import { MCPSynthesizer } from "@openbindings/mcp";

const synth = new MCPSynthesizer();

const iface = await synth.synthesizeInterface({
  sources: [{
    format: "mcp@2025-11-25",
    location: "https://mcp.example.com",
  }],
});
```

The synthesizer connects to the server, lists every advertised tool, resource, resource template, and prompt, and synthesizes an OBI with one operation per entity. The server's reported `name` and `version` are copied onto the resulting interface.

## How it works

### Execution flow

1. Parses the ref as `<entityType>/<name>` (`tools`, `resources`, or `prompts`) — pre-dispatch failures (bad ref, missing endpoint, non-object input) terminate the invocation before any network I/O
2. Reads the input message from the handle (tools and prompts; resource reads close the input side on entry) and closes input so callers never have to
3. **Opens a fresh MCP session per call** via `StreamableHTTPClientTransport`. There is no session caching — every execution is a new connect/close cycle.
4. Dispatches based on entity type:
   - **`tools/<name>`:** calls `client.callTool`. Progress notifications are emitted as outputs as they arrive. The final output prefers `structuredContent` if the tool returns one, otherwise parses the `content` array (single text item is JSON-parsed if possible; multi-text items are joined; mixed content is returned as-is).
   - **`resources/<uri>`:** calls `client.readResource`. Single text content is JSON-parsed if possible. Multi-content responses are returned as the raw `contents` array.
   - **`prompts/<name>`:** calls `client.getPrompt`. Output is `{ messages, description? }`.
5. Sets the entity call's HTTP response headers as the handle's leading metadata, then closes the output side (or fires the terminal error).
6. Closes the client in a `finally` block.

HTTP 401/403 map to `ERR_AUTH_REQUIRED` / `ERR_PERMISSION_DENIED`; JSON-RPC errors and tool `isError` results map to `ERR_EXECUTION_FAILED`. MCP servers declare no security schemes, so the binding raises no upfront `CONTEXT_REQUIRED` challenge — credential resolution happens above the binding (see the `OperationInvoker`'s `contextResolver`).

### Credential application

MCP has no native security scheme declarations. Headers are passed to the underlying HTTP transport via `RequestInit.headers`, derived from the binding context in this fallback order:

1. **`bearerToken`** → `Authorization: Bearer <token>`
2. **`apiKey`** → `Authorization: ApiKey <token>`
3. **`basic.username` + `basic.password`** → `Authorization: Basic <base64>`

Context's `headers` field merges on top, and `cookies` join as a sorted `Cookie:` header.

### Interface synthesis

Converts an MCP server's published catalog into an OBI by:
- Listing tools, resources, resource templates, and prompts (in that order)
- Iterating each list alphabetically by name for deterministic output
- Tools: input schema is the tool's declared `inputSchema`; output is the declared `outputSchema` if present
- Resources: input is `{ uri: const <resource-uri> }`; the operation key is the resource's name (collisions are disambiguated by prefixing with `resource_`)
- Resource templates: input is `{ uriTemplate: const <template> }`; key collisions disambiguated with `resource_template_`
- Prompts: input is built from the prompt's declared arguments (all `string`-typed); output is `{ messages, description }`
- All bindings use refs of the form `<entity-type>/<name-or-uri>`

## License

Apache-2.0

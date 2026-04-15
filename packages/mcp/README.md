# @openbindings/mcp

Model Context Protocol (MCP) binding executor and interface creator for the [OpenBindings](https://openbindings.com) TypeScript SDK.

This package enables OpenBindings to execute operations against MCP servers and synthesize OBI documents from them. It connects to MCP servers via the Streamable HTTP transport, dispatches calls to tools, resources, resource templates, and prompts, and returns results as a stream of events. Built on `@modelcontextprotocol/sdk`.

See the [spec](https://github.com/openbindings/spec) and [pattern documentation](https://github.com/openbindings/spec/tree/main/patterns) for how executors and creators fit into the OpenBindings architecture.

## Install

```
npm install @openbindings/mcp
```

Requires [@openbindings/sdk](https://www.npmjs.com/package/@openbindings/sdk) (the core SDK).

## Usage

### Register with OperationExecutor

```typescript
import { OperationExecutor } from "@openbindings/sdk";
import { MCPExecutor, MCPCreator } from "@openbindings/mcp";

const exec = new OperationExecutor([new MCPExecutor(), new MCPCreator()]);
```

The executor declares the date-versioned format token `mcp@2025-11-25`, matching the MCP protocol revision it implements. The MCP server must support the **Streamable HTTP** transport — stdio and the legacy SSE transport are not supported.

### Execute a binding

```typescript
const executor = new MCPExecutor();

for await (const event of executor.executeBinding({
  source: {
    format: "mcp@2025-11-25",
    location: "https://mcp.example.com",
  },
  ref: "tools/search",
  input: { query: "openbindings" },
  context: { bearerToken: "tok_123" },
})) {
  if (event.error) console.error(event.error.message);
  else console.log(event.data);
}
```

Refs follow MCP entity conventions:

- `tools/<name>` — invoke a tool (input must be an object)
- `resources/<uri>` — read a resource (or a resource template `uriTemplate`)
- `prompts/<name>` — render a prompt (input fields are stringified before being sent)

### Create an interface from an MCP server

```typescript
const creator = new MCPCreator();

const iface = await creator.createInterface({
  sources: [{
    format: "mcp@2025-11-25",
    location: "https://mcp.example.com",
  }],
});
```

The creator connects to the server, lists every advertised tool, resource, resource template, and prompt, and synthesizes an OBI with one operation per entity. The server's reported `name` and `version` are copied onto the resulting interface.

## How it works

### Execution flow

1. Parses the ref as `<entityType>/<name>` (`tools`, `resources`, or `prompts`)
2. **Opens a fresh MCP session per call** via `StreamableHTTPClientTransport`. There is no session caching — every execution is a new connect/close cycle.
3. Dispatches based on entity type:
   - **`tools/<name>`:** calls `client.callTool`. Output prefers `structuredContent` if the tool returns one, otherwise parses the `content` array (single text item is JSON-parsed if possible; multi-text items are joined; mixed content is returned as-is).
   - **`resources/<uri>`:** calls `client.readResource`. Single text content is JSON-parsed if possible. Multi-content responses are returned as the raw `contents` array.
   - **`prompts/<name>`:** calls `client.getPrompt`. Output is `{ messages, description? }`.
4. Closes the client in a `finally` block.

On a connect-time 401/403, the executor maps the error to `auth_required` / `permission_denied`. If the binding declares security entries and a credential callback is configured, it calls `resolveSecurity` and retries once with the new credentials.

### Credential application

MCP has no native security scheme declarations. Headers are passed to the underlying HTTP transport via `RequestInit.headers`, derived from the binding context in this fallback order:

1. **`bearerToken`** → `Authorization: Bearer <token>`
2. **`apiKey`** → `Authorization: ApiKey <token>`
3. **`basic.username` + `basic.password`** → `Authorization: Basic <base64>`

`ExecutionOptions.headers` are merged in after, and `ExecutionOptions.cookies` are joined as a sorted `Cookie:` header.

### Interface creation

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

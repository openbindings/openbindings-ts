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

The invoker declares `openbindings.mcp@1` (the [published binding specification](https://github.com/openbindings/spec), defined against MCP revision 2025-11-25). The MCP server must support the **Streamable HTTP** transport — stdio and the legacy SSE transport are not supported.

### Invoke a binding

`invokeBinding` returns an `Invocation` handle synchronously. Tool and prompt arguments are the operation's single input message, written to the handle; outputs are bare values.

```typescript
import { single } from "@openbindings/sdk";

const invoker = new MCPInvoker();

const call = invoker.invokeBinding({
  source: {
    bindingSpec: "openbindings.mcp@1",
    location: "https://mcp.example.com/mcp",
  },
  ref: "tools/search",
  context: { bearerToken: "tok_123" },
});

await call.write({ query: "openbindings" });
const result = await single(call.outputs);
```

The output stream is the result value alone unless progress is solicited (the `solicit` configuration point, default off): opt in per invocation via context `{"configuration": {"solicit": true}}` or per invoker via `new MCPInvoker({ solicitProgress: true })`, and progress values then precede the result; consume the same handle with `for await`:

```typescript
const call = invoker.invokeBinding({
  source: { bindingSpec: "openbindings.mcp@1", location: "https://mcp.example.com/mcp" },
  ref: "tools/long_job",
  context: { configuration: { solicit: true } },
});

await call.write({ target: "all" });
for await (const output of call.outputs) {
  console.log(output); // progress values, then the result
}
```

Static resource reads (`resources/<uri>`) take no input: skip the `write` and read outputs directly. A resource template (`resources/<template>`) takes one input — an object of its RFC 6570 variables, every value a string — and the invoker expands the template before `resources/read`.

Failures surface as a rejected `call.closed` (and a throwing output iterator) carrying an `InvocationError` with a stable `code` — e.g. `ERR_AUTH_REQUIRED` for an HTTP 401, `ERR_EXECUTION_FAILED` for a JSON-RPC error or a tool `isError` result.

### Synthesize an interface from an MCP server

```typescript
import { MCPSynthesizer } from "@openbindings/mcp";

const synth = new MCPSynthesizer();

const iface = await synth.synthesizeInterface({
  sources: [{
    bindingSpec: "openbindings.mcp@1",
    location: "https://mcp.example.com/mcp",
  }],
});
```

The synthesizer connects to the server, lists every advertised tool, resource, resource template, and prompt — each list followed to pagination exhaustion — and synthesizes an OBI with one operation per entity. The server's reported `name` and `version` are copied onto the resulting interface.

## The binding specification

This package implements **`openbindings.mcp@1`**, the openbindings project's published binding specification for MCP (`spec/binding-specs/mcp/openbindings.mcp.md`), defined against MCP revision 2025-11-25. The normative answers live there; the highlights as implemented here:

### Ref format (MCP-D-03)

`<entity>/<remainder>` — the entity family followed by the identity, matched byte-exactly against the (pagination-exhausted) listing before dispatch; unresolvable and ambiguous refs are refused (`ERR_REF_NOT_FOUND`):

- `tools/get_weather` - a tool's `name`
- `resources/file:///data.csv` - a resource's `uri`
- `resources/users/{id}` - a resource template, addressed by its template string
- `prompts/summarize` - a prompt's `name`

### Source expectations

- **`location`** (MCP-D-02): The MCP server's Streamable HTTP endpoint URL (HTTP/HTTPS), required.
- **`content`** (MCP-D-01): Optional **pinned listing** — a JSON object of pagination-exhausted entity arrays under `tools`/`resources`/`resourceTemplates`/`prompts` in the 2025-11-25 result shapes. A pin makes ref resolution offline-checkable and displaces the list requests entirely; stray members (`nextCursor`, `_meta`, anything else) invalidate it loudly. Without `content`, the listing is obtained live, each list request followed to pagination exhaustion (MCP-P-02).

### Input mapping (§9.1, MCP-P-03)

The input value maps whole — there is no field routing — and every refusal is loud and pre-dispatch:

- **Tools**: the input object is the `tools/call` `arguments`, verbatim. An absent input omits the `arguments` member **entirely** (never `arguments: {}`).
- **Prompts**: prompt arguments are string-typed; a non-string member is refused, never coerced. An absent input omits `arguments`.
- **Resource templates**: the input is an object of the template's RFC 6570 variables (strings only; undeclared variables refused). An unsupplied declared variable follows RFC 6570's undefined-value expansion.
- **Static resources** take no input.

### Decode lanes (the `decode` configuration point, §9.3)

This invoker consults the **decode axis** of the consumer hooks seam (`InvokeHooks`) on its text lanes; classification stays protocol-native (`isError` decides success, MCP-P-06).

- **Tool results.** `structuredContent` is MCP's declared structured lane (2025-11-25: servers MUST conform it to `outputSchema`) and wins outright. Absent it, a single text content is a **string, verbatim** — MCP defines JSON-serialized-into-text as the backwards-compatibility *shadow* of `structuredContent`, so parsing it is a consumer choice made through a decode hook, never a payload sniff. Other content shapes pass through as generic values.
- **Resources.** The output value is **always the array** of decoded contents items, in order (`contents: []` yields `[]`); a bare single value is an `outputTransform` concern. Each item decodes structurally first — a `blob` item passes as its Base64 string whatever `mimeType` it declares — and a `text` item decodes by its declared `mimeType`, exactly like the HTTP header rule: `application/json`/`+json` parses strictly (a parse failure is a loud error, never a silent fall-through); anything else is text.
- **Prompts.** The `prompts/get` result sans JSON-RPC envelope — `{ messages, description? }` — is the output value, verbatim.

Success provenance rides the `x-ob-decode` trailer stamp (`structuredContent`, `text`, `contents/declared`, or `hook`); classification stamps `protocol/isError`.

### Progress solicitation (the `solicit` configuration point)

Default **off**: no `progressToken` rides `tools/call` and the output stream is the result value alone. Opt in per invocation (`context.configuration.solicit: true`) or per invoker (`new MCPInvoker({ solicitProgress: true })`); per-invocation wins. When solicited, each correlated `notifications/progress` emits one output value — the notification's params minus `progressToken`, presence-preserving (an explicit `total: 0` survives) — ahead of the result, which is always last; correlated notifications arriving after the result are discarded.

### Entity type mapping

| Entity | Ref format | Input | Output |
|--------|-----------|-------|--------|
| **Tool** | `tools/<name>` | Tool's `inputSchema` | Tool's `outputSchema` or content array |
| **Resource** | `resources/<uri>` | None (the URI is the ref) | Array of decoded contents items |
| **Resource template** | `resources/<template>` | RFC 6570 variables (string-typed) | Array of decoded contents items |
| **Prompt** | `prompts/<name>` | Prompt arguments (string-typed) | `{messages: [...]}` |

## How it works

### Execution flow

`invokeBinding` returns the `Invocation` handle synchronously; the MCP work is scheduled asynchronously:

1. Parses the ref to determine entity type: `tools/`, `resources/`, or `prompts/` (a bad ref, a missing/non-HTTP endpoint, or an invalid pinned listing terminates the handle before any network I/O)
2. Resolves the ref against the listing before dispatch — offline against a pinned listing, otherwise against the live capability-gated, pagination-exhausted listing after the handshake; unresolvable or ambiguous refs are refused
3. Reads the operation's single input message from the handle (tools, prompts, and resource templates — whose input is validated as string variables and expanded per RFC 6570); static resource reads take no input. An absent input omits the `arguments` member entirely
4. **Opens a fresh MCP session per call** via `StreamableHTTPClientTransport`, applying credentials from the context as HTTP headers. There is no session caching — every invocation is a new connect/close cycle.
5. Calls the appropriate MCP method (`tools/call`, `resources/read`, or `prompts/get`)
6. Emits the result and closes the output side; when progress was solicited, correlated `notifications/progress` events emit as outputs ahead of the result
7. Closes the client in a `finally` block

The entity call's HTTP response headers surface as the invocation's leading metadata (`header`). Errors map to terminal invocation errors: JSON-RPC errors → `ERR_EXECUTION_FAILED` with the `{code, data}` in details, HTTP 401/403 → `ERR_AUTH_REQUIRED`/`ERR_PERMISSION_DENIED`, connection failures → `ERR_CONNECT_FAILED`. MCP servers declare no security schemes, so the binding raises no upfront `CONTEXT_REQUIRED` challenge — credential resolution happens above the binding (see the `OperationInvoker`'s `contextResolver`).

### Credential application

MCP has no native security scheme declarations (MCP-P-07). Headers are passed to the underlying HTTP transport via `RequestInit.headers`, derived from the binding context in this fallback order:

1. **`bearerToken`** → `Authorization: Bearer <token>`
2. **`apiKey`** → `Authorization: ApiKey <token>`
3. **`basic.username` + `basic.password`** → `Authorization: Basic <base64>`

Context's `headers` field merges on top, and `cookies` join as a sorted `Cookie:` header.

### Interface synthesis

Converts an MCP server's published catalog into an OBI by:
- Listing tools, resources, resource templates, and prompts (in that order), each list followed to pagination exhaustion (MCP-P-02)
- Iterating each list alphabetically by name for deterministic output
- Tools: input schema is the tool's declared `inputSchema`; output is the declared `outputSchema` if present
- Static resources declare no input (the URI is the binding's ref, not caller input); the operation key is the resource's name (collisions are disambiguated by prefixing with `resource_`)
- Resource templates: input is the template's RFC 6570 variables as string properties (`additionalProperties: false`, none required); key collisions disambiguated with `resource_template_`
- Prompts: input is built from the prompt's declared arguments (all `string`-typed); output is `{ messages, description? }`
- All bindings use refs of the form `<entity-type>/<name-or-uri>`
- No security metadata exposed (MCP-P-07)

## License

Apache-2.0

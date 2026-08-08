# @openbindings/mcp

MCP (Model Context Protocol) binding invoker and interface synthesizer for the [OpenBindings](https://openbindings.com) TypeScript SDK.

The package implements `openbindings.mcp@2` and retains `openbindings.mcp@1` compatibility for existing OBIs. Both revisions use MCP 2025-11-25 over Streamable HTTP.

## Install

```sh
npm install @openbindings/mcp
```

## Register

```typescript
import { OperationInvoker } from "@openbindings/sdk";
import { MCPInvoker } from "@openbindings/mcp";

const invoker = new OperationInvoker([new MCPInvoker()]);
```

The invoker and synthesizer advertise revision 2 first and revision 1 as a compatibility revision. Stdio and the deprecated HTTP+SSE transport are not supported.

## Revision 2: protocol-blind tools

`openbindings.mcp@2` binds only `tools/<name>` targets whose MCP listing declares an `outputSchema`. That schema is the application's output contract; successful invocation emits `structuredContent` alone after checking it against the schema.

```typescript
import { MCPInvoker } from "@openbindings/mcp";
import { single } from "@openbindings/sdk";

const invoker = new MCPInvoker();
const call = invoker.invokeBinding({
  source: {
    bindingSpec: "openbindings.mcp@2",
    location: "https://mcp.example.com/mcp",
  },
  ref: "tools/search",
  context: { bearerToken: "tok_123" },
});

await call.write({ query: "openbindings" });
const result = await single(call.outputs);
// result is the tool's structuredContent, not an MCP result envelope
```

Revision 2 deliberately does not turn MCP `content`, `_meta`, `isError`, progress notifications, JSON-RPC fields, HTTP fields, or session facts into ordinary operation values. It also does not solicit progress. A tool error, transport or JSON-RPC failure, or missing/nonconforming `structuredContent` rejects `call.closed` and the output iterator with an `InvocationError`. Native evidence may be retained only through the explicit `call.diagnostics` view.

Tools without `outputSchema`, required-task tools, resources, resource templates, and prompts are reported as coverage exclusions during synthesis. Their MCP-native result shapes are not recompiled into application schemas merely to make them bindable.

## Synthesize revision 2

```typescript
import { MCPSynthesizer } from "@openbindings/mcp";

const synth = new MCPSynthesizer();
const iface = await synth.synthesizeInterface({
  sources: [{
    bindingSpec: "openbindings.mcp@2",
    location: "https://mcp.example.com/mcp",
  }],
});
```

Live synthesis negotiates MCP 2025-11-25 and exhausts all advertised listing pages. Present `content` may instead pin the complete listing. In revision 2, each eligible tool becomes one operation:

| OBI field | MCP source |
|---|---|
| `binding.ref` | `tools/<name>` |
| operation input | tool `inputSchema` |
| operation output | tool `outputSchema` |
| successful output value | `CallToolResult.structuredContent` |

Operation naming is synthesizer policy rather than binding semantics.

## Revision 1 compatibility

`openbindings.mcp@1` remains available so previously synthesized OBIs keep their published meaning. Revision 1 supports tools, resources, resource templates, and prompts; its output mapping retains the legacy MCP-shaped result behavior, and its optional `solicit` configuration can surface progress values. Use revision 1 only when consuming an existing revision-1 OBI or when those native MCP families and shapes are intentionally required.

The two revisions are not silently interchangeable. A source requesting revision 1 is processed as revision 1, and a source requesting revision 2 receives the narrower protocol-blind contract.

## Source, refs, and credentials

- `location` is a required absolute HTTP(S) Streamable HTTP endpoint.
- Revision-2 refs are byte-exact `tools/<name>` references resolved against the pagination-exhausted listing before dispatch.
- Present `content` is an authoritative pinned listing; it avoids live list calls but does not replace the endpoint used for invocation.
- `bearerToken` maps to `Authorization: Bearer`.
- Explicitly named headers and cookies use their named HTTP carriers.
- Generic `apiKey` or `basic` values have no MCP-declared carrier and surface as context requirements rather than receiving an invented destination.

## Sessions and response size

The TypeScript invoker opens and closes a fresh MCP client session for each call.

Response reading is delegated to `@modelcontextprotocol/sdk`, which currently exposes no delivery-unit read-bound seam. `maxDeliveryUnitBytes` therefore does not bound this lane. This is a named implementation exclusion, not a different MCP binding meaning.

## Specification

The normative behavior lives in [`spec/binding-specs/mcp/openbindings.mcp.md`](https://github.com/openbindings/spec/blob/main/binding-specs/mcp/openbindings.mcp.md). Published revisions are immutable.

## License

Apache-2.0

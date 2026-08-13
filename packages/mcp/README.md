# `@openbindings/mcp`

MCP binding invoker and interface synthesizer for the OpenBindings TypeScript
SDK. It implements the unreleased first `openbindings.mcp@1` candidate over
MCP 2025-11-25 Streamable HTTP. No MCP binding specification has been
published, and there is no older compatibility meaning for `@1`.

## Install and register

```sh
npm install @openbindings/sdk @openbindings/mcp
```

```ts
import { OperationInvoker } from "@openbindings/sdk";
import { MCPInvoker } from "@openbindings/mcp";

const invoker = new OperationInvoker([new MCPInvoker()]);
```

The candidate binds only `tools/<name>` targets whose MCP listing declares an
`outputSchema`. That schema is the application output contract; a successful
invocation emits conforming `structuredContent` alone.

```ts
import { MCPInvoker } from "@openbindings/mcp";
import { single } from "@openbindings/sdk";

const call = new MCPInvoker().invokeBinding({
  source: {
    bindingSpec: "openbindings.mcp@1",
    location: "https://mcp.example.com/mcp",
  },
  ref: "tools/search",
  context: { bearerToken: "tok_123" },
});

await call.write({ query: "openbindings" });
const result = await single(call.outputs);
// result is the tool's structuredContent, not an MCP result envelope
```

MCP `content`, `_meta`, `isError`, progress notifications, JSON-RPC fields,
HTTP fields, and session facts never become ordinary operation values. A tool
error, transport or JSON-RPC failure, or missing/nonconforming
`structuredContent` completes unsuccessfully. Native evidence may be retained
inside the MCP runtime or native protocol tooling below the OpenBindings
bridge; it has no ordinary abstract invocation representation.

Tools without `outputSchema`, required-task tools, resources, resource
templates, and prompts are coverage exclusions. Their MCP-native result
shapes are not recompiled into application schemas merely to make them
bindable.

## Synthesis

```ts
import { MCPSynthesizer } from "@openbindings/mcp";

const iface = await new MCPSynthesizer().synthesizeInterface({
  sources: [{
    bindingSpec: "openbindings.mcp@1",
    location: "https://mcp.example.com/mcp",
  }],
});
```

Live synthesis negotiates MCP 2025-11-25 and exhausts all advertised listing
pages. Present `content` may instead pin the complete listing. Each eligible
tool becomes one operation:

| OBI field | MCP source |
| --- | --- |
| `binding.ref` | `tools/<name>` |
| operation input | tool `inputSchema` |
| operation output | tool `outputSchema` |
| successful output value | `CallToolResult.structuredContent` |

Operation naming is synthesizer policy rather than binding semantics.

`location` is a required absolute HTTP(S) endpoint. Present `content` is an
authoritative pinned listing but does not replace the invocation endpoint.
`bearerToken` maps to `Authorization: Bearer`; explicitly named headers and
cookies use their named carriers. Generic API-key or basic credentials have no
MCP-declared carrier and become context requirements rather than receiving an
invented destination.

The TypeScript invoker opens and closes a fresh MCP client session for each
call. Response reading is delegated to `@modelcontextprotocol/sdk`, which does
not currently expose a delivery-unit read-bound seam; this lane therefore has
a named implementation exclusion for `maxDeliveryUnitBytes`.

The candidate behavior is defined in the
[`openbindings.mcp@1` document](https://github.com/openbindings/spec/blob/main/binding-specs/mcp/openbindings.mcp.md).

## License

Apache-2.0

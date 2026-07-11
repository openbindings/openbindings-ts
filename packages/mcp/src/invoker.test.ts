import { describe, it, expect } from "vitest";
import {
  ERR_AUTH_REQUIRED,
  ERR_CANCELLED,
  ERR_EXECUTION_FAILED,
  ERR_INVALID_REF,
  ERR_PERMISSION_DENIED,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_VALIDATION_FAILED,
  single,
} from "@openbindings/sdk";
import { MCPInvoker, MCPSynthesizer } from "./invoker.js";

// ---------------------------------------------------------------------------
// Fake MCP server (Streamable HTTP over a fetch stub)
// ---------------------------------------------------------------------------

const ENDPOINT = "https://mcp.example.com/mcp";
const source = { format: "mcp@2025-11-25", location: ENDPOINT };

interface RpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params: Record<string, unknown> & { _meta?: { progressToken?: number | string } };
}

interface CapturedCall {
  method: string;
  params: RpcRequest["params"];
  headers: Record<string, string>;
}

/** A reply from the fake server to one JSON-RPC request. */
type RpcReply =
  | { result: unknown; headers?: Record<string, string> }
  | { error: { code: number; message: string; data?: unknown } }
  | { sse: unknown[] }
  | { http: Response }
  | { hang: true };

function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A fetch stub speaking just enough MCP Streamable HTTP for the client:
 * answers `initialize`, accepts notifications with 202, declines the
 * standalone GET SSE stream with 405, and routes entity-call requests
 * (tools/call, resources/read, prompts/get) to the responder. Records each
 * entity call and counts every fetch so pre-dispatch tests can assert zero
 * network I/O.
 */
function mcpServer(
  respond: (req: RpcRequest) => RpcReply,
  opts?: { initResponse?: Response },
) {
  const calls: CapturedCall[] = [];
  let fetchCount = 0;

  const fn: typeof fetch = async (_input, init) => {
    fetchCount++;
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });

    const msg = JSON.parse(String(init?.body)) as Partial<RpcRequest> & { method: string };
    if (msg.method === "initialize") {
      if (opts?.initResponse) return opts.initResponse;
      const params = msg.params as { protocolVersion: string };
      return jsonResponse({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "fake-server", version: "1.0.0" },
        },
      });
    }
    if (msg.id === undefined) return new Response(null, { status: 202 }); // notifications

    const req = msg as RpcRequest;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    calls.push({ method: req.method, params: req.params, headers });

    const reply = respond(req);
    if ("hang" in reply) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }
    if ("http" in reply) return reply.http;
    if ("sse" in reply) {
      const body = reply.sse.map((m) => `data: ${JSON.stringify(m)}\n\n`).join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if ("error" in reply) {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, error: reply.error });
    }
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: reply.result }, reply.headers);
  };

  return { fn, calls, fetches: () => fetchCount };
}

const textResult = (text: string): RpcReply => ({
  result: { content: [{ type: "text", text }] },
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe("MCPInvoker tools", () => {
  it("invokes a tool: write + single; text content is a STRING, never sniffed", async () => {
    // MCP 2025-11-25 defines JSON-in-text as the backwards-compatibility
    // shadow of structuredContent; a client never parses text by shape.
    const { fn, calls } = mcpServer(() => textResult('{"tempC":20}'));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/get_weather", fetch: fn });

    await call.write({ city: "Oslo" });
    await expect(single(call.outputs)).resolves.toEqual('{"tempC":20}');
    await expect(call.closed).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("tools/call");
    expect(calls[0].params.name).toBe("get_weather");
    expect(calls[0].params.arguments).toEqual({ city: "Oslo" });
  });

  it("joins multiple text content blocks verbatim, never JSON-sniffed, even when one looks like JSON", async () => {
    // Exercises the real wiring's parseContent lane (reached because there
    // are two content items, not one) end to end, per the de-sniff ruling.
    const { fn } = mcpServer(() => ({
      result: { content: [{ type: "text", text: "note:" }, { type: "text", text: '{"a":1}' }] },
    }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/multi", fetch: fn });

    await call.write({});
    await expect(single(call.outputs)).resolves.toBe('note:\n{"a":1}');
  });

  it("prefers structuredContent over the content array", async () => {
    const { fn } = mcpServer(() => ({
      result: { content: [{ type: "text", text: "ignored" }], structuredContent: { ok: true } },
    }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/check", fetch: fn });

    await call.write({});
    await expect(single(call.outputs)).resolves.toEqual({ ok: true });
  });

  it("treats close-without-write as empty arguments", async () => {
    const { fn, calls } = mcpServer(() => textResult("ok"));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/ping", fetch: fn });

    await call.close();
    await expect(single(call.outputs)).resolves.toBe("ok");
    expect(calls[0].params.arguments).toEqual({});
  });

  it("streams progress notifications as outputs ahead of the result", async () => {
    const { fn } = mcpServer((req) => ({
      sse: [
        {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: req.params._meta?.progressToken, progress: 1, total: 2 },
        },
        {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: req.params._meta?.progressToken, progress: 2, total: 2 },
        },
        { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "done" }] } },
      ],
    }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/long_job", fetch: fn });

    await call.write({});
    const outputs: unknown[] = [];
    for await (const o of call.outputs) outputs.push(o);

    expect(outputs).toHaveLength(3);
    expect(outputs[0]).toMatchObject({ progress: 1, total: 2 });
    expect(outputs[1]).toMatchObject({ progress: 2, total: 2 });
    expect(outputs[2]).toBe("done");
    await expect(call.closed).resolves.toBeUndefined();
  });

  it("NAMED GAP: preserves an explicit total:0 the server sent, unlike Go", async () => {
    // Go's runTool (invoke.go) builds the progress map with `if p.Total !=
    // 0`, because the go-mcp SDK's ProgressNotificationParams.Total is a
    // plain (non-pointer) float64 tagged `json:"total,omitempty"` -- its
    // own doc comment says "Zero means unknown" -- so Go cannot distinguish
    // an explicit total:0 from an absent total once go-mcp has unmarshaled
    // it; both collapse to the Go zero value and get dropped. TS's zod
    // schema (ProgressSchema: total is z.optional(z.number())) has no such
    // collapse: an explicit total:0 on the wire survives into the emitted
    // object. This is a real, verified divergence forced by the two SDKs'
    // underlying MCP libraries, not a choice either binding author made;
    // tracked as a named gap (see final report) rather than "fixed" on
    // either side, since aligning would mean either bypassing go-mcp's
    // typed API to hand-parse raw JSON-RPC (disproportionate to a total=0
    // edge case) or teaching TS to lie about a value the server actually
    // sent.
    const { fn } = mcpServer((req) => ({
      sse: [
        {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: req.params._meta?.progressToken, progress: 1, total: 0 },
        },
        { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "done" }] } },
      ],
    }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/long_job", fetch: fn });

    await call.write({});
    const outputs: unknown[] = [];
    for await (const o of call.outputs) outputs.push(o);

    expect(outputs[0]).toEqual({ progress: 1, total: 0 });
  });

  it("maps a tool isError result to ERR_EXECUTION_FAILED", async () => {
    const { fn } = mcpServer(() => ({
      result: { content: [{ type: "text", text: "tool blew up" }], isError: true },
    }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/boom", fetch: fn });

    await call.write({});
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      message: "tool blew up",
    });
  });

  it("maps a JSON-RPC error to ERR_EXECUTION_FAILED with the MCP code in details", async () => {
    const { fn } = mcpServer(() => ({ error: { code: -32602, message: "unknown tool" } }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/nope", fetch: fn });

    await call.write({});
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      details: { code: -32602 },
    });
  });

  it("maps a dispatch-time HTTP 500 to ERR_EXECUTION_FAILED with status details", async () => {
    const { fn } = mcpServer(() => ({ http: new Response("boom", { status: 500 }) }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/flaky", fetch: fn });

    await call.write({});
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      details: { status: 500 },
    });
  });

  it("exposes HTTP response headers as leading metadata", async () => {
    const { fn } = mcpServer(() => ({
      result: { content: [{ type: "text", text: "ok" }] },
      headers: { "x-request-id": "r1" },
    }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/ping", fetch: fn });

    await call.write({});
    await expect(single(call.outputs)).resolves.toBe("ok");
    await expect(call.header).resolves.toMatchObject({ "x-request-id": ["r1"] });
  });

  it("applies bearer context to the Authorization header", async () => {
    const { fn, calls } = mcpServer(() => textResult("ok"));
    const call = new MCPInvoker().invokeBinding({
      source, ref: "tools/ping", fetch: fn, context: { bearerToken: "tok_123" },
    });

    await call.write({});
    await expect(single(call.outputs)).resolves.toBe("ok");
    expect(calls[0].headers["authorization"]).toBe("Bearer tok_123");
  });

  it("rejects a non-object input with ERR_VALIDATION_FAILED before any I/O", async () => {
    const { fn, fetches } = mcpServer(() => textResult("ok"));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/ping", fetch: fn });

    await call.write("not an object");
    await expect(call.closed).rejects.toMatchObject({ code: ERR_VALIDATION_FAILED });
    expect(fetches()).toBe(0);
  });

  it("cancel aborts an in-flight call", async () => {
    const { fn, calls } = mcpServer(() => ({ hang: true }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/slow", fetch: fn });

    await call.write({});
    // Let the session connect and the tool call dispatch, then cancel.
    await new Promise<void>((resolve) => {
      const tick = () => (calls.length > 0 ? resolve() : setTimeout(tick, 0));
      tick();
    });
    await call.cancel();
    await expect(call.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
  });
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

describe("MCPInvoker resources", () => {
  it("reads a resource without any input (no-input recipe); declared JSON parses", async () => {
    // Resources decode by their DECLARED mimeType — the header-driven
    // lane, never a payload sniff.
    const { fn, calls } = mcpServer(() => ({
      result: { contents: [{ uri: "file:///data.json", mimeType: "application/json", text: '{"a":1}' }] },
    }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "resources/file:///data.json", fetch: fn });

    // No write, no close: the binding closes input on entry.
    await expect(single(call.outputs)).resolves.toEqual({ a: 1 });
    expect(calls[0].method).toBe("resources/read");
    expect(calls[0].params.uri).toBe("file:///data.json");
  });

  it("a resource with no declared JSON mimeType stays text, whatever its shape", async () => {
    const { fn } = mcpServer(() => ({
      result: { contents: [{ uri: "file:///notes.txt", mimeType: "text/plain", text: '{"a":1}' }] },
    }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "resources/file:///notes.txt", fetch: fn });
    await expect(single(call.outputs)).resolves.toEqual('{"a":1}');
  });

  it("declared-JSON that does not parse is a loud error, never a silent string", async () => {
    const { fn } = mcpServer(() => ({
      result: { contents: [{ uri: "file:///bad.json", mimeType: "application/json", text: "{not json" }] },
    }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "resources/file:///bad.json", fetch: fn });
    await expect(single(call.outputs)).rejects.toMatchObject({ code: ERR_EXECUTION_FAILED });
  });

  it("returns the raw contents array for multi-content responses", async () => {
    const contents = [
      { uri: "file:///a.txt", text: "a" },
      { uri: "file:///b.txt", text: "b" },
    ];
    const { fn } = mcpServer(() => ({ result: { contents } }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "resources/file:///dir", fetch: fn });

    await expect(single(call.outputs)).resolves.toEqual(contents);
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe("MCPInvoker prompts", () => {
  it("closes input on entry under the operation-layer no-input convention (zero-argument prompt)", async () => {
    const messages = [{ role: "user", content: { type: "text", text: "Hi" } }];
    const { fn, calls } = mcpServer(() => ({ result: { messages } }));
    // binding present + inputSchema absent: the operation declares NO input
    // (the synthesizer emits no input schema for zero-argument prompts), so the
    // caller never writes nor closes — the call must not park on a read.
    const call = new MCPInvoker().invokeBinding({
      source,
      ref: "prompts/greeting",
      binding: { operation: "greeting", source: "mcp", ref: "prompts/greeting" },
      fetch: fn,
    });

    await expect(single(call.outputs)).resolves.toEqual({ messages });
    await expect(call.closed).resolves.toBeUndefined();
    expect(calls[0].method).toBe("prompts/get");
    expect(calls[0].params.name).toBe("greeting");
  });

  it("renders a prompt with stringified arguments", async () => {
    const messages = [{ role: "user", content: { type: "text", text: "Summarize this" } }];
    const { fn, calls } = mcpServer(() => ({
      result: { description: "A summary prompt", messages },
    }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "prompts/summarize", fetch: fn });

    await call.write({ text: "hello", maxWords: 10 });
    await expect(single(call.outputs)).resolves.toEqual({
      messages,
      description: "A summary prompt",
    });
    expect(calls[0].method).toBe("prompts/get");
    expect(calls[0].params.arguments).toEqual({ text: "hello", maxWords: "10" });
  });
});

// ---------------------------------------------------------------------------
// Pre-dispatch and connect failures
// ---------------------------------------------------------------------------

describe("MCPInvoker failures", () => {
  it("fails a malformed ref pre-dispatch without any I/O", async () => {
    const { fn, fetches } = mcpServer(() => textResult("ok"));
    const call = new MCPInvoker().invokeBinding({ source, ref: "bogus", fetch: fn });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_INVALID_REF });
    expect(fetches()).toBe(0);
  });

  it("fails a non-HTTP location scheme pre-dispatch with ERR_SOURCE_CONFIG_ERROR (Go parity)", async () => {
    // Go's IsHTTPURL precheck (invoke.go) rejects a non-http(s) location
    // before any I/O with ERR_SOURCE_CONFIG_ERROR; TS previously had no
    // such precheck, so a bad scheme fell through to whatever the
    // transport/URL machinery did with it (ERR_RUNTIME for a string
    // that fails URL parsing, or straight through to the network for a
    // syntactically valid non-http URL like ftp://).
    const { fn, fetches } = mcpServer(() => textResult("ok"));
    const call = new MCPInvoker().invokeBinding({
      source: { format: "mcp@2025-11-25", location: "ftp://mcp.example.com" },
      ref: "resources/file:///x",
      fetch: fn,
    });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_SOURCE_CONFIG_ERROR });
    expect(fetches()).toBe(0);
  });

  it("fails a missing endpoint pre-dispatch with ERR_SOURCE_CONFIG_ERROR", async () => {
    const { fn, fetches } = mcpServer(() => textResult("ok"));
    const call = new MCPInvoker().invokeBinding({
      source: { format: "mcp@2025-11-25" }, ref: "resources/file:///x", fetch: fn,
    });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_SOURCE_CONFIG_ERROR });
    expect(fetches()).toBe(0);
  });

  it("maps a connect-time HTTP 401 to ERR_AUTH_REQUIRED", async () => {
    const { fn } = mcpServer(() => textResult("ok"), {
      initResponse: new Response("denied", { status: 401 }),
    });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/ping", fetch: fn });

    await call.write({});
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_AUTH_REQUIRED,
      details: { status: 401 },
    });
  });

  it("maps a connect-time HTTP 403 to ERR_PERMISSION_DENIED", async () => {
    const { fn } = mcpServer(() => textResult("ok"), {
      initResponse: new Response("forbidden", { status: 403 }),
    });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/ping", fetch: fn });

    await call.write({});
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_PERMISSION_DENIED,
      details: { status: 403 },
    });
  });
});

// ---------------------------------------------------------------------------
// MCPSynthesizer (discovery: synthesizeInterface + inspectSource)
// ---------------------------------------------------------------------------

/**
 * A fetch stub that answers `initialize` plus the four list-discovery
 * calls (tools, resources, resource templates, prompts) the way a real
 * MCP server with one tool, one resource, and one prompt would. Reused
 * for both synthesizeInterface and inspectSource,
 * whose discovery lane is otherwise identical (list_refs_test.go /
 * TestInspectSource_RefsMatchSynthesizeInterface asserts the Go SDK's two
 * entry points agree; this is the TS-side discovery fixture).
 */
function discoveryServer(): { fn: typeof fetch; fetches: () => number } {
  let fetchCount = 0;
  const fn: typeof fetch = async (_input, init) => {
    fetchCount++;
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });

    const msg = JSON.parse(String(init?.body)) as { id?: number | string; method: string };
    const reply = (result: unknown) =>
      jsonResponse({ jsonrpc: "2.0", id: msg.id, result });

    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "fake-server", version: "1.0.0" },
        });
      case "tools/list":
        return reply({
          tools: [{ name: "get_weather", description: "Get weather for a city", inputSchema: { type: "object", properties: {} } }],
        });
      case "resources/list":
        return reply({ resources: [{ name: "config", uri: "file:///etc/config.json", description: "Config file" }] });
      case "resources/templates/list":
        return reply({ resourceTemplates: [] });
      case "prompts/list":
        return reply({ prompts: [{ name: "summarize", description: "Summarize text" }] });
      default:
        if (msg.id === undefined) return new Response(null, { status: 202 }); // notifications (e.g. initialized)
        return reply({});
    }
  };
  return { fn, fetches: () => fetchCount };
}

describe("MCPSynthesizer", () => {
  it("inspectSource suggests the same operationKey synthesizeInterface assigns (Go parity)", async () => {
    // Go's InspectSource (list_refs.go) stamps BindableTarget.OperationKey
    // with the same SanitizeKey + collision-resolved key SynthesizeInterface
    // assigns, sharing one usedKeys map across all four entity kinds, "so an
    // inspection previews exactly what synthesis names." TS's inspectSource
    // pushed {ref, operation} only -- operationKey was never set.
    const { fn: synthFetch } = discoveryServer();
    const iface = await new MCPSynthesizer({ fetch: synthFetch }).synthesizeInterface({
      sources: [{ format: "mcp@2025-11-25", location: ENDPOINT }],
    });

    const { fn: inspectFetch } = discoveryServer();
    const inspection = await new MCPSynthesizer({ fetch: inspectFetch }).inspectSource({
      format: "mcp@2025-11-25",
      location: ENDPOINT,
    });

    expect(inspection.targets.length).toBeGreaterThan(0);
    for (const target of inspection.targets) {
      expect(target.operationKey).toBeDefined();
      // The suggested key must resolve to an operation synthesizeInterface
      // actually produced for the same ref, under the same binding source.
      const binding = Object.values(iface.bindings ?? {}).find((b) => b.ref === target.ref);
      expect(binding).toBeDefined();
      expect(target.operationKey).toBe(binding!.operation);
    }
  });

  it("uses the constructor-injected fetch for discovery (Go's WithSynthesizerHTTPClient parity)", async () => {
    // Go's Synthesizer takes an httpClient at construction (WithSynthesizerHTTPClient,
    // invoker.go) that discover() rides for proxy/mTLS/custom-CA setups;
    // TS's discover() previously had no seam at all -- always the ambient
    // global fetch, with no way to reach a server behind that kind of setup.
    const { fn, fetches } = discoveryServer();
    const synthesizer = new MCPSynthesizer({ fetch: fn });

    await synthesizer.synthesizeInterface({
      sources: [{ format: "mcp@2025-11-25", location: ENDPOINT }],
    });
    expect(fetches()).toBeGreaterThan(0);

    const before = fetches();
    await synthesizer.inspectSource({ format: "mcp@2025-11-25", location: ENDPOINT });
    expect(fetches()).toBeGreaterThan(before);
  });
});

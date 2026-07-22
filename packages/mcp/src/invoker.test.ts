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
import { ENDPOINT, jsonResponse, mcpServer, textResult } from "./testserver.js";

const source = { bindingSpec: "openbindings.mcp@1", location: ENDPOINT };

// The invoker resolves every ref against the listing before dispatch
// (openbindings.mcp@1 §7, MCP-P-02), so each test declares the live listing
// its ref must resolve against; the fixture serves it via the list requests.

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe("MCPInvoker tools", () => {
  it("invokes a tool: write + single; text content is a STRING, never sniffed", async () => {
    // MCP 2025-11-25 defines JSON-in-text as the backwards-compatibility
    // shadow of structuredContent; a client never parses text by shape.
    const server = mcpServer(() => textResult('{"tempC":20}'), { tools: ["get_weather"] });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/get_weather", fetch: server.fn });

    await call.write({ city: "Oslo" });
    await expect(single(call.outputs)).resolves.toEqual('{"tempC":20}');
    await expect(call.closed).resolves.toBeUndefined();

    const calls = server.params("tools/call");
    expect(calls).toHaveLength(1);
    expect(calls.at(0)?.name).toBe("get_weather");
    expect(calls.at(0)?.arguments).toEqual({ city: "Oslo" });
  });

  it("passes multiple text content blocks through as the content array, verbatim (MCP-P-05), never a joined string", async () => {
    // Two content items reach the parseContent lane end to end; §9.3 says any
    // shape other than a single text block passes through as the content
    // array, verbatim in MCP's block shapes — never a "\n"-joined string.
    const server = mcpServer(
      () => ({ result: { content: [{ type: "text", text: "note:" }, { type: "text", text: '{"a":1}' }] } }),
      { tools: ["multi"] },
    );
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/multi", fetch: server.fn });

    await call.write({});
    await expect(single(call.outputs)).resolves.toEqual([
      { type: "text", text: "note:" },
      { type: "text", text: '{"a":1}' },
    ]);
  });

  it("prefers structuredContent over the content array", async () => {
    const server = mcpServer(
      () => ({ result: { content: [{ type: "text", text: "ignored" }], structuredContent: { ok: true } } }),
      { tools: ["check"] },
    );
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/check", fetch: server.fn });

    await call.write({});
    await expect(single(call.outputs)).resolves.toEqual({ ok: true });
  });

  it("omits the arguments member entirely on close-without-write (§9.1, MCP-P-03)", async () => {
    // An absent input value omits the arguments member ENTIRELY — never
    // arguments: {} (this test previously pinned the non-conformant
    // arguments: {} the invoker used to send).
    const server = mcpServer(() => textResult("ok"), { tools: ["ping"] });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/ping", fetch: server.fn });

    await call.close();
    await expect(single(call.outputs)).resolves.toBe("ok");
    expect(server.params("tools/call")[0]).not.toHaveProperty("arguments");
  });

  it("streams progress ahead of the result only when solicited (§9.2/§9.3)", async () => {
    // Solicitation is the family's `solicit` configuration point, DEFAULT
    // OFF (this test previously pinned always-on solicitation); the
    // per-invocation opt-in is context.configuration.solicit.
    const server = mcpServer(
      (req) => ({
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
      }),
      { tools: ["long_job"] },
    );
    const call = new MCPInvoker().invokeBinding({
      source,
      ref: "tools/long_job",
      context: { configuration: { solicit: true } },
      fetch: server.fn,
    });

    await call.write({});
    const outputs: unknown[] = [];
    for await (const o of call.outputs) outputs.push(o);

    expect(outputs).toHaveLength(3);
    expect(outputs[0]).toMatchObject({ progress: 1, total: 2 });
    expect(outputs[1]).toMatchObject({ progress: 2, total: 2 });
    expect(outputs[2]).toBe("done");
    await expect(call.closed).resolves.toBeUndefined();
  });

  it("maps a tool isError result to ERR_EXECUTION_FAILED", async () => {
    const server = mcpServer(
      () => ({ result: { content: [{ type: "text", text: "tool blew up" }], isError: true } }),
      { tools: ["boom"] },
    );
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/boom", fetch: server.fn });

    await call.write({});
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      message: "tool blew up",
    });
  });

  it("maps a JSON-RPC error to ERR_EXECUTION_FAILED with the MCP code in details", async () => {
    const server = mcpServer(() => ({ error: { code: -32602, message: "unknown tool" } }), { tools: ["nope"] });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/nope", fetch: server.fn });

    await call.write({});
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      details: { code: -32602 },
    });
  });

  it("maps a dispatch-time HTTP 500 to ERR_EXECUTION_FAILED with status details", async () => {
    const server = mcpServer(() => ({ http: new Response("boom", { status: 500 }) }), { tools: ["flaky"] });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/flaky", fetch: server.fn });

    await call.write({});
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      details: { status: 500 },
    });
  });

  it("exposes HTTP response headers as leading metadata", async () => {
    const server = mcpServer(
      () => ({ result: { content: [{ type: "text", text: "ok" }] }, headers: { "x-request-id": "r1" } }),
      { tools: ["ping"] },
    );
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/ping", fetch: server.fn });

    await call.write({});
    await expect(single(call.outputs)).resolves.toBe("ok");
    await expect(call.header).resolves.toMatchObject({ "x-request-id": ["r1"] });
  });

  it("applies bearer context to the Authorization header", async () => {
    const server = mcpServer(() => textResult("ok"), { tools: ["ping"] });
    const call = new MCPInvoker().invokeBinding({
      source, ref: "tools/ping", fetch: server.fn, context: { bearerToken: "tok_123" },
    });

    await call.write({});
    await expect(single(call.outputs)).resolves.toBe("ok");
    const toolCall = server.calls.find((c) => c.method === "tools/call");
    expect(toolCall?.headers["authorization"]).toBe("Bearer tok_123");
  });

  it("rejects a non-object input with ERR_VALIDATION_FAILED before any I/O", async () => {
    const server = mcpServer(() => textResult("ok"), { tools: ["ping"] });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/ping", fetch: server.fn });

    await call.write("not an object");
    await expect(call.closed).rejects.toMatchObject({ code: ERR_VALIDATION_FAILED });
    expect(server.fetches()).toBe(0);
  });

  it("cancel aborts an in-flight call", async () => {
    const server = mcpServer(() => ({ hang: true }), { tools: ["slow"] });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/slow", fetch: server.fn });

    await call.write({});
    // Let the session connect, the listing resolve, and the tool call
    // dispatch, then cancel.
    await new Promise<void>((resolve) => {
      const tick = () => (server.count("tools/call") > 0 ? resolve() : setTimeout(tick, 0));
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
  it("reads a resource without any input; the output is always the array of decoded items (§9.3, MCP-P-05)", async () => {
    // Resources decode by their DECLARED mimeType — the header-driven
    // lane, never a payload sniff — and the output value is uniformly the
    // array of decoded contents items (this test previously pinned the
    // non-conformant single-item unwrap).
    const server = mcpServer(
      () => ({ result: { contents: [{ uri: "file:///data.json", mimeType: "application/json", text: '{"a":1}' }] } }),
      { resources: ["file:///data.json"] },
    );
    const call = new MCPInvoker().invokeBinding({ source, ref: "resources/file:///data.json", fetch: server.fn });

    // No write, no close: static resources take no input (§9.1).
    await expect(single(call.outputs)).resolves.toEqual([{ a: 1 }]);
    const reads = server.params("resources/read");
    expect(reads).toHaveLength(1);
    expect(reads.at(0)?.uri).toBe("file:///data.json");
  });

  it("a resource with no declared JSON mimeType stays text, whatever its shape", async () => {
    const server = mcpServer(
      () => ({ result: { contents: [{ uri: "file:///notes.txt", mimeType: "text/plain", text: '{"a":1}' }] } }),
      { resources: ["file:///notes.txt"] },
    );
    const call = new MCPInvoker().invokeBinding({ source, ref: "resources/file:///notes.txt", fetch: server.fn });
    await expect(single(call.outputs)).resolves.toEqual(['{"a":1}']);
  });

  it("declared-JSON that does not parse is a loud error, never a silent string", async () => {
    const server = mcpServer(
      () => ({ result: { contents: [{ uri: "file:///bad.json", mimeType: "application/json", text: "{not json" }] } }),
      { resources: ["file:///bad.json"] },
    );
    const call = new MCPInvoker().invokeBinding({ source, ref: "resources/file:///bad.json", fetch: server.fn });
    await expect(single(call.outputs)).rejects.toMatchObject({ code: ERR_EXECUTION_FAILED });
  });

  it("decodes multiple contents items item-by-item, in order (§9.3, MCP-P-05)", async () => {
    // The output value is ALWAYS the array of decoded contents items (this
    // test previously pinned the raw contents-array passthrough): a
    // declared-JSON item parses, a text item stays text.
    const server = mcpServer(
      () => ({
        result: {
          contents: [
            { uri: "file:///a.json", mimeType: "application/json", text: '{"n":1}' },
            { uri: "file:///b.txt", mimeType: "text/plain", text: "second" },
          ],
        },
      }),
      { resources: ["file:///dir"] },
    );
    const call = new MCPInvoker().invokeBinding({ source, ref: "resources/file:///dir", fetch: server.fn });

    await expect(single(call.outputs)).resolves.toEqual([{ n: 1 }, "second"]);
  });

  it("a blob item passes as its Base64 string, whatever mimeType it declares (§9.3)", async () => {
    // Structural first: the blob member wins before any mimeType
    // consideration — even a declared application/json.
    const blob = Buffer.from("hello world").toString("base64");
    const server = mcpServer(
      () => ({ result: { contents: [{ uri: "app://blob", mimeType: "application/json", blob }] } }),
      { resources: ["app://blob"] },
    );
    const call = new MCPInvoker().invokeBinding({ source, ref: "resources/app://blob", fetch: server.fn });

    await expect(single(call.outputs)).resolves.toEqual([blob]);
  });

  it("contents: [] yields [] — the shape never depends on the item count (§9.3)", async () => {
    const server = mcpServer(() => ({ result: { contents: [] } }), { resources: ["app://empty"] });
    const call = new MCPInvoker().invokeBinding({ source, ref: "resources/app://empty", fetch: server.fn });

    await expect(single(call.outputs)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe("MCPInvoker prompts", () => {
  it("closes input on entry under the operation-layer no-input convention (zero-argument prompt)", async () => {
    const messages = [{ role: "user", content: { type: "text", text: "Hi" } }];
    const server = mcpServer(() => ({ result: { messages } }), { prompts: ["greeting"] });
    // binding present + inputSchema absent: the operation declares NO input
    // (the synthesizer emits no input schema for zero-argument prompts), so the
    // caller never writes nor closes — the call must not park on a read.
    const call = new MCPInvoker().invokeBinding({
      source,
      ref: "prompts/greeting",
      binding: { operation: "greeting", source: "mcp", ref: "prompts/greeting" },
      fetch: server.fn,
    });

    await expect(single(call.outputs)).resolves.toEqual({ messages });
    await expect(call.closed).resolves.toBeUndefined();
    const gets = server.params("prompts/get");
    expect(gets).toHaveLength(1);
    expect(gets.at(0)?.name).toBe("greeting");
    // The no-input convention also omits the arguments member (§9.1).
    expect(gets.at(0)).not.toHaveProperty("arguments");
  });

  it("renders a prompt with string arguments, verbatim", async () => {
    const messages = [{ role: "user", content: { type: "text", text: "Summarize this" } }];
    const server = mcpServer(() => ({ result: { description: "A summary prompt", messages } }), {
      prompts: ["summarize"],
    });
    const call = new MCPInvoker().invokeBinding({ source, ref: "prompts/summarize", fetch: server.fn });

    await call.write({ text: "hello", style: "brief" });
    await expect(single(call.outputs)).resolves.toEqual({
      messages,
      description: "A summary prompt",
    });
    const gets = server.params("prompts/get");
    expect(gets.at(0)?.name).toBe("summarize");
    expect(gets.at(0)?.arguments).toEqual({ text: "hello", style: "brief" });
  });

  it("refuses a non-string prompt argument, never coerced (§9.1, MCP-P-03)", async () => {
    // MCP prompt arguments are string-typed; this test previously pinned
    // the non-conformant String(v) stringification of non-string members.
    const server = mcpServer(() => textResult("unreachable"), { prompts: ["summarize"] });
    const call = new MCPInvoker().invokeBinding({ source, ref: "prompts/summarize", fetch: server.fn });

    await call.write({ text: "hello", maxWords: 10 });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_VALIDATION_FAILED });
    expect(server.count("prompts/get")).toBe(0); // refused before dispatch
  });
});

// ---------------------------------------------------------------------------
// Pre-dispatch and connect failures
// ---------------------------------------------------------------------------

describe("MCPInvoker failures", () => {
  it("fails a malformed ref pre-dispatch without any I/O", async () => {
    const server = mcpServer(() => textResult("ok"));
    const call = new MCPInvoker().invokeBinding({ source, ref: "bogus", fetch: server.fn });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_INVALID_REF });
    expect(server.fetches()).toBe(0);
  });

  it("fails a non-HTTP location scheme pre-dispatch with ERR_SOURCE_CONFIG_ERROR (Go parity)", async () => {
    // Go's IsHTTPURL precheck (invoke.go) rejects a non-http(s) location
    // before any I/O with ERR_SOURCE_CONFIG_ERROR; TS previously had no
    // such precheck, so a bad scheme fell through to whatever the
    // transport/URL machinery did with it (ERR_RUNTIME for a string
    // that fails URL parsing, or straight through to the network for a
    // syntactically valid non-http URL like ftp://).
    const server = mcpServer(() => textResult("ok"));
    const call = new MCPInvoker().invokeBinding({
      source: { bindingSpec: "openbindings.mcp@1", location: "ftp://mcp.example.com" },
      ref: "resources/file:///x",
      fetch: server.fn,
    });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_SOURCE_CONFIG_ERROR });
    expect(server.fetches()).toBe(0);
  });

  it("fails a missing endpoint pre-dispatch with ERR_SOURCE_CONFIG_ERROR (MCP-D-02: location is required)", async () => {
    const server = mcpServer(() => textResult("ok"));
    const call = new MCPInvoker().invokeBinding({
      source: { bindingSpec: "openbindings.mcp@1" }, ref: "resources/file:///x", fetch: server.fn,
    });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_SOURCE_CONFIG_ERROR });
    expect(server.fetches()).toBe(0);
  });

  it("maps a connect-time HTTP 401 to ERR_AUTH_REQUIRED", async () => {
    const server = mcpServer(() => textResult("ok"), {
      tools: ["ping"],
      initResponse: new Response("denied", { status: 401 }),
    });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/ping", fetch: server.fn });

    await call.write({});
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_AUTH_REQUIRED,
      details: { status: 401 },
    });
  });

  it("maps a connect-time HTTP 403 to ERR_PERMISSION_DENIED", async () => {
    const server = mcpServer(() => textResult("ok"), {
      tools: ["ping"],
      initResponse: new Response("forbidden", { status: 403 }),
    });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/ping", fetch: server.fn });

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
 * entry points agree; this is the TS-side discovery fixture). When
 * pageSize is set, each list paginates via nextCursor so tests can prove
 * discovery follows the listing to exhaustion (MCP-P-02).
 */
function discoveryServer(opts?: { pageSize?: number; toolNames?: string[] }): {
  fn: typeof fetch;
  fetches: () => number;
} {
  let fetchCount = 0;
  const toolNames = opts?.toolNames ?? ["get_weather"];
  const tools = toolNames.map((name) => ({
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object", properties: {} },
  }));

  const paginate = <T>(items: T[], cursor: unknown): { page: T[]; nextCursor?: string } => {
    const size = opts?.pageSize && opts.pageSize > 0 ? opts.pageSize : Math.max(items.length, 1);
    const start = typeof cursor === "string" ? Number(cursor) : 0;
    const next = start + size;
    return next < items.length
      ? { page: items.slice(start, next), nextCursor: String(next) }
      : { page: items.slice(start, next) };
  };

  const fn: typeof fetch = async (_input, init) => {
    fetchCount++;
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });

    const msg = JSON.parse(String(init?.body)) as {
      id?: number | string;
      method: string;
      params?: { cursor?: string };
    };
    const reply = (result: unknown) =>
      jsonResponse({ jsonrpc: "2.0", id: msg.id, result });
    const page = <T>(items: T[], member: string): Response => {
      const { page: p, nextCursor } = paginate(items, msg.params?.cursor);
      return reply({ [member]: p, ...(nextCursor !== undefined ? { nextCursor } : {}) });
    };

    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "fake-server", version: "1.0.0" },
        });
      case "tools/list":
        return page(tools, "tools");
      case "resources/list":
        return page([{ name: "config", uri: "file:///etc/config.json", description: "Config file" }], "resources");
      case "resources/templates/list":
        return page([], "resourceTemplates");
      case "prompts/list":
        return page([{ name: "summarize", description: "Summarize text" }], "prompts");
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
      sources: [{ bindingSpec: "openbindings.mcp@1", location: ENDPOINT }],
    });

    const { fn: inspectFetch } = discoveryServer();
    const inspection = await new MCPSynthesizer({ fetch: inspectFetch }).inspectSource({
      bindingSpec: "openbindings.mcp@1",
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
      sources: [{ bindingSpec: "openbindings.mcp@1", location: ENDPOINT }],
    });
    expect(fetches()).toBeGreaterThan(0);

    const before = fetches();
    await synthesizer.inspectSource({ bindingSpec: "openbindings.mcp@1", location: ENDPOINT });
    expect(fetches()).toBeGreaterThan(before);
  });

  it("follows every list to pagination exhaustion (MCP-P-02): the artifact is the exhausted aggregate", async () => {
    // With a page size of 1, a first-page-only discovery would synthesize
    // an interface missing every tool past the first page.
    const { fn } = discoveryServer({ pageSize: 1, toolNames: ["alpha", "beta", "gamma"] });
    const iface = await new MCPSynthesizer({ fetch: fn }).synthesizeInterface({
      sources: [{ bindingSpec: "openbindings.mcp@1", location: ENDPOINT }],
    });

    for (const name of ["alpha", "beta", "gamma"]) {
      expect(iface.operations[name]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Pinned-listing synthesis and inspection (MCP-D-01, §6 content primacy)
// ---------------------------------------------------------------------------

describe("MCPSynthesizer pinned listings", () => {
  const pin = {
    tools: [
      {
        name: "get_weather",
        description: "Get weather",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
    resources: [{ uri: "app://status", name: "status", description: "Application status" }],
    resourceTemplates: [{ uriTemplate: "file:///{path}", name: "file" }],
    prompts: [{ name: "greet", arguments: [{ name: "name", required: true }] }],
  };

  it("synthesizes OFFLINE from a pinned listing: the server is never dialed", async () => {
    const { fn, fetches } = discoveryServer();
    const iface = await new MCPSynthesizer({ fetch: fn }).synthesizeInterface({
      sources: [{ bindingSpec: "openbindings.mcp@1", location: ENDPOINT, content: pin }],
    });

    expect(Object.keys(iface.operations).sort()).toEqual(["file", "get_weather", "greet", "status"]);
    expect(iface.bindings!["get_weather.mcpServer"]?.ref).toBe("tools/get_weather");
    expect(iface.bindings!["status.mcpServer"]?.ref).toBe("resources/app://status");
    expect(iface.bindings!["file.mcpServer"]?.ref).toBe("resourceTemplates/file:///{path}");
    expect(iface.bindings!["greet.mcpServer"]?.ref).toBe("prompts/greet");
    expect(iface.operations.get_weather?.input).toEqual(pin.tools.at(0)?.inputSchema);
    expect((iface.operations.greet?.input as { required?: string[] }).required).toEqual(["name"]);
    expect(iface.sources!.mcpServer?.location).toBe(ENDPOINT);

    expect(fetches()).toBe(0); // pin-authoritative: zero network dials
  });

  it("inspects OFFLINE from a pinned listing, previewing the keys pinned synthesis assigns", async () => {
    const { fn, fetches } = discoveryServer();
    const inspection = await new MCPSynthesizer({ fetch: fn }).inspectSource({
      bindingSpec: "openbindings.mcp@1",
      location: ENDPOINT,
      content: pin,
    });

    expect(inspection.exhaustive).toBe(true);
    const keys = Object.fromEntries(inspection.targets.map((t) => [t.ref, t.operationKey]));
    expect(keys).toEqual({
      "tools/get_weather": "get_weather",
      "resources/app://status": "status",
      "resourceTemplates/file:///{path}": "file",
      "prompts/greet": "greet",
    });

    expect(fetches()).toBe(0);
  });

  it("refuses an invalid pin loudly before any I/O (grammar and entity shapes)", async () => {
    const { fn, fetches } = discoveryServer();
    const synthesizer = new MCPSynthesizer({ fetch: fn });

    const invalid: Array<[string, unknown]> = [
      ["stray nextCursor", { tools: [{ name: "probe" }], nextCursor: "page2" }],
      ["non-object content", "not a listing"],
      ["entry missing identity", { tools: [{ description: "no name" }] }],
      ["entity shape mismatch", { tools: [{ name: "probe", description: 5 }] }],
      ["bad prompt arguments", { prompts: [{ name: "p", arguments: "nope" }] }],
    ];
    for (const [, content] of invalid) {
      await expect(
        synthesizer.synthesizeInterface({
          sources: [{ bindingSpec: "openbindings.mcp@1", location: ENDPOINT, content }],
        }),
      ).rejects.toThrow(/MCP-D-01/);
      await expect(
        synthesizer.inspectSource({ bindingSpec: "openbindings.mcp@1", location: ENDPOINT, content }),
      ).rejects.toThrow(/MCP-D-01/);
    }

    expect(fetches()).toBe(0);
  });

  it("content does not waive MCP-D-02: a pinned source still requires the location", async () => {
    const { fn, fetches } = discoveryServer();
    const synthesizer = new MCPSynthesizer({ fetch: fn });

    await expect(
      synthesizer.synthesizeInterface({
        sources: [{ bindingSpec: "openbindings.mcp@1", content: pin }],
      }),
    ).rejects.toThrow(/MCP-D-02/);
    await expect(
      synthesizer.inspectSource({ bindingSpec: "openbindings.mcp@1", content: pin }),
    ).rejects.toThrow(/MCP-D-02/);

    expect(fetches()).toBe(0);
  });

  it("absent content still dials live", async () => {
    const { fn, fetches } = discoveryServer();
    const synthesizer = new MCPSynthesizer({ fetch: fn });

    await synthesizer.synthesizeInterface({
      sources: [{ bindingSpec: "openbindings.mcp@1", location: ENDPOINT }],
    });
    expect(fetches()).toBeGreaterThan(0);

    const before = fetches();
    await synthesizer.inspectSource({ bindingSpec: "openbindings.mcp@1", location: ENDPOINT });
    expect(fetches()).toBeGreaterThan(before);
  });
});

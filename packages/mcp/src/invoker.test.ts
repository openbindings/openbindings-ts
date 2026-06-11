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
import { MCPInvoker } from "./invoker.js";

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
  it("invokes a tool: write + single, JSON text content parsed", async () => {
    const { fn, calls } = mcpServer(() => textResult('{"tempC":20}'));
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/get_weather", fetch: fn });

    await call.write({ city: "Oslo" });
    await expect(single(call.outputs)).resolves.toEqual({ tempC: 20 });
    await expect(call.closed).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("tools/call");
    expect(calls[0].params.name).toBe("get_weather");
    expect(calls[0].params.arguments).toEqual({ city: "Oslo" });
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
  it("reads a resource without any input (no-input recipe)", async () => {
    const { fn, calls } = mcpServer(() => ({
      result: { contents: [{ uri: "file:///data.json", text: '{"a":1}' }] },
    }));
    const call = new MCPInvoker().invokeBinding({ source, ref: "resources/file:///data.json", fetch: fn });

    // No write, no close: the binding closes input on entry.
    await expect(single(call.outputs)).resolves.toEqual({ a: 1 });
    expect(calls[0].method).toBe("resources/read");
    expect(calls[0].params.uri).toBe("file:///data.json");
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
    // (the creator emits no input schema for zero-argument prompts), so the
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

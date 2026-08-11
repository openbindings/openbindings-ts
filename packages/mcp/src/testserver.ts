/**
 * Shared test fixture: a fetch stub speaking just enough MCP Streamable
 * HTTP for the client. Used by invoker.test.ts and conformance.test.ts —
 * the TS analogue of the Go suite's setupConformanceServer + wireLog
 * (conformance_test.go): every JSON-RPC request body is recorded so tests
 * can assert what actually rode the wire (which list requests were
 * consulted, whether tools/call carried an arguments member or a
 * progressToken, which URI a resources/read targeted).
 */

export const ENDPOINT = "https://mcp.example.com/mcp";

export interface RpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params: Record<string, unknown> & { _meta?: { progressToken?: number | string } };
}

export interface CapturedCall {
  method: string;
  params: RpcRequest["params"];
  headers: Record<string, string>;
}

/** A reply from the fake server to one JSON-RPC request. */
export type RpcReply =
  | { result: unknown; headers?: Record<string, string> }
  | { error: { code: number; message: string; data?: unknown } }
  | { sse: unknown[] }
  | { http: Response }
  | { hang: true };

export function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

export const textResult = (text: string): RpcReply => ({
  result: { content: [{ type: "text", text }] },
});

export interface MCPServerOptions {
  /** Overrides the response to the initialize request (connect-failure tests). */
  initResponse?: Response;
  /** Live listing: declared tool names, served via tools/list. */
  tools?: string[];
  /** Live listing: declared resource URIs, served via resources/list. */
  resources?: string[];
  /** Live listing: declared template strings, served via resources/templates/list. */
  resourceTemplates?: string[];
  /** Live listing: declared prompt names, served via prompts/list. */
  prompts?: string[];
  /**
   * List page size. When set, list results paginate with nextCursor so
   * tests can prove exhaustion (MCP-P-02); default is one page.
   */
  pageSize?: number;
}

export interface MCPServer {
  fn: typeof fetch;
  /** Every recorded JSON-RPC request (list requests included), in arrival order. */
  calls: CapturedCall[];
  /** Total fetch invocations — pre-I/O refusal tests assert zero. */
  fetches: () => number;
  /** The parsed params of every request with the given method, in order. */
  params: (method: string) => RpcRequest["params"][];
  /** How many requests with the given method rode the wire. */
  count: (method: string) => number;
}

function paginate<T>(items: T[], cursor: unknown, pageSize?: number): { page: T[]; nextCursor?: string } {
  const size = pageSize && pageSize > 0 ? pageSize : Math.max(items.length, 1);
  const start = typeof cursor === "string" ? Number(cursor) : 0;
  const page = items.slice(start, start + size);
  const next = start + size;
  return next < items.length ? { page, nextCursor: String(next) } : { page };
}

/**
 * Builds the fetch stub: answers `initialize`, serves the four list
 * requests from the configured listing (paginated when pageSize is set),
 * accepts notifications with 202, declines the standalone GET SSE stream
 * with 405, and routes entity-call requests (tools/call, resources/read,
 * prompts/get) to the responder.
 */
export function mcpServer(respond: (req: RpcRequest) => RpcReply, opts?: MCPServerOptions): MCPServer {
  const calls: CapturedCall[] = [];
  let fetchCount = 0;

  // `unknown` absorbs `undefined`; the union deliberately documents the
  // "not a list method" sentinel next to the reply value.
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  const listReply = (req: RpcRequest): unknown | undefined => {
    const cursor = req.params?.cursor;
    switch (req.method) {
      case "tools/list": {
        const { page, nextCursor } = paginate(opts?.tools ?? [], cursor, opts?.pageSize);
        return {
          tools: page.map((name) => ({
            name,
            description: "fixture tool",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          })),
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        };
      }
      case "resources/list": {
        const { page, nextCursor } = paginate(opts?.resources ?? [], cursor, opts?.pageSize);
        return {
          resources: page.map((uri) => ({ name: uri, uri })),
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        };
      }
      case "resources/templates/list": {
        const { page, nextCursor } = paginate(opts?.resourceTemplates ?? [], cursor, opts?.pageSize);
        return {
          resourceTemplates: page.map((t) => ({ name: t, uriTemplate: t })),
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        };
      }
      case "prompts/list": {
        const { page, nextCursor } = paginate(opts?.prompts ?? [], cursor, opts?.pageSize);
        return {
          prompts: page.map((name) => ({ name })),
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        };
      }
      default:
        return undefined;
    }
  };

  const fn: typeof fetch = async (_input, init) => {
    fetchCount++;
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });

    // The MCP client under test always POSTs a JSON string body.
    const msg = JSON.parse(init?.body as string) as Partial<RpcRequest> & { method: string };
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ method: msg.method, params: (msg.params ?? {}), headers });

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
    const list = listReply(req);
    if (list !== undefined) {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: list });
    }

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

  const params = (method: string): RpcRequest["params"][] =>
    calls.filter((c) => c.method === method).map((c) => c.params);

  return { fn, calls, fetches: () => fetchCount, params, count: (m) => params(m).length };
}

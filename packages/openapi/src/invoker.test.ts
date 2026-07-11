import { describe, it, expect, vi } from "vitest";
import {
  single,
  CONTEXT_REQUIRED,
  ERR_AUTH_REQUIRED,
  ERR_CANCELLED,
  ERR_CONNECT_FAILED,
  ERR_EXECUTION_FAILED,
  ERR_INVALID_REF,
  ERR_MISSING_INPUT,
  ERR_PERMISSION_DENIED,
  ERR_REF_NOT_FOUND,
  ERR_RESPONSE_ERROR,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_SOURCE_LOAD_FAILED,
  USE_DEFAULT,
  newInvokeHooks,
} from "@openbindings/sdk";
import { OpenAPIInvoker } from "./invoker.js";

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: BodyInit | null;
  signal?: AbortSignal | null;
}

function mockFetch(
  respond: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req: CapturedRequest = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
      signal: init?.signal,
    };
    requests.push(req);
    return respond(req);
  };
  return { fetch: fn as typeof globalThis.fetch, requests };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Test API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/ping": {
      get: { responses: { "200": { description: "OK" } } },
    },
    "/users/{id}": {
      get: {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "verbose", in: "query", schema: { type: "boolean" } },
          { name: "X-Trace", in: "header", schema: { type: "string" } },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
    "/users": {
      post: {
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "201": { description: "Created" } },
      },
    },
    "/search": {
      get: {
        parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "OK" } },
      },
    },
  },
};

const SOURCE = { format: "openapi@3.1", content: SPEC };

const REF_PING = "#/paths/~1ping/get";
const REF_GET_USER = "#/paths/~1users~1{id}/get";
const REF_CREATE_USER = "#/paths/~1users/post";
const REF_SEARCH = "#/paths/~1search/get";

/** Builds a one-operation spec with the given security configuration. */
function authSpec(opts: {
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, unknown>>;
  opSecurity?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Auth API", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    ...(opts.securitySchemes ? { components: { securitySchemes: opts.securitySchemes } } : {}),
    ...(opts.security ? { security: opts.security } : {}),
    paths: {
      "/data": {
        get: {
          ...(opts.opSecurity !== undefined ? { security: opts.opSecurity } : {}),
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
}

const REF_DATA = "#/paths/~1data/get";

function authSource(spec: Record<string, unknown>) {
  return { format: "openapi@3.1", content: spec };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAPIInvoker.formats", () => {
  it("advertises the OpenAPI 3.x range token", () => {
    expect(new OpenAPIInvoker().formats()).toEqual([
      { token: "openapi@^3.0.0", description: "OpenAPI 3.x HTTP APIs" },
    ]);
  });
});

describe("invokeBinding — request construction", () => {
  it("dispatches a no-input operation immediately and emits the parsed body", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({ pong: true }));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    const out = await single(call.outputs);

    expect(out).toEqual({ pong: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.example.com/v1/ping");
    expect(requests[0].method).toBe("GET");
    expect(requests[0].headers.get("Accept")).toBe("application/json, text/event-stream");
    await expect(call.closed).resolves.toBeUndefined();
  });

  it("classifies input fields into path, query, and header parameters", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({ id: "42" }));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_GET_USER, fetch });

    await call.write({ id: "42", verbose: true, "X-Trace": "abc" });
    const out = await single(call.outputs);

    expect(out).toEqual({ id: "42" });
    expect(requests[0].url).toBe("https://api.example.com/v1/users/42?verbose=true");
    expect(requests[0].headers.get("X-Trace")).toBe("abc");
  });

  it("serializes unclassified fields into the JSON request body", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({ id: "u1" }, 201));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_CREATE_USER, fetch });

    await call.write({ name: "Ada", email: "ada@example.com" });
    const out = await single(call.outputs);

    expect(out).toEqual({ id: "u1" });
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(requests[0].body as string)).toEqual({
      name: "Ada",
      email: "ada@example.com",
    });
  });

  it("a field declared as parameter AND body property is delivered to both wire locations", async () => {
    // Field-collision rule: PUT /users/{id} with id also in the body
    // sends ONE caller value to the path AND the body.
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      servers: [{ url: "https://api.example.com/v1" }],
      paths: {
        "/users/{id}": {
          put: {
            operationId: "updateUser",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" }, name: { type: "string" } },
                    required: ["id", "name"],
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({ ok: true }));
    const call = new OpenAPIInvoker().invokeBinding({
      source: { format: "openapi@3.1", content: spec },
      ref: "#/paths/~1users~1{id}/put",
      fetch,
    });

    await call.write({ id: "u1", name: "Ada" });
    await single(call.outputs);

    expect(requests[0].url).toBe("https://api.example.com/v1/users/u1");
    expect(JSON.parse(requests[0].body as string)).toEqual({ id: "u1", name: "Ada" });
  });

  it("errors ERR_MISSING_INPUT when input closes bare on a required-input operation", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_GET_USER, fetch });

    await call.close();

    await expect(call.closed).rejects.toMatchObject({ code: ERR_MISSING_INPUT });
    expect(requests).toHaveLength(0);
  });

  it("dispatches with an empty input when all parameters are optional", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse([]));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_SEARCH, fetch });

    await call.close();
    const out = await single(call.outputs);

    expect(out).toEqual([]);
    expect(requests[0].url).toBe("https://api.example.com/v1/search");
  });

  it("percent-encodes path parameter values so reserved characters cannot corrupt the URL", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({ id: "x" }));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_GET_USER, fetch });

    await call.write({ id: "a/b?c#d" });
    await single(call.outputs);

    expect(requests[0].url).toBe("https://api.example.com/v1/users/a%2Fb%3Fc%23d");
  });

  // Pins byte-for-byte parity with Go's encodePathValue (TestEncodePathValue_
  // MatchesEncodeURIComponent / TestClassifyInput_PathValuesPercentEncoded):
  // encodeURIComponent's unreserved set (ALPHA/DIGIT/-_.!~*'()) is exactly
  // the byte set encodePathValue hand-rolls, UTF-8 bytewise for multibyte
  // characters.
  it("percent-encodes multibyte UTF-8 path values byte-identically to Go's encodePathValue", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({ id: "x" }));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_GET_USER, fetch });

    await call.write({ id: "héllo" });
    await single(call.outputs);

    expect(requests[0].url).toBe("https://api.example.com/v1/users/h%C3%A9llo");
  });

  // Tier 1: the invoke.ts comment claiming "the document is dereferenced at
  // load" used to be false — parameters expressed as {"$ref": "..."} carried
  // no name/in and fell through to body routing. Mirrors Go's
  // TestIntegration_RefParametersRouteCorrectly.
  it("$ref'd parameters route by their resolved name/in, never fall to the body", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: "https://api.example.com/v1" }],
      paths: {
        "/users/{id}": {
          get: {
            operationId: "getUser",
            parameters: [
              { $ref: "#/components/parameters/IdParam" },
              { $ref: "#/components/parameters/VerboseParam" },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        parameters: {
          IdParam: { name: "id", in: "path", required: true, schema: { type: "string" } },
          VerboseParam: { name: "verbose", in: "query", schema: { type: "boolean" } },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({ ok: true }));
    const call = new OpenAPIInvoker().invokeBinding({
      source: { format: "openapi@3.0", content: spec },
      ref: "#/paths/~1users~1{id}/get",
      fetch,
    });

    await call.write({ id: "u1", verbose: true });
    await single(call.outputs);

    expect(requests[0].url).toBe("https://api.example.com/v1/users/u1?verbose=true");
    // A GET with no requestBody has nowhere for a body-routed field to go —
    // unresolved $ref params previously vanished silently instead of
    // routing to the path/query.
    expect(requests[0].body == null).toBe(true);
  });

  // Tier 1: Go routes declared `in: cookie` params to a Cookie header; the
  // TS invoker had no cookie case at all. Mirrors Go's
  // TestClassifyInput_CookieParamsGoToCookieHeader.
  it("declared cookie parameters join a sorted Cookie header, never the body", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      servers: [{ url: "https://api.example.com/v1" }],
      paths: {
        "/session": {
          get: {
            parameters: [
              { name: "session_id", in: "cookie", schema: { type: "string" } },
              { name: "csrf", in: "cookie", schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({ ok: true }));
    const call = new OpenAPIInvoker().invokeBinding({
      source: { format: "openapi@3.1", content: spec },
      ref: "#/paths/~1session/get",
      fetch,
    });

    await call.write({ session_id: "s-1", csrf: "c-2" });
    await single(call.outputs);

    expect(requests[0].headers.get("Cookie")).toBe("csrf=c-2; session_id=s-1");
    expect(requests[0].body == null).toBe(true);
  });

  // Verify item: media-type parameters ("; charset=utf-8") must never change
  // whether a declared request body counts as JSON for the field-collision
  // rule. Mirrors Go's TestBodyPropertyNames_MediaTypeParameters (already
  // correct on the TS side — this pins it).
  it("recognizes a JSON body content-type carrying media-type parameters for the collision rule", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      servers: [{ url: "https://api.example.com/v1" }],
      paths: {
        "/users/{id}": {
          put: {
            operationId: "updateUser",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: {
                "application/json; charset=utf-8": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" }, name: { type: "string" } },
                    required: ["id", "name"],
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const { fetch, requests } = mockFetch(() => jsonResponse({ ok: true }));
    const call = new OpenAPIInvoker().invokeBinding({
      source: { format: "openapi@3.1", content: spec },
      ref: "#/paths/~1users~1{id}/put",
      fetch,
    });

    await call.write({ id: "u1", name: "Ada" });
    await single(call.outputs);

    // The collision rule only fires when bodyPropertyNames sees through the
    // "; charset=utf-8" parameter: id must ride both the path AND the body.
    expect(requests[0].url).toBe("https://api.example.com/v1/users/u1");
    expect(JSON.parse(requests[0].body as string)).toEqual({ id: "u1", name: "Ada" });
  });

  it("dispatches immediately with empty input under the operation-layer no-input convention", async () => {
    // binding present + inputSchema absent: the operation declares NO input,
    // so the caller never writes nor closes — even though the OpenAPI doc
    // declares a required requestBody for this path.
    const { fetch, requests } = mockFetch(() => jsonResponse({ id: "u1" }, 201));
    const call = new OpenAPIInvoker().invokeBinding({
      source: SOURCE,
      ref: REF_CREATE_USER,
      binding: { operation: "createUser", source: "api", ref: REF_CREATE_USER },
      fetch,
    });

    await expect(single(call.outputs)).resolves.toEqual({ id: "u1" });
    await expect(call.closed).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].body as string)).toEqual({});
  });
});

describe("invokeBinding — pre-dispatch failures", () => {
  it("errors ERR_INVALID_REF on a malformed ref without dispatching", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: "#/nope", fetch });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_INVALID_REF });
    expect(requests).toHaveLength(0);
  });

  it("errors ERR_REF_NOT_FOUND when the ref resolves to no operation", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: SOURCE,
      ref: "#/paths/~1missing/get",
      fetch,
    });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_REF_NOT_FOUND });
    expect(requests).toHaveLength(0);
  });

  it("errors ERR_SOURCE_CONFIG_ERROR when the document declares no server URL", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const spec = { ...SPEC, servers: undefined };
    const call = new OpenAPIInvoker().invokeBinding({
      source: { format: "openapi@3.1", content: spec },
      ref: REF_PING,
      fetch,
    });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_SOURCE_CONFIG_ERROR });
    expect(requests).toHaveLength(0);
  });

  it("errors ERR_SOURCE_LOAD_FAILED when the source document cannot be fetched", async () => {
    const { fetch } = mockFetch(() => new Response("nope", { status: 500 }));
    const call = new OpenAPIInvoker().invokeBinding({
      source: { format: "openapi@3.1", location: "https://example.com/openapi.json" },
      ref: REF_PING,
      fetch,
    });

    await expect(call.closed).rejects.toMatchObject({ code: ERR_SOURCE_LOAD_FAILED });
  });

  it("maps a network-level fetch rejection to ERR_CONNECT_FAILED", async () => {
    const fetch = (() =>
      Promise.reject(new TypeError("fetch failed"))) as typeof globalThis.fetch;
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    await expect(call.closed).rejects.toMatchObject({
      code: ERR_CONNECT_FAILED,
      message: "fetch failed",
    });
  });
});

describe("invokeBinding — responses", () => {
  it("maps HTTP error statuses to terminal errors carrying status and body", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ error: "not found" }, 404));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    // Details carry the RAW capture (diagnostics, never a decoded value —
    // the content-independence de-sniff removed failure-path parsing too).
    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      details: { status: 404, body: JSON.stringify({ error: "not found" }) },
    });
  });

  it("maps 401 to ERR_AUTH_REQUIRED and 403 to ERR_PERMISSION_DENIED", async () => {
    const inv = new OpenAPIInvoker();

    const { fetch: f401 } = mockFetch(() => jsonResponse({}, 401));
    await expect(
      inv.invokeBinding({ source: SOURCE, ref: REF_PING, fetch: f401 }).closed,
    ).rejects.toMatchObject({ code: ERR_AUTH_REQUIRED, details: { status: 401 } });

    const { fetch: f403 } = mockFetch(() => jsonResponse({}, 403));
    await expect(
      inv.invokeBinding({ source: SOURCE, ref: REF_PING, fetch: f403 }).closed,
    ).rejects.toMatchObject({ code: ERR_PERMISSION_DENIED, details: { status: 403 } });
  });

  it("consults consumer hooks through the seam (decode + classify)", async () => {
    // The diff(1)-class election, HTTP flavor: a 404 the consumer declares
    // a valid outcome (axios validateStatus), and a text lane the consumer
    // decodes itself. Per-invocation hooks ride args.hooks (the carrier a
    // direct binding-layer caller builds via OperationInvoker.snapshotHooks).
    const hooks = newInvokeHooks(
      {
        classify: (_site, raw) => (raw.status === 404 ? true : USE_DEFAULT),
        decode: (_site, raw) => (raw.body.length > 0 ? { missing: true, note: raw.body } : USE_DEFAULT),
      },
      {},
    );
    const { fetch } = mockFetch(
      () => new Response("no such pet", { status: 404, headers: { "Content-Type": "text/plain" } }),
    );
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch, hooks });

    const out = await single(call.outputs);
    expect(out).toEqual({ missing: true, note: "no such pet" });
    await call.closed;

    // the conventions record success stamps name what decided each axis.
    expect(call.trailer()).toMatchObject({ "x-ob-decode": ["hook"], "x-ob-classify": ["hook"] });
  });

  it("a declared-JSON body that fails to parse is loud, never a silent string", async () => {
    const { fetch } = mockFetch(
      () => new Response("not json {", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });
    await expect(call.closed).rejects.toMatchObject({ code: ERR_RESPONSE_ERROR });
  });

  it("an undeclared lane decodes as text — the header decides, never the bytes", async () => {
    // A JSON-shaped body WITHOUT a JSON Content-Type stays a string (the
    // removed maybeJSON sniffer would have parsed it).
    const { fetch } = mockFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });
    const out = await single(call.outputs);
    expect(out).toBe(JSON.stringify({ ok: true }));
    await call.closed;
    expect(call.trailer()).toMatchObject({ "x-ob-decode": ["header/content-type"], "x-ob-classify": ["assumption/2xx"] });
  });

  it("exposes response headers as leading metadata", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ ok: true }, 200, { "X-Request-Id": "r1" }));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    const md = await call.header;
    expect(md["x-request-id"]).toEqual(["r1"]);
    expect(md["content-type"]).toEqual(["application/json"]);
    await expect(single(call.outputs)).resolves.toEqual({ ok: true });
  });

  it("emits a non-JSON body as a string", async () => {
    const { fetch } = mockFetch(
      () => new Response("plain text", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    await expect(single(call.outputs)).resolves.toBe("plain text");
  });

  it("emits a single null output for an empty body", async () => {
    const { fetch } = mockFetch(() => new Response(null, { status: 204 }));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    // An empty body decodes to null (the builtin's empty-unit answer),
    // matching the Go SDK — never undefined, which JSON cannot carry.
    const outs: unknown[] = [];
    for await (const o of call.outputs) outs.push(o);
    expect(outs).toEqual([null]);
  });

  it("cancels the body stream when the response exceeds the size limit", async () => {
    let bodyCancelled = false;
    const huge = new Uint8Array(1024 * 1024); // 1 MiB per chunk
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(huge);
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const { fetch } = mockFetch(() => new Response(stream, { status: 200 }));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    await expect(call.closed).rejects.toMatchObject({
      code: ERR_RESPONSE_ERROR,
      message: expect.stringContaining("byte limit"),
    });
    expect(bodyCancelled).toBe(true);
  });

  it("aborts the in-flight request and terminates ERR_CANCELLED on cancel", async () => {
    const { fetch, requests } = mockFetch(
      (req) =>
        new Promise<Response>((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    await vi.waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    await call.cancel();

    await expect(call.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
    expect(requests[0].signal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tier 2: SSE server-streaming (sse.ts wired into invoke.ts's decode path)
// ---------------------------------------------------------------------------

/** Builds a `text/event-stream` Response from raw SSE-framed chunks. */
function sseResponse(
  chunks: string[],
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: { "Content-Type": "text/event-stream", ...init?.headers },
  });
}

describe("invokeBinding — SSE responses", () => {
  it("requests text/event-stream alongside JSON via Accept", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({ pong: true }));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });
    await single(call.outputs);
    expect(requests[0].headers.get("Accept")).toBe("application/json, text/event-stream");
  });

  it("streams one output per SSE event and closes cleanly at stream end", async () => {
    const { fetch } = mockFetch(() =>
      sseResponse(['data: {"id":"1","msg":"first"}\n\n', 'data: {"id":"2","msg":"second"}\n\n']),
    );
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    const events: unknown[] = [];
    for await (const e of call.outputs) events.push(e);
    await call.closed;

    // Default decode follows the Content-Type header (text/event-stream ->
    // text lane), so each event's data arrives as a raw string — a JSON
    // event payload is an OutputDecoder hook case, not a builtin sniff.
    expect(events).toEqual(['{"id":"1","msg":"first"}', '{"id":"2","msg":"second"}']);
  });

  it("joins multiple data: lines for one event with a literal newline", async () => {
    const { fetch } = mockFetch(() => sseResponse(["data: line one\ndata: line two\ndata: line three\n\n"]));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    await expect(single(call.outputs)).resolves.toBe("line one\nline two\nline three");
  });

  it("rides event:/id:/retry: as per-event metadata (x-sse-*), never the output value", async () => {
    const hooks = newInvokeHooks(
      {
        decode: (_site, raw) => {
          const event = raw.meta["x-sse-event"]?.[0];
          const id = raw.meta["x-sse-id"]?.[0];
          if (!event && !id) return USE_DEFAULT;
          return { event, id, data: JSON.parse(raw.body) };
        },
      },
      {},
    );
    const { fetch } = mockFetch(() =>
      sseResponse([
        'data: {"msg":"first"}\n\n',
        'event: progress\nid: 42\ndata: {"msg":"third"}\n\n',
      ]),
    );
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch, hooks });

    const events: unknown[] = [];
    for await (const e of call.outputs) events.push(e);

    // No event:/id: on the first unit: the hook declines (USE_DEFAULT) and
    // the builtin text lane returns the raw string, unwrapped.
    expect(events[0]).toBe('{"msg":"first"}');
    expect(events[1]).toEqual({ event: "progress", id: "42", data: { msg: "third" } });
  });

  it("ignores comment lines (leading colon)", async () => {
    const { fetch } = mockFetch(() =>
      sseResponse([": this is a comment, should be ignored\n\n", 'data: {"id":"survivor"}\n\n']),
    );
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    await expect(single(call.outputs)).resolves.toBe('{"id":"survivor"}');
  });

  it("a non-2xx text/event-stream response is a normal HTTP failure, not a stream", async () => {
    const { fetch } = mockFetch(() => sseResponse(["data: nope\n\n"], { status: 500 }));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    await expect(call.closed).rejects.toMatchObject({
      code: ERR_EXECUTION_FAILED,
      details: { status: 500 },
    });
  });

  it("a 2xx JSON (non-SSE) response stays a plain unary invocation", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ pong: true }));
    const call = new OpenAPIInvoker().invokeBinding({ source: SOURCE, ref: REF_PING, fetch });

    const events: unknown[] = [];
    for await (const e of call.outputs) events.push(e);
    expect(events).toEqual([{ pong: true }]);
  });
});

describe("invokeBinding — context negotiation", () => {
  const BEARER = authSpec({
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    security: [{ bearerAuth: [] }],
  });

  it("challenges CONTEXT_REQUIRED before any dispatch when context is missing", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: authSource(BEARER),
      ref: REF_DATA,
      fetch,
    });

    await expect(call.closed).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      details: {
        target: "https://api.example.com",
        alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
      },
    });
    expect(requests).toHaveLength(0);
  });

  it("applies a bearer token from context", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({ ok: true }));
    const call = new OpenAPIInvoker().invokeBinding({
      source: authSource(BEARER),
      ref: REF_DATA,
      context: { bearerToken: "tok_123" },
      fetch,
    });

    await expect(single(call.outputs)).resolves.toEqual({ ok: true });
    expect(requests[0].headers.get("Authorization")).toBe("Bearer tok_123");
  });

  it("applies basic credentials from context", async () => {
    const spec = authSpec({
      securitySchemes: { basicAuth: { type: "http", scheme: "basic" } },
      security: [{ basicAuth: [] }],
    });
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: authSource(spec),
      ref: REF_DATA,
      context: { basic: { username: "u", password: "p" } },
      fetch,
    });

    await single(call.outputs);
    expect(requests[0].headers.get("Authorization")).toBe(`Basic ${btoa("u:p")}`);
  });

  it("challenges auth.basic when basic credentials are missing", async () => {
    const spec = authSpec({
      securitySchemes: { basicAuth: { type: "http", scheme: "basic" } },
      security: [{ basicAuth: [] }],
    });
    const { fetch } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: authSource(spec),
      ref: REF_DATA,
      fetch,
    });

    await expect(call.closed).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      details: { alternatives: [{ requirements: [{ type: "auth.basic" }] }] },
    });
  });

  it("places an apiKey in its declared header", async () => {
    const spec = authSpec({
      securitySchemes: { key: { type: "apiKey", name: "X-API-Key", in: "header" } },
      security: [{ key: [] }],
    });
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: authSource(spec),
      ref: REF_DATA,
      context: { apiKey: "k1" },
      fetch,
    });

    await single(call.outputs);
    expect(requests[0].headers.get("X-API-Key")).toBe("k1");
  });

  it("places an apiKey in its declared query parameter", async () => {
    const spec = authSpec({
      securitySchemes: { key: { type: "apiKey", name: "api_key", in: "query" } },
      security: [{ key: [] }],
    });
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: authSource(spec),
      ref: REF_DATA,
      context: { apiKey: "k1" },
      fetch,
    });

    await single(call.outputs);
    expect(requests[0].url).toBe("https://api.example.com/data?api_key=k1");
  });

  it("places an apiKey in its declared cookie", async () => {
    const spec = authSpec({
      securitySchemes: { key: { type: "apiKey", name: "sid", in: "cookie" } },
      security: [{ key: [] }],
    });
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: authSource(spec),
      ref: REF_DATA,
      context: { apiKey: "k1" },
      fetch,
    });

    await single(call.outputs);
    expect(requests[0].headers.get("Cookie")).toBe("sid=k1");
  });

  it("challenges auth.oauth2 and applies an accessToken as a bearer", async () => {
    // clientCredentials is a token-only flow: it defines tokenUrl/scopes but
    // never authorizationUrl. The flow fallback keys on tokenUrl, so the
    // challenge must carry tokenUrl (and scopes) — keying on authorizationUrl
    // would skip this flow and yield a bare auth.oauth2 requirement.
    const spec = authSpec({
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: "https://auth.example.com/token",
              scopes: { read: "Read", write: "Write" },
            },
          },
        },
      },
      security: [{ oauth: [] }],
    });
    const inv = new OpenAPIInvoker();

    const { fetch: f1, requests: r1 } = mockFetch(() => jsonResponse({}));
    await expect(
      inv.invokeBinding({ source: authSource(spec), ref: REF_DATA, fetch: f1 }).closed,
    ).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      details: {
        alternatives: [
          {
            requirements: [
              {
                type: "auth.oauth2",
                tokenUrl: "https://auth.example.com/token",
                scopes: ["read", "write"],
              },
            ],
          },
        ],
      },
    });
    expect(r1).toHaveLength(0);

    const { fetch: f2, requests: r2 } = mockFetch(() => jsonResponse({}));
    const call = inv.invokeBinding({
      source: authSource(spec),
      ref: REF_DATA,
      context: { accessToken: "at_1" },
      fetch: f2,
    });
    await single(call.outputs);
    expect(r2[0].headers.get("Authorization")).toBe("Bearer at_1");
  });

  it("carries the oauth2 authorization-code flow endpoints into the challenge", async () => {
    const spec = authSpec({
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "/oauth/authorize", // relative -> absolutized
              tokenUrl: "https://auth.example.com/oauth/token",
              scopes: { read: "Read", write: "Write" },
            },
          },
        },
      },
      security: [{ oauth: [] }],
    });
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    await expect(
      new OpenAPIInvoker().invokeBinding({ source: authSource(spec), ref: REF_DATA, fetch }).closed,
    ).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      details: {
        alternatives: [
          {
            requirements: [
              {
                type: "auth.oauth2",
                authorizeUrl: "https://api.example.com/oauth/authorize",
                tokenUrl: "https://auth.example.com/oauth/token",
                scopes: ["read", "write"],
              },
            ],
          },
        ],
      },
    });
    expect(requests).toHaveLength(0);
  });

  it("carries the openIdConnect discovery URL into the challenge", async () => {
    const spec = authSpec({
      securitySchemes: {
        oidc: {
          type: "openIdConnect",
          openIdConnectUrl: "https://auth.example.com/.well-known/openid-configuration",
        },
      },
      security: [{ oidc: [] }],
    });
    const { fetch } = mockFetch(() => jsonResponse({}));
    await expect(
      new OpenAPIInvoker().invokeBinding({ source: authSource(spec), ref: REF_DATA, fetch }).closed,
    ).rejects.toMatchObject({
      details: {
        alternatives: [
          {
            requirements: [
              {
                type: "auth.oauth2",
                openIdConnectUrl: "https://auth.example.com/.well-known/openid-configuration",
              },
            ],
          },
        ],
      },
    });
  });

  it("maps openIdConnect to auth.oauth2 and applies an accessToken as a bearer", async () => {
    const spec = authSpec({
      securitySchemes: {
        oidc: {
          type: "openIdConnect",
          openIdConnectUrl: "https://auth.example.com/.well-known/openid-configuration",
        },
      },
      security: [{ oidc: [] }],
    });
    const inv = new OpenAPIInvoker();

    const { fetch: f1, requests: r1 } = mockFetch(() => jsonResponse({}));
    await expect(
      inv.invokeBinding({ source: authSource(spec), ref: REF_DATA, fetch: f1 }).closed,
    ).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      details: { alternatives: [{ requirements: [{ type: "auth.oauth2" }] }] },
    });
    expect(r1).toHaveLength(0);

    const { fetch: f2, requests: r2 } = mockFetch(() => jsonResponse({}));
    const call = inv.invokeBinding({
      source: authSource(spec),
      ref: REF_DATA,
      context: { accessToken: "at_2" },
      fetch: f2,
    });
    await single(call.outputs);
    expect(r2[0].headers.get("Authorization")).toBe("Bearer at_2");
  });

  it("prefers the password flow over clientCredentials by fixed priority, not declaration order", async () => {
    // Both flows are token-only (define tokenUrl but not authorizationUrl).
    // Declared clientCredentials-first to prove the fix: object insertion
    // order must NOT decide the winner — the fixed priority (password
    // before clientCredentials, mirroring the Go SDK exactly) does.
    const spec = authSpec({
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: "https://auth.example.com/client-credentials/token",
              scopes: { cc: "ClientCredentials" },
            },
            password: {
              tokenUrl: "https://auth.example.com/password/token",
              scopes: { pw: "Password" },
            },
          },
        },
      },
      security: [{ oauth: [] }],
    });
    const { fetch } = mockFetch(() => jsonResponse({}));
    await expect(
      new OpenAPIInvoker().invokeBinding({ source: authSource(spec), ref: REF_DATA, fetch }).closed,
    ).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      details: {
        alternatives: [
          {
            requirements: [
              {
                type: "auth.oauth2",
                tokenUrl: "https://auth.example.com/password/token",
                scopes: ["pw"],
              },
            ],
          },
        ],
      },
    });
  });

  it("prefers authorizationCode over every other flow when multiple are declared", async () => {
    const spec = authSpec({
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            clientCredentials: { tokenUrl: "https://auth.example.com/client-credentials/token" },
            password: { tokenUrl: "https://auth.example.com/password/token" },
            implicit: { authorizationUrl: "https://auth.example.com/implicit/authorize" },
            authorizationCode: {
              authorizationUrl: "https://auth.example.com/authorize",
              tokenUrl: "https://auth.example.com/authcode/token",
            },
          },
        },
      },
      security: [{ oauth: [] }],
    });
    const { fetch } = mockFetch(() => jsonResponse({}));
    await expect(
      new OpenAPIInvoker().invokeBinding({ source: authSource(spec), ref: REF_DATA, fetch }).closed,
    ).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      details: {
        alternatives: [
          {
            requirements: [
              {
                type: "auth.oauth2",
                authorizeUrl: "https://auth.example.com/authorize",
                tokenUrl: "https://auth.example.com/authcode/token",
              },
            ],
          },
        ],
      },
    });
  });

  it("treats multiple security-requirement objects as alternatives (OR)", async () => {
    const spec = authSpec({
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        key: { type: "apiKey", name: "X-API-Key", in: "header" },
      },
      security: [{ bearerAuth: [] }, { key: [] }],
    });
    const inv = new OpenAPIInvoker();

    const { fetch: f1 } = mockFetch(() => jsonResponse({}));
    await expect(
      inv.invokeBinding({ source: authSource(spec), ref: REF_DATA, fetch: f1 }).closed,
    ).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      details: {
        alternatives: [
          { requirements: [{ type: "auth.bearer" }] },
          { requirements: [{ type: "auth.apiKey" }] },
        ],
      },
    });

    // Satisfying any one alternative suffices.
    const { fetch: f2, requests: r2 } = mockFetch(() => jsonResponse({}));
    const call = inv.invokeBinding({
      source: authSource(spec),
      ref: REF_DATA,
      context: { apiKey: "k1" },
      fetch: f2,
    });
    await single(call.outputs);
    expect(r2[0].headers.get("X-API-Key")).toBe("k1");
  });

  it("treats schemes within one requirement object as conjunctive (AND)", async () => {
    const spec = authSpec({
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        key: { type: "apiKey", name: "X-API-Key", in: "header" },
      },
      security: [{ bearerAuth: [], key: [] }],
    });
    const inv = new OpenAPIInvoker();

    // One credential is not enough.
    const { fetch: f1 } = mockFetch(() => jsonResponse({}));
    await expect(
      inv.invokeBinding({
        source: authSource(spec),
        ref: REF_DATA,
        context: { bearerToken: "tok" },
        fetch: f1,
      }).closed,
    ).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      details: {
        alternatives: [
          { requirements: [{ type: "auth.bearer" }, { type: "auth.apiKey" }] },
        ],
      },
    });

    // Both credentials are applied together.
    const { fetch: f2, requests: r2 } = mockFetch(() => jsonResponse({}));
    const call = inv.invokeBinding({
      source: authSource(spec),
      ref: REF_DATA,
      context: { bearerToken: "tok", apiKey: "k1" },
      fetch: f2,
    });
    await single(call.outputs);
    expect(r2[0].headers.get("Authorization")).toBe("Bearer tok");
    expect(r2[0].headers.get("X-API-Key")).toBe("k1");
  });

  it("lets operation-level security remove document-level requirements", async () => {
    const spec = authSpec({
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      security: [{ bearerAuth: [] }],
      opSecurity: [],
    });
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: authSource(spec),
      ref: REF_DATA,
      fetch,
    });

    await single(call.outputs);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("Authorization")).toBeNull();
  });

  it("requires no context when an empty requirement object allows anonymous access", async () => {
    const spec = authSpec({
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      security: [{ bearerAuth: [] }, {}],
    });
    const { fetch, requests } = mockFetch(() => jsonResponse({}));
    const call = new OpenAPIInvoker().invokeBinding({
      source: authSource(spec),
      ref: REF_DATA,
      fetch,
    });

    await single(call.outputs);
    expect(requests).toHaveLength(1);
  });

  it("merges context headers and cookies into the request", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({ pong: true }));
    const call = new OpenAPIInvoker().invokeBinding({
      source: SOURCE,
      ref: REF_PING,
      context: { headers: { "X-Custom": "v" }, cookies: { session: "s1" } },
      fetch,
    });

    await single(call.outputs);
    expect(requests[0].headers.get("X-Custom")).toBe("v");
    expect(requests[0].headers.get("Cookie")).toBe("session=s1");
  });

  it("falls back to bearer placement when the document declares no schemes", async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse({ pong: true }));
    const call = new OpenAPIInvoker().invokeBinding({
      source: SOURCE,
      ref: REF_PING,
      context: { bearerToken: "tok" },
      fetch,
    });

    await single(call.outputs);
    expect(requests[0].headers.get("Authorization")).toBe("Bearer tok");
  });
});

describe("prepareBinding", () => {
  const BEARER = authSpec({
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    security: [{ bearerAuth: [] }],
  });

  it("reports the requirement when context is insufficient", async () => {
    const details = await new OpenAPIInvoker().prepareBinding({
      source: authSource(BEARER),
      ref: REF_DATA,
    });

    expect(details).toEqual({
      target: "https://api.example.com",
      alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
    });
  });

  // Go parity: prepareDoc's content path uses a loader with external refs
  // NOT allowed ("no I/O") — the side-effect-free preflight promise must
  // hold even when the inline content itself declares an external $ref.
  it("never fetches, even when inline content declares an external $ref", async () => {
    const spec = {
      ...BEARER,
      paths: {
        "/data": {
          get: {
            security: [{ bearerAuth: [] }],
            parameters: [{ $ref: "https://external.example/components.json#/params/Trace" }],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      const details = await new OpenAPIInvoker().prepareBinding({
        source: authSource(spec),
        ref: REF_DATA,
      });
      expect(fetchCalled).toBe(false);
      // Go parity: kin-openapi's loader rejects the WHOLE document the
      // instant it meets a disallowed external ref (loader.go:
      // allowsExternalRefs), regardless of where that ref sits — prepareDoc
      // returns nil on that error, so PrepareBinding reports no requirement
      // rather than fetching. Silent-fallback, never a thrown error.
      expect(details).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null when context satisfies the requirement", async () => {
    const details = await new OpenAPIInvoker().prepareBinding({
      source: authSource(BEARER),
      ref: REF_DATA,
      context: { bearerToken: "tok" },
    });

    expect(details).toBeNull();
  });

  it("returns null when the operation requires no auth", async () => {
    const details = await new OpenAPIInvoker().prepareBinding({
      source: SOURCE,
      ref: REF_PING,
    });

    expect(details).toBeNull();
  });

  it("returns null instead of fetching a location-only source", async () => {
    const details = await new OpenAPIInvoker().prepareBinding({
      source: { format: "openapi@3.1", location: "https://example.com/openapi.json" },
      ref: REF_DATA,
    });

    expect(details).toBeNull();
  });

  it("uses the cached document for a location source after an invocation loaded it", async () => {
    const SPEC_URL = "https://example.com/openapi.json";
    const inv = new OpenAPIInvoker();
    const { fetch } = mockFetch((req) =>
      req.url === SPEC_URL ? jsonResponse(BEARER) : jsonResponse({}),
    );

    // The challenged invocation loads and caches the document.
    const call = inv.invokeBinding({
      source: { format: "openapi@3.1", location: SPEC_URL },
      ref: REF_DATA,
      fetch,
    });
    await expect(call.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });

    const details = await inv.prepareBinding({
      source: { format: "openapi@3.1", location: SPEC_URL },
      ref: REF_DATA,
    });
    expect(details).toMatchObject({ target: "https://api.example.com" });
  });

  // Tier 2: a content+location invocation primes the location-keyed cache,
  // so a later location-only preflight is served warm without ever
  // fetching. Mirrors Go's TestPrepareBinding_UsesCachePrimedFromContent.
  it("a content+location invocation primes the location-keyed cache for a later location-only preflight", async () => {
    const SPEC_URL = "https://example.test/openapi.json";
    const inv = new OpenAPIInvoker();
    const { fetch, requests } = mockFetch(() => jsonResponse({}));

    // Content is authoritative: no fetch of SPEC_URL happens here, but the
    // parse must still land in the location-keyed cache.
    const call = inv.invokeBinding({
      source: { format: "openapi@3.1", location: SPEC_URL, content: BEARER },
      ref: REF_DATA,
      fetch,
    });
    await expect(call.closed).rejects.toMatchObject({ code: CONTEXT_REQUIRED });
    expect(requests).toHaveLength(0);

    // Location-only preflight: prepareBinding's location-only path never
    // fetches, so a non-null result here proves the cache was warm.
    const details = await inv.prepareBinding({
      source: { format: "openapi@3.1", location: SPEC_URL },
      ref: REF_DATA,
    });
    expect(details).toMatchObject({ target: "https://api.example.com" });
  });
});

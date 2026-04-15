import type {
  BindingExecutionInput,
  ExecuteOutput,
  ExecutionOptions,
  StreamEvent,
} from "@openbindings/sdk";
import {
  maybeJSON,
  contextBearerToken,
  contextApiKey,
  contextBasicAuth,
  normalizeContextKey,
  httpErrorCode,
  ERR_INVALID_REF,
  ERR_SOURCE_LOAD_FAILED,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_REF_NOT_FOUND,
  ERR_EXECUTION_FAILED,
  ERR_CONNECT_FAILED,
  ERR_RESPONSE_ERROR,
  ERR_STREAM_ERROR,
} from "@openbindings/sdk";
import type {
  AsyncAPIDocument,
  AsyncAPIOperation,
  AsyncAPISecurityScheme,
  AsyncAPIServer,
} from "./asyncapi-types.js";
import { parseAsyncAPIDocument, parseRef, errorMessage } from "./util.js";
import type { WSPool } from "./ws-pool.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export async function executeBinding(
  input: BindingExecutionInput,
  options?: { signal?: AbortSignal },
  preloadedDoc?: AsyncAPIDocument,
): Promise<ExecuteOutput> {
  const start = performance.now();

  let doc: AsyncAPIDocument;
  if (preloadedDoc) {
    doc = preloadedDoc;
  } else {
    try {
      doc = await parseAsyncAPIDocument(input.source.location, input.source.content, options, input.fetch);
    } catch (e: unknown) {
      return failedOutput(start, ERR_SOURCE_LOAD_FAILED, errorMessage(e));
    }
  }

  let opID: string;
  try {
    opID = parseRef(input.ref);
  } catch (e: unknown) {
    return failedOutput(start, ERR_INVALID_REF, errorMessage(e));
  }

  const asyncOp = findOperation(doc, opID);
  if (!asyncOp) {
    return failedOutput(start, ERR_REF_NOT_FOUND, `operation "${opID}" not in AsyncAPI doc`);
  }

  let serverURL: string, protocol: string;
  try {
    ({ url: serverURL, protocol } = resolveServer(doc, input.options));
  } catch (e: unknown) {
    return failedOutput(start, ERR_SOURCE_CONFIG_ERROR, errorMessage(e));
  }

  const address = asyncOp.channel?.address ?? "";

  switch (asyncOp.action) {
    case "receive":
      return executeReceive(serverURL, protocol, address, doc, asyncOp, input, start, options);
    case "send":
      return executeSend(serverURL, protocol, address, doc, asyncOp, input, start, options);
    default:
      return failedOutput(start, ERR_EXECUTION_FAILED, `unknown action "${asyncOp.action}"`);
  }
}

export async function* subscribeBinding(
  input: BindingExecutionInput,
  options?: { signal?: AbortSignal },
  preloadedDoc?: AsyncAPIDocument,
  wsPool?: WSPool,
): AsyncIterable<StreamEvent> {
  let doc: AsyncAPIDocument;
  if (preloadedDoc) {
    doc = preloadedDoc;
  } else {
    try {
      doc = await parseAsyncAPIDocument(input.source.location, input.source.content, options, input.fetch);
    } catch (e: unknown) {
      yield { error: { code: ERR_SOURCE_LOAD_FAILED, message: errorMessage(e) } };
      return;
    }
  }

  let opID: string;
  try {
    opID = parseRef(input.ref);
  } catch (e: unknown) {
    yield { error: { code: ERR_INVALID_REF, message: errorMessage(e) } };
    return;
  }

  const asyncOp = findOperation(doc, opID);
  if (!asyncOp) {
    yield { error: { code: ERR_REF_NOT_FOUND, message: `operation "${opID}" not in AsyncAPI doc` } };
    return;
  }

  let serverURL: string, protocol: string;
  try {
    ({ url: serverURL, protocol } = resolveServer(doc, input.options));
  } catch (e: unknown) {
    yield { error: { code: ERR_SOURCE_CONFIG_ERROR, message: errorMessage(e) } };
    return;
  }

  const address = asyncOp.channel?.address ?? "";

  if (asyncOp.action === "receive") {
    // Server pushes to client (SSE or WebSocket listen).
    if (protocol === "ws" || protocol === "wss") {
      yield* wsPool
        ? pooledStreamWS(wsPool, serverURL, address, doc, asyncOp, input, options)
        : streamWS(serverURL, address, doc, asyncOp, input, options);
    } else if (protocol === "http" || protocol === "https") {
      yield* streamSSE(serverURL, address, doc, asyncOp, input, options);
    } else {
      yield { error: { code: ERR_SOURCE_CONFIG_ERROR, message: `streaming not supported for protocol "${protocol}" (supported: http, https, ws, wss)` } };
      return;
    }
  } else if (asyncOp.action === "send") {
    // Client sends a message on a shared WebSocket (fire-and-forget).
    if (protocol === "ws" || protocol === "wss") {
      yield* wsPool
        ? pooledSendWS(wsPool, serverURL, address, input, options)
        : streamWS(serverURL, address, doc, asyncOp, input, options);
    } else {
      yield { error: { code: ERR_SOURCE_CONFIG_ERROR, message: `streaming for "send" action requires ws or wss protocol (got "${protocol}")` } };
      return;
    }
  } else {
    yield { error: { code: ERR_SOURCE_CONFIG_ERROR, message: `unknown action "${asyncOp.action}"` } };
    return;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findOperation(
  doc: AsyncAPIDocument,
  opID: string,
): AsyncAPIOperation | undefined {
  const ops = doc.operations ?? {};
  return ops[opID];
}

/**
 * Extracts the server origin from an AsyncAPI doc and normalizes it as a
 * stable context store key.
 */
const SUPPORTED_PROTOCOLS = new Set(["http", "https", "ws", "wss"]);

function pickDocServer(doc: AsyncAPIDocument): { url: string; protocol: string } | null {
  const servers = doc.servers ?? {};
  // Sort by id for deterministic selection
  const sorted = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b));
  for (const [, server] of sorted) {
    const proto = server.protocol.toLowerCase();
    if (SUPPORTED_PROTOCOLS.has(proto)) {
      let url = `${proto}://${server.host}`;
      const pathname = server.pathname;
      if (pathname) url += pathname;
      return { url, protocol: proto };
    }
  }
  return null;
}

export function resolveAsyncAPIServerKey(doc: AsyncAPIDocument): string {
  const server = pickDocServer(doc);
  return server ? normalizeContextKey(server.url.replace(/\/+$/, "")) : "";
}

function resolveServer(
  doc: AsyncAPIDocument,
  opts?: ExecutionOptions,
): { url: string; protocol: string } {
  if (opts?.metadata?.["baseURL"]) {
    const base = String(opts.metadata["baseURL"]);
    let proto = "http";
    if (base.startsWith("https://")) proto = "https";
    else if (base.startsWith("wss://")) proto = "wss";
    else if (base.startsWith("ws://")) proto = "ws";
    return { url: base.replace(/\/+$/, ""), protocol: proto };
  }

  const server = pickDocServer(doc);
  if (!server) throw new Error("no supported server found (need http, https, ws, or wss protocol)");
  return { url: server.url.replace(/\/+$/, ""), protocol: server.protocol };
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

function resolveSecuritySchemes(
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
): AsyncAPISecurityScheme[] {
  // Operation-level security overrides server-level.
  // After dereference, security items are resolved scheme objects.
  const opSecurity = asyncOp.security;
  if (opSecurity && opSecurity.length > 0) {
    return opSecurity.filter(isSecurityScheme);
  }

  // Fall back to server-level security
  const servers = doc.servers ?? {};
  const sorted = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b));
  for (const [, server] of sorted) {
    const serverSec = server.security;
    if (serverSec && serverSec.length > 0) {
      return serverSec.filter(isSecurityScheme);
    }
  }

  return [];
}

/** Type guard: after dereference, security requirement entries that were $refs to
 *  securitySchemes are resolved into the scheme object itself. */
function isSecurityScheme(obj: unknown): obj is AsyncAPISecurityScheme {
  return typeof obj === "object" && obj !== null && "type" in obj;
}

function applyCredentialsViaSchemes(
  headers: Headers,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  ctx: Record<string, unknown>,
): { applied: boolean; queryParams?: Record<string, string> } {
  const schemes = resolveSecuritySchemes(doc, asyncOp);
  if (!schemes.length) return { applied: false };

  let applied = false;
  let queryParams: Record<string, string> | undefined;

  for (const scheme of schemes) {
    const schemeType = scheme.type;
    switch (schemeType) {
      case "apiKey":
      case "httpApiKey": {
        const val = contextApiKey(ctx);
        if (!val) continue;
        const loc = scheme.in;
        const name = scheme.name;
        switch (loc) {
          case "header":
            headers.set(name ?? "Authorization", val);
            applied = true;
            break;
          case "query":
            if (name) {
              queryParams ??= {};
              queryParams[name] = val;
              applied = true;
            }
            break;
          case "cookie":
            if (name) {
              headers.append("Cookie", `${name}=${encodeURIComponent(val)}`);
              applied = true;
            }
            break;
        }
        break;
      }
      case "http":
        switch ((scheme.scheme ?? "").toLowerCase()) {
          case "bearer": {
            const token = contextBearerToken(ctx);
            if (token) {
              headers.set("Authorization", `Bearer ${token}`);
              applied = true;
            }
            break;
          }
          case "basic": {
            const basic = contextBasicAuth(ctx);
            if (basic) {
              const encoded = btoa(`${basic.username}:${basic.password}`);
              headers.set("Authorization", `Basic ${encoded}`);
              applied = true;
            }
            break;
          }
        }
        break;
      case "httpBearer": {
        const token = contextBearerToken(ctx);
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
          applied = true;
        }
        break;
      }
      case "userPassword": {
        const basic = contextBasicAuth(ctx);
        if (basic) {
          const encoded = btoa(`${basic.username}:${basic.password}`);
          headers.set("Authorization", `Basic ${encoded}`);
          applied = true;
        }
        break;
      }
    }
  }

  return { applied, queryParams };
}

function applyCredentialsFallback(headers: Headers, ctx: Record<string, unknown>): void {
  const token = contextBearerToken(ctx);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
    return;
  }
  const basic = contextBasicAuth(ctx);
  if (basic) {
    const encoded = btoa(`${basic.username}:${basic.password}`);
    headers.set("Authorization", `Basic ${encoded}`);
    return;
  }
  const apiKey = contextApiKey(ctx);
  if (apiKey) {
    headers.set("Authorization", `ApiKey ${apiKey}`);
  }
}

function applyContext(
  headers: Headers,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  ctx?: Record<string, unknown>,
  opts?: ExecutionOptions,
): Record<string, string> | undefined {
  let queryParams: Record<string, string> | undefined;

  if (ctx) {
    const result = applyCredentialsViaSchemes(headers, doc, asyncOp, ctx);
    if (!result.applied) {
      applyCredentialsFallback(headers, ctx);
    }
    queryParams = result.queryParams;
  }

  if (opts?.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers.set(k, v);
    }
  }

  if (opts?.cookies) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(opts.cookies)) {
      parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    if (parts.length > 0) {
      headers.append("Cookie", parts.join("; "));
    }
  }

  return queryParams;
}

// ---------------------------------------------------------------------------
// Execute: Receive (SSE)
// ---------------------------------------------------------------------------

async function executeReceive(
  serverURL: string,
  protocol: string,
  address: string,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  input: BindingExecutionInput,
  start: number,
  options?: { signal?: AbortSignal },
): Promise<ExecuteOutput> {
  let maxEvents = 1;
  if (input.input && typeof input.input === "object" && !Array.isArray(input.input)) {
    const m = input.input as Record<string, unknown>;
    if (typeof m["maxEvents"] === "number" && m["maxEvents"] > 0) {
      maxEvents = m["maxEvents"];
    }
  }

  if (protocol !== "http" && protocol !== "https") {
    return failedOutput(start, ERR_SOURCE_CONFIG_ERROR,
      `receive not supported for protocol "${protocol}" (supported: http, https)`);
  }

  return executeSSESubscribe(serverURL, address, maxEvents, doc, asyncOp, input, start, options);
}

async function executeSend(
  serverURL: string,
  protocol: string,
  address: string,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  input: BindingExecutionInput,
  start: number,
  options?: { signal?: AbortSignal },
): Promise<ExecuteOutput> {
  if (protocol !== "http" && protocol !== "https") {
    return failedOutput(start, ERR_SOURCE_CONFIG_ERROR,
      `send not supported for protocol "${protocol}" (supported: http, https)`);
  }

  return executeHTTPSend(serverURL, address, doc, asyncOp, input, start, options);
}

async function executeSSESubscribe(
  serverURL: string,
  address: string,
  maxEvents: number,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  input: BindingExecutionInput,
  start: number,
  options?: { signal?: AbortSignal },
): Promise<ExecuteOutput> {
  let url = `${serverURL}/${address.replace(/^\/+/, "")}`;

  const headers = new Headers({ Accept: "text/event-stream" });
  const authQueryParams = applyContext(headers, doc, asyncOp, input.context, input.options);
  if (authQueryParams) {
    const sep = url.includes("?") ? "&" : "?";
    url += sep + new URLSearchParams(authQueryParams).toString();
  }

  const doFetch = input.fetch ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(url, { headers, signal: options?.signal });
  } catch (e: unknown) {
    return failedOutput(start, ERR_CONNECT_FAILED, errorMessage(e));
  }

  if (resp.status < 200 || resp.status >= 300) {
    return httpErrorOutput(start, resp.status, resp.statusText);
  }

  const events: unknown[] = [];
  const reader = resp.body?.getReader();
  if (!reader) {
    return failedOutput(start, ERR_CONNECT_FAILED, "no response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let totalBytes = 0;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      reader.cancel().catch(() => {});
      return failedOutput(start, ERR_RESPONSE_ERROR, `SSE stream exceeds ${MAX_RESPONSE_BYTES} byte limit`);
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
        continue;
      }
      if (line === "" && dataLines.length > 0) {
        events.push(parseSSEPayload(dataLines));
        dataLines = [];
        if (events.length >= maxEvents) break outer;
      }
    }
  }

  if (dataLines.length > 0) {
    events.push(parseSSEPayload(dataLines));
  }

  reader.cancel().catch(() => {});

  const output = events.length === 1 ? events[0] : events;
  return {
    output,
    status: resp.status,
    durationMs: Math.round(performance.now() - start),
  };
}

async function* streamSSE(
  serverURL: string,
  address: string,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  input: BindingExecutionInput,
  options?: { signal?: AbortSignal },
): AsyncIterable<StreamEvent> {
  let url = `${serverURL}/${address.replace(/^\/+/, "")}`;

  const headers = new Headers({ Accept: "text/event-stream" });
  const authQueryParams = applyContext(headers, doc, asyncOp, input.context, input.options);
  if (authQueryParams) {
    const sep = url.includes("?") ? "&" : "?";
    url += sep + new URLSearchParams(authQueryParams).toString();
  }

  const doFetch = input.fetch ?? fetch;
  const resp = await doFetch(url, { headers, signal: options?.signal });

  if (resp.status < 200 || resp.status >= 300) {
    yield { error: { code: ERR_CONNECT_FAILED, message: `SSE endpoint returned HTTP ${resp.status}` } };
    return;
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    yield { error: { code: ERR_CONNECT_FAILED, message: "no response body" } };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        yield { error: { code: ERR_RESPONSE_ERROR, message: `SSE stream exceeds ${MAX_RESPONSE_BYTES} byte limit` } };
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
          continue;
        }
        if (line === "" && dataLines.length > 0) {
          yield { data: parseSSEPayload(dataLines) };
          dataLines = [];
        }
      }
    }

    if (dataLines.length > 0) {
      yield { data: parseSSEPayload(dataLines) };
    }
  } catch (e: unknown) {
    if (options?.signal?.aborted) return;
    yield { error: { code: ERR_STREAM_ERROR, message: errorMessage(e) } };
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Execute: WebSocket
// ---------------------------------------------------------------------------

async function* streamWS(
  serverURL: string,
  address: string,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  input: BindingExecutionInput,
  options?: { signal?: AbortSignal },
): AsyncIterable<StreamEvent> {
  const wsURL = new URL(`/${address.replace(/^\/+/, "")}`, serverURL);

  // Apply query-param credentials (e.g. apiKey in query) to the WebSocket URL.
  // Note: browser WebSocket API does not support custom headers, so header-based
  // auth is handled via the message body (bearer token) instead.
  const tempHeaders = new Headers();
  const authQueryParams = applyContext(tempHeaders, doc, asyncOp, input.context, input.options);
  if (authQueryParams) {
    for (const [k, v] of Object.entries(authQueryParams)) {
      wsURL.searchParams.set(k, v);
    }
  }

  const ws = new WebSocket(wsURL.toString());

  const queue: StreamEvent[] = [];
  let resolve: (() => void) | undefined;
  let done = false;

  ws.addEventListener("message", (ev) => {
    try {
      const parsed = JSON.parse(String(ev.data));
      if (parsed.error) {
        queue.push({ error: parsed.error });
      } else if (parsed.data !== undefined) {
        queue.push({ data: parsed.data });
      } else {
        queue.push({ data: parsed });
      }
    } catch {
      queue.push({ data: String(ev.data) });
    }
    resolve?.();
  });

  ws.addEventListener("close", () => {
    done = true;
    resolve?.();
  });

  ws.addEventListener("error", (ev) => {
    queue.push({
      error: { code: ERR_CONNECT_FAILED, message: `WebSocket error: ${String(ev)}` },
    });
    done = true;
    resolve?.();
  });

  await new Promise<void>((r) => {
    ws.addEventListener("open", () => {
      const payload: Record<string, unknown> = {};
      if (input.input !== undefined && typeof input.input === "object" && input.input !== null) {
        Object.assign(payload, input.input);
      }
      const bearerToken = input.context ? contextBearerToken(input.context) : undefined;
      if (bearerToken) {
        payload.bearerToken = bearerToken;
      }
      ws.send(JSON.stringify(payload));
      r();
    });
    ws.addEventListener("error", () => r());
  });

  const onAbort = () => {
    ws.close(1000, "aborted");
    done = true;
    resolve?.();
  };
  options?.signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (done) break;
      await new Promise<void>((r) => { resolve = r; });
    }
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000);
    }
  }
}

// ---------------------------------------------------------------------------
// Pooled WebSocket: receive (long-lived stream via shared connection)
// ---------------------------------------------------------------------------

async function* pooledStreamWS(
  pool: WSPool,
  serverURL: string,
  address: string,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  input: BindingExecutionInput,
  options?: { signal?: AbortSignal },
): AsyncIterable<StreamEvent> {
  let pooled;
  try {
    pooled = await pool.acquire(serverURL, address);
  } catch (e: unknown) {
    yield { error: { code: ERR_CONNECT_FAILED, message: errorMessage(e) } };
    return;
  }

  // Send the initial payload (same as unpooled streamWS on-open behavior).
  const payload: Record<string, unknown> = {};
  if (input.input !== undefined && typeof input.input === "object" && input.input !== null) {
    Object.assign(payload, input.input);
  }
  const bearerToken = input.context ? contextBearerToken(input.context) : undefined;
  if (bearerToken) {
    payload.bearerToken = bearerToken;
  }
  if (Object.keys(payload).length > 0) {
    pooled.send(JSON.stringify(payload));
  }

  const queue: StreamEvent[] = [];
  let resolve: (() => void) | undefined;
  let done = false;

  const removeMsg = pooled.onMessage((event) => {
    queue.push(event);
    resolve?.();
  });

  const removeClose = pooled.onClose(() => {
    done = true;
    resolve?.();
  });

  const onAbort = () => {
    done = true;
    resolve?.();
  };
  options?.signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (done) break;
      await new Promise<void>((r) => { resolve = r; });
    }
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
    removeMsg();
    removeClose();
    pooled.release();
  }
}

// ---------------------------------------------------------------------------
// Pooled WebSocket: send (fire-and-forget on shared connection)
// ---------------------------------------------------------------------------

async function* pooledSendWS(
  pool: WSPool,
  serverURL: string,
  address: string,
  input: BindingExecutionInput,
  options?: { signal?: AbortSignal },
): AsyncIterable<StreamEvent> {
  let pooled;
  try {
    pooled = await pool.acquire(serverURL, address);
  } catch (e: unknown) {
    yield { error: { code: ERR_CONNECT_FAILED, message: errorMessage(e) } };
    return;
  }

  try {
    const payload: Record<string, unknown> = {};
    if (input.input !== undefined && typeof input.input === "object" && input.input !== null) {
      Object.assign(payload, input.input);
    }
    pooled.send(JSON.stringify(payload));
  } finally {
    pooled.release();
  }
  // Fire-and-forget: no events to yield.
}

// ---------------------------------------------------------------------------
// Execute: HTTP Send (POST)
// ---------------------------------------------------------------------------

async function executeHTTPSend(
  serverURL: string,
  address: string,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  input: BindingExecutionInput,
  start: number,
  options?: { signal?: AbortSignal },
): Promise<ExecuteOutput> {
  let url = `${serverURL}/${address.replace(/^\/+/, "")}`;

  const body = input.input != null ? JSON.stringify(input.input) : "{}";

  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  const authQueryParams = applyContext(headers, doc, asyncOp, input.context, input.options);
  if (authQueryParams) {
    const sep = url.includes("?") ? "&" : "?";
    url += sep + new URLSearchParams(authQueryParams).toString();
  }

  const doFetch = input.fetch ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(url, { method: "POST", headers, body, signal: options?.signal });
  } catch (e: unknown) {
    return failedOutput(start, ERR_EXECUTION_FAILED, errorMessage(e));
  }

  const durationMs = Math.round(performance.now() - start);

  if (resp.status >= 400) {
    let errorBody: unknown;
    try {
      const text = await readResponseText(resp, MAX_RESPONSE_BYTES);
      if (text && maybeJSON(text)) {
        try { errorBody = JSON.parse(text); } catch { errorBody = text; }
      } else if (text) {
        errorBody = text;
      }
    } catch { /* ignore read errors on error responses */ }
    return {
      output: errorBody,
      status: resp.status,
      durationMs: Math.round(performance.now() - start),
      error: { code: httpErrorCode(resp.status), message: `HTTP ${resp.status} ${resp.statusText}` },
    };
  }

  if (resp.status === 202 || resp.status === 204) {
    return { status: resp.status, durationMs };
  }

  let respText: string;
  try {
    respText = await readResponseText(resp, MAX_RESPONSE_BYTES);
  } catch (e: unknown) {
    return failedOutput(start, ERR_RESPONSE_ERROR, errorMessage(e));
  }

  let output: unknown;
  if (respText.length > 0 && maybeJSON(respText)) {
    try {
      output = JSON.parse(respText);
    } catch {
      output = respText;
    }
  } else if (respText.length > 0) {
    output = respText;
  }

  return { output, status: resp.status, durationMs };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseSSEPayload(dataLines: string[]): unknown {
  const raw = dataLines.join("\n");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function readResponseText(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return resp.text();

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`response exceeds ${maxBytes} byte limit`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }

  return chunks.join("");
}

function failedOutput(startMs: number, code: string, message: string): ExecuteOutput {
  return {
    status: 1,
    durationMs: Math.round(performance.now() - startMs),
    error: { code, message },
  };
}

function httpErrorOutput(startMs: number, statusCode: number, statusText: string): ExecuteOutput {
  return {
    output: undefined,
    status: statusCode,
    durationMs: Math.round(performance.now() - startMs),
    error: {
      code: httpErrorCode(statusCode),
      message: `HTTP ${statusCode} ${statusText}`,
    },
  };
}

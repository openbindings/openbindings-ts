/**
 * AsyncAPI binding execution over the cardinality-agnostic invocation handle.
 *
 * One entrypoint ({@link runBinding}) drives every channel shape against the
 * binding-facing {@link BindingHandle}:
 *
 *   - send + http/https     unary HTTP POST: first input -> request body,
 *                           response -> single output
 *   - send + ws/wss         client-streaming publish: every input -> one
 *                           socket frame; closing input closes the call
 *   - receive + http/https  SSE subscribe: server events -> outputs
 *   - receive + ws/wss      WebSocket subscribe (bidi-capable): socket
 *                           frames -> outputs, caller inputs -> socket frames
 *
 * All pre-dispatch failures (bad ref, missing server, missing context) are
 * raised via `fireError` BEFORE any network I/O, per the binding-author
 * contract.
 */

import {
  InvocationError,
  contextRequiredError,
  contextSatisfies,
  normalizeEndpoint,
  maybeJSON,
  contextBearerToken,
  contextApiKey,
  contextBasicAuth,
  contextString,
  contextHeaders,
  contextCookies,
  contextMetadata,
  httpErrorCode,
  ERR_INVALID_REF,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_REF_NOT_FOUND,
  ERR_MISSING_INPUT,
  ERR_CONNECT_FAILED,
  ERR_RESPONSE_ERROR,
  ERR_STREAM_ERROR,
  type BindingHandle,
  type BindingInvocationArgs,
  type ContextAlternative,
  type ContextRequiredDetails,
  type Metadata,
} from "@openbindings/sdk";
import type {
  AsyncAPIDocument,
  AsyncAPIOperation,
  AsyncAPISecurityScheme,
} from "./asyncapi-types.js";
import { isSecurityScheme } from "./asyncapi-types.js";
import { parseRef, errorMessage } from "./util.js";
import type { PooledWS, WSPool } from "./ws-pool.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

type Handle = BindingHandle<unknown, unknown>;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Resolves the operation, checks runtime context, and dispatches to the
 * protocol-specific runner. Terminates the handle exactly once.
 */
export async function runBinding(
  args: BindingInvocationArgs,
  h: Handle,
  doc: AsyncAPIDocument,
  wsPool: WSPool,
): Promise<void> {
  let opID: string;
  try {
    opID = parseRef(args.ref);
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_INVALID_REF, errorMessage(e)));
    return;
  }

  const asyncOp = (doc.operations ?? {})[opID];
  if (!asyncOp) {
    h.fireError(
      new InvocationError(ERR_REF_NOT_FOUND, `operation "${opID}" not in AsyncAPI doc`),
    );
    return;
  }

  let serverURL: string;
  let protocol: string;
  try {
    ({ url: serverURL, protocol } = resolveServer(doc, args.context));
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e)));
    return;
  }

  // Context negotiation: challenge BEFORE any connection is opened.
  const required = requiredContext(doc, asyncOp, serverURL, args.context);
  if (required) {
    h.fireError(
      contextRequiredError(
        `operation "${opID}" requires credentials the context does not provide`,
        required,
      ),
    );
    return;
  }

  const address = asyncOp.channel?.address ?? "";

  switch (asyncOp.action) {
    case "receive":
      if (protocol === "ws" || protocol === "wss") {
        await runWSReceive(wsPool, serverURL, address, doc, asyncOp, args, h);
      } else if (protocol === "http" || protocol === "https") {
        await runSSEReceive(serverURL, address, doc, asyncOp, args, h);
      } else {
        h.fireError(
          new InvocationError(
            ERR_SOURCE_CONFIG_ERROR,
            `receive not supported for protocol "${protocol}" (supported: http, https, ws, wss)`,
          ),
        );
      }
      return;
    case "send":
      if (protocol === "ws" || protocol === "wss") {
        await runWSSend(wsPool, serverURL, address, doc, asyncOp, args, h);
      } else if (protocol === "http" || protocol === "https") {
        await runHTTPSend(serverURL, address, doc, asyncOp, args, h);
      } else {
        h.fireError(
          new InvocationError(
            ERR_SOURCE_CONFIG_ERROR,
            `send not supported for protocol "${protocol}" (supported: http, https, ws, wss)`,
          ),
        );
      }
      return;
    default:
      h.fireError(
        new InvocationError(
          ERR_SOURCE_CONFIG_ERROR,
          `unknown action "${(asyncOp as { action: string }).action}"`,
        ),
      );
  }
}

// ---------------------------------------------------------------------------
// Server resolution
// ---------------------------------------------------------------------------

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

export function resolveServer(
  doc: AsyncAPIDocument,
  ctx?: Record<string, unknown>,
): { url: string; protocol: string } {
  const meta = contextMetadata(ctx);
  if (meta["baseURL"]) {
    const base = String(meta["baseURL"]);
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
// Context requirements (CONTEXT_REQUIRED negotiation)
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

/** Maps an AsyncAPI security scheme to a standard requirement family, or null when unknown. */
function requirementType(scheme: AsyncAPISecurityScheme): string | null {
  switch (scheme.type) {
    case "http": {
      const s = (scheme.scheme ?? "").toLowerCase();
      if (s === "bearer") return "auth.bearer";
      if (s === "basic") return "auth.basic";
      return null;
    }
    case "httpBearer":
      return "auth.bearer";
    case "userPassword":
      return "auth.basic";
    case "apiKey":
    case "httpApiKey":
      return "auth.apiKey";
    case "oauth2":
      return "auth.oauth2";
    default:
      return null;
  }
}

/**
 * Computes the context the binding requires for this operation, or null when
 * the provided context already satisfies it (or the doc declares nothing
 * checkable). Side-effect-free; shared by runBinding and prepareBinding.
 */
export function requiredContext(
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  serverURL: string,
  ctx?: Record<string, unknown>,
): ContextRequiredDetails | null {
  const schemes = resolveSecuritySchemes(doc, asyncOp);
  const alternatives: ContextAlternative[] = [];
  for (const scheme of schemes) {
    const type = requirementType(scheme);
    if (!type) continue; // unknown scheme family: not checkable, not enforced
    const requirement: ContextAlternative["requirements"][number] = { type };
    if (scheme.description) requirement.description = scheme.description;
    alternatives.push({ requirements: [requirement] });
  }
  if (alternatives.length === 0) return null;

  const details: ContextRequiredDetails = {
    key: normalizeEndpoint(serverURL),
    alternatives,
  };
  if (ctx && contextSatisfies(ctx, details)) return null;
  return details;
}

// ---------------------------------------------------------------------------
// Credential application
// ---------------------------------------------------------------------------

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
      case "oauth2": {
        const token = contextBearerToken(ctx) || contextString(ctx, "accessToken");
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
): Record<string, string> | undefined {
  let queryParams: Record<string, string> | undefined;

  if (ctx) {
    const result = applyCredentialsViaSchemes(headers, doc, asyncOp, ctx);
    if (!result.applied) {
      applyCredentialsFallback(headers, ctx);
    }
    queryParams = result.queryParams;
    for (const [k, v] of Object.entries(contextHeaders(ctx))) {
      headers.set(k, v);
    }
    const cookies = contextCookies(ctx);
    const parts: string[] = [];
    for (const [k, v] of Object.entries(cookies)) {
      parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    if (parts.length > 0) {
      headers.append("Cookie", parts.join("; "));
    }
  }

  return queryParams;
}

// ---------------------------------------------------------------------------
// Receive over HTTP: SSE subscribe
// ---------------------------------------------------------------------------

async function runSSEReceive(
  serverURL: string,
  address: string,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  args: BindingInvocationArgs,
  h: Handle,
): Promise<void> {
  // Server -> client: the channel takes no caller input.
  void h.closeInput();

  let url = `${serverURL}/${address.replace(/^\/+/, "")}`;
  const headers = new Headers({ Accept: "text/event-stream" });
  const authQueryParams = applyContext(headers, doc, asyncOp, args.context);
  if (authQueryParams) {
    const sep = url.includes("?") ? "&" : "?";
    url += sep + new URLSearchParams(authQueryParams).toString();
  }

  const doFetch = args.fetch ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(url, { headers, signal: h.signal });
  } catch (e: unknown) {
    if (h.signal.aborted) return; // cancellation is already terminal
    h.fireError(new InvocationError(ERR_CONNECT_FAILED, errorMessage(e)));
    return;
  }

  if (resp.status < 200 || resp.status >= 300) {
    const body = await readErrorBody(resp);
    h.fireError(
      new InvocationError(
        httpErrorCode(resp.status),
        `HTTP ${resp.status} ${resp.statusText}`,
        { status: resp.status, body },
      ),
    );
    return;
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    h.fireError(new InvocationError(ERR_CONNECT_FAILED, "no response body"));
    return;
  }

  h.setHeader(headersToMetadata(resp.headers));

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
        h.fireError(
          new InvocationError(
            ERR_RESPONSE_ERROR,
            `SSE stream exceeds ${MAX_RESPONSE_BYTES} byte limit`,
          ),
        );
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
          // Throws if the invocation terminated while parked: stop reading.
          await h.emitOutput(parseSSEPayload(dataLines));
          dataLines = [];
        }
      }
    }

    if (dataLines.length > 0) {
      await h.emitOutput(parseSSEPayload(dataLines));
    }
    h.closeOutput();
  } catch (e: unknown) {
    // emitOutput rethrows the terminal error (fireError is then a no-op);
    // anything else is a genuine mid-stream failure.
    h.fireError(
      e instanceof InvocationError
        ? e
        : new InvocationError(ERR_STREAM_ERROR, errorMessage(e)),
    );
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Send over HTTP: unary POST
// ---------------------------------------------------------------------------

async function runHTTPSend(
  serverURL: string,
  address: string,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  args: BindingInvocationArgs,
  h: Handle,
): Promise<void> {
  // Unary: the first input is the message payload.
  const first = await readFirstInput(h);
  if (!first.ok) {
    h.fireError(
      new InvocationError(ERR_MISSING_INPUT, "send operation requires an input message"),
    );
    return;
  }
  void h.closeInput();

  let url = `${serverURL}/${address.replace(/^\/+/, "")}`;
  const body = first.value != null ? JSON.stringify(first.value) : "{}";

  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  const authQueryParams = applyContext(headers, doc, asyncOp, args.context);
  if (authQueryParams) {
    const sep = url.includes("?") ? "&" : "?";
    url += sep + new URLSearchParams(authQueryParams).toString();
  }

  const doFetch = args.fetch ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(url, { method: "POST", headers, body, signal: h.signal });
  } catch (e: unknown) {
    if (h.signal.aborted) return;
    h.fireError(new InvocationError(ERR_CONNECT_FAILED, errorMessage(e)));
    return;
  }

  if (resp.status >= 400) {
    const errBody = await readErrorBody(resp);
    h.fireError(
      new InvocationError(
        httpErrorCode(resp.status),
        `HTTP ${resp.status} ${resp.statusText}`,
        { status: resp.status, body: errBody },
      ),
    );
    return;
  }

  h.setHeader(headersToMetadata(resp.headers));

  if (resp.status === 202 || resp.status === 204) {
    // Accepted with no payload: a publish acknowledgment, not an output.
    h.closeOutput();
    return;
  }

  let respText: string;
  try {
    respText = await readResponseText(resp, MAX_RESPONSE_BYTES);
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_RESPONSE_ERROR, errorMessage(e)));
    return;
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

  if (output !== undefined) await h.emitOutput(output);
  h.closeOutput();
}

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

type WSFrame =
  | { kind: "output"; value: unknown }
  | { kind: "error"; error: unknown; message: string };

/**
 * Interprets one socket frame. `{error}` frames are terminal stream errors;
 * `{data}` frames unwrap to the payload; everything else passes through.
 */
function parseWSFrame(raw: string): WSFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "output", value: raw };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj["error"]) {
      const err = obj["error"];
      const message =
        err && typeof err === "object" &&
        typeof (err as Record<string, unknown>)["message"] === "string"
          ? ((err as Record<string, unknown>)["message"] as string)
          : "server reported an error";
      return { kind: "error", error: err, message };
    }
    if (obj["data"] !== undefined) {
      return { kind: "output", value: obj["data"] };
    }
  }
  return { kind: "output", value: parsed };
}

function buildWSURL(
  serverURL: string,
  address: string,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  ctx?: Record<string, unknown>,
): string {
  const url = new URL(`/${address.replace(/^\/+/, "")}`, serverURL);
  // Apply query-param credentials (e.g. apiKey in query) to the WebSocket URL.
  // Browser WebSocket cannot set handshake headers, so header-based auth is
  // handled via the first-frame bearer convention instead.
  const tempHeaders = new Headers();
  const authQueryParams = applyContext(tempHeaders, doc, asyncOp, ctx);
  if (authQueryParams) {
    for (const [k, v] of Object.entries(authQueryParams)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Receive over WebSocket: subscribe (bidi-capable) on a pooled socket
// ---------------------------------------------------------------------------

async function runWSReceive(
  pool: WSPool,
  serverURL: string,
  address: string,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  args: BindingInvocationArgs,
  h: Handle,
): Promise<void> {
  let pooled: PooledWS;
  try {
    pooled = await pool.acquire(serverURL, address, {
      buildURL: (base, addr) => buildWSURL(base, addr, doc, asyncOp, args.context),
      signal: h.signal,
    });
  } catch (e: unknown) {
    if (h.signal.aborted) return;
    h.fireError(new InvocationError(ERR_CONNECT_FAILED, errorMessage(e)));
    return;
  }

  // First-frame bearer convention: browsers cannot set headers on WebSocket
  // upgrades, so the token travels in the first message body.
  const bearer = contextBearerToken(args.context);
  if (bearer) pooled.send(JSON.stringify({ bearerToken: bearer }));

  const frames: WSFrame[] = [];
  let socketClosed = false;
  let socketError: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();

  const removeMsg = pooled.onMessage((data) => {
    frames.push(parseWSFrame(data));
    notify();
  });
  const removeClose = pooled.onClose((err) => {
    socketClosed = true;
    socketError = err;
    notify();
  });
  const onAbort = () => notify();
  h.signal.addEventListener("abort", onAbort);

  // Socket -> outputs. Owns the terminal transition.
  const outputPump = async (): Promise<void> => {
    while (true) {
      while (frames.length > 0) {
        const frame = frames.shift()!;
        if (frame.kind === "error") {
          h.fireError(new InvocationError(ERR_STREAM_ERROR, frame.message, { error: frame.error }));
          return;
        }
        // Throws if the invocation terminated while parked: stop emitting.
        await h.emitOutput(frame.value);
      }
      if (h.signal.aborted) return;
      if (socketClosed) {
        if (socketError) {
          h.fireError(new InvocationError(ERR_STREAM_ERROR, socketError.message));
        } else {
          h.closeOutput();
        }
        return;
      }
      await new Promise<void>((r) => {
        wake = r;
      });
      wake = undefined;
    }
  };

  // Inputs -> socket. Lets callers push subscription/control frames; closing
  // input does NOT end the subscription (outputs keep flowing).
  const inputPump = async (): Promise<void> => {
    try {
      for await (const msg of h.inputs()) {
        pooled.send(JSON.stringify(msg));
      }
    } catch {
      // Invocation terminated; the output pump owns the terminal transition.
    }
  };

  try {
    await Promise.all([
      outputPump().catch((e: unknown) => {
        h.fireError(
          e instanceof InvocationError
            ? e
            : new InvocationError(ERR_STREAM_ERROR, errorMessage(e)),
        );
      }),
      inputPump(),
    ]);
  } finally {
    h.signal.removeEventListener("abort", onAbort);
    removeMsg();
    removeClose();
    pooled.release();
  }
}

// ---------------------------------------------------------------------------
// Send over WebSocket: client-streaming publish on a pooled socket
// ---------------------------------------------------------------------------

async function runWSSend(
  pool: WSPool,
  serverURL: string,
  address: string,
  doc: AsyncAPIDocument,
  asyncOp: AsyncAPIOperation,
  args: BindingInvocationArgs,
  h: Handle,
): Promise<void> {
  let pooled: PooledWS;
  try {
    pooled = await pool.acquire(serverURL, address, {
      buildURL: (base, addr) => buildWSURL(base, addr, doc, asyncOp, args.context),
      signal: h.signal,
    });
  } catch (e: unknown) {
    if (h.signal.aborted) return;
    h.fireError(new InvocationError(ERR_CONNECT_FAILED, errorMessage(e)));
    return;
  }

  try {
    // Every input is one frame; the loop ends cleanly when the caller closes
    // input, and throws if the invocation terminates.
    for await (const msg of h.inputs()) {
      pooled.send(JSON.stringify(msg));
    }
    h.closeOutput();
  } catch (e: unknown) {
    h.fireError(
      e instanceof InvocationError
        ? e
        : new InvocationError(ERR_STREAM_ERROR, errorMessage(e)),
    );
  } finally {
    pooled.release();
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function readFirstInput(
  h: Handle,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  for await (const v of h.inputs()) {
    return { ok: true, value: v };
  }
  return { ok: false };
}

function headersToMetadata(headers: Headers): Metadata {
  const md: Metadata = {};
  headers.forEach((value, key) => {
    md[key] = [value];
  });
  return md;
}

function parseSSEPayload(dataLines: string[]): unknown {
  const raw = dataLines.join("\n");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function readErrorBody(resp: Response): Promise<unknown> {
  try {
    const text = await readResponseText(resp, MAX_RESPONSE_BYTES);
    if (!text) return undefined;
    if (maybeJSON(text)) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  } catch {
    return undefined;
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

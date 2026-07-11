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
  isJSONContentType,
  decodeThroughHooks,
  USE_DEFAULT,
  type InvokeHooks,
  type InvokeSite,
  type OutputDecoder,
  type RawResult,
} from "@openbindings/sdk";
import type {
  AsyncAPIDocument,
  AsyncAPIOperation,
  AsyncAPISecurityScheme,
  AsyncAPIServer,
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
  let server: AsyncAPIServer | undefined;
  try {
    ({ url: serverURL, protocol, server } = resolveServer(doc, args.context));
  } catch (e: unknown) {
    h.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR, errorMessage(e)));
    return;
  }

  // Context negotiation: challenge BEFORE any connection is opened.
  // Requirements derive from the SAME server the connection targets.
  const required = requiredContext(asyncOp, server, serverURL, args.context);
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

  const defaultContentType = doc.defaultContentType ?? "";

  switch (asyncOp.action) {
    case "receive":
      if (protocol === "ws" || protocol === "wss") {
        await runWSReceive(wsPool, serverURL, address, asyncOp, server, args, h, defaultContentType);
      } else if (protocol === "http" || protocol === "https") {
        await runSSEReceive(serverURL, address, asyncOp, server, args, h, defaultContentType);
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
        await runWSSend(wsPool, serverURL, address, asyncOp, server, args, h);
      } else if (protocol === "http" || protocol === "https") {
        await runHTTPSend(serverURL, address, asyncOp, server, args, h, defaultContentType);
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

function pickDocServer(
  doc: AsyncAPIDocument,
): { url: string; protocol: string; server: AsyncAPIServer } | null {
  const servers = doc.servers ?? {};
  // Sort by id for deterministic selection
  const sorted = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b));
  for (const [, server] of sorted) {
    const proto = server.protocol.toLowerCase();
    if (SUPPORTED_PROTOCOLS.has(proto)) {
      let url = `${proto}://${server.host}`;
      const pathname = server.pathname;
      if (pathname) url += pathname;
      return { url, protocol: proto, server };
    }
  }
  return null;
}

/**
 * Resolves the server the connection targets. `server` is the selected
 * document server — the single source of server-level security for this
 * invocation. With a `baseURL` context override the connection goes to the
 * override, but the document's selected server still supplies the security
 * model (undefined when the document declares no supported server).
 */
export function resolveServer(
  doc: AsyncAPIDocument,
  ctx?: Record<string, unknown>,
): { url: string; protocol: string; server: AsyncAPIServer | undefined } {
  const meta = contextMetadata(ctx);
  if (meta["baseURL"]) {
    const base = String(meta["baseURL"]);
    let proto = "http";
    if (base.startsWith("https://")) proto = "https";
    else if (base.startsWith("wss://")) proto = "wss";
    else if (base.startsWith("ws://")) proto = "ws";
    return {
      url: base.replace(/\/+$/, ""),
      protocol: proto,
      server: pickDocServer(doc)?.server,
    };
  }

  const picked = pickDocServer(doc);
  if (!picked) throw new Error("no supported server found (need http, https, ws, or wss protocol)");
  return { url: picked.url.replace(/\/+$/, ""), protocol: picked.protocol, server: picked.server };
}

// ---------------------------------------------------------------------------
// Context requirements (CONTEXT_REQUIRED negotiation)
// ---------------------------------------------------------------------------

function resolveSecuritySchemes(
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
): AsyncAPISecurityScheme[] {
  // Operation-level security overrides server-level.
  // After dereference, security items are resolved scheme objects.
  const opSecurity = asyncOp.security;
  if (opSecurity && opSecurity.length > 0) {
    return opSecurity.filter(isSecurityScheme);
  }

  // Fall back to the security of the server the connection targets —
  // never to some other server's declaration.
  return (server?.security ?? []).filter(isSecurityScheme);
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
 * checkable). `server` is the server the connection logic picked — its
 * security (not some other server's) backs the operation-level fallback.
 * Side-effect-free; shared by runBinding and prepareBinding.
 */
export function requiredContext(
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  serverURL: string,
  ctx?: Record<string, unknown>,
): ContextRequiredDetails | null {
  const schemes = resolveSecuritySchemes(asyncOp, server);
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
    target: serverURL,
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
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  ctx: Record<string, unknown>,
): { applied: boolean; queryParams?: Record<string, string> } {
  const schemes = resolveSecuritySchemes(asyncOp, server);
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
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  ctx?: Record<string, unknown>,
): Record<string, string> | undefined {
  let queryParams: Record<string, string> | undefined;

  if (ctx) {
    const result = applyCredentialsViaSchemes(headers, asyncOp, server, ctx);
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
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  args: BindingInvocationArgs,
  h: Handle,
  defaultContentType: string,
): Promise<void> {
  // Server -> client: the channel takes no caller input.
  void h.closeInput();

  let url = `${serverURL}/${address.replace(/^\/+/, "")}`;
  const headers = new Headers({ Accept: "text/event-stream" });
  const authQueryParams = applyContext(headers, asyncOp, server, args.context);
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
  const encoder = new TextEncoder();
  let buffer = "";
  let dataLines: string[] = [];
  // The size cap is PER EVENT, not cumulative: a long-lived subscription
  // legitimately streams more than MAX_RESPONSE_BYTES in total (the same
  // choice the Go SDK's runSSEReceive documents, and connect/streaming.go's
  // per-envelope cap). eventBytes resets at every event boundary (blank
  // line), mirroring the Go SDK's scanner-driven accounting exactly.
  let eventBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        eventBytes += encoder.encode(line).length + 1; // +1 for the newline
        if (eventBytes > MAX_RESPONSE_BYTES) {
          h.fireError(
            new InvocationError(
              ERR_RESPONSE_ERROR,
              `SSE event exceeds ${MAX_RESPONSE_BYTES} byte limit`,
            ),
          );
          return;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
          continue;
        }
        if (line === "") {
          eventBytes = 0;
          if (dataLines.length > 0) {
            // Throws if the invocation terminated while parked: stop reading.
            await h.emitOutput(
              await decodeSSEEvent(args, serverURL, asyncOp, resp, dataLines, defaultContentType),
            );
            dataLines = [];
          }
        }
      }
    }

    if (dataLines.length > 0) {
      await h.emitOutput(
        await decodeSSEEvent(args, serverURL, asyncOp, resp, dataLines, defaultContentType),
      );
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
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  args: BindingInvocationArgs,
  h: Handle,
  defaultContentType: string,
): Promise<void> {
  // Unary: the first input is the message payload.
  let body: string;
  if (noInputDeclared(args)) {
    // Operation-layer no-input convention: the caller never writes nor
    // closes. Close input on entry and send one empty-object message.
    void h.closeInput();
    body = "{}";
  } else {
    const first = await readFirstInput(h);
    if (!first.ok) {
      h.fireError(
        new InvocationError(ERR_MISSING_INPUT, "send operation requires an input message"),
      );
      return;
    }
    void h.closeInput();
    body = first.value != null ? JSON.stringify(first.value) : "{}";
  }

  let url = `${serverURL}/${address.replace(/^\/+/, "")}`;

  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  const authQueryParams = applyContext(headers, asyncOp, server, args.context);
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

  if (respText.length === 0) {
    h.closeOutput();
    return;
  }

  // Decode through the consultation seam — content-independent, per the
  // conventions record's recommended built-in defaults
  // (spec/formats/README.md): the operation's declared message contentType
  // decides the lane — JSON for application/json and +json suffixes (a
  // declared-JSON payload that fails to parse is loud), text otherwise.
  // Never sniffed.
  let output: unknown;
  try {
    output = await decodeThroughHooks(
      args.hooks,
      siteFor(args, serverURL),
      { status: resp.status, body: respText, meta: headersToMetadata(resp.headers) },
      builtinDecodeFor(declaredContentType(asyncOp, defaultContentType)),
    );
  } catch (e: unknown) {
    h.fireError(toInvocationError(e));
    return;
  }

  // Success provenance stamps (per the conventions record's recommended
  // built-in defaults, spec/formats/README.md): decode is
  // spec/content-type (the message's declared contentType decides the
  // lane), hook when overridden; classify is not-consulted (asyncapi runs
  // no result classifier — the HTTP status guard above is transport, not
  // a format verdict).
  h.setTrailer(decodeTrailer(args.hooks, "spec/content-type"));
  await h.emitOutput(output);
  h.closeOutput();
}

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

function buildWSURL(
  serverURL: string,
  address: string,
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  ctx?: Record<string, unknown>,
): string {
  const url = new URL(`/${address.replace(/^\/+/, "")}`, serverURL);
  // Apply query-param credentials (e.g. apiKey in query) to the WebSocket URL.
  // Browser WebSocket cannot set handshake headers, so header-based auth is
  // handled via the first-frame bearer convention instead.
  const tempHeaders = new Headers();
  const authQueryParams = applyContext(tempHeaders, asyncOp, server, ctx);
  if (authQueryParams) {
    for (const [k, v] of Object.entries(authQueryParams)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// WebSocket connection-pool credential partitioning
// ---------------------------------------------------------------------------

/** One FNV-1a (32-bit) pass over `str`, seeded, returned as an unsigned int. */
function fnv1a(str: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Fingerprints the credential identity a WebSocket dial for this operation
 * would use: the same header names/values and query params
 * `applyContext`/`buildWSURL` would place on the connection, plus the
 * first-frame bearer token (which authenticates the connection itself even
 * when no scheme places it on the upgrade request or query — see
 * `sendFirstFrameBearer`). A digest — not the raw material — feeds the pool
 * key, mirroring the Go SDK's `credentialDigest`: two invocations whose
 * fingerprints differ must never share a pooled connection (cross-tenant
 * credential leak).
 *
 * Non-cryptographic by design: two 32-bit FNV-1a passes with distinct seeds
 * give a 64-bit digest, which is plenty for a pool-key partition function
 * (the realistic collision surface is auth material containing
 * high-entropy tokens, not an adversary crafting collisions). This avoids a
 * `globalThis.crypto.subtle` dependency, which is not guaranteed available
 * without a flag on this package's minimum supported Node (18).
 */
function credentialFingerprint(
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  ctx?: Record<string, unknown>,
): string {
  const headers = new Headers();
  const queryParams = applyContext(headers, asyncOp, server, ctx);
  const headerParts: string[] = [];
  headers.forEach((value, name) => {
    headerParts.push(`h:${name}=${value}`);
  });
  headerParts.sort();
  const parts: string[] = [...headerParts];
  if (queryParams) {
    for (const key of Object.keys(queryParams).sort()) {
      parts.push(`q:${key}=${queryParams[key]}`);
    }
  }
  const bearer = contextBearerToken(ctx);
  if (bearer) parts.push(`b:${bearer}`);
  const material = parts.join(" ");
  const a = fnv1a(material, 0x811c9dc5);
  const b = fnv1a(material, 0x9e3779b9);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * True when the resolved security declares a bearer-family scheme (HTTP
 * bearer, httpBearer, or an OAuth2 access token presented as a bearer).
 * Gates the first-frame bearer convention: the `{bearerToken}` frame is
 * only sent to servers that declare they expect one.
 */
function declaresBearerScheme(
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
): boolean {
  return resolveSecuritySchemes(asyncOp, server).some((s) => {
    if (s.type === "httpBearer" || s.type === "oauth2") return true;
    return s.type === "http" && (s.scheme ?? "").toLowerCase() === "bearer";
  });
}

/**
 * First-frame bearer convention: browsers cannot set headers on WebSocket
 * upgrades, so the token travels in the first message body — once per
 * CONNECTION (a reused pooled socket must not re-authenticate per
 * invocation), and only when the resolved security declares a
 * bearer-family scheme.
 */
function sendFirstFrameBearer(
  pooled: PooledWS,
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  ctx?: Record<string, unknown>,
): void {
  const bearer = contextBearerToken(ctx);
  if (!bearer || !declaresBearerScheme(asyncOp, server)) return;
  if (!pooled.once("first-frame-bearer")) return;
  pooled.send(JSON.stringify({ bearerToken: bearer }));
}

/** Operation-layer no-input convention: binding populated, no input schema. */
function noInputDeclared(args: BindingInvocationArgs): boolean {
  return args.binding !== undefined && args.inputSchema === undefined;
}

// ---------------------------------------------------------------------------
// Receive over WebSocket: subscribe (bidi-capable) on a pooled socket
// ---------------------------------------------------------------------------

/**
 * Backpressure bounds for the undelivered-frame buffer between the socket
 * and the output pump: whichever bound trips first fails the stream
 * (bounded-queue-fail-loud, per spec/formats/asyncapi.md's WS slow-consumer
 * ruling — Redis client-output-buffer-limit, NATS slow-consumer, and MQTT
 * max_queued_messages are the pub/sub-ecosystem precedent, and NATS pairs a
 * count bound with a byte bound the same way). The handle's bounded output
 * buffer IS the backpressure contract for a draining consumer; an unbounded
 * second buffer here would defeat it for a non-draining one, so overflow
 * fails the stream and closes the socket instead. Reference-package
 * defaults, not spec-mandated numbers.
 *
 * `let`, not `const`: setBackpressureBoundsForTest lowers these for a test
 * instead of pushing the full frame count / byte volume through a real
 * socket. This module is never re-exported from index.ts, so the mutable
 * bindings are intra-package only, not part of the public API.
 */
let MAX_BUFFERED_FRAMES = 1024;
let MAX_BUFFERED_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * Test-only seam: lowers the WS receive backpressure bounds so overflow
 * tests can trip them deterministically without pushing the full volume
 * through a real socket. Returns a restore function.
 */
export function setBackpressureBoundsForTest(frames: number, bytes: number): () => void {
  const prevFrames = MAX_BUFFERED_FRAMES;
  const prevBytes = MAX_BUFFERED_BYTES;
  MAX_BUFFERED_FRAMES = frames;
  MAX_BUFFERED_BYTES = bytes;
  return () => {
    MAX_BUFFERED_FRAMES = prevFrames;
    MAX_BUFFERED_BYTES = prevBytes;
  };
}

async function runWSReceive(
  pool: WSPool,
  serverURL: string,
  address: string,
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  args: BindingInvocationArgs,
  h: Handle,
  defaultContentType: string,
): Promise<void> {
  let pooled: PooledWS;
  try {
    pooled = await pool.acquire(serverURL, address, {
      buildURL: (base, addr) => buildWSURL(base, addr, asyncOp, server, args.context),
      credentialKey: credentialFingerprint(asyncOp, server, args.context),
      signal: h.signal,
    });
  } catch (e: unknown) {
    if (h.signal.aborted) return;
    h.fireError(new InvocationError(ERR_CONNECT_FAILED, errorMessage(e)));
    return;
  }

  const frames: string[] = [];
  // Parallel to `frames`: the byte length of each still-buffered frame, so
  // the running bufferedBytes total can be decremented in the output pump
  // without re-encoding the frame just to measure it again.
  const frameByteLengths: number[] = [];
  let bufferedBytes = 0;
  let overflowed = false;
  let overflowMessage = "";
  let socketClosed = false;
  let socketError: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  const byteEncoder = new TextEncoder();

  const removeMsg = pooled.onMessage((data) => {
    if (overflowed) return;
    const frameBytes = byteEncoder.encode(data).length;
    if (frames.length >= MAX_BUFFERED_FRAMES) {
      overflowed = true;
      overflowMessage = `backpressure overflow: more than ${MAX_BUFFERED_FRAMES} undelivered frames`;
    } else if (bufferedBytes + frameBytes > MAX_BUFFERED_BYTES) {
      overflowed = true;
      overflowMessage = `backpressure overflow: more than ${MAX_BUFFERED_BYTES} undelivered bytes`;
    }
    if (overflowed) {
      // The consumer is not draining; stop buffering for THIS subscription
      // (the guard above drops further frames) and let the output pump fail
      // the stream after draining what's already buffered. The socket stays
      // open — it is shared with any sibling subscriptions (the pool is
      // ref-counted), so a slow consumer must never tear it down under
      // them; this listener detaches when the pump's terminal returns
      // through the finally below. Mirrors Go's wsSubscription overflow.
      notify();
      return;
    }
    frames.push(data);
    frameByteLengths.push(frameBytes);
    bufferedBytes += frameBytes;
    notify();
  });
  const removeClose = pooled.onClose((err) => {
    socketClosed = true;
    socketError = err;
    notify();
  });
  const onAbort = () => notify();
  h.signal.addEventListener("abort", onAbort);

  // Socket -> outputs. Owns the terminal transition. Each frame is one
  // delivery unit decoded through the consultation seam by the declared
  // message contentType (status null — a WS frame has no completion
  // status; never fabricated). Convention envelopes ({error}/{data}
  // unwrapping) are consumer knowledge: a decode hook's job, never the
  // builtin's.
  const wsContentType = declaredContentType(asyncOp, defaultContentType);
  const wsSite = siteFor(args, serverURL);
  const outputPump = async (): Promise<void> => {
    while (true) {
      // Drain-before-terminal: unconditionally, regardless of `overflowed`
      // — a synchronous flood of incoming messages can set `overflowed`
      // before this pump ever gets a turn, and every frame already
      // buffered by then must still reach the consumer before the
      // terminal error does (matches the decode-error and socket-closed
      // paths below, and the Go SDK's wsSubscription.next).
      while (frames.length > 0) {
        const frame = frames.shift()!;
        bufferedBytes -= frameByteLengths.shift()!;
        let out: unknown;
        try {
          out = await decodeThroughHooks(
            args.hooks,
            wsSite,
            { status: null, body: frame, meta: {} },
            builtinDecodeFor(wsContentType),
          );
        } catch (e: unknown) {
          // A decode error mid-stream is terminal; already-emitted
          // outputs stand (drain-before-terminal).
          h.fireError(toInvocationError(e));
          return;
        }
        // Throws if the invocation terminated while parked: stop emitting.
        await h.emitOutput(out);
      }
      if (overflowed) {
        h.fireError(new InvocationError(ERR_STREAM_ERROR, overflowMessage));
        return;
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
    // sendFirstFrameBearer may throw on a dead socket (pooled.send throws
    // when the socket is not open), before either pump owns the terminal.
    // Catch it here — mirroring runWSSend — so the terminal is a meaningful
    // ERR_STREAM_ERROR, not the invoker's generic ERR_RUNTIME fallback.
    sendFirstFrameBearer(pooled, asyncOp, server, args.context);
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
  } catch (e: unknown) {
    h.fireError(
      e instanceof InvocationError
        ? e
        : new InvocationError(ERR_STREAM_ERROR, errorMessage(e)),
    );
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
  asyncOp: AsyncAPIOperation,
  server: AsyncAPIServer | undefined,
  args: BindingInvocationArgs,
  h: Handle,
): Promise<void> {
  let pooled: PooledWS;
  try {
    pooled = await pool.acquire(serverURL, address, {
      buildURL: (base, addr) => buildWSURL(base, addr, asyncOp, server, args.context),
      credentialKey: credentialFingerprint(asyncOp, server, args.context),
      signal: h.signal,
    });
  } catch (e: unknown) {
    if (h.signal.aborted) return;
    h.fireError(new InvocationError(ERR_CONNECT_FAILED, errorMessage(e)));
    return;
  }

  // A socket that dies mid-stream must fail the publish, not silently
  // swallow frames and then close as success. The terminal also rejects
  // any caller write parked on the input channel.
  const removeClose = pooled.onClose((err) => {
    h.fireError(
      new InvocationError(
        ERR_STREAM_ERROR,
        err ? `socket failed mid-publish: ${err.message}` : "socket closed mid-publish",
      ),
    );
  });

  try {
    // Deliberately NO sendFirstFrameBearer here: the first-frame bearer
    // convention is a `receive`-subscription convention only. Auth never
    // rides `send` message bodies — mirrors the Go SDK's runWSSend, and the
    // conventions doc (spec/formats/asyncapi.md): "auth never rides send
    // message bodies."
    if (noInputDeclared(args)) {
      // Operation-layer no-input convention: the caller never writes nor
      // closes. Close input on entry and publish one empty-object message.
      void h.closeInput();
      pooled.send(JSON.stringify({}));
    } else {
      // Every input is one frame; the loop ends cleanly when the caller
      // closes input, and throws if the invocation terminates. `send`
      // throws on a dead socket, so no frame is ever silently dropped.
      for await (const msg of h.inputs()) {
        pooled.send(JSON.stringify(msg));
      }
    }
    h.closeOutput();
  } catch (e: unknown) {
    h.fireError(
      e instanceof InvocationError
        ? e
        : new InvocationError(ERR_STREAM_ERROR, errorMessage(e)),
    );
  } finally {
    removeClose();
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

async function readErrorBody(resp: Response): Promise<unknown> {
  // The raw capture, verbatim (details are diagnostics, never a decoded
  // value — no sniffing on the failure path either).
  try {
    const text = await readResponseText(resp, MAX_RESPONSE_BYTES);
    return text || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The consultation seam's format half
// ---------------------------------------------------------------------------

/**
 * Returns the operation's declared message contentType — the SPEC'S answer
 * to the decode question, when the document gives one. Walks the
 * operation's messages, then its reply messages, then falls back to the
 * document's `defaultContentType` (spec/formats/asyncapi.md: "the declared
 * message contentType decides (operation messages, then reply messages,
 * then the document's defaultContentType)"); "" when nothing declares.
 */
function declaredContentType(
  asyncOp: AsyncAPIOperation | undefined,
  defaultContentType: string,
): string {
  for (const m of asyncOp?.messages ?? []) {
    if (m.contentType) return m.contentType;
  }
  for (const m of asyncOp?.reply?.messages ?? []) {
    if (m.contentType) return m.contentType;
  }
  return defaultContentType;
}

/**
 * Returns the builtin decoder for a declared message contentType: strict
 * JSON for application/json and +json suffixes (a declared-JSON payload
 * that fails to parse is loud), text otherwise; an empty body is a null
 * output. Content-independent — the declaration decides, never the bytes.
 */
export function builtinDecodeFor(contentType: string): OutputDecoder {
  const isJSON = isJSONContentType(contentType);
  return (_site: InvokeSite, raw: RawResult): unknown => {
    if (raw.body.length === 0) return null;
    if (isJSON) {
      try {
        return JSON.parse(raw.body);
      } catch (e: unknown) {
        throw new InvocationError(
          ERR_RESPONSE_ERROR,
          `message declares ${JSON.stringify(contentType)} but the payload is not valid JSON: ${errorMessage(e)}`,
        );
      }
    }
    return raw.body;
  };
}

/** Decodes one SSE event through the consultation seam. */
async function decodeSSEEvent(
  args: BindingInvocationArgs,
  serverURL: string,
  asyncOp: AsyncAPIOperation,
  resp: Response,
  dataLines: string[],
  defaultContentType: string,
): Promise<unknown> {
  const raw: RawResult = {
    status: resp.status,
    body: dataLines.join("\n"),
    meta: headersToMetadata(resp.headers),
  };
  return decodeThroughHooks(
    args.hooks,
    siteFor(args, serverURL),
    raw,
    builtinDecodeFor(declaredContentType(asyncOp, defaultContentType)),
  );
}

/**
 * Completes the site for one dispatch with the format-known target (the
 * resolved server URL). A missing site (direct format-package call) gets a
 * minimal one so hook tables keyed on format/ref still match.
 */
function siteFor(args: BindingInvocationArgs, serverURL: string): InvokeSite {
  const site: InvokeSite = args.site
    ? { ...args.site }
    : {
        operation: args.binding?.operation ?? "",
        invokedAs: args.binding?.operation ?? "",
        bindingKey: "",
        format: args.source.format,
        ref: args.ref,
        target: "",
      };
  if (site.target === "") site.target = serverURL;
  return site;
}

/**
 * Builds the x-ob-decode stamp (and the fixed x-ob-classify not-consulted
 * stamp — asyncapi runs no classifier) for a successful message decode,
 * given the builtin decode provenance token, per the conventions record's
 * recommended built-in defaults (spec/formats/README.md).
 */
function decodeTrailer(hooks: InvokeHooks | null | undefined, builtinDecode: string): Metadata {
  const decode = hooks?.decodeDecidedBy() === "hook" ? "hook" : builtinDecode;
  return { "x-ob-decode": [decode], "x-ob-classify": ["not-consulted"] };
}

/** Converts a seam failure into the terminal InvocationError to surface. */
function toInvocationError(e: unknown): InvocationError {
  if (e instanceof InvocationError) return e;
  return new InvocationError(ERR_RESPONSE_ERROR, errorMessage(e));
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

import type { Effects, Metadata } from "@openbindings/sdk";
import {
  DEFAULT_MAX_DELIVERY_UNIT_BYTES,
  ERR_AUTH_REQUIRED,
  ERR_CONNECT_FAILED,
  ERR_EXECUTION_FAILED,
  ERR_PERMISSION_DENIED,
  ERR_RESPONSE_ERROR,
  ERR_STREAM_ERROR,
  InvocationError,
  httpErrorCode,
  httpErrorEffects,
} from "@openbindings/sdk";
import type { Field, IntrospectionSchema } from "./introspection.js";
import { rootTypeName, INTROSPECTION_QUERY } from "./introspection.js";
import type { DocumentConfiguration, GraphQLWebSocketFactory } from "./configuration.js";

// ---------------------------------------------------------------------------
// Ref parsing
// ---------------------------------------------------------------------------

/** Parse an exact openbindings.graphql@1 ref. */
export function parseRef(ref: string): { rootType: string; fieldName: string } {
  const idx = ref.indexOf("/");
  if (idx < 0 || idx === 0 || idx === ref.length - 1 || ref.indexOf("/", idx + 1) >= 0) {
    throw new Error(`GraphQL ref "${ref}" must be in the form query/fieldName, mutation/fieldName, or subscription/fieldName`);
  }
  const rootType = ref.slice(0, idx);
  const fieldName = ref.slice(idx + 1);
  if (rootType !== "query" && rootType !== "mutation" && rootType !== "subscription") {
    throw new Error(`GraphQL ref "${ref}" has invalid operation kind "${rootType}" (must be query, mutation, or subscription)`);
  }
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(fieldName)) {
    throw new Error(`GraphQL ref "${ref}" has invalid field name "${fieldName}"`);
  }
  return { rootType, fieldName };
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/** Introspect a GraphQL endpoint and return the parsed schema. */
export async function introspect(
  url: string,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
  maxResponseBytes: number = DEFAULT_MAX_DELIVERY_UNIT_BYTES,
): Promise<IntrospectionSchema> {
  const { body } = await doGraphQLHTTP(url, INTROSPECTION_QUERY, undefined, undefined, headers, fetchFn, signal, maxResponseBytes);
  if (Array.isArray(body.errors)) {
    const messages = body.errors.map((error) => {
      if (error !== null && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") return message;
      }
      return "";
    });
    throw new Error(`introspection errors: ${messages.join("; ")}`);
  }
  const data = body.data;
  const schemaData = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>).__schema
    : undefined;
  if (!schemaData || typeof schemaData !== "object" || Array.isArray(schemaData)) {
    throw new Error("introspection response missing __schema field");
  }
  return schemaData as IntrospectionSchema;
}

/** Resolve a root-type field from the introspected schema. Throws when the root type or field is missing. */
export function resolveField(schema: IntrospectionSchema, rootType: string, fieldName: string): Field {
  const typeName = rootTypeName(schema, rootType);
  if (!typeName) throw new Error(`schema has no ${rootType} root type`);
  const t = schema.types.find((x) => x.name === typeName);
  if (!t) throw new Error(`type "${typeName}" not found in schema`);
  const field = t.fields?.find((f) => f.name === fieldName);
  if (!field) throw new Error(`field "${fieldName}" not found on ${rootType} root type "${typeName}"`);
  return field;
}

// ---------------------------------------------------------------------------
// HTTP invocation
// ---------------------------------------------------------------------------

type GraphQLResponse = Record<string, unknown>;

/** Multi-valued invocation metadata from a fetch Headers object. */
function metadataFromHeaders(h: Headers): Metadata {
  const md: Metadata = {};
  h.forEach((value, key) => { md[key] = [value]; });
  return md;
}

interface GraphQLHTTPResult {
  body: GraphQLResponse;
  headers: Metadata;
}

/**
 * Reads a Response body as bytes, refusing past maxBytes. Cancels the body
 * stream before bailing so the connection doesn't sit pinned on the
 * remaining bytes.
 */
async function readResponseBytes(resp: Response, maxBytes: number): Promise<Uint8Array> {
  if (!resp.body) return new Uint8Array(await resp.arrayBuffer());

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`response exceeds ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/**
 * Send a GraphQL query over HTTP POST. Non-2xx statuses throw an
 * InvocationError coded via httpErrorCode with `{ status, body }` details;
 * network and parse failures propagate as-is. The body is read under the
 * delivery-unit bound BEFORE the status check (Go parity: the cap applies
 * to every response, success or failure alike). An unbounded GraphQL
 * response (a single overlarge field, a runaway introspection dump) must
 * not be buffered without limit; the bound is consumer-configurable via
 * `BindingInvocationArgs.maxDeliveryUnitBytes` (default 10MB).
 */
async function doGraphQLHTTP(
  url: string,
  query: string,
  operationName: string | undefined,
  variables: Record<string, unknown> | undefined,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
  maxResponseBytes: number = DEFAULT_MAX_DELIVERY_UNIT_BYTES,
): Promise<GraphQLHTTPResult> {
  const body: Record<string, unknown> = { query };
  if (operationName) body.operationName = operationName;
  if (variables !== undefined) body.variables = variables;

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/graphql-response+json, application/json;q=0.9",
    ...headers,
  };

  const resp = await fetchFn(url, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(body),
    signal,
    redirect: "manual",
  });

  const responseBytes = await readResponseBytes(resp, maxResponseBytes);
  const text = new TextDecoder().decode(responseBytes);
  const mediaType = (resp.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType !== "application/graphql-response+json" && mediaType !== "application/json") {
    throw graphQLHTTPFailure(
      resp,
      responseBytes,
      ERR_RESPONSE_ERROR,
      `unsupported GraphQL response media type ${JSON.stringify(mediaType)}`,
      mediaType,
    );
  }
  if (mediaType === "application/json" && !resp.ok) {
    throw graphQLHTTPFailure(
      resp,
      responseBytes,
      httpErrorCode(resp.status),
      `HTTP ${resp.status}: ${text}`,
      mediaType,
      httpErrorEffects(resp.status),
    );
  }
  let respBody: unknown;
  try {
    respBody = JSON.parse(text);
  } catch (e: unknown) {
    throw graphQLHTTPFailure(
      resp,
      responseBytes,
      ERR_RESPONSE_ERROR,
      `parse GraphQL response: ${e instanceof Error ? e.message : String(e)}`,
      mediaType,
    );
  }
  if (!wellFormedGraphQLResponse(respBody)) {
    throw graphQLHTTPFailure(
      resp,
      responseBytes,
      ERR_RESPONSE_ERROR,
      "response is not a well-formed GraphQL response envelope",
      mediaType,
    );
  }
  return { body: respBody, headers: metadataFromHeaders(resp.headers) };
}

function graphQLHTTPFailure(
  response: Response,
  body: Uint8Array,
  code: string,
  message: string,
  mediaType: string,
  effects?: Effects,
): InvocationError {
  return new InvocationError(code, message, {
    status: response.status,
    body: new TextDecoder().decode(body),
    httpResponse: {
      status: response.status,
      statusText: response.statusText,
      ...(response.url ? { url: response.url } : {}),
      headers: metadataFromHeaders(response.headers),
      body: capturedBytes(body),
    },
    graphql: { mediaType },
  }, effects);
}

function capturedBytes(bytes: Uint8Array): { base64: string; byteLength: number } {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return { base64: btoa(binary), byteLength: bytes.byteLength };
}

export function wellFormedGraphQLResponse(value: unknown): value is GraphQLResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  const hasData = Object.hasOwn(envelope, "data");
  const hasErrors = Object.hasOwn(envelope, "errors");
  if (!hasData && !hasErrors) return false;
  if (
    hasData && envelope.data !== null
    && (typeof envelope.data !== "object" || Array.isArray(envelope.data))
  ) return false;
  if (hasErrors) {
    if (!Array.isArray(envelope.errors) || envelope.errors.length === 0) return false;
    for (const error of envelope.errors) {
      if (
        error === null || typeof error !== "object" || Array.isArray(error)
        || typeof (error as Record<string, unknown>).message !== "string"
        || !(error as Record<string, unknown>).message
      ) return false;
    }
  }
  if (
    Object.hasOwn(envelope, "extensions")
    && envelope.extensions !== null
    && (typeof envelope.extensions !== "object" || Array.isArray(envelope.extensions))
  ) return false;
  return true;
}

/** Result of a unary GraphQL invocation: the complete envelope plus response headers. */
export interface GraphQLInvokeResult {
  response: GraphQLResponse;
  headers: Metadata;
}

/**
 * Invoke a GraphQL query/mutation via HTTP POST. GraphQL errors remain
 * in-band in the returned complete response envelope.
 */
export async function invokeGraphQL(
  url: string,
  query: string,
  operationName: string | undefined,
  variables: Record<string, unknown> | undefined,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
  maxResponseBytes: number = DEFAULT_MAX_DELIVERY_UNIT_BYTES,
): Promise<GraphQLInvokeResult> {
  let res: GraphQLHTTPResult;
  try {
    res = await doGraphQLHTTP(url, query, operationName, variables, headers, fetchFn, signal, maxResponseBytes);
  } catch (e: unknown) {
    if (e instanceof InvocationError) throw e;
    throw new InvocationError(ERR_RESPONSE_ERROR, e instanceof Error ? e.message : String(e));
  }
  return { response: res.body, headers: res.headers };
}

/** Check if an error is an HTTP auth failure (401/403). */
export function isAuthError(e: unknown): boolean {
  return e instanceof InvocationError && (e.code === ERR_AUTH_REQUIRED || e.code === ERR_PERMISSION_DENIED);
}

/**
 * Parse inline Source.Content under GQL-D-02. Only one successful
 * introspection execution-result object is accepted.
 */
export function parseIntrospectionContent(content: unknown): IntrospectionSchema {
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("content must be an introspection execution-result object");
  }
  const result = content as Record<string, unknown>;
  if (Object.hasOwn(result, "errors")) {
    throw new Error("introspection content must not contain an errors member");
  }
  if (result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) {
    throw new Error("introspection content must contain object data");
  }
  const schema = (result.data as Record<string, unknown>).__schema;
  const types = schema !== null && typeof schema === "object" && !Array.isArray(schema)
    ? (schema as Record<string, unknown>).types
    : undefined;
  if (
    schema === null || typeof schema !== "object" || Array.isArray(schema)
    || !Array.isArray(types)
    || types.length === 0
  ) {
    throw new Error("introspection content must contain object data.__schema with types");
  }
  return schema as IntrospectionSchema;
}

// ---------------------------------------------------------------------------
// WebSocket subscription (graphql-transport-ws protocol)
// ---------------------------------------------------------------------------

/**
 * Maximum number of undelivered subscription events buffered between the
 * socket and the consuming pump. The handle's bounded output buffer IS the
 * backpressure contract; an unbounded second buffer here would defeat it,
 * so overflow fails the stream instead.
 */
const MAX_QUEUED_EVENTS = 1024;

const byteEncoder = new TextEncoder();

/**
 * Subscribe to a GraphQL subscription via the graphql-transport-ws protocol.
 * Yields each event's bare data payload until the subscription completes
 * (clean return) or fails (throws an InvocationError). An aborted `signal`
 * ends the sequence cleanly — the cancellation terminal belongs to the
 * invocation handle, not the transport. Generator teardown (early return or
 * throw, including an emitOutput rejection in the consuming pump) closes the
 * WebSocket.
 */
export async function* subscribeGraphQL(
  target: string,
  document: DocumentConfiguration,
  variables: Record<string, unknown> | undefined,
  headers: Record<string, string>,
  connectionInitPayload: Record<string, unknown> | null | undefined,
  connectionInitPayloadSet: boolean,
  maxUnitBytes: number,
  signal?: AbortSignal,
  webSocketFactory?: GraphQLWebSocketFactory,
): AsyncGenerator<unknown> {
  let ws: WebSocket;
  try {
    if (webSocketFactory) {
      ws = webSocketFactory({
        url: target,
        protocols: ["graphql-transport-ws"],
        headers,
      });
    } else {
      if (Object.keys(headers).length > 0) {
        throw new Error("WebSocket upgrade headers require a GraphQLWebSocketFactory that can carry them");
      }
      ws = new WebSocket(target, "graphql-transport-ws");
    }
  } catch (e: unknown) {
    throw new InvocationError(ERR_CONNECT_FAILED, `WebSocket create failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // One event queue for the whole session, handshake included: protocol
  // callbacks push, the generator loop drains in order. `null` ends the
  // sequence cleanly; an error event throws.
  type WireEvent = { data: unknown } | { error: InvocationError } | null;
  const queue: WireEvent[] = [];
  let waiting: (() => void) | null = null;
  let finished = false;
  let acked = false;

  const push = (ev: WireEvent) => {
    queue.push(ev);
    if (waiting) { waiting(); waiting = null; }
  };
  const finish = (ev: { error: InvocationError } | null) => {
    if (finished) return;
    finished = true;
    push(ev);
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "connection_init",
      ...(connectionInitPayloadSet ? { payload: connectionInitPayload } : {}),
    }));
  };

  ws.onmessage = (ev) => {
    // Delivery-unit bound, enforced post-receive: the browser/undici
    // WebSocket API exposes no pre-delivery read-limit seam (Go's
    // SetReadLimit), so the check runs on the received frame before decode
    // — same bound, same error identity, platform enforcement point.
    const raw = String(ev.data);
    if (byteEncoder.encode(raw).length > maxUnitBytes) {
      finish({ error: new InvocationError(ERR_STREAM_ERROR, `WebSocket message exceeds ${maxUnitBytes} byte limit`) });
      return;
    }
    let msg: { type: string; payload?: unknown };
    try {
      msg = JSON.parse(raw) as { type: string; payload?: unknown };
    } catch (e: unknown) {
      finish({ error: new InvocationError(ERR_RESPONSE_ERROR, `parse ws message: ${e instanceof Error ? e.message : String(e)}`) });
      return;
    }

    if (!acked) {
      if (msg.type === "connection_ack") {
        acked = true;
        const payload: Record<string, unknown> = { query: document.source };
        if (document.operationName) payload.operationName = document.operationName;
        if (variables !== undefined) payload.variables = variables;
        ws.send(JSON.stringify({ id: "1", type: "subscribe", payload }));
      } else {
        finish({ error: new InvocationError(ERR_CONNECT_FAILED, `expected connection_ack, got ${msg.type}`) });
      }
      return;
    }

    switch (msg.type) {
      case "next": {
        const p = msg.payload;
        if (!wellFormedGraphQLResponse(p)) {
          finish({ error: new InvocationError(ERR_RESPONSE_ERROR, "next payload is not a well-formed GraphQL response envelope") });
        } else if (queue.length >= MAX_QUEUED_EVENTS) {
          // The consumer is not draining; fail the stream rather than
          // buffer without bound, and stop the inflow at the socket.
          queue.length = 0;
          finish({
            error: new InvocationError(
              ERR_STREAM_ERROR,
              `backpressure overflow: more than ${MAX_QUEUED_EVENTS} undelivered subscription events`,
            ),
          });
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        } else {
          push({ data: p });
        }
        break;
      }
      case "error": {
        const errors = Array.isArray(msg.payload) ? (msg.payload as Array<{ message: string }>) : undefined;
        finish({ error: new InvocationError(
          ERR_EXECUTION_FAILED,
          errors?.[0]?.message ?? String(msg.payload),
          {
            ...(errors ? { errors } : {}),
            graphqlTransportWs: { type: "error", payload: msg.payload },
          },
        ) });
        break;
      }
      case "complete":
        finish(null);
        break;
    }
  };

  ws.onerror = () => {
    finish({
      error: acked
        ? new InvocationError(ERR_STREAM_ERROR, "WebSocket error")
        : new InvocationError(ERR_CONNECT_FAILED, "WebSocket connect failed"),
    });
  };

  ws.onclose = (event) => {
    // graphql-transport-ws semantics: a clean end is signalled by a
    // `complete` frame (which already finished the sequence and makes this
    // a no-op). A post-ack close without one is an abnormal termination —
    // surfacing it as clean completion would mask server crashes.
    const details = {
      graphqlTransportWs: {
        type: "close",
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      },
    };
    finish({ error: acked
      ? new InvocationError(ERR_STREAM_ERROR, "WebSocket closed before subscription complete", details)
      : new InvocationError(ERR_CONNECT_FAILED, "WebSocket closed during handshake", details) });
  };

  const onAbort = () => {
    if (acked && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ id: "1", type: "complete" }));
      } catch {
        // The transport may already be closing; cancellation still completes locally.
      }
    }
    finish(null);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) finish(null);

  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((r) => { waiting = r; });
      }
      const ev = queue.shift()!;
      if (ev === null) return;
      if ("error" in ev) throw ev.error;
      yield ev.data;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}

import type { JSONSchema, Metadata } from "@openbindings/sdk";
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
import type { Field, IntrospectionSchema, TypeRef, TypeMap, InputValue } from "./introspection.js";
import { buildTypeMap, rootTypeName, unwrapTypeName, INTROSPECTION_QUERY } from "./introspection.js";
import { MAX_SELECTION_DEPTH, QUERY_FIELD_NAME } from "./constants.js";

// ---------------------------------------------------------------------------
// Ref parsing
// ---------------------------------------------------------------------------

/** Parse a GraphQL ref in the form "Query/field", "Mutation/field", or "Subscription/field". */
export function parseRef(ref: string): { rootType: string; fieldName: string } {
  const idx = ref.indexOf("/");
  if (idx < 0 || idx === 0 || idx === ref.length - 1) {
    throw new Error(`GraphQL ref "${ref}" must be in the form Query/fieldName, Mutation/fieldName, or Subscription/fieldName`);
  }
  const rootType = ref.slice(0, idx);
  const fieldName = ref.slice(idx + 1);
  if (rootType !== "Query" && rootType !== "Mutation" && rootType !== "Subscription") {
    throw new Error(`GraphQL ref "${ref}" has invalid root type "${rootType}" (must be Query, Mutation, or Subscription)`);
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
  const { body } = await doGraphQLHTTP(url, INTROSPECTION_QUERY, undefined, headers, fetchFn, signal, maxResponseBytes);
  if (body.errors?.length) {
    throw new Error(`introspection errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  const schemaData = body.data?.__schema;
  if (!schemaData) {
    throw new Error("introspection response missing __schema field");
  }
  return schemaData as IntrospectionSchema;
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/** Extract a pre-built query from the operation's input schema _query const. */
export function queryFromSchema(schema: JSONSchema | undefined): string | null {
  if (!schema) return null;
  const props = (schema as Record<string, unknown>).properties as Record<string, unknown> | undefined;
  if (!props) return null;
  const queryProp = props[QUERY_FIELD_NAME] as Record<string, unknown> | undefined;
  if (!queryProp) return null;
  const constVal = queryProp.const;
  return typeof constVal === "string" && constVal.length > 0 ? constVal : null;
}

/** True when the operation's input schema declares variable properties beyond the _query const. */
export function schemaDeclaresVariables(schema: JSONSchema | undefined): boolean {
  if (!schema) return false;
  const props = (schema as Record<string, unknown>).properties as Record<string, unknown> | undefined;
  if (!props) return false;
  return Object.keys(props).some((k) => k !== QUERY_FIELD_NAME);
}

/** Resolve a root-type field from the introspected schema. Throws when the root type or field is missing. */
export function resolveField(schema: IntrospectionSchema, rootType: string, fieldName: string): Field {
  const typeName = rootTypeName(schema, rootType);
  if (!typeName) throw new Error(`schema has no ${rootType} type`);
  const t = schema.types.find((x) => x.name === typeName);
  if (!t) throw new Error(`type "${typeName}" not found in schema`);
  const field = t.fields?.find((f) => f.name === fieldName);
  if (!field) throw new Error(`field "${fieldName}" not found on ${rootType} type "${typeName}"`);
  return field;
}

/** Build a query from the introspected schema with auto-generated selection set. */
export function buildQueryFromIntrospection(
  schema: IntrospectionSchema,
  rootType: string,
  fieldName: string,
  input: unknown,
): { query: string; variables: Record<string, unknown> | undefined } {
  const targetField = resolveField(schema, rootType, fieldName);
  const tm = buildTypeMap(schema);

  const { varDecls, argList } = buildVariables(targetField.args);

  const returnType = unwrapTypeName(targetField.type);
  let selectionSet = "";
  if (returnType) {
    const rt = tm.get(returnType);
    if (rt && (rt.kind === "OBJECT" || rt.kind === "INTERFACE" || rt.kind === "UNION")) {
      selectionSet = buildSelectionSet(returnType, tm, 0, new Set());
    }
  }

  const variables = inputToVariables(input, targetField.args);

  const keyword = rootType === "Query" ? "query" : rootType === "Mutation" ? "mutation" : "subscription";
  let q = keyword;
  if (varDecls) q += `(${varDecls})`;
  q += ` { ${fieldName}`;
  if (argList) q += `(${argList})`;
  if (selectionSet) q += ` ${selectionSet}`;
  q += " }";

  return { query: q, variables };
}

/** Build variable declarations and argument list from field args. */
function buildVariables(args: InputValue[]): { varDecls: string; argList: string } {
  if (!args.length) return { varDecls: "", argList: "" };
  const decls: string[] = [];
  const passing: string[] = [];
  for (const arg of args) {
    decls.push(`$${arg.name}: ${typeRefToGraphQL(arg.type)}`);
    passing.push(`${arg.name}: $${arg.name}`);
  }
  return { varDecls: decls.join(", "), argList: passing.join(", ") };
}

/** Convert an introspection TypeRef to a GraphQL type string. */
export function typeRefToGraphQL(t: TypeRef): string {
  if (t.kind === "NON_NULL") return t.ofType ? typeRefToGraphQL(t.ofType) + "!" : (t.name ?? "String") + "!";
  if (t.kind === "LIST") return t.ofType ? `[${typeRefToGraphQL(t.ofType)}]` : `[${t.name ?? "String"}]`;
  return t.name ?? "String";
}

/** Build a selection set recursively (depth-limited, cycle-safe). */
export function buildSelectionSet(typeName: string, tm: TypeMap, depth: number, visited: Set<string>): string {
  if (depth >= MAX_SELECTION_DEPTH || visited.has(typeName)) return "";
  const t = tm.get(typeName);
  if (!t) return "";

  if (t.kind === "UNION" || t.kind === "INTERFACE") {
    if (!t.possibleTypes?.length) return "";
    const fragments = ["__typename"];
    for (const pt of t.possibleTypes) {
      if (pt.name) {
        const nested = buildSelectionSet(pt.name, tm, depth, visited);
        if (nested) fragments.push(`... on ${pt.name} ${nested}`);
      }
    }
    return `{ ${fragments.join(" ")} }`;
  }

  if (t.kind !== "OBJECT" || !t.fields?.length) return "";

  visited.add(typeName);
  const fields: string[] = [];
  for (const f of t.fields) {
    if (f.name.startsWith("__")) continue;
    const returnType = unwrapTypeName(f.type);
    if (!returnType) { fields.push(f.name); continue; }
    const ft = tm.get(returnType);
    if (!ft) { fields.push(f.name); continue; }
    if (ft.kind === "SCALAR" || ft.kind === "ENUM") {
      fields.push(f.name);
    } else if (ft.kind === "OBJECT" || ft.kind === "INTERFACE" || ft.kind === "UNION") {
      const nested = buildSelectionSet(returnType, tm, depth + 1, visited);
      if (nested) fields.push(`${f.name} ${nested}`);
    }
  }
  visited.delete(typeName);

  return fields.length ? `{ ${fields.join(" ")} }` : "";
}

/** Pass through all input keys except _query as GraphQL variables. */
export function inputToVariablesPassthrough(input: unknown): Record<string, unknown> | undefined {
  if (input == null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const map = input as Record<string, unknown>;
  const vars: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(map)) {
    if (k === QUERY_FIELD_NAME) continue;
    vars[k] = v;
    count++;
  }
  return count > 0 ? vars : undefined;
}

/** Build variables from input, using only keys that match declared field arguments. */
function inputToVariables(input: unknown, args: InputValue[]): Record<string, unknown> | undefined {
  if (input == null || !args.length) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) return undefined;
  const map = input as Record<string, unknown>;
  const argNames = new Set(args.map((a) => a.name));
  const vars: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(map)) {
    if (argNames.has(k)) { vars[k] = v; count++; }
  }
  return count > 0 ? vars : undefined;
}

// ---------------------------------------------------------------------------
// HTTP invocation
// ---------------------------------------------------------------------------

interface GraphQLError { message: string }

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: GraphQLError[];
}

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
 * Reads a Response body as text, refusing past maxBytes. Cancels the body
 * stream before bailing so the connection doesn't sit pinned on the
 * remaining bytes.
 */
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
        await reader.cancel().catch(() => {});
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
  variables: Record<string, unknown> | undefined,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
  maxResponseBytes: number = DEFAULT_MAX_DELIVERY_UNIT_BYTES,
): Promise<GraphQLHTTPResult> {
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...headers,
  };

  const resp = await fetchFn(url, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(body),
    signal,
  });

  const text = await readResponseText(resp, maxResponseBytes);

  if (!resp.ok) {
    throw new InvocationError(
      httpErrorCode(resp.status),
      `HTTP ${resp.status}: ${text}`,
      { status: resp.status, body: text },
      httpErrorEffects(resp.status),
    );
  }

  const respBody = JSON.parse(text) as GraphQLResponse;
  return { body: respBody, headers: metadataFromHeaders(resp.headers) };
}

/** Result of a unary GraphQL invocation: the requested field's bare data plus response headers. */
export interface GraphQLInvokeResult {
  data: unknown;
  headers: Metadata;
}

/**
 * Invoke a GraphQL query/mutation via HTTP POST. Returns the requested
 * field's data and the response headers; throws an InvocationError on HTTP,
 * network, or GraphQL-level failure (`errors` in the response body map to
 * ERR_EXECUTION_FAILED with `{ errors }` details).
 */
export async function invokeGraphQL(
  url: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  fieldName: string,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
  maxResponseBytes: number = DEFAULT_MAX_DELIVERY_UNIT_BYTES,
): Promise<GraphQLInvokeResult> {
  let res: GraphQLHTTPResult;
  try {
    res = await doGraphQLHTTP(url, query, variables, headers, fetchFn, signal, maxResponseBytes);
  } catch (e: unknown) {
    if (e instanceof InvocationError) throw e;
    throw new InvocationError(ERR_EXECUTION_FAILED, e instanceof Error ? e.message : String(e));
  }

  if (res.body.errors?.length) {
    throw new InvocationError(
      ERR_EXECUTION_FAILED,
      res.body.errors.map((e) => e.message).join("; "),
      { errors: res.body.errors },
    );
  }

  return { data: res.body.data?.[fieldName] ?? null, headers: res.headers };
}

/** Check if an error is an HTTP auth failure (401/403). */
export function isAuthError(e: unknown): boolean {
  return e instanceof InvocationError && (e.code === ERR_AUTH_REQUIRED || e.code === ERR_PERMISSION_DENIED);
}

/**
 * Parse inline Source.Content as a GraphQL introspection result.
 * Accepts the full response shape ({"data": {"__schema": ...}}),
 * the __schema wrapper ({"__schema": ...}), or a bare schema object.
 */
export function parseIntrospectionContent(content: unknown): IntrospectionSchema {
  let raw: unknown = content;

  // If content is a string, parse it as JSON.
  if (typeof content === "string") {
    try {
      raw = JSON.parse(content);
    } catch {
      throw new Error("unrecognized introspection content format");
    }
  }

  if (raw == null || typeof raw !== "object") {
    throw new Error("unrecognized introspection content format");
  }

  const obj = raw as Record<string, unknown>;

  // Try full response: {"data": {"__schema": ...}}
  const data = obj.data as Record<string, unknown> | undefined;
  if (data?.__schema && typeof data.__schema === "object") {
    return data.__schema as IntrospectionSchema;
  }

  // Try wrapper: {"__schema": ...}
  if (obj.__schema && typeof obj.__schema === "object") {
    return obj.__schema as IntrospectionSchema;
  }

  // Try bare schema.
  if (obj.queryType || (Array.isArray(obj.types) && obj.types.length > 0)) {
    return obj as unknown as IntrospectionSchema;
  }

  throw new Error("unrecognized introspection content format");
}

// ---------------------------------------------------------------------------
// WebSocket subscription (graphql-transport-ws protocol)
// ---------------------------------------------------------------------------

function httpToWS(url: string): string {
  if (url.startsWith("https://")) return "wss://" + url.slice(8);
  if (url.startsWith("http://")) return "ws://" + url.slice(7);
  return url;
}

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
  url: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  headers: Record<string, string>,
  maxUnitBytes: number,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const wsURL = httpToWS(url);

  // Browser WebSocket API doesn't support custom headers on the upgrade request.
  // Pass auth via the graphql-transport-ws connection_init payload instead.
  const connectionParams: Record<string, unknown> = {};
  if (headers["Authorization"]) {
    connectionParams.authorization = headers["Authorization"];
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsURL, "graphql-transport-ws");
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
      ...(Object.keys(connectionParams).length > 0 ? { payload: connectionParams } : {}),
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
        const payload: Record<string, unknown> = { query };
        if (variables) payload.variables = variables;
        ws.send(JSON.stringify({ id: "1", type: "subscribe", payload }));
      } else {
        finish({ error: new InvocationError(ERR_CONNECT_FAILED, `expected connection_ack, got ${msg.type}`) });
      }
      return;
    }

    switch (msg.type) {
      case "next": {
        const p = msg.payload as { data?: unknown; errors?: Array<{ message: string }> } | undefined;
        if (p?.errors?.length) {
          // A malformed first element (e.g. JSON null) still surfaces as
          // the structured error with an empty message — Go parity: a null
          // element unmarshals to the zero graphqlError — never a TypeError.
          finish({ error: new InvocationError(ERR_EXECUTION_FAILED, p.errors[0]?.message ?? "", { errors: p.errors }) });
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
          push({ data: p?.data });
        }
        break;
      }
      case "error": {
        const errors = Array.isArray(msg.payload) ? (msg.payload as Array<{ message: string }>) : undefined;
        finish({ error: new InvocationError(ERR_EXECUTION_FAILED, errors?.[0]?.message ?? String(msg.payload), { errors }) });
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

  ws.onclose = () => {
    // graphql-transport-ws semantics: a clean end is signalled by a
    // `complete` frame (which already finished the sequence and makes this
    // a no-op). A post-ack close without one is an abnormal termination —
    // surfacing it as clean completion would mask server crashes.
    finish({
      error: acked
        ? new InvocationError(ERR_STREAM_ERROR, "WebSocket closed before subscription complete")
        : new InvocationError(ERR_CONNECT_FAILED, "WebSocket closed during handshake"),
    });
  };

  const onAbort = () => finish(null);
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

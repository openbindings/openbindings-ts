import type { ExecuteOutput, JSONSchema, StreamEvent } from "@openbindings/sdk";
import {
  ERR_INVALID_REF,
  ERR_EXECUTION_FAILED,
  ERR_AUTH_REQUIRED,
  ERR_PERMISSION_DENIED,
  ERR_STREAM_ERROR,
  ERR_RESPONSE_ERROR,
  ERR_CONNECT_FAILED,
} from "@openbindings/sdk";
import type { IntrospectionSchema, TypeRef, TypeMap, InputValue } from "./introspection.js";
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
): Promise<IntrospectionSchema> {
  const { data, errors } = await doGraphQLHTTP(url, INTROSPECTION_QUERY, undefined, headers, fetchFn, signal);
  if (errors?.length) {
    throw new Error(`introspection errors: ${errors.map((e) => e.message).join("; ")}`);
  }
  const schemaData = data?.__schema;
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

/**
 * Build a GraphQL query. Uses the _query const from the input schema if available,
 * otherwise builds from introspection.
 */
export function buildQuery(
  schema: IntrospectionSchema,
  rootType: string,
  fieldName: string,
  input: unknown,
  inputSchema?: JSONSchema,
): { query: string; variables: Record<string, unknown> | undefined } {
  const prebuilt = queryFromSchema(inputSchema);
  if (prebuilt) {
    return { query: prebuilt, variables: inputToVariablesPassthrough(input) };
  }
  return buildQueryFromIntrospection(schema, rootType, fieldName, input);
}

/** Build a query from the introspected schema with auto-generated selection set. */
export function buildQueryFromIntrospection(
  schema: IntrospectionSchema,
  rootType: string,
  fieldName: string,
  input: unknown,
): { query: string; variables: Record<string, unknown> | undefined } {
  const typeName = rootTypeName(schema, rootType);
  if (!typeName) throw new Error(`schema has no ${rootType} type`);

  const tm = buildTypeMap(schema);
  const rootTypeObj = tm.get(typeName);
  if (!rootTypeObj) throw new Error(`type "${typeName}" not found in schema`);

  const targetField = rootTypeObj.fields?.find((f) => f.name === fieldName);
  if (!targetField) throw new Error(`field "${fieldName}" not found on ${rootType} type "${typeName}"`);

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
function inputToVariablesPassthrough(input: unknown): Record<string, unknown> | undefined {
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
// HTTP execution
// ---------------------------------------------------------------------------

interface GraphQLError { message: string }

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: GraphQLError[];
}

/** Send a GraphQL query over HTTP POST. */
async function doGraphQLHTTP(
  url: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
): Promise<GraphQLResponse> {
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

  if (resp.status === 401 || resp.status === 403) {
    const text = await resp.text().catch(() => "");
    throw new HttpError(resp.status, text);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }

  const result: GraphQLResponse = await resp.json();
  return result;
}

class HttpError extends Error {
  constructor(public readonly statusCode: number, body: string) {
    super(`HTTP ${statusCode}: ${body}`);
  }
}

/** Execute a GraphQL query/mutation and return an ExecuteOutput. */
export async function executeGraphQL(
  url: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  fieldName: string,
  headers: Record<string, string>,
  fetchFn: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
): Promise<ExecuteOutput> {
  const start = performance.now();

  let result: GraphQLResponse;
  try {
    result = await doGraphQLHTTP(url, query, variables, headers, fetchFn, signal);
  } catch (e: unknown) {
    const durationMs = Math.round(performance.now() - start);
    if (e instanceof HttpError) {
      const code = e.statusCode === 401 ? ERR_AUTH_REQUIRED : e.statusCode === 403 ? ERR_PERMISSION_DENIED : ERR_EXECUTION_FAILED;
      return { status: e.statusCode, durationMs, error: { code, message: e.message } };
    }
    return { status: 1, durationMs, error: { code: ERR_EXECUTION_FAILED, message: e instanceof Error ? e.message : String(e) } };
  }

  const durationMs = Math.round(performance.now() - start);

  if (result.errors?.length) {
    return {
      status: 200,
      durationMs,
      error: { code: ERR_EXECUTION_FAILED, message: result.errors.map((e) => e.message).join("; ") },
    };
  }

  const output = result.data?.[fieldName] ?? null;
  return { output, status: 200, durationMs };
}

/** Check if an error is an HTTP auth error. */
export function isAuthError(e: unknown): boolean {
  return e instanceof HttpError && (e.statusCode === 401 || e.statusCode === 403);
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
 * Subscribe to a GraphQL subscription via the graphql-transport-ws protocol.
 * Yields StreamEvents as they arrive until the subscription completes or is cancelled.
 */
export async function* subscribeGraphQL(
  url: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
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
    yield { error: { code: ERR_CONNECT_FAILED, message: `WebSocket create failed: ${e instanceof Error ? e.message : String(e)}` } };
    return;
  }

  // Wait for open.
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket connect failed"));
      if (signal?.aborted) reject(new Error("aborted"));
    });
  } catch (e: unknown) {
    yield { error: { code: ERR_CONNECT_FAILED, message: e instanceof Error ? e.message : String(e) } };
    return;
  }

  // connection_init
  ws.send(JSON.stringify({
    type: "connection_init",
    ...(Object.keys(connectionParams).length > 0 ? { payload: connectionParams } : {}),
  }));

  // Wait for connection_ack.
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "connection_ack") resolve();
          else reject(new Error(`expected connection_ack, got ${msg.type}`));
        } catch (e) {
          reject(e);
        }
      };
      ws.onerror = () => reject(new Error("WebSocket error during handshake"));
    });
  } catch (e: unknown) {
    ws.close();
    yield { error: { code: ERR_CONNECT_FAILED, message: e instanceof Error ? e.message : String(e) } };
    return;
  }

  // Send subscribe.
  const payload: Record<string, unknown> = { query };
  if (variables) payload.variables = variables;
  ws.send(JSON.stringify({ id: "1", type: "subscribe", payload }));

  // Stream events via an async queue.
  const queue: Array<StreamEvent | null> = [];
  let waiting: (() => void) | null = null;
  let done = false;

  function enqueue(event: StreamEvent | null) {
    queue.push(event);
    if (waiting) { waiting(); waiting = null; }
  }

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type: string; payload?: unknown };
      switch (msg.type) {
        case "next": {
          const p = msg.payload as { data?: unknown; errors?: Array<{ message: string }> } | undefined;
          if (p?.errors?.length) {
            enqueue({ error: { code: ERR_EXECUTION_FAILED, message: p.errors[0].message } });
            done = true;
            enqueue(null);
          } else {
            enqueue({ data: p?.data });
          }
          break;
        }
        case "error": {
          const errors = Array.isArray(msg.payload) ? msg.payload as Array<{ message: string }> : undefined;
          enqueue({ error: { code: ERR_EXECUTION_FAILED, message: errors?.[0]?.message ?? String(msg.payload) } });
          done = true;
          enqueue(null);
          break;
        }
        case "complete":
          done = true;
          enqueue(null);
          break;
      }
    } catch (e) {
      enqueue({ error: { code: ERR_RESPONSE_ERROR, message: `parse ws message: ${e instanceof Error ? e.message : String(e)}` } });
      done = true;
      enqueue(null);
    }
  };

  ws.onerror = () => {
    if (!done) {
      enqueue({ error: { code: ERR_STREAM_ERROR, message: "WebSocket error" } });
      done = true;
      enqueue(null);
    }
  };

  ws.onclose = () => {
    if (!done) {
      done = true;
      enqueue(null);
    }
  };

  const onAbort = () => { done = true; enqueue(null); };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((r) => { waiting = r; });
      }
      const event = queue.shift()!;
      if (event === null) return;
      yield event;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}

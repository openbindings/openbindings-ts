import {
  ERR_AUTH_REQUIRED,
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_SOURCE_LOAD_FAILED,
  NoSourcesError,
  resolveSecurity,
  normalizeContextKey,
  contextBearerToken,
  contextApiKey,
  contextBasicAuth,
  type BindingExecutor,
  type InterfaceCreator,
  type BindingExecutionInput,
  type CreateInput,
  type OBInterface,
  type StreamEvent,
  type FormatInfo,
  type ExecutionOptions,
  type Source,
  type ListRefsResult,
} from "@openbindings/sdk";
import { FORMAT_TOKEN } from "./constants.js";
import { parseRef, introspect, buildQuery, executeGraphQL, subscribeGraphQL, isAuthError, parseIntrospectionContent } from "./execute.js";
import type { IntrospectionSchema } from "./introspection.js";
import { buildTypeMap, rootTypeName } from "./introspection.js";
import { convertToInterface } from "./create.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHeaders(
  context?: Record<string, unknown>,
  options?: ExecutionOptions,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (context) {
    const bearer = contextBearerToken(context);
    if (bearer) {
      headers["Authorization"] = `Bearer ${bearer}`;
    } else {
      const apiKey = contextApiKey(context);
      if (apiKey) {
        headers["Authorization"] = `ApiKey ${apiKey}`;
      } else {
        const basic = contextBasicAuth(context);
        if (basic) {
          headers["Authorization"] = `Basic ${btoa(`${basic.username}:${basic.password}`)}`;
        }
      }
    }
  }

  if (options?.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      headers[k] = v;
    }
  }
  if (options?.cookies) {
    const pairs = Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).sort();
    if (pairs.length > 0) headers["Cookie"] = pairs.join("; ");
  }

  return headers;
}

function normalizeEndpoint(url: string): string {
  try {
    return normalizeContextKey(new URL(url).host);
  } catch {
    return normalizeContextKey(url);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Executes GraphQL bindings via HTTP POST with introspection-driven query construction. */
export class GraphQLExecutor implements BindingExecutor {
  private readonly schemaCache = new Map<string, IntrospectionSchema>();

  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "GraphQL APIs" }];
  }

  async *executeBinding(
    input: BindingExecutionInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent> {
    // Validate ref early.
    let rootType: string, fieldName: string;
    try {
      ({ rootType, fieldName } = parseRef(input.ref));
    } catch (e: unknown) {
      yield { error: { code: ERR_INVALID_REF, message: e instanceof Error ? e.message : String(e) } };
      return;
    }

    if (!input.source.location) {
      yield { error: { code: ERR_SOURCE_LOAD_FAILED, message: "GraphQL source requires a location (endpoint URL)" } };
      return;
    }

    const enriched = await this.resolveStoreContext(input);
    const headers = buildHeaders(enriched.context, enriched.options);
    const fetchFn = enriched.fetch ?? fetch;
    const url = enriched.source.location!;

    // Load schema: inline content or network introspection (cached).
    let schema: IntrospectionSchema;
    if (enriched.source.content != null) {
      try {
        schema = parseIntrospectionContent(enriched.source.content);
      } catch (e: unknown) {
        yield { error: { code: ERR_SOURCE_LOAD_FAILED, message: `parse inline GraphQL content: ${e instanceof Error ? e.message : String(e)}` } };
        return;
      }
    } else {
      try {
        schema = await this.cachedIntrospect(url, headers, fetchFn, options?.signal);
      } catch (e: unknown) {
        if (isAuthError(e)) {
          yield { error: { code: ERR_AUTH_REQUIRED, message: e instanceof Error ? e.message : String(e) } };
        } else {
          yield { error: { code: ERR_SOURCE_LOAD_FAILED, message: e instanceof Error ? e.message : String(e) } };
        }
        return;
      }
    }

    // Build query.
    let query: string;
    let variables: Record<string, unknown> | undefined;
    try {
      ({ query, variables } = buildQuery(schema, rootType, fieldName, enriched.input, enriched.inputSchema));
    } catch (e: unknown) {
      yield { error: { code: ERR_REF_NOT_FOUND, message: e instanceof Error ? e.message : String(e) } };
      return;
    }

    // Subscriptions use WebSocket streaming.
    if (rootType === "Subscription") {
      yield* subscribeGraphQL(url, query, variables, headers, options?.signal);
      return;
    }

    // Execute query/mutation via HTTP.
    let result = await executeGraphQL(url, query, variables, fieldName, headers, fetchFn, options?.signal);

    // Auth retry.
    if (result.error?.code === ERR_AUTH_REQUIRED && enriched.security?.length && enriched.callbacks) {
      const creds = await resolveSecurity(enriched.security, enriched.callbacks);
      if (creds) {
        const retryContext = { ...enriched.context, ...creds };
        if (enriched.store) {
          const key = normalizeEndpoint(url);
          if (key) try { await enriched.store.set(key, retryContext); } catch { /* ignore */ }
        }
        const retryHeaders = buildHeaders(retryContext, enriched.options);
        result = await executeGraphQL(url, query, variables, fieldName, retryHeaders, fetchFn, options?.signal);
      }
    }

    if (result.error) {
      yield { error: result.error, status: result.status, durationMs: result.durationMs };
    } else {
      yield { data: result.output, status: result.status, durationMs: result.durationMs };
    }
  }

  private async cachedIntrospect(
    url: string,
    headers: Record<string, string>,
    fetchFn: typeof globalThis.fetch,
    signal?: AbortSignal,
  ): Promise<IntrospectionSchema> {
    const key = normalizeEndpoint(url) || url;
    const cached = this.schemaCache.get(key);
    if (cached) return cached;
    const schema = await introspect(url, headers, fetchFn, signal);
    this.schemaCache.set(key, schema);
    return schema;
  }

  private async resolveStoreContext(input: BindingExecutionInput): Promise<BindingExecutionInput> {
    if (!input.store || !input.source.location) return input;
    const key = normalizeEndpoint(input.source.location);
    if (!key) return input;
    let stored: Record<string, unknown> | null;
    try { stored = await input.store.get(key); } catch { return input; }
    if (!stored) return input;
    const merged = input.context && Object.keys(input.context).length > 0
      ? { ...stored, ...input.context }
      : stored;
    return { ...input, context: merged };
  }
}

// ---------------------------------------------------------------------------
// Creator
// ---------------------------------------------------------------------------

/** Creates OBInterface definitions by introspecting GraphQL endpoints. */
export class GraphQLCreator implements InterfaceCreator {
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "GraphQL APIs" }];
  }

  async createInterface(
    input: CreateInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    if (!input.sources?.length) throw new NoSourcesError();
    const src = input.sources[0];
    if (!src.location) throw new Error("GraphQL source requires a location (endpoint URL)");

    const schema = await introspect(src.location, {}, fetch, options?.signal);
    const iface = convertToInterface(schema, src.location);
    if (input.name) iface.name = input.name;
    if (input.version) iface.version = input.version;
    if (input.description) iface.description = input.description;
    return iface;
  }

  /** Lists all bindable refs (Query/Mutation/Subscription fields) from a GraphQL endpoint. */
  async listBindableRefs(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<ListRefsResult> {
    if (!source.location) throw new Error("GraphQL source requires a location (endpoint URL)");
    const schema = await introspect(source.location, {}, fetch, options?.signal);
    const refs: ListRefsResult["refs"] = [];
    const tm = buildTypeMap(schema);

    const rootTypes: Array<{ label: string; typeName: string | null }> = [
      { label: "Query", typeName: rootTypeName(schema, "Query") },
      { label: "Mutation", typeName: rootTypeName(schema, "Mutation") },
      { label: "Subscription", typeName: rootTypeName(schema, "Subscription") },
    ];

    for (const rt of rootTypes) {
      if (!rt.typeName) continue;
      const t = tm.get(rt.typeName);
      if (!t?.fields) continue;
      for (const f of [...t.fields].sort((a, b) => a.name.localeCompare(b.name))) {
        if (f.name.startsWith("__")) continue;
        refs.push({ ref: `${rt.label}/${f.name}`, description: f.description || undefined });
      }
    }

    return { refs, exhaustive: true };
  }
}

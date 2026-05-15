import {
  ERR_AUTH_REQUIRED,
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_SOURCE_LOAD_FAILED,
  NoSourcesError,
  resolveSecurity,
  buildAuthHeaders,
  normalizeEndpoint,
  type BindingInvoker,
  type InterfaceCreator,
  type SourceInspector,
  type BindingInvocationInput,
  type CreateInput,
  type OBInterface,
  type InvocationOutput,
  type FormatInfo,
  type Source,
  type SourceInspection,
} from "@openbindings/sdk";
import { FORMAT_TOKEN } from "./constants.js";
import { parseRef, introspect, buildQuery, invokeGraphQL, subscribeGraphQL, isAuthError, parseIntrospectionContent } from "./invoke.js";
import type { IntrospectionSchema } from "./introspection.js";
import { buildTypeMap, rootTypeName } from "./introspection.js";
import { convertToInterface } from "./create.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** Invokes GraphQL bindings via HTTP POST with introspection-driven query construction. */
export class GraphQLInvoker implements BindingInvoker {
  private readonly schemaCache = new Map<string, IntrospectionSchema>();

  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "GraphQL APIs" }];
  }

  async *invokeBinding(
    input: BindingInvocationInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<InvocationOutput> {
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
    const headers = buildAuthHeaders(enriched.context);
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

    // Invoke query/mutation via HTTP.
    let result = await invokeGraphQL(url, query, variables, fieldName, headers, fetchFn, options?.signal);

    // Auth retry.
    if (result.error?.code === ERR_AUTH_REQUIRED && enriched.security?.length && enriched.callbacks) {
      const creds = await resolveSecurity(enriched.security, enriched.callbacks, enriched.fetch);
      if (creds) {
        const retryContext = { ...enriched.context, ...creds };
        if (enriched.store) {
          const key = normalizeEndpoint(url);
          if (key) try { await enriched.store.set(key, retryContext); } catch { /* ignore */ }
        }
        const retryHeaders = buildAuthHeaders(retryContext);
        result = await invokeGraphQL(url, query, variables, fieldName, retryHeaders, fetchFn, options?.signal);
      }
    }

    if (result.error) {
      yield { error: result.error, status: result.status, durationMs: result.durationMs };
    } else {
      yield { output: result.output, status: result.status, durationMs: result.durationMs };
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

  private async resolveStoreContext(input: BindingInvocationInput): Promise<BindingInvocationInput> {
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
export class GraphQLCreator implements InterfaceCreator, SourceInspector {
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

  /** Lists all bindable targets (Query/Mutation/Subscription fields) from a GraphQL endpoint. */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    if (!source.location) throw new Error("GraphQL source requires a location (endpoint URL)");
    const schema = await introspect(source.location, {}, fetch, options?.signal);
    const targets: SourceInspection["targets"] = [];
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
        const desc = f.description || undefined;
        targets.push({ ref: `${rt.label}/${f.name}`, operation: desc ? { description: desc } : undefined });
      }
    }

    return { targets, exhaustive: true };
  }
}

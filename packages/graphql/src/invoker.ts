import {
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_RUNTIME,
  ERR_SOURCE_LOAD_FAILED,
  InvocationError,
  InvocationImpl,
  NoSourcesError,
  buildAuthHeaders,
  type BindingInvocationArgs,
  type BindingInvoker,
  type CreateInput,
  type FormatInfo,
  type InterfaceCreator,
  type Invocation,
  type OBInterface,
  type Source,
  type SourceInspection,
  type SourceInspector,
} from "@openbindings/sdk";
import { FORMAT_TOKEN } from "./constants.js";
import {
  buildQueryFromIntrospection,
  inputToVariablesPassthrough,
  introspect,
  invokeGraphQL,
  isAuthError,
  parseIntrospectionContent,
  parseRef,
  queryFromSchema,
  resolveField,
  schemaDeclaresVariables,
  subscribeGraphQL,
} from "./invoke.js";
import type { Field, IntrospectionSchema } from "./introspection.js";
import { buildTypeMap, rootTypeName } from "./introspection.js";
import { convertToInterface } from "./create.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Reads the first input from the handle, or undefined when input closes without one. */
async function readFirst<T>(it: AsyncIterable<T>): Promise<T | undefined> {
  for await (const v of it) return v;
  return undefined;
}

/**
 * Invokes GraphQL bindings via HTTP POST (queries/mutations) or the
 * graphql-transport-ws WebSocket protocol (subscriptions), with
 * introspection-driven query construction.
 *
 * `invokeBinding` returns the Invocation handle synchronously; the GraphQL
 * variables object is the operation's single input message, read from the
 * handle. Fields that take no arguments use the no-input recipe (input is
 * closed on entry and the request dispatches with empty variables), so
 * callers never have to write or close.
 */
export class GraphQLInvoker implements BindingInvoker {
  private readonly schemaCache = new Map<string, IntrospectionSchema>();

  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "GraphQL APIs" }];
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() =>
      this.run(args, inv).catch((err: unknown) => {
        inv.fireError(
          err instanceof InvocationError
            ? err
            : new InvocationError(ERR_RUNTIME, errMsg(err)),
        );
      }),
    );
    return inv as Invocation<I, O>;
  }

  private async run(args: BindingInvocationArgs, inv: InvocationImpl<unknown, unknown>): Promise<void> {
    // Pre-dispatch validation: fail before any network I/O.
    let rootType: string, fieldName: string;
    try {
      ({ rootType, fieldName } = parseRef(args.ref));
    } catch (e: unknown) {
      throw new InvocationError(ERR_INVALID_REF, errMsg(e));
    }

    if (!args.source.location) {
      throw new InvocationError(ERR_SOURCE_LOAD_FAILED, "GraphQL source requires a location (endpoint URL)");
    }

    const url = args.source.location;
    const headers = buildAuthHeaders(args.context);
    const fetchFn = args.fetch ?? fetch;

    // Resolve the query plan. A prebuilt _query const from the operation's
    // input schema dispatches without loading the schema; otherwise the
    // field is resolved from inline content or (cached) network introspection.
    let wantsInput: boolean;
    let buildFor: (input: unknown) => { query: string; variables: Record<string, unknown> | undefined };

    const prebuilt = queryFromSchema(args.inputSchema);
    if (prebuilt) {
      wantsInput = schemaDeclaresVariables(args.inputSchema);
      buildFor = (input) => ({ query: prebuilt, variables: inputToVariablesPassthrough(input) });
    } else {
      let schema: IntrospectionSchema;
      if (args.source.content != null) {
        try {
          schema = parseIntrospectionContent(args.source.content);
        } catch (e: unknown) {
          throw new InvocationError(ERR_SOURCE_LOAD_FAILED, `parse inline GraphQL content: ${errMsg(e)}`);
        }
      } else {
        try {
          schema = await this.cachedIntrospect(url, headers, fetchFn, inv.signal);
        } catch (e: unknown) {
          // A cancelled introspection fetch rejects with an AbortError, not
          // an InvocationError: cancellation is already terminal (the handle
          // fired ERR_CANCELLED), so return rather than masquerade the abort
          // as a source-load failure. Mirrors the asyncapi/HTTP runners.
          if (inv.signal.aborted) return;
          if (isAuthError(e)) throw e;
          throw new InvocationError(ERR_SOURCE_LOAD_FAILED, errMsg(e));
        }
      }

      let field: Field;
      try {
        field = resolveField(schema, rootType, fieldName);
      } catch (e: unknown) {
        throw new InvocationError(ERR_REF_NOT_FOUND, errMsg(e));
      }
      wantsInput = field.args.length > 0;
      buildFor = (input) => buildQueryFromIntrospection(schema, rootType, fieldName, input);
    }

    // The GraphQL variables object is the single input message, read from
    // the handle. No-argument fields skip the read entirely; a caller that
    // closes without writing dispatches with empty variables.
    let input: unknown = {};
    if (wantsInput) {
      input = (await readFirst(inv.inputs())) ?? {};
    }
    void inv.closeInput();

    const { query, variables } = buildFor(input);

    // Subscriptions stream over WebSocket.
    if (rootType === "Subscription") {
      // The graphql-transport-ws upgrade exposes no HTTP response headers
      // (the browser WebSocket API hides them), so there is no leading
      // metadata to surface. Settle the header to empty up front — before
      // the first emit — so a caller awaiting `header` resolves at
      // subscription start rather than blocking until the first event.
      inv.setHeader({});
      for await (const ev of subscribeGraphQL(url, query, variables, headers, inv.signal)) {
        // Always await: a rejection means the invocation terminated, and the
        // for-await teardown closes the WebSocket via the generator's finally.
        await inv.emitOutput(ev);
      }
      inv.closeOutput();
      return;
    }

    // Queries and mutations dispatch one HTTP POST.
    const { data, headers: responseHeaders } = await invokeGraphQL(
      url, query, variables, fieldName, headers, fetchFn, inv.signal,
    );
    inv.setHeader(responseHeaders);
    await inv.emitOutput(data);
    inv.closeOutput();
  }

  private async cachedIntrospect(
    url: string,
    headers: Record<string, string>,
    fetchFn: typeof globalThis.fetch,
    signal?: AbortSignal,
  ): Promise<IntrospectionSchema> {
    // Key by the full endpoint URL (origin + path + query): two GraphQL
    // endpoints on one host must not share introspected schemas.
    let key: string;
    try {
      const u = new URL(url);
      key = u.origin + u.pathname + u.search;
    } catch {
      key = url;
    }
    const cached = this.schemaCache.get(key);
    if (cached) return cached;
    const schema = await introspect(url, headers, fetchFn, signal);
    this.schemaCache.set(key, schema);
    return schema;
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

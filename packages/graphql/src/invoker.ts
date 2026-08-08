import {
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_RUNTIME,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_SOURCE_LOAD_FAILED,
  ERR_VALIDATION_FAILED,
  InvocationError,
  InvocationImpl,
  MultipleSourcesError,
  contextRequiredError,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  resolveDeliveryUnitLimit,
  synthesisSkeleton,
  type BindingInvocationArgs,
  type BindingInvoker,
  type ContextRequiredDetails,
  type CoverageSynthesizer,
  type SynthesizeInput,
  type SynthesizeResult,
  type SynthesisCoverageEntry,
  type BindingSpecInfo,
  type InterfaceSynthesizer,
  type Invocation,
  type OBInterface,
  type Source,
  type SourceInspection,
  type SourceInspector,
} from "@openbindings/sdk";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";
import { graphQLFailureEvidence } from "./failure.js";
import {
  introspect,
  invokeGraphQL,
  isAuthError,
  parseIntrospectionContent,
  parseRef,
  resolveField,
  subscribeGraphQL,
} from "./invoke.js";
import type { IntrospectionSchema } from "./introspection.js";
import { buildTypeMap, rootTypeName } from "./introspection.js";
import { convertToInterface, resolveKey, sanitizeKey, codePointCompare } from "./synthesize.js";
import {
  configurationRequirement,
  emptyMetadata,
  httpHeaders,
  readConfiguration,
  validateHTTPLocation,
  wantsCallerInput,
  websocketHeaders,
  type GraphQLWebSocketFactory,
} from "./configuration.js";
import { parseExecutableDocument } from "./document.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Reads the first input while preserving absent versus present-undefined. */
async function readFirst<T>(it: AsyncIterable<T>): Promise<{ present: boolean; value?: T }> {
  for await (const value of it) return { present: true, value };
  return { present: false };
}

/**
 * Invokes GraphQL bindings via HTTP POST (queries/mutations) or the
 * graphql-transport-ws WebSocket protocol (subscriptions). The caller
 * supplies the exact executable document through configuration; schema
 * introspection is used only to prove ref/root correspondence.
 *
 * `invokeBinding` returns the Invocation handle synchronously; the GraphQL
 * variables object is the operation's optional single input message.
 */
export class GraphQLInvoker implements BindingInvoker {
  private readonly schemaCache = new Map<string, IntrospectionSchema>();

  constructor(private readonly webSocketFactory?: GraphQLWebSocketFactory) {}

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "GraphQL APIs" }];
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => {
      void this.run(args, inv).catch((err: unknown) => {
        inv.fireError(
          err instanceof InvocationError
            ? err
            : new InvocationError(ERR_RUNTIME, errMsg(err)),
        );
      });
    });
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

    let url: string;
    try {
      url = validateHTTPLocation(args.source.location);
    } catch (e: unknown) {
      throw new InvocationError(ERR_SOURCE_CONFIG_ERROR, errMsg(e));
    }

    let configuration;
    try {
      configuration = readConfiguration(args.context);
    } catch (e: unknown) {
      throw new InvocationError(ERR_SOURCE_CONFIG_ERROR, errMsg(e));
    }
    if (!configuration.document) {
      throw contextRequiredError(
        "GraphQL invocation requires an executable document",
        configurationRequirement(url, "document", "supply the exact GraphQL executable document and optional operationName"),
      );
    }
    if (rootType === "subscription" && !configuration.subscriptionTarget) {
      throw contextRequiredError(
        "GraphQL subscription requires a WebSocket target",
        configurationRequirement(url, "subscriptionTarget", "supply an absolute ws or wss GraphQL subscription target"),
      );
    }
    let document;
    try {
      document = parseExecutableDocument(configuration.document.source);
    } catch (e: unknown) {
      throw new InvocationError(ERR_SOURCE_CONFIG_ERROR, `parse configuration.document: ${errMsg(e)}`);
    }
    let headers: Record<string, string>;
    let wsHeaders: Record<string, string> = {};
    try {
      headers = httpHeaders(configuration, args.context);
      if (rootType === "subscription") wsHeaders = websocketHeaders(configuration);
    } catch (e: unknown) {
      throw new InvocationError(ERR_SOURCE_CONFIG_ERROR, errMsg(e));
    }
    if (rootType === "subscription" && Object.keys(wsHeaders).length > 0 && !this.webSocketFactory) {
      throw new InvocationError(
        ERR_SOURCE_CONFIG_ERROR,
        "configuration.protocolFields websocket headers or cookies require a GraphQLWebSocketFactory that can carry WebSocket upgrade headers",
      );
    }
    const fetchFn = args.fetch ?? fetch;
    // One resolved delivery-unit bound for every body this invocation reads
    // (the response, and an introspection load when the plan needs one —
    // both flow through doGraphQLHTTP, the lane's single bounded reader).
    const maxResponseBytes = resolveDeliveryUnitLimit(args);

    let schema: IntrospectionSchema;
    if (args.source.content !== undefined) {
      try {
        schema = parseIntrospectionContent(args.source.content);
      } catch (e: unknown) {
        throw new InvocationError(ERR_SOURCE_LOAD_FAILED, `parse inline GraphQL content: ${errMsg(e)}`);
      }
    } else {
      try {
        schema = await this.cachedIntrospect(url, headers, fetchFn, inv.signal, maxResponseBytes);
      } catch (e: unknown) {
        if (inv.signal.aborted) return;
        if (isAuthError(e)) throw e;
        throw new InvocationError(ERR_SOURCE_LOAD_FAILED, errMsg(e));
      }
    }
    try {
      resolveField(schema, rootType, fieldName);
    } catch (e: unknown) {
      throw new InvocationError(ERR_REF_NOT_FOUND, errMsg(e));
    }

    let variables: Record<string, unknown> | undefined;
    if (wantsCallerInput(args)) {
      const input = await readFirst(inv.inputs());
      if (input.present) {
        if (input.value === null || typeof input.value !== "object" || Array.isArray(input.value)) {
          throw new InvocationError(ERR_VALIDATION_FAILED, "GraphQL caller input must be one JSON object used wholesale as variables");
        }
        variables = input.value as Record<string, unknown>;
      }
    }
    void inv.closeInput();

    try {
      document.verifySelection(
        configuration.document.operationName,
        rootType,
        fieldName,
        variables,
        schema,
      );
    } catch (e: unknown) {
      throw new InvocationError(
        ERR_SOURCE_CONFIG_ERROR,
        `configured document does not denote binding ref ${JSON.stringify(args.ref)}: ${errMsg(e)}`,
      );
    }

    // Subscriptions stream over WebSocket.
    if (rootType === "subscription") {
      // The graphql-transport-ws upgrade exposes no HTTP response headers
      // (the browser WebSocket API hides them), so there is no leading
      // metadata to surface. Settle the header to empty up front — before
      // the first emit — so a caller awaiting `header` resolves at
      // subscription start rather than blocking until the first event.
      inv.setHeader(emptyMetadata());
      for await (const ev of subscribeGraphQL(
        configuration.subscriptionTarget!,
        configuration.document,
        variables,
        wsHeaders,
        configuration.protocol.connectionInitPayload,
        configuration.protocol.connectionInitPayloadSet,
        maxResponseBytes,
        inv.signal,
        this.webSocketFactory,
      )) {
        // Always await: a rejection means the invocation terminated, and the
        // for-await teardown closes the WebSocket via the generator's finally.
        await inv.emitOutput(ev);
      }
      inv.closeOutput();
      return;
    }

    // Queries and mutations dispatch one HTTP POST.
    let invoked: Awaited<ReturnType<typeof invokeGraphQL>>;
    try {
      invoked = await invokeGraphQL(
        url,
        configuration.document.source,
        configuration.document.operationName,
        variables,
        headers,
        fetchFn,
        inv.signal,
        maxResponseBytes,
      );
    } catch (error: unknown) {
      const evidence = graphQLFailureEvidence(error);
      if (evidence?.httpResponse) inv.setHeader(evidence.httpResponse.headers);
      throw error;
    }
    const { response, headers: responseHeaders } = invoked;
    inv.setHeader(responseHeaders);
    await inv.emitOutput(response);
    inv.closeOutput();
  }

  /** Side-effect-free configuration preflight. */
  prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
    let rootType: string;
    try {
      ({ rootType } = parseRef(args.ref));
      validateHTTPLocation(args.source.location);
    } catch {
      return Promise.resolve(null);
    }
    const url = args.source.location!;
    const configuration = readConfiguration(args.context);
    if (!configuration.document) {
      return Promise.resolve(configurationRequirement(url, "document", "supply the exact GraphQL executable document and optional operationName"));
    }
    if (rootType === "subscription" && !configuration.subscriptionTarget) {
      return Promise.resolve(configurationRequirement(url, "subscriptionTarget", "supply an absolute ws or wss GraphQL subscription target"));
    }
    return Promise.resolve(null);
  }

  private async cachedIntrospect(
    url: string,
    headers: Record<string, string>,
    fetchFn: typeof globalThis.fetch,
    signal?: AbortSignal,
    maxResponseBytes?: number,
  ): Promise<IntrospectionSchema> {
    const key = introspectionCacheKey(url, headers);
    const cached = this.schemaCache.get(key);
    if (cached) return cached;
    const schema = await introspect(url, headers, fetchFn, signal, maxResponseBytes);
    this.schemaCache.set(key, schema);
    return schema;
  }
}

/**
 * Normalizes an endpoint URL to a schema cache key, preserving the full
 * target (origin + path + query) — keying by origin alone would let two
 * endpoints on one host share a schema (wrong results). Host case is
 * already normalized by the URL parser; a trailing slash and surrounding
 * whitespace still collapse to one key (Go parity: introspectionCacheKey
 * in invoker.go).
 */
function introspectionCacheKey(endpoint: string, headers: Record<string, string> = {}): string {
  const trimmed = endpoint.trim();
  try {
    const u = new URL(trimmed);
    const path = u.pathname.replace(/\/+$/, "");
    const identity = Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort(([a], [b]) => codePointCompare(a, b))
      .map(([name, value]) => `\0${name}:${value}`)
      .join("");
    return u.origin + path + u.search + identity;
  } catch {
    return trimmed;
  }
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

/** Synthesizes OBInterface definitions by introspecting GraphQL endpoints. */
export class GraphQLSynthesizer implements InterfaceSynthesizer, CoverageSynthesizer, SourceInspector {
  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "GraphQL APIs" }];
  }

  async synthesizeInterface(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    const { iface } = await this.synthesizeObserved(input, options);
    return iface;
  }

  async synthesizeInterfaceWithCoverage(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<SynthesizeResult> {
    const { iface, schema } = await this.synthesizeObserved(input, options);
    return finalizeSynthesisCoverage(
      iface,
      schema ? graphQLSynthesisCoverage(iface) : [],
      true,
    );
  }

  private async synthesizeObserved(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<{ iface: OBInterface; schema?: IntrospectionSchema }> {
    const sources = input.sources ?? [];
    const src = sources[0];
    if (src === undefined) return { iface: synthesisSkeleton(input) };
    if (sources.length > 1) throw new MultipleSourcesError();
    if (src.bindingSpec !== BINDING_SPEC) {
      throw new Error(`synthesizer supports exact binding specification ${JSON.stringify(BINDING_SPEC)}, got ${JSON.stringify(src.bindingSpec)}`);
    }
    const location = validateHTTPLocation(src.location);
    if (src.outputLocation) validateHTTPLocation(src.outputLocation);

    let schema: IntrospectionSchema;
    let artifactContent: unknown;
    if (src.content !== undefined) {
      schema = parseIntrospectionContent(src.content);
      artifactContent = src.content;
    } else {
      schema = await introspect(location, {}, fetch, options?.signal);
      if (src.embed) artifactContent = { data: { __schema: schema } };
    }
    const iface = convertToInterface(schema, location);
    if (artifactContent !== undefined) {
      iface.sources![DEFAULT_SOURCE_NAME]!.content = artifactContent;
    }
    return {
      iface: finalizeSynthesis(iface, input, DEFAULT_SOURCE_NAME, BINDING_SPEC),
      schema,
    };
  }

  /** Lists all bindable query/mutation/subscription root fields. */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    const location = validateHTTPLocation(source.location);
    const schema = source.content !== undefined
      ? parseIntrospectionContent(source.content)
      : await introspect(location, {}, fetch, options?.signal);
    const targets: SourceInspection["targets"] = [];
    const tm = buildTypeMap(schema);

    const rootTypes: Array<{ label: string; typeName: string | null }> = [
      { label: "query", typeName: rootTypeName(schema, "query") },
      { label: "mutation", typeName: rootTypeName(schema, "mutation") },
      { label: "subscription", typeName: rootTypeName(schema, "subscription") },
    ];

    // Suggest the same operation key convertToInterface assigns (same
    // sanitizeKey + resolveKey collision resolution against the root type),
    // so an inspection previews exactly what synthesis names (Go parity:
    // list_refs.go).
    const usedKeys = new Map<string, string>();
    for (const rt of rootTypes) {
      if (!rt.typeName) continue;
      const t = tm.get(rt.typeName);
      if (!t?.fields) continue;
      for (const f of [...t.fields].sort((a, b) => codePointCompare(a.name, b.name))) {
        if (f.name.startsWith("__")) continue;
        const ref = `${rt.label}/${f.name}`;
        const operationKey = resolveKey(sanitizeKey(f.name), rt.label.toLowerCase(), usedKeys);
        usedKeys.set(operationKey, ref);
        const desc = f.description || undefined;
        targets.push({ ref, operationKey, operation: desc ? { description: desc } : undefined });
      }
    }

    return { targets, exhaustive: true };
  }
}

function graphQLSynthesisCoverage(iface: OBInterface): SynthesisCoverageEntry[] {
  return Object.entries(iface.bindings ?? {})
    .sort(([, a], [, b]) => codePointCompare(a.ref ?? "", b.ref ?? ""))
    .map(([bindingKey, binding]) => ({
      sourceIndex: 0,
      sourceRef: binding.ref!,
      scope: "target" as const,
      status: "represented" as const,
      operationKey: binding.operation,
      bindingKey,
      bindingRef: binding.ref!,
      requirements: binding.ref!.startsWith("subscription/")
        ? ["document", "subscriptionTarget"]
        : ["document"],
    }));
}

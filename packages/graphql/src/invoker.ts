import { checkBindingSpecs as checkBindingSpecSupport } from "@openbindings/core";
import { type BindingSpecInfo, type BindingSpecVerdict, type OBInterface, type Source } from "@openbindings/core";
import {
  ERR_INVALID_SELECTOR,
  ERR_EXECUTION_FAILED,
  ERR_SELECTOR_NOT_FOUND,
  ERR_RUNTIME,
  ERR_RESPONSE_ERROR,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_SOURCE_LOAD_FAILED,
  ERR_VALIDATION_FAILED,
  InvocationError,
  InvocationImpl,
  contextRequiredError,
  resolveDeliveryUnitLimit,
  type BindingInvocationArgs,
  type BindingInvoker,
  type ContextRequiredDetails,
  type Invocation,
} from "@openbindings/invoke";
import {
  MultipleSourcesError,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  synthesisSkeleton,
  type CoverageSynthesizer,
  type SynthesizeInput,
  type SynthesizeResult,
  type SynthesisCoverageEntry,
  type InterfaceSynthesizer,
  type SourceInspection,
  type SourceInspector,
} from "@openbindings/synthesize";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";
import {
  introspect,
  invokeGraphQL,
  parseIntrospectionContent,
  parseSelector,
  resolveField,
  subscribeGraphQL,
} from "./invoke.js";
import type { IntrospectionSchema } from "./introspection.js";
import { buildTypeMap, rootTypeName } from "./introspection.js";
import { convertToInterface, resolveKey, sanitizeKey, codePointCompare } from "./synthesize.js";
import {
  configurationRequirement,
  httpHeaders,
  readConfiguration,
  validateHTTPLocation,
  wantsCallerInput,
  websocketHeaders,
  type GraphQLWebSocketFactory,
} from "./configuration.js";
import { parseExecutableDocument } from "./document.js";

/** Reads the first input while preserving absent versus present-undefined. */
async function readFirst<T>(it: AsyncIterable<T>): Promise<{ present: boolean; value?: T }> {
  for await (const value of it) return { present: true, value };
  return { present: false };
}

function graphQLBindingSpecs(): BindingSpecInfo[] {
  return [{ bindingSpec: BINDING_SPEC, description: "GraphQL query and mutation application values" }];
}

function checkGraphQLBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
  return checkBindingSpecSupport(bindingSpecs, graphQLBindingSpecs());
}

/**
 * Invokes GraphQL bindings via HTTP POST (queries/mutations) or the
 * graphql-transport-ws WebSocket protocol (subscriptions). The caller
 * supplies the exact executable document through configuration; schema
 * introspection is used only to prove selector/root correspondence.
 *
 * `invokeBinding` returns the Invocation handle synchronously; the GraphQL
 * variables object is the operation's optional single input message.
 */
export class GraphQLInvoker implements BindingInvoker {
  private readonly schemaCache = new Map<string, IntrospectionSchema>();

  constructor(private readonly webSocketFactory?: GraphQLWebSocketFactory) {}

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return checkGraphQLBindingSpecs(bindingSpecs);
  }

  bindingSpecs(): BindingSpecInfo[] {
    return graphQLBindingSpecs();
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => {
      void this.run(args, inv).catch((err: unknown) => {
        inv.fireError(
          err instanceof InvocationError
            ? err
            : new InvocationError(ERR_RUNTIME),
        );
      });
    });
    return inv as Invocation<I, O>;
  }

  private async run(args: BindingInvocationArgs, inv: InvocationImpl<unknown, unknown>): Promise<void> {
    // Pre-dispatch validation: fail before any network I/O.
    let rootType: string, fieldName: string;
    try {
      ({ rootType, fieldName } = parseSelector(args.selector));
    } catch {
      throw new InvocationError(ERR_INVALID_SELECTOR);
    }
    if (args.source.bindingSpec !== BINDING_SPEC) {
      throw new InvocationError(ERR_SOURCE_CONFIG_ERROR);
    }
    if (rootType === "subscription") {
      throw new InvocationError(ERR_INVALID_SELECTOR);
    }

    let url: string;
    try {
      url = validateHTTPLocation(args.source.location);
    } catch {
      throw new InvocationError(ERR_SOURCE_CONFIG_ERROR);
    }

    let configuration;
    try {
      configuration = readConfiguration(args.context);
    } catch {
      throw new InvocationError(ERR_SOURCE_CONFIG_ERROR);
    }
    if (!configuration.document) {
      throw contextRequiredError(configurationRequirement(url, "document", "supply the exact GraphQL executable document and optional operationName"));
    }
    if (rootType === "subscription" && !configuration.subscriptionTarget) {
      throw contextRequiredError(configurationRequirement(url, "subscriptionTarget", "supply an absolute ws or wss GraphQL subscription target"));
    }
    let document;
    try {
      document = parseExecutableDocument(configuration.document.source);
    } catch {
      throw new InvocationError(ERR_SOURCE_CONFIG_ERROR);
    }
    let headers: Record<string, string>;
    let wsHeaders: Record<string, string> = {};
    try {
      headers = httpHeaders(configuration, args.context);
      if (rootType === "subscription") wsHeaders = websocketHeaders(configuration);
    } catch {
      throw new InvocationError(ERR_SOURCE_CONFIG_ERROR);
    }
    if (rootType === "subscription" && Object.keys(wsHeaders).length > 0 && !this.webSocketFactory) {
      throw new InvocationError(ERR_SOURCE_CONFIG_ERROR);
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
      } catch {
        throw new InvocationError(ERR_SOURCE_LOAD_FAILED);
      }
    } else {
      try {
        schema = await this.cachedIntrospect(url, headers, fetchFn, inv.signal, maxResponseBytes);
      } catch {
        if (inv.signal.aborted) return;
        throw new InvocationError(ERR_SOURCE_LOAD_FAILED);
      }
    }
    try {
      resolveField(schema, rootType, fieldName);
    } catch {
      throw new InvocationError(ERR_SELECTOR_NOT_FOUND);
    }

    let variables: Record<string, unknown> | undefined;
    if (wantsCallerInput(args)) {
      const input = await readFirst(inv.inputs());
      if (input.present) {
        if (input.value === null || typeof input.value !== "object" || Array.isArray(input.value)) {
          throw new InvocationError(ERR_VALIDATION_FAILED);
        }
        variables = input.value as Record<string, unknown>;
      }
    }
    void inv.closeInput();

    let responseKey: string;
    try {
      responseKey = document.responseKey(
        configuration.document.operationName,
        rootType,
        fieldName,
        variables,
        schema,
      );
    } catch {
      throw new InvocationError(ERR_SOURCE_CONFIG_ERROR);
    }

    // Subscriptions stream over WebSocket.
    if (rootType === "subscription") {
      // graphql-transport-ws native upgrade evidence remains below the
      // abstract invocation boundary.
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
    const invoked = await invokeGraphQL(
      url,
      configuration.document.source,
      configuration.document.operationName,
      variables,
      headers,
      fetchFn,
      inv.signal,
      maxResponseBytes,
    );
    await emitProjectedGraphQLResult(inv, invoked.response, responseKey);
  }

  /** Side-effect-free configuration preflight. */
  prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
    let rootType: string;
    try {
      ({ rootType } = parseSelector(args.selector));
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
  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return checkGraphQLBindingSpecs(bindingSpecs);
  }

  bindingSpecs(): BindingSpecInfo[] {
    return graphQLBindingSpecs();
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
      schema ? graphQLSynthesisCoverage(schema, iface, iface.sources?.[DEFAULT_SOURCE_NAME]?.bindingSpec ?? BINDING_SPEC) : [],
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
    const iface = convertToInterface(schema, location, src.bindingSpec);
    if (artifactContent !== undefined) {
      iface.sources![DEFAULT_SOURCE_NAME]!.content = artifactContent;
    }
    return {
      iface: finalizeSynthesis(iface, input, DEFAULT_SOURCE_NAME, src.bindingSpec),
      schema,
    };
  }

  /** Lists the root fields bindable under the source's exact revision. */
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

    let rootTypes: Array<{ label: string; typeName: string | null }> = [
      { label: "query", typeName: rootTypeName(schema, "query") },
      { label: "mutation", typeName: rootTypeName(schema, "mutation") },
      { label: "subscription", typeName: rootTypeName(schema, "subscription") },
    ];
    const bindingSpec = source.bindingSpec || BINDING_SPEC;
    if (bindingSpec === BINDING_SPEC) rootTypes = rootTypes.slice(0, 2);

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
        const selector = `${rt.label}/${f.name}`;
        const operationKey = resolveKey(sanitizeKey(f.name), rt.label.toLowerCase(), usedKeys);
        usedKeys.set(operationKey, selector);
        const desc = f.description || undefined;
        targets.push({ selector, operationKey, operation: desc ? { description: desc } : undefined });
      }
    }

    return { targets, exhaustive: true };
  }
}

function graphQLSynthesisCoverage(
  schema: IntrospectionSchema,
  iface: OBInterface,
  bindingSpec: string,
): SynthesisCoverageEntry[] {
  const entries: SynthesisCoverageEntry[] = Object.entries(iface.bindings ?? {})
    .sort(([, a], [, b]) => codePointCompare(a.selector ?? "", b.selector ?? ""))
    .map(([bindingKey, binding]) => ({
      sourceIndex: 0,
      sourceRef: binding.selector!,
      scope: "target" as const,
      status: "represented" as const,
      operationKey: binding.operation,
      bindingKey,
      bindingSelector: binding.selector!,
      requirements: binding.selector!.startsWith("subscription/")
        ? ["document", "subscriptionTarget"]
        : ["document"],
    }));
  if (bindingSpec === BINDING_SPEC) {
    const tm = buildTypeMap(schema);
    const root = tm.get(rootTypeName(schema, "subscription") ?? "");
    for (const field of [...(root?.fields ?? [])].sort((a, b) => codePointCompare(a.name, b.name))) {
      if (field.name.startsWith("__")) continue;
      entries.push({
        sourceIndex: 0,
        sourceRef: `subscription/${field.name}`,
        scope: "target",
        status: "excluded",
        reasonCode: "graphql.subscription_lifecycle_not_representable",
        rule: "GQL-P-04",
        message: "subscription events may carry partial data and errors while the native stream continues; the first-revision candidate does not approximate that lifecycle",
        requirements: [],
      });
    }
    entries.sort((a, b) => codePointCompare(a.sourceRef, b.sourceRef));
  }
  return entries;
}

async function emitProjectedGraphQLResult(
  inv: InvocationImpl<unknown, unknown>,
  response: Record<string, unknown>,
  responseKey: string,
): Promise<void> {
  const data = response.data !== null && typeof response.data === "object" && !Array.isArray(response.data)
    ? response.data as Record<string, unknown>
    : undefined;
  const present = data !== undefined && Object.hasOwn(data, responseKey);
  if (present) await inv.emitOutput(data[responseKey]);
  if (Object.hasOwn(response, "errors")) {
    inv.fireError(new InvocationError(ERR_EXECUTION_FAILED));
    return;
  }
  if (!present) {
    inv.fireError(new InvocationError(ERR_RESPONSE_ERROR));
    return;
  }
  inv.closeOutput();
}

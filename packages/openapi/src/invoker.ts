import { checkBindingSpecs as checkBindingSpecSupport } from "@openbindings/core";
import { type BindingSpecInfo, type BindingSpecVerdict, type OBInterface, type Source } from "@openbindings/core";
import {
  CONTEXT_REQUIRED,
  InvocationError,
  InvocationImpl,
  isContextRequiredDetails,
  type BindingInvoker,
  type BindingInvocationArgs,
  type ContextRequiredDetails,
  type Invocation,
  type Metadata,
} from "@openbindings/invoke";
import {
  MultipleSourcesError,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  synthesisSkeleton,
  type SynthesizeInput,
  type InterfaceSynthesizer,
  type CoverageSynthesizer,
  type SynthesizeResult,
  type SourceInspection,
  type SourceInspector,
} from "@openbindings/synthesize";
import {
  OPENAPI_USE_DEFAULT,
  OpenAPIEngine,
  OpenAPIExecutionError,
  openAPIPortableFailureData,
  type OpenAPIExecution,
  type OpenAPIExecutionProfile,
  type OpenAPIExecutionHooks,
  type OpenAPIEngineSecurityHandler,
  type OpenAPIHookResult,
} from "@openbindings/openapi-client/engine";
import type {
  OpenAPIDocument,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIPathItem,
} from "./types.js";
import {
  DEFAULT_SOURCE_NAME,
  BINDING_SPEC_OPENAPI_30,
  BINDING_SPEC_OPENAPI_31,
  ERR_UNSUPPORTED_BINDING_SPEC,
  checkAcceptedOpenAPIEdition,
  profileForBindingSpec,
} from "./constants.js";
import { convertToInterface, type UnrealizableTarget } from "./synthesize.js";
import type { AcceptanceFloor } from "@openbindings/openapi-client/analysis";
import { openAPISynthesisCoverage } from "./coverage.js";
import {
  codePointCompare,
  loadOpenAPIDocument,
  parseSelector,
  validateDocumentAddress,
} from "./util.js";
import {
  FAMILY_JSON,
  configureRequestMedia,
  isJSONMediaType,
  planRequestBodies,
  type BodyPlan,
} from "./media.js";
import {
  duplicateEffectiveParameterIdentity,
  effectiveParameters,
  requestBodyIgnoredForBindingSpec,
} from "./params.js";
import {
  engineInputForCallerEnvelope,
  planAbstractInputRoutes,
  type AbstractInputRoutes,
} from "./input-routes-v2.js";
import {
  normalizeAuthoringLocation,
  readAuthoringArtifact,
} from "./platform.js";

// ---------------------------------------------------------------------------
// Invoker
// ---------------------------------------------------------------------------

function openAPIBindingSpecs(): BindingSpecInfo[] {
  return [
    { bindingSpec: BINDING_SPEC_OPENAPI_30, description: "OpenAPI 3.0 HTTP APIs" },
    { bindingSpec: BINDING_SPEC_OPENAPI_31, description: "OpenAPI 3.1 HTTP APIs" },
  ];
}

function checkOpenAPIBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
  return checkBindingSpecSupport(bindingSpecs, openAPIBindingSpecs());
}

/** Invokes OpenAPI bindings by performing HTTP requests against the described API. */
export interface OpenAPIInvokerOptions {
  engine?: OpenAPIEngine;
  /**
   * Artifact-scheme handlers for mechanisms the built-in OpenAPI credential
   * adapter cannot apply, keyed by the authored security-scheme name.
   */
  securityHandlers?: Record<string, OpenAPIEngineSecurityHandler>;
}

export class OpenAPIInvoker implements BindingInvoker {
  private readonly engine: OpenAPIEngine;
  private readonly securityHandlers?: Record<string, OpenAPIEngineSecurityHandler>;

  constructor(options: OpenAPIInvokerOptions = {}) {
    this.engine = options?.engine ?? new OpenAPIEngine();
    this.securityHandlers = options.securityHandlers
      ? { ...options.securityHandlers }
      : undefined;
  }

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return checkOpenAPIBindingSpecs(bindingSpecs);
  }

  /** Returns the binding specifications this invoker supports, by exact identifier. */
  bindingSpecs(): BindingSpecInfo[] {
    return openAPIBindingSpecs();
  }

  /**
   * Returns the invocation handle synchronously; the HTTP work is scheduled
   * asynchronously. Input messages flow through the handle's `write`
   * channel. All pre-dispatch failures (bad selector, missing server URL,
   * unresolvable operation, missing context) terminate the handle before
   * any network side effect.
   */
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const invocation = new InvocationImpl<I, O>({ signal: args.signal });
    queueMicrotask(() => {
      this.runAdapter(args, invocation).catch((error: unknown) => {
        invocation.fireError(toSDKError(error));
      });
    });
    return invocation;
  }

  /**
   * Side-effect-free preflight (the `prepareBinding` operation of the
   * openbindings.binding-invoker role): derives the operation's auth
   * requirements from the document's securitySchemes and reports the
   * context the invocation would require, or null when it can proceed.
   *
   * Uses the source content or a previously cached document; never
   * fetches. When the document would have to be fetched to learn its
   * security schemes, reports no requirement and lets the invocation
   * raise the challenge instead.
   */
  async prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
    const profile = profileForInvocation(args.source.bindingSpec);
    try {
      const prepared = await this.engine.prepareCached({
        source: { location: args.source.location, content: args.source.content },
        // The standalone client engine's own API names the selector `ref`.
        ref: args.selector,
        profile,
        context: args.context,
        signal: args.signal,
        fetch: args.fetch,
        hooks: adaptHooks(args),
        maxDeliveryUnitBytes: args.maxDeliveryUnitBytes,
        securityHandlers: this.securityHandlers,
      });
      return prepared?.prerequisites ?? null;
    } catch {
      // The optional prepareBinding surface reports context only. Source and
      // operation failures remain authoritative on the invocation terminal.
      return null;
    }
  }

  private async runAdapter<I, O>(
    args: BindingInvocationArgs,
    outer: InvocationImpl<I, O>,
  ): Promise<void> {
    const bindingSpec = args.source.bindingSpec;
    const profile = profileForInvocation(bindingSpec);
    const model = await loadRuntimeOperationModel(args, bindingSpec);
    const prepared = await this.engine.prepare({
      // The model is an adapter-local loaded view: edition and method-body
      // gates have already run, and ignored requestBody declarations have
      // been removed before the standalone engine sees the operation.
      source: { location: args.source.location, content: model.engineContent },
      // The standalone client engine's own API names the selector `ref`.
      ref: args.selector,
      profile,
      context: args.context,
      signal: outer.signal,
      fetch: adaptRuntimeFetch(args.fetch ?? globalThis.fetch, model),
      hooks: adaptHooks(args),
      maxDeliveryUnitBytes: args.maxDeliveryUnitBytes,
      securityHandlers: this.securityHandlers,
    });
    // start() resolves only after all artifact/configuration checks that do
    // not require application input. Only then does the bridge acquire the
    // SDK input sequence.
    const execution = await prepared.start<I, O>();
    const selectedPlans = configuredRequestPlans(
      model.plans,
      args.context,
      profile,
      model.document.openapi,
    );
    await bridgeExecution(execution, outer, (input) => engineInputForCallerEnvelope(
      input,
      model.parameters,
      selectedPlans,
      model.routes,
      profile,
    ));
  }
}

interface RuntimeOperationModel {
  document: OpenAPIDocument;
  engineContent: unknown;
  operation: OpenAPIOperation;
  parameters: OpenAPIParameter[];
  plans: BodyPlan[];
  routes: AbstractInputRoutes;
  typeAbsentParts: string[];
}

function unsupportedBindingSpecError(bindingSpec: string): InvocationError {
  const data: Record<string, unknown> = { bindingSpec };
  if (bindingSpec === "") {
    data.message = "name an exact OpenAPI family token in Source.BindingSpec";
  }
  return new InvocationError(ERR_UNSUPPORTED_BINDING_SPEC, data);
}

function profileForInvocation(bindingSpec: string): OpenAPIExecutionProfile {
  try {
    return profileForBindingSpec(bindingSpec);
  } catch {
    throw unsupportedBindingSpecError(bindingSpec);
  }
}

async function loadRuntimeOperationModel(
  args: BindingInvocationArgs,
  bindingSpec: string,
): Promise<RuntimeOperationModel> {
  let document: OpenAPIDocument;
  let rawDocument: unknown;
  try {
    document = await loadOpenAPIDocument(
      args.source.location,
      args.source.content,
      {
        signal: args.signal,
        onRawDocument: (raw) => { rawDocument = structuredClone(raw); },
      },
      args.fetch,
    );
  } catch {
    throw new InvocationError("ERR_SOURCE_LOAD_FAILED");
  }
  try {
    checkAcceptedOpenAPIEdition(bindingSpec, document.openapi);
  } catch {
    throw new InvocationError("ERR_SOURCE_LOAD_FAILED");
  }

  let target: { path: string; method: string };
  try {
    target = parseSelector(args.selector);
  } catch {
    throw new InvocationError("ERR_INVALID_SELECTOR");
  }
  const rawPathItem = document.paths?.[target.path];
  if (!rawPathItem || typeof rawPathItem !== "object") {
    throw new InvocationError("ERR_SELECTOR_NOT_FOUND");
  }
  const pathItem = rawPathItem as OpenAPIPathItem;
  const rawOperation = pathItem[target.method];
  if (!rawOperation || typeof rawOperation !== "object") {
    throw new InvocationError("ERR_SELECTOR_NOT_FOUND");
  }
  const operation = rawOperation as OpenAPIOperation;
  const parameters = effectiveParameters(pathItem, operation);
  if (duplicateEffectiveParameterIdentity(parameters)) {
    throw new InvocationError("ERR_REFUSED");
  }

  if (requestBodyIgnoredForBindingSpec(bindingSpec, target.method)) {
    delete operation.requestBody;
  }
  const typeAbsentParts = multipartTypeAbsentParts(operation);
  if (bindingSpec === BINDING_SPEC_OPENAPI_30 && typeAbsentParts.length > 0) {
    const configuration = asRecord(args.context?.configuration);
    const partMedia = asRecord(configuration?.partMedia);
    const missing = typeAbsentParts.find((name) => typeof partMedia?.[name] !== "string");
    if (missing !== undefined) {
      throw new InvocationError(CONTEXT_REQUIRED, {
        target: args.source.location ?? "",
        alternatives: [{ requirements: [{
          type: "config.value",
          point: "partMedia",
          path: `/${missing.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        }] }],
      });
    }
  }
  if (bindingSpec === BINDING_SPEC_OPENAPI_31) {
    adaptOpenAPI31TypeAbsentParts(operation);
  }
  prioritizeNoncollidingRequestMedia(operation, parameters);
  let plans: BodyPlan[] = [];
  let forcedJSONEnvelope = false;
  if (operation.requestBody) {
    try {
      plans = planRequestBodies(operation, {
        profile: profileForInvocation(bindingSpec),
        openapiVersion: document.openapi,
        inventoryUnsupported: true,
      });
      if (forceJSONBodyEnvelopeCarriage(plans)) {
        forcedJSONEnvelope = true;
        plans = planRequestBodies(operation, {
          profile: profileForInvocation(bindingSpec),
          openapiVersion: document.openapi,
          inventoryUnsupported: true,
        });
      }
    } catch {
      throw new InvocationError("ERR_SOURCE_CONFIG_ERROR");
    }
  }
  const routes = planAbstractInputRoutes(parameters, plans);
  // A fully dereferenced recursive schema is cyclic. Passing that adapter
  // view through the standalone engine's loader a second time cannot preserve
  // its graph, so let the engine load the original authored artifact in that
  // one case. Non-cyclic views retain the method/body adaptations above.
  const engineContent = hasObjectCycle(document)
    ? cyclicEngineDocument(rawDocument, target, bindingSpec, forcedJSONEnvelope)
    : document;
  return { document, engineContent, operation, parameters, plans, routes, typeAbsentParts };
}

function cyclicEngineDocument(
  raw: unknown,
  target: { path: string; method: string },
  bindingSpec: string,
  forcedJSONEnvelope: boolean,
): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const document = raw as OpenAPIDocument;
  const rawOperation = document.paths?.[target.path]?.[target.method];
  if (!rawOperation || typeof rawOperation !== "object") return raw;
  const operation = rawOperation as OpenAPIOperation;
  if (requestBodyIgnoredForBindingSpec(bindingSpec, target.method)) {
    delete operation.requestBody;
    return document;
  }
  if (!forcedJSONEnvelope) return document;
  for (const media of Object.values(operation.requestBody?.content ?? {})) {
    const schema = media.schema;
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) continue;
    media.schema = bindingSpec === BINDING_SPEC_OPENAPI_30
      ? { allOf: [schema], additionalProperties: true }
      : { ...schema, additionalProperties: true };
  }
  return document;
}

function hasObjectCycle(root: unknown): boolean {
  const visiting = new WeakSet<object>();
  const visited = new WeakSet<object>();
  const walk = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return false;
    const object = value as object;
    if (visiting.has(object)) return true;
    if (visited.has(object)) return false;
    visiting.add(object);
    for (const member of Object.values(value as Record<string, unknown>)) {
      if (walk(member)) return true;
    }
    visiting.delete(object);
    visited.add(object);
    return false;
  };
  return walk(root);
}

function forceJSONBodyEnvelopeCarriage(plans: BodyPlan[]): boolean {
  if (plans.length !== 1) return false;
  let changed = false;
  for (const plan of plans) {
    if (plan.family !== FAMILY_JSON || plan.synthetic || plan.wholeObject || !plan.media) continue;
    const schema = plan.media.schema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) continue;
    schema.additionalProperties = true;
    changed = true;
  }
  return changed;
}

function multipartTypeAbsentParts(operation: OpenAPIOperation): string[] {
  const content = operation.requestBody?.content;
  const media = content?.["multipart/form-data"];
  const schema = media?.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.entries(properties as Record<string, unknown>)
    .filter(([, raw]) => raw !== null && typeof raw === "object" && !Array.isArray(raw)
      && !("type" in (raw as Record<string, unknown>)))
    .map(([name]) => name)
    .sort(codePointCompare);
}

/** Invocation-local bridge for the 3.1 authority's type-absent octet part row. */
function adaptOpenAPI31TypeAbsentParts(operation: OpenAPIOperation): void {
  const content = operation.requestBody?.content;
  const media = content?.["multipart/form-data"];
  const schema = media?.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
  for (const name of multipartTypeAbsentParts(operation)) {
    const raw = (properties as Record<string, unknown>)[name] as Record<string, unknown>;
    (properties as Record<string, unknown>)[name] = {
      ...raw,
      type: "string",
      contentEncoding: "base64",
    };
  }
}

function prioritizeNoncollidingRequestMedia(
  operation: OpenAPIOperation,
  parameters: OpenAPIParameter[],
): void {
  const content = operation.requestBody?.content;
  if (!content || Object.keys(content).length < 2) return;
  const parameterNames = new Set(parameters.map((parameter) => parameter.name ?? ""));
  const scored = Object.entries(content).map(([mediaType, media], index) => {
    const schema = media.schema;
    const properties = schema && typeof schema === "object" && !Array.isArray(schema)
      && schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? Object.keys(schema.properties as Record<string, unknown>)
      : [];
    return {
      mediaType,
      media,
      index,
      collisions: properties.filter((name) => parameterNames.has(name)).length,
    };
  });
  scored.sort((a, b) => a.collisions - b.collisions || a.index - b.index);
  operation.requestBody!.content = Object.fromEntries(
    scored.map(({ mediaType, media }) => [mediaType, media]),
  );
}

/** Repairs the wire-only 3.1 type-absent part cell after the legacy client serializes it. */
function adaptRuntimeFetch(
  fetchFn: typeof globalThis.fetch,
  model: RuntimeOperationModel,
): typeof globalThis.fetch {
  return async (input, init) => {
    if (!init?.body) return fetchFn(input, init);
    const text = bodyText(init.body);
    const contentType = new Headers(init.headers).get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (
      model.operation.requestBody?.required
      && contentType !== undefined
      && isJSONMediaType(contentType)
      && text?.trim() === "{}"
    ) {
      throw new InvocationError("ERR_REFUSED");
    }

    let next: RequestInit = init;
    if (text !== undefined) {
      try {
        const value = JSON.parse(text) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const keys = Object.keys(value as Record<string, unknown>);
          const selected = model.plans.find((plan) =>
            plan.family === FAMILY_JSON
            && !plan.synthetic
            && keys.every((key) => plan.props?.has(key) === true));
          if (selected) {
            const headers = new Headers(next.headers);
            headers.set("Content-Type", selected.mediaType || selected.mediaKey);
            next = { ...next, headers };
          }
        }
      } catch { /* not a JSON body */ }
    }

    const rewritten = rewriteEncodedMultipartParts(next.body!, model.typeAbsentParts);
    if (rewritten !== next.body) next = { ...next, body: rewritten };
    return fetchFn(input, next);
  };
}

function bodyText(body: BodyInit): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  return undefined;
}

function rewriteEncodedMultipartParts(body: BodyInit, names: string[]): BodyInit {
  let bytes: Uint8Array;
  if (typeof body === "string") {
    bytes = new TextEncoder().encode(body);
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else {
    return body;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  let changed = false;
  for (const name of names) {
    const marker = `name="${name}"`;
    const markerAt = binary.indexOf(marker);
    if (markerAt < 0) continue;
    const headerStart = binary.lastIndexOf("\r\n", markerAt);
    const bodyStart = binary.indexOf("\r\n\r\n", markerAt);
    const bodyEnd = bodyStart < 0 ? -1 : binary.indexOf("\r\n--", bodyStart + 4);
    if (headerStart < 0 || bodyStart < 0 || bodyEnd < 0) continue;
    const encoded = binary.slice(bodyStart + 4, bodyEnd);
    let decoded: string;
    try {
      decoded = atob(encoded);
      if (btoa(decoded) !== encoded) continue;
    } catch {
      continue;
    }
    const headers = binary.slice(headerStart, bodyStart)
      .replace("\r\nContent-Transfer-Encoding: base64", "");
    binary = binary.slice(0, headerStart) + headers + "\r\n\r\n" + decoded + binary.slice(bodyEnd);
    changed = true;
  }
  if (!changed) return body;
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function configuredRequestPlans(
  plans: BodyPlan[],
  context: Record<string, unknown> | undefined,
  profile: OpenAPIExecutionProfile,
  openapiVersion: string | undefined,
): BodyPlan[] {
  const configuration = asRecord(context?.configuration);
  const configured = configuration?.requestMedia;
  if (configured == null) return plans.filter((plan) => !plan.range && !plan.unsupported);
  if (typeof configured !== "string") return [];
  return configureRequestMedia(plans, configured, { profile, openapiVersion });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function bridgeExecution<I, O>(
  execution: OpenAPIExecution<I, O>,
  outer: InvocationImpl<I, O>,
  mapInput: (input: I) => unknown,
): Promise<void> {
  const mirrorInnerInputClose = execution.inputFinished.then(() => outer.closeInput());
  const input = (async () => {
    try {
      for await (const value of outer.inputs()) {
        let mapped: unknown;
        try {
          mapped = mapInput(value);
        } catch (error: unknown) {
          outer.fireError(error instanceof InvocationError
            ? error
            : new InvocationError("ERR_REFUSED"));
          await execution.cancel();
          return;
        }
        try {
          await execution.send(mapped as I);
        } catch (error: unknown) {
          outer.fireError(toSDKError(error));
          await execution.cancel();
          return;
        }
      }
      await execution.finishInput();
    } catch (error: unknown) {
      if (!outer.signal.aborted) throw error;
    }
  })();

  const output = (async () => {
    for await (const event of execution.events) {
      await outer.emitOutput(event.value);
    }
    await execution.completed;
    outer.closeOutput();
  })();

  try {
    await output;
  } catch (error: unknown) {
    outer.fireError(toSDKError(error));
  } finally {
    await execution.cancel();
    await Promise.allSettled([input, mirrorInnerInputClose]);
  }
}

function adaptHooks(args: BindingInvocationArgs): OpenAPIExecutionHooks | undefined {
  const hooks = args.hooks;
  if (!hooks) return undefined;
  const site = (target: string) => ({
    ...(args.site ?? {
      operation: "",
      invokedAs: "",
      bindingKey: "",
      bindingSpec: args.source.bindingSpec,
      selector: args.selector,
      target: "",
    }),
    target,
  });
  const raw = (result: OpenAPIHookResult) => ({
    status: result.status,
    body: result.body,
    meta: cloneMetadata(result.metadata),
  });
  return {
    decode: async (engineSite, result) => {
      const declined = Symbol("openapi-adapter: decode declined");
      try {
        const value = await hooks.decodeOutput(
          site(engineSite.target),
          raw(result),
          () => declined,
        );
        return value === declined ? OPENAPI_USE_DEFAULT : value;
      } catch (error: unknown) {
        throw toEngineError(error);
      }
    },
    classify: async (engineSite, result) => {
      const declined = Symbol("openapi-adapter: classify declined");
      try {
        const value = await hooks.classify(
          site(engineSite.target),
          raw(result),
          () => declined as unknown as boolean,
        );
        return value === (declined as unknown) ? OPENAPI_USE_DEFAULT : value;
      } catch (error: unknown) {
        throw toEngineError(error);
      }
    },
  };
}

function toSDKError(error: unknown): InvocationError {
  try {
    return mapSDKError(error);
  } catch {
    // A malformed standalone-runtime portable marker is an implementation
    // failure at this bridge. It must still settle the abstract invocation.
    return new InvocationError("ERR_RUNTIME");
  }
}

function mapSDKError(error: unknown): InvocationError {
  if (error instanceof InvocationError) {
    return new InvocationError(error.code, error.data);
  }
  if (error instanceof OpenAPIExecutionError) {
    const authored = sdkInvocationCause(error);
    if (authored) return new InvocationError(authored.code, authored.data);
    const code = error.code === "SOURCE_LOAD_FAILED" ? "ERR_SOURCE_LOAD_FAILED"
      : error.code === "INVALID_OPERATION_REF" ? "ERR_INVALID_SELECTOR"
      : error.code === "OPERATION_NOT_FOUND" ? "ERR_SELECTOR_NOT_FOUND"
      : error.code === "INVALID_DOCUMENT" ? "ERR_SOURCE_CONFIG_ERROR"
      : error.code === "RUNTIME_ERROR" || error.code === "EXECUTION_COMPLETED_BEFORE_READY" ? "ERR_RUNTIME"
      : error.code;
    if (code === "CONTEXT_REQUIRED" && isContextRequiredDetails(error.details)) {
      return new InvocationError(code, error.details);
    }
    const failure = openAPIPortableFailureData(error);
    return failure.present
      ? new InvocationError(code, failure.value)
      : new InvocationError(code);
  }
  return new InvocationError("ERR_RUNTIME");
}

function sdkInvocationCause(error: unknown): InvocationError | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof InvocationError) return current;
    seen.add(current);
    current = current.cause;
  }
  return null;
}

function toEngineError(error: unknown): OpenAPIExecutionError {
  if (error instanceof OpenAPIExecutionError) return error;
  if (error instanceof InvocationError) {
    return new OpenAPIExecutionError(error.code, error.message, {
      cause: error,
      details: error.data,
    });
  }
  return new OpenAPIExecutionError(
    "ERR_RUNTIME",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

function cloneMetadata(metadata: Record<string, string[]>): Metadata {
  return Object.fromEntries(Object.entries(metadata).map(([name, values]) => [name, [...values]]));
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

/** Synthesizes OBInterface definitions from OpenAPI specification documents. */
export class OpenAPISynthesizer implements InterfaceSynthesizer, CoverageSynthesizer, SourceInspector {
  private readonly fetchFn: typeof globalThis.fetch;

  /**
   * Creates a synthesizer whose artifact retrievals, including external
   * references, use the supplied fetch implementation. Resolver configuration
   * is an implementation seam only and is never represented in the OBI.
   */
  constructor(options?: { fetch?: typeof globalThis.fetch }) {
    this.fetchFn = options?.fetch ?? globalThis.fetch;
  }

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return checkOpenAPIBindingSpecs(bindingSpecs);
  }

  /** Returns the binding specifications this synthesizer supports, by exact identifier. */
  bindingSpecs(): BindingSpecInfo[] {
    return openAPIBindingSpecs();
  }

  /** Converts an OpenAPI source into an OBInterface, applying optional name/version/description overrides. */
  async synthesizeInterface(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    const { iface } = await this.synthesizeObserved(input, options);
    return iface;
  }

  /**
   * Synthesizes an OBI and durable interaction coverage from the same OpenAPI
   * load. This surface is per-operation tolerant: an operation whose
   * registered-family boundary cannot be represented is omitted from the
   * OBI and accounted for as an excluded target in coverage — a sound partial
   * OBI with every omission evidenced, never a whole-document refusal
   * (interface-synthesizer contract; core §10 posture). Strict synthesis
   * (`synthesizeInterface`) is unchanged.
   */
  async synthesizeInterfaceWithCoverage(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<SynthesizeResult> {
    const unrealizable = new Map<string, UnrealizableTarget>();
    const { iface, document, floor } = await this.synthesizeObserved(
      input,
      options,
      (target) => unrealizable.set(target.selector, target),
    );
    // synthesizeObserved already ran finalizeSynthesis (which validates this
    // same interface value); skip the redundant second validation.
    return finalizeSynthesisCoverage(
      iface,
      openAPISynthesisCoverage(document, iface, unrealizable, floor),
      true,
      undefined,
      { revalidateInterface: false },
    );
  }

  private async synthesizeObserved(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
    onUnrealizable?: (target: UnrealizableTarget) => void,
  ): Promise<{ iface: OBInterface; document?: OpenAPIDocument; floor?: AcceptanceFloor }> {
    const sources = input.sources ?? [];
    const src = sources[0];
    if (src === undefined) {
      return { iface: synthesisSkeleton(input) };
    }
    if (sources.length > 1) {
      throw new MultipleSourcesError();
    }
    // Refuse absent, unknown, and unwarranted exact tokens before touching
    // artifact location or content.
    profileForBindingSpec(src.bindingSpec);
    if (src.outputLocation) validateDocumentAddress(src.outputLocation);
    const location = normalizeAuthoringLocation(src.location);
    const artifactContent = src.content === undefined && src.embed && location
      ? await readAuthoringArtifact(location, options?.signal, this.fetchFn)
      : src.content;
    let document: OpenAPIDocument | undefined;
    let floor: AcceptanceFloor | undefined;
    const iface = await convertToInterface(
      location,
      artifactContent,
      { ...options, fetch: this.fetchFn },
      input.onWarning,
      (observed) => {
        document = observed;
      },
      onUnrealizable,
      src.bindingSpec,
      (observedFloor) => {
        floor = observedFloor;
      },
    );
    // Content is authoritative and remains verbatim in the synthesized
    // source. A co-present location is its base/provenance, not permission
    // to replace the embedded artifact with a later fetch.
    if (artifactContent !== undefined) {
      const entry = iface.sources?.[DEFAULT_SOURCE_NAME];
      if (entry) entry.content = artifactContent;
    }
    return {
      iface: finalizeSynthesis(iface, input, DEFAULT_SOURCE_NAME, src.bindingSpec),
      document,
      floor,
    };
  }

  /** Lists all bindable targets (path+method combinations) from an OpenAPI source. */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    // Inspection and synthesis share the same realizability filter. A selector
    // whose registered-family boundary cannot be represented is not
    // advertised as a bindable target merely because it appears in paths —
    // it is filtered per operation (tolerant mode), never a reason to refuse
    // inspecting the rest of the document.
    const location = normalizeAuthoringLocation(source.location);
    const iface = await convertToInterface(
      location,
      source.content,
      { ...options, fetch: this.fetchFn },
      undefined,
      undefined,
      () => {},
      source.bindingSpec,
    );
    const targets: SourceInspection["targets"] = [];
    for (const binding of Object.values(iface.bindings ?? {})) {
      targets.push({
        selector: binding.selector ?? "",
        operationKey: binding.operation,
        operation: iface.operations[binding.operation],
      });
    }
    targets.sort((a, b) => codePointCompare(a.selector, b.selector));
    return { targets, exhaustive: true };
  }
}

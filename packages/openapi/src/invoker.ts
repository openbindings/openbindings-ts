import { prepareSwagger20 } from "@openbindings/openapi-client/engine";
import { checkBindingSpecs as checkBindingSpecSupport } from "@openbindings/core";
import { type BindingSpecInfo, type BindingSpecVerdict, type OBInterface, type Source } from "@openbindings/core";
import {
  CONTEXT_REQUIRED,
  InvocationError,
  InvocationImpl,
  contextConfiguration,
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
  OpenAPIArtifact,
  OpenAPIEngine,
  OpenAPIExecutionError,
  OpenAPIOperationResolutionError,
  loadOpenAPIArtifact,
  openAPIPortableFailureData,
  type OpenAPIExecution,
  type OpenAPIExecutionProfile,
  type OpenAPIExecutionHooks,
  type OpenAPIEngineSecurityHandler,
  type OpenAPIHookResult,
  type OpenAPIResolvedOperation,
} from "@openbindings/openapi-client/engine";
import type {
  OpenAPIDocument,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIPathItem,
} from "./types.js";
import {
  DEFAULT_SOURCE_NAME,
  BINDING_SPEC_OPENAPI_20,
  BINDING_SPEC_OPENAPI_30,
  BINDING_SPEC_OPENAPI_31,
  BINDING_SPEC_OPENAPI_32,
  ERR_UNSUPPORTED_BINDING_SPEC,
  checkAcceptedOpenAPIEdition,
  profileForBindingSpec,
} from "./constants.js";
import {
  convertToInterface,
  type InboundDependencyDisposition,
  type UnrealizableTarget,
} from "./synthesize.js";
import type {
  AcceptanceFloor,
  OpenAPI32ResponseMediaExclusion,
} from "@openbindings/openapi-client/analysis";
import { openAPISynthesisCoverage } from "./coverage.js";
import {
  codePointCompare,
  loadOpenAPIDocument,
  parseSelector,
  validateDocumentAddress,
} from "./util.js";
import {
  applyMultipartTransferEncodings,
  decodeBase64MultipartParts,
  FAMILY_JSON,
  FAMILY_MULTIPART,
  configureRequestMedia,
  configuredPropertyMedia,
  isJSONMediaType,
  parseMediaType,
  planRequestBodies,
  prepareEnginePropertyMediaView,
  requiredPropertyMediaNames,
  type BodyPlan,
} from "./media.js";
import {
  ACTUAL_CONTENT_TYPE_HEADER,
  governRequest,
  governResponse,
  normalizeContentCodings,
  prepareEngineResponseView,
  type ContentDecoder,
  type ContentEncoder,
  type MediaGovernanceModel,
} from "./media-transport.js";
import {
  caseFoldedHeaderCollision,
  duplicateEffectiveParameterIdentity,
  effectiveParameters,
  requestBodyIgnoredForBindingSpec,
  styleLaneUndefinedExpansionParam,
  validateParameterSerialization,
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
import {
  checkPathTemplateDeclaration,
  effectiveParameterDeclarationRows,
  equivalentPathTemplateCollision,
  formStyleCookieMultiValueParameter,
  malformedEffectiveParameter,
  prepareEngineEncodingView,
  sourceExclusionReason,
  validateCompletedURL,
  type ParameterConversion,
} from "./parameter-semantics.js";
import {
  ConfigRequired,
  replaceSerializedServerBase,
  requestWithOpenAPIURL,
  resolveServer,
} from "./servers.js";
import {
  REFERRING_SECURITY_SCHEMES_MARKER,
  markBindingOrigins,
  markReferencedPathItemOrigins,
} from "./binding-origins.js";
import {
  electSecurityAlternative,
  installSelectedSecurityAlternative,
  requiredImplicitConnectionScopeContext,
  requiredSelectedSecurityContext,
  requiredSecuritySelectionContext,
  validateSelectedCredentials,
  type SecuritySelection,
} from "./security.js";
import { bridgeSwagger20Error, runSwagger20Adapter, swagger20Configuration } from "./swagger20-adapter.js";
import { swagger20ConfigurationRequirements, swagger20SecurityRequirements } from "./swagger20-prepare.js";
import { synthesizeSwagger20 } from "./swagger20-synthesis.js";

// ---------------------------------------------------------------------------
// Invoker
// ---------------------------------------------------------------------------

function openAPIBindingSpecs(): BindingSpecInfo[] {
  return [
    { bindingSpec: BINDING_SPEC_OPENAPI_20, description: "Swagger 2.0 HTTP APIs" },
    { bindingSpec: BINDING_SPEC_OPENAPI_30, description: "OpenAPI 3.0 HTTP APIs" },
    { bindingSpec: BINDING_SPEC_OPENAPI_31, description: "OpenAPI 3.1 HTTP APIs" },
    { bindingSpec: BINDING_SPEC_OPENAPI_32, description: "OpenAPI 3.2 HTTP APIs" },
  ];
}

function checkOpenAPIBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
  return checkBindingSpecSupport(bindingSpecs, openAPIBindingSpecs());
}

/** Invokes OpenAPI bindings by performing HTTP requests against the described API. */
export interface OpenAPIInvokerOptions {
  engine?: OpenAPIEngine;
  /**
   * §8.1's deterministic conversion from a supplied JSON boolean or number
   * to its parameter/style-lane string spelling. No conversion is configured
   * when omitted.
   */
  parameterConversion?: ParameterConversion;
  /**
   * Artifact-scheme handlers for mechanisms the built-in OpenAPI credential
   * adapter cannot apply, keyed by the authored security-scheme name.
   */
  securityHandlers?: Record<string, OpenAPIEngineSecurityHandler>;
  /** Deterministic whole-representation request content-coding capabilities. */
  requestContentCodings?: Record<string, ContentEncoder>;
  /** Deterministic whole-representation response content-coding capabilities. */
  responseContentCodings?: Record<string, ContentDecoder>;
}

export class OpenAPIInvoker implements BindingInvoker {
  private readonly engine: OpenAPIEngine;
  private readonly securityHandlers?: Record<string, OpenAPIEngineSecurityHandler>;
  private readonly parameterConversion?: ParameterConversion;
  private readonly requestContentCodings: ReadonlyMap<string, ContentEncoder>;
  private readonly responseContentCodings: ReadonlyMap<string, ContentDecoder>;
  private readonly contentCodingDefect?: Error;
  private readonly runtimeModels = new Map<string, RuntimeOperationModel>();

  constructor(options: OpenAPIInvokerOptions = {}) {
    this.engine = options?.engine ?? new OpenAPIEngine();
    this.securityHandlers = options.securityHandlers
      ? { ...options.securityHandlers }
      : undefined;
    this.parameterConversion = options.parameterConversion;
    const requestCodings = normalizeContentCodings(options.requestContentCodings, "request");
    const responseCodings = normalizeContentCodings(options.responseContentCodings, "response");
    this.requestContentCodings = requestCodings.codecs;
    this.responseContentCodings = responseCodings.codecs;
    this.contentCodingDefect = requestCodings.defect ?? responseCodings.defect;
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
    if (args.source.bindingSpec === BINDING_SPEC_OPENAPI_20) {
      return this.prepareSwagger20Binding(args);
    }
    let profile: OpenAPIExecutionProfile;
    try {
      profile = profileForInvocation(args.source.bindingSpec);
    } catch {
      return null;
    }
    let model: RuntimeOperationModel;
    if (args.source.content === undefined) {
      const cached = this.runtimeModels.get(runtimeModelCacheKey(args));
      if (cached) {
        model = cloneRuntimeModel(cached);
      } else {
        try {
          const prepared = await this.engine.prepareCached({
            source: { location: args.source.location },
            ref: args.selector,
            profile,
            context: contextWithoutConfigurationPoints(
              args.context,
              "server",
              "security",
              "implicitConnectionScope",
            ),
            signal: args.signal,
            hooks: adaptHooks(args),
            maxDeliveryUnitBytes: args.maxDeliveryUnitBytes,
            securityHandlers: this.securityHandlers,
          });
          return prepared?.prerequisites ?? null;
        } catch {
          return null;
        }
      }
    } else {
      try {
        model = await loadRuntimeOperationModel({
          ...args,
          fetch: () => Promise.reject(new Error("prepareBinding performs no external retrieval")),
        }, args.source.bindingSpec);
      } catch {
        // The optional prepareBinding surface reports context only. Source and
        // operation failures remain authoritative on the invocation terminal.
        return null;
      }
    }
    let combined: ContextRequiredDetails | null = null;
    let serverBase = "";
    try {
      serverBase = resolveServer(
        model.document,
        model.pathItem,
        model.operation,
        args.context,
        args.source.location,
      );
    } catch (error: unknown) {
      if (error instanceof ConfigRequired) {
        combined = mergeContextRequirements(combined, configRequiredDetails(error, args.source.location ?? ""));
      } else {
        throw new InvocationError("ERR_REFUSED");
      }
    }

    try {
      combined = mergeContextRequirements(combined, requiredSecuritySelectionContext(
        model.document,
        model.operation,
        args.context,
        serverBase,
        model.parameters,
        serverBase || args.source.location || "",
      ));
    } catch {
      throw new InvocationError("ERR_REFUSED");
    }
    try {
      const media = requiredMediaContext(model, args.context, profile);
      if (media && media.target === "") {
        media.target = serverBase || args.source.location || "";
      }
      combined = mergeContextRequirements(combined, media);
    } catch {
      // Invalid request-media configuration keeps this optional historical
      // preflight unavailable; invocation supplies its terminal refusal.
      return null;
    }
    if (combined) return combined;

    try {
      const implicitScope = requiredImplicitConnectionScopeContext(
        model.document,
        model.operation,
        args.context,
        serverBase,
        model.parameters,
        serverBase || args.source.location || "",
      );
      if (implicitScope) return implicitScope;
      const selection = electSecurityAlternative(
        model.document,
        model.operation,
        args.context,
        serverBase,
        model.parameters,
      );
      const security = requiredSelectedSecurityContext(
        selection,
        args.context,
        serverBase || args.source.location || "",
        this.securityHandlers,
      );
      return security;
    } catch (error: unknown) {
      if (error instanceof InvocationError) throw error;
      throw new InvocationError("ERR_REFUSED");
    }
  }

  /**
   * The Swagger 2.0 half of the side-effect-free preflight. Inline content is
   * analyzed with external references disabled; a location-only source remains
   * unknowable to this surface and is left to the invocation's own challenge,
   * which the binding-invoker contract makes authoritative in any case.
   */
  private async prepareSwagger20Binding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
    if (args.source.content === undefined) return null;
    let configuration: { securityAlternative?: number };
    try {
      configuration = swagger20Configuration(args.context);
    } catch {
      throw new InvocationError("ERR_REFUSED");
    }
    let operation;
    try {
      const prepared = await prepareSwagger20({
        source: { content: args.source.content, ...(args.source.location === undefined ? {} : { location: args.source.location }) },
        ref: args.selector,
        context: args.context,
        allowExternalRefs: false,
      });
      operation = await prepared.synthesisOperation();
    } catch (error: unknown) {
      throw bridgeSwagger20Error(error);
    }
    if (operation.excluded) throw new InvocationError("ERR_REFUSED");
    const target = args.source.location ?? "";
    try {
      return mergeContextRequirements(
        swagger20ConfigurationRequirements(operation, args.context, {
          parameterConversion: this.parameterConversion !== undefined,
          requestContentCodings: (this.requestContentCodings?.size ?? 0) > 0,
          responseContentCodings: (this.responseContentCodings?.size ?? 0) > 0,
        }),
        swagger20SecurityRequirements(operation, configuration.securityAlternative, args.context, target),
      );
    } catch {
      throw new InvocationError("ERR_REFUSED");
    }
  }

  private async runAdapter<I, O>(
    args: BindingInvocationArgs,
    outer: InvocationImpl<I, O>,
  ): Promise<void> {
    if (args.source.bindingSpec === BINDING_SPEC_OPENAPI_20) {
      if (this.contentCodingDefect) throw new InvocationError("ERR_REFUSED");
      return runSwagger20Adapter(args, outer, {
        parameterConversion: this.parameterConversion as ((value: unknown) => string) | undefined,
        requestContentCodings: this.requestContentCodings,
        responseContentCodings: this.responseContentCodings,
      });
    }
    if (this.contentCodingDefect) throw new InvocationError("ERR_REFUSED");
    const bindingSpec = args.source.bindingSpec;
    const profile = profileForInvocation(bindingSpec);
    const model = await loadRuntimeOperationModel(args, bindingSpec);
    if (args.source.location) {
      this.runtimeModels.set(runtimeModelCacheKey(args), cloneRuntimeModel(model));
    }
    let resolvedServerBase: string;
    try {
      resolvedServerBase = resolveServer(
        model.document,
        model.pathItem,
        model.operation,
        args.context,
        args.source.location,
      );
    } catch (error: unknown) {
      if (error instanceof ConfigRequired) {
        throw new InvocationError(CONTEXT_REQUIRED, configRequiredDetails(error, args.source.location ?? ""));
      }
      throw new InvocationError("ERR_REFUSED");
    }
    let selectedSecurity: SecuritySelection | null;
    let pendingSecurityRequirement: ContextRequiredDetails | null;
    try {
      const scopeRequired = requiredImplicitConnectionScopeContext(
        model.document,
        model.operation,
        args.context,
        resolvedServerBase,
        model.parameters,
        resolvedServerBase,
      );
      if (scopeRequired) throw new InvocationError(CONTEXT_REQUIRED, scopeRequired);
      selectedSecurity = electSecurityAlternative(
        model.document,
        model.operation,
        args.context,
        resolvedServerBase,
        model.parameters,
      );
      pendingSecurityRequirement = requiredSelectedSecurityContext(
        selectedSecurity,
        args.context,
        resolvedServerBase,
        this.securityHandlers,
      );
      validateSelectedCredentials(selectedSecurity, args.context);
    } catch (error: unknown) {
      if (error instanceof InvocationError) throw error;
      throw new InvocationError("ERR_REFUSED");
    }

    const engineServerBase = resolvedServerBase.replace(/\/+$/u, "") || resolvedServerBase;
    installEngineAdapterView(model, engineServerBase, selectedSecurity);
    model.resolvedServerBase = resolvedServerBase;
    model.engineServerBase = engineServerBase;
    const required = requiredMediaContext(model, args.context, profile);
    if (required) throw new InvocationError(CONTEXT_REQUIRED, required);
    prepareEnginePropertyMediaView(model.plans, args.context);
    const preparedTarget = model.target
      ? {
          ...model.target,
          document: model.document,
          pathItem: model.pathItem,
          operation: model.operation,
        }
      : undefined;
    const preparedArtifact = model.artifact && preparedTarget
      ? model.artifact.withOperationTarget(preparedTarget)
      : undefined;
    const prepared = await this.engine.prepare({
      // The model is an adapter-local loaded view: edition and method-body
      // gates have already run, and ignored requestBody declarations have
      // been removed before the standalone engine sees the operation.
      source: preparedArtifact
        ? { ...(args.source.location ? { location: args.source.location } : {}), artifact: preparedArtifact }
        : { ...(args.source.location ? { location: args.source.location } : {}), content: model.engineContent },
      // The standalone client engine's own API names the selector `ref`.
      ref: args.selector,
      profile,
      context: contextWithoutConfigurationPoints(args.context, "server", "security", "implicitConnectionScope"),
      signal: outer.signal,
      fetch: adaptRuntimeFetch(
        args.fetch ?? globalThis.fetch,
        model,
        this.requestContentCodings,
        this.responseContentCodings,
      ),
      hooks: adaptHooks(args),
      maxDeliveryUnitBytes: args.maxDeliveryUnitBytes,
      securityHandlers: this.securityHandlers,
    });
    if (pendingSecurityRequirement) {
      throw new InvocationError(CONTEXT_REQUIRED, pendingSecurityRequirement);
    }
    const mapInput = (input: unknown): unknown => {
      const selectedPlans = configuredRequestPlans(
        model.operation,
        model.plans,
        args.context,
        profile,
        model.document.openapi,
        inputHasBody(input),
      );
      for (const plan of selectedPlans) configuredPropertyMedia(plan, args.context);
      return engineInputForCallerEnvelope(
        input,
        model.parameters,
        selectedPlans,
        model.routes,
        profile,
        bindingSpec,
        this.parameterConversion,
      );
    };
    const prefetchedInput = model.preStartBodyGate
      ? await preReadValidatedInput(outer, mapInput)
      : undefined;
    // start() resolves only after all artifact/configuration checks that do
    // not require application input. Only then does the bridge acquire the
    // SDK input sequence.
    const execution = await prepared.start<I, O>();
    await bridgeExecution(execution, outer, mapInput, model, prefetchedInput);
  }
}

interface RuntimeOperationModel {
  bindingSpec: string;
  artifact?: OpenAPIArtifact;
  target?: OpenAPIResolvedOperation;
  document: OpenAPIDocument;
  engineContent: unknown;
  pathItem: OpenAPIPathItem;
  operation: OpenAPIOperation;
  governanceOperation: OpenAPIOperation;
  parameters: OpenAPIParameter[];
  plans: BodyPlan[];
  routes: AbstractInputRoutes;
  method: string;
  path: string;
  resolvedServerBase?: string;
  engineServerBase?: string;
  emptyResponse: boolean;
  maxDeliveryUnitBytes?: number;
  transportError?: InvocationError;
  preStartBodyGate: boolean;
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
  let artifact: OpenAPIArtifact | undefined;
  let operationTarget: OpenAPIResolvedOperation | undefined;
  let target: { path: string; method: string };
  let pathItem: OpenAPIPathItem;
  let operation: OpenAPIOperation;

  if (bindingSpec === BINDING_SPEC_OPENAPI_32) {
    try {
      artifact = await loadOpenAPIArtifact(
        {
          ...(args.source.location ? { location: args.source.location } : {}),
          ...(Object.hasOwn(args.source, "content") ? { content: args.source.content } : {}),
        },
        {
          ...(args.signal ? { signal: args.signal } : {}),
          ...(args.fetch ? { fetch: args.fetch } : {}),
          allowExternalRefs: true,
        },
      );
      document = artifact.document;
    } catch {
      throw new InvocationError("ERR_SOURCE_LOAD_FAILED");
    }
  } else {
    const resourceBases = new WeakMap<object, string | undefined>();
    try {
      document = await loadOpenAPIDocument(
        args.source.location,
        args.source.content,
        {
          signal: args.signal,
          onRawDocument: (raw) => { rawDocument = structuredClone(raw); },
          onResource: (root, baseURI) => {
            resourceBases.set(root, baseURI);
            markBindingOrigins(root, baseURI);
          },
          onRefTarget: (referenced, declaringRoot) => {
            markReferencedPathItemOrigins(referenced, declaringRoot, resourceBases.get(declaringRoot));
          },
        },
        args.fetch,
      );
    } catch {
      throw new InvocationError("ERR_SOURCE_LOAD_FAILED");
    }
  }
  try {
    checkAcceptedOpenAPIEdition(bindingSpec, document.openapi);
  } catch {
    throw new InvocationError("ERR_SOURCE_LOAD_FAILED");
  }
  if (artifact?.refusal || artifact?.sourceExclusion) {
    throw new InvocationError("ERR_REFUSED");
  }
  if (!artifact && sourceExclusionReason(document, bindingSpec)) {
    throw new InvocationError("ERR_REFUSED");
  }

  if (artifact) {
    try {
      operationTarget = await artifact.resolveOperation(args.selector);
    } catch (error: unknown) {
      if (error instanceof OpenAPIOperationResolutionError) {
        if (error.kind === "excluded") throw new InvocationError("ERR_REFUSED");
        if (error.kind === "invalid-reference") throw new InvocationError("ERR_INVALID_SELECTOR");
      }
      throw new InvocationError("ERR_SELECTOR_NOT_FOUND");
    }
    document = operationTarget.document;
    pathItem = operationTarget.pathItem;
    operation = operationTarget.operation;
    if (operationTarget.referringSecuritySchemes) {
      operation[REFERRING_SECURITY_SCHEMES_MARKER] = structuredClone(
        operationTarget.referringSecuritySchemes,
      );
    }
    target = {
      path: operationTarget.reference.path,
      method: operationTarget.reference.method,
    };
  } else {
    try {
      target = parseSelector(args.selector);
    } catch {
      throw new InvocationError("ERR_INVALID_SELECTOR");
    }
    const rawPathItem = document.paths?.[target.path];
    if (!rawPathItem || typeof rawPathItem !== "object") {
      throw new InvocationError("ERR_SELECTOR_NOT_FOUND");
    }
    pathItem = rawPathItem;
    const rawOperation = pathItem[target.method];
    if (!rawOperation || typeof rawOperation !== "object") {
      throw new InvocationError("ERR_SELECTOR_NOT_FOUND");
    }
    operation = rawOperation as OpenAPIOperation;
  }
  const governanceOperation = structuredClone(operation);
  const declarationRows = effectiveParameterDeclarationRows(pathItem, operation);
  if (malformedEffectiveParameter(declarationRows, bindingSpec)) {
    throw new InvocationError("ERR_REFUSED");
  }
  const parameters = effectiveParameters(pathItem, operation);
  if (duplicateEffectiveParameterIdentity(parameters)) {
    throw new InvocationError("ERR_REFUSED");
  }
  if (caseFoldedHeaderCollision(parameters)) {
    throw new InvocationError("ERR_REFUSED");
  }
  if (checkPathTemplateDeclaration(target.path, parameters, bindingSpec)) {
    throw new InvocationError("ERR_REFUSED");
  }
  // Equivalent-hierarchy path keys are an OAS-forbidden construct in 3.0 and
  // 3.1 alike, and both siblings exclude every selected operation on a
  // participating Path Item before any caller value is inspected. 3.2 owns
  // the same question through its own lane.
  if (
    (bindingSpec === BINDING_SPEC_OPENAPI_30 || bindingSpec === BINDING_SPEC_OPENAPI_31)
    && equivalentPathTemplateCollision(document.paths, target.path)
  ) {
    throw new InvocationError("ERR_REFUSED");
  }
  for (const parameter of parameters) {
    if (bindingSpec === BINDING_SPEC_OPENAPI_32) break;
    try {
      validateParameterSerialization(parameter, bindingSpec === BINDING_SPEC_OPENAPI_30);
    } catch {
      throw new InvocationError("ERR_REFUSED");
    }
  }
  if (styleLaneUndefinedExpansionParam(
    parameters,
    profileForInvocation(bindingSpec),
    bindingSpec === BINDING_SPEC_OPENAPI_30,
  )) {
    throw new InvocationError("ERR_REFUSED");
  }
  if (formStyleCookieMultiValueParameter(
    parameters,
    bindingSpec === BINDING_SPEC_OPENAPI_30,
  )) {
    throw new InvocationError("ERR_REFUSED");
  }

  const bodyForbidden = requestBodyIgnoredForBindingSpec(bindingSpec, target.method);
  const preStartBodyGate = bodyForbidden || bindingSpec === BINDING_SPEC_OPENAPI_32;
  if (bodyForbidden) {
    delete operation.requestBody;
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
  const callerParameters = parameters.map((parameter) => ({ ...parameter }));
  const routes = planAbstractInputRoutes(callerParameters, plans);
  prepareEngineEncodingView(plans);
  if (bindingSpec !== BINDING_SPEC_OPENAPI_32) prepareEngineResponseView(operation);
  // A fully dereferenced recursive schema is cyclic. Passing that adapter
  // view through the standalone engine's loader a second time cannot preserve
  // its graph, so let the engine load the original authored artifact in that
  // one case. Non-cyclic views retain the method/body adaptations above.
  const engineContent = artifact
    ? document
    : hasObjectCycle(document)
    ? cyclicEngineDocument(rawDocument, target, bindingSpec, forcedJSONEnvelope)
    : document;
  return {
    bindingSpec,
    ...(artifact ? { artifact } : {}),
    ...(operationTarget ? { target: operationTarget } : {}),
    document,
    engineContent,
    pathItem,
    operation,
    governanceOperation,
    parameters: callerParameters,
    plans,
    routes,
    method: target.method,
    path: target.path,
    emptyResponse: false,
    maxDeliveryUnitBytes: args.maxDeliveryUnitBytes,
    preStartBodyGate,
  };
}

function configRequiredDetails(required: ConfigRequired, target: string): ContextRequiredDetails {
  return {
    target,
    alternatives: [{ requirements: [{
      type: "config.value",
      point: required.point,
      path: required.path,
      ...(required.schema ? { schema: required.schema } : {}),
      ...(required.durable === true ? { durable: true } : {}),
      ...(required.message ? { description: required.message } : {}),
    }] }],
  };
}

function runtimeModelCacheKey(args: BindingInvocationArgs): string {
  return `${args.source.bindingSpec}\u0000${args.source.location ?? ""}\u0000${args.selector}`;
}

function cloneRuntimeModel(model: RuntimeOperationModel): RuntimeOperationModel {
  const { routes: _routes, artifact, target, ...data } = model;
  const clone = structuredClone(data);
  const clonedTarget = target
    ? {
        ...target,
        document: clone.document,
        pathItem: clone.pathItem,
        operation: clone.operation,
      }
    : undefined;
  return {
    ...clone,
    ...(artifact ? { artifact } : {}),
    ...(clonedTarget ? { target: clonedTarget } : {}),
    routes: planAbstractInputRoutes(clone.parameters, clone.plans),
  };
}

function mergeContextRequirements(
  left: ContextRequiredDetails | null,
  right: ContextRequiredDetails | null,
): ContextRequiredDetails | null {
  if (!left) return right;
  if (!right) return left;
  return {
    target: left.target || right.target,
    alternatives: left.alternatives.flatMap((leftAlternative) =>
      right.alternatives.map((rightAlternative) => ({
        requirements: [...leftAlternative.requirements, ...rightAlternative.requirements],
      }))),
  };
}

function contextWithoutConfigurationPoints(
  context: Record<string, unknown> | undefined,
  ...points: string[]
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const configuration = { ...contextConfiguration(context) };
  for (const point of points) delete configuration[point];
  return { ...context, configuration };
}

function installEngineAdapterView(
  model: RuntimeOperationModel,
  engineServerBase: string,
  selection: SecuritySelection | null,
): void {
  installSelectedSecurityAlternative(model.document, model.operation, selection);
  model.operation.servers = [{ url: engineServerBase }];
  if (model.engineContent === model.document) return;

  const rawDocument = asRecord(model.engineContent);
  const rawPathItem = asRecord(asRecord(rawDocument?.paths)?.[model.path]);
  const rawOperation = asRecord(rawPathItem?.[model.method]);
  if (!rawDocument || !rawOperation) return;
  rawOperation.servers = [{ url: engineServerBase }];
  if (selection) rawOperation.security = [{ ...selection.requirement }];
  if (!selection) return;
  const components = asRecord(rawDocument.components) ?? {};
  rawDocument.components = components;
  const schemes = asRecord(components.securitySchemes) ?? {};
  components.securitySchemes = schemes;
  for (const plan of selection.plans) {
    for (const named of plan.schemes) schemes[named.name] = named.scheme;
  }
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
    const object = value;
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
      ? Object.keys(schema.properties)
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
  requestContentCodings: ReadonlyMap<string, ContentEncoder>,
  responseContentCodings: ReadonlyMap<string, ContentDecoder>,
): typeof globalThis.fetch {
  return async (input, init) => {
    model.transportError = undefined;
    let nextInput: RequestInfo | URL = input;
    const nextInit = init;
    if (model.resolvedServerBase && model.engineServerBase) {
      try {
        const currentURL = input instanceof Request ? input.url : String(input);
        const completedURL = model.bindingSpec === BINDING_SPEC_OPENAPI_32
          ? replaceOpenAPI32SerializedServerBase(
            currentURL,
            model.resolvedServerBase,
            model.engineServerBase,
          )
          : replaceSerializedServerBase(
            currentURL,
            model.resolvedServerBase,
            model.engineServerBase,
          );
        nextInput = input instanceof Request
          ? requestWithOpenAPIURL(input, completedURL)
          : completedURL;
      } catch {
        return transportRefusal(model);
      }
    }
    const completedURL = nextInput instanceof Request ? nextInput.url : String(nextInput);
    try {
      validateCompletedURL(completedURL);
    } catch {
      return transportRefusal(model);
    }
    let next: RequestInit = nextInit ?? {};
    if (next.body) {
      const text = bodyText(next.body);
      const contentType = new Headers(next.headers).get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (
        model.operation.requestBody?.required
        && contentType !== undefined
        && isJSONMediaType(contentType)
        && text?.trim() === "{}"
      ) {
        return transportRefusal(model);
      }

      if (text !== undefined) {
        try {
          const value = JSON.parse(text) as unknown;
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const keys = Object.keys(value);
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

      const rawPartNames = [...new Set(model.plans.flatMap((plan) =>
        (plan as { rawProperties?: string[] }).rawProperties ?? []))];
      let rewritten: BodyInit;
      try {
        rewritten = decodeBase64MultipartParts(next.body!, rawPartNames);
      } catch {
        // A non-canonical Base64 string at the raw-octet caller boundary
        // refuses the whole invocation before dispatch rather than emitting
        // a partly-decoded part (openbindings.openapi-3.1@1 SS9.2-9.3).
        return transportRefusal(model);
      }
      if (model.bindingSpec !== BINDING_SPEC_OPENAPI_32) {
        const transferEncodings = selectedMultipartPlan(model, contentType)?.transferEncodings ?? {};
        rewritten = applyMultipartTransferEncodings(rewritten, transferEncodings);
      }
      if (rewritten !== next.body) next = { ...next, body: rewritten };
    }
    const governedModel: MediaGovernanceModel = {
      document: model.document,
      operation: model.governanceOperation,
      parameters: model.parameters,
      method: model.method,
      emptyResponse: model.emptyResponse,
      maxDeliveryUnitBytes: model.maxDeliveryUnitBytes,
    };
    try {
      const governed = await governRequest(nextInput, next, governedModel, requestContentCodings);
      const response = await fetchFn(governed.input, governed.init);
      const result = await governResponse(response, governedModel, responseContentCodings);
      model.emptyResponse = governedModel.emptyResponse;
      return result;
    } catch (error: unknown) {
      if (error instanceof InvocationError) model.transportError = error;
      throw error;
    }
  };
}

/** Preserves 3.2's serialized path bytes, including terminal dot segments. */
function replaceOpenAPI32SerializedServerBase(
  currentURL: string,
  resolvedServerBase: string,
  engineServerBase: string,
): string {
  if (!currentURL.startsWith(engineServerBase)) {
    throw new Error("serialized request URL does not begin with the engine server base");
  }
  return resolvedServerBase + currentURL.slice(engineServerBase.length);
}

function transportRefusal(model: RuntimeOperationModel): never {
  const error = new InvocationError("ERR_REFUSED");
  model.transportError = error;
  throw error;
}

function bodyText(body: BodyInit): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  return undefined;
}

function selectedMultipartPlan(
  model: RuntimeOperationModel,
  contentType: string | undefined,
): { transferEncodings?: Record<string, string> } | undefined {
  if (!contentType) return undefined;
  try {
    const selected = configureRequestMedia(model.plans, contentType, {
      profile: profileForBindingSpec(model.bindingSpec),
      openapiVersion: model.document.openapi,
    }).filter((plan) => plan.family === FAMILY_MULTIPART);
    return selected.length === 1
      ? selected[0] as BodyPlan & { transferEncodings?: Record<string, string> }
      : undefined;
  } catch {
    return undefined;
  }
}

function configuredRequestPlans(
  operation: OpenAPIOperation,
  plans: BodyPlan[],
  context: Record<string, unknown> | undefined,
  profile: OpenAPIExecutionProfile,
  openapiVersion: string | undefined,
  bodyEmitting = true,
): BodyPlan[] {
  if (!bodyEmitting) return plans;
  const configuration = asRecord(context?.configuration);
  const configured = configuration?.requestMedia;
  if (configured == null) {
    const sole = soleConcreteRequestPlan(operation, plans);
    if (sole) return [sole];
    if (operation.requestBody?.required === true) {
      throw new InvocationError(CONTEXT_REQUIRED, configRequirement("requestMedia", ""));
    }
    // Optional bodies reach this point only after the caller has supplied an
    // input body. A retry challenge would require replaying consumed input, so
    // the missing prior choice is a plain pre-dispatch refusal.
    throw new InvocationError("ERR_REFUSED");
  }
  if (typeof configured !== "string") throw new InvocationError("ERR_REFUSED");
  const selected = configureRequestMedia(plans, configured, { profile, openapiVersion });
  if (selected.length !== 1) throw new InvocationError("ERR_REFUSED");
  return selected;
}

function requiredMediaContext(
  model: RuntimeOperationModel,
  context: Record<string, unknown> | undefined,
  profile: OpenAPIExecutionProfile,
): ContextRequiredDetails | null {
  if (model.operation.requestBody?.required !== true) return null;
  let selected: BodyPlan[];
  const configuration = asRecord(context?.configuration);
  if (configuration?.requestMedia == null) {
    const usable = model.plans.filter((plan) => !plan.unsupported);
    if (usable.length === 0) throw new InvocationError("ERR_REFUSED");
    const sole = soleConcreteRequestPlan(model.operation, usable);
    if (!sole) return configRequirement("requestMedia", "");
    selected = [sole];
  } else {
    if (typeof configuration.requestMedia !== "string") throw new InvocationError("ERR_REFUSED");
    selected = configureRequestMedia(model.plans, configuration.requestMedia, {
      profile,
      openapiVersion: model.document.openapi,
    });
    if (selected.length !== 1) throw new InvocationError("ERR_REFUSED");
  }
  const propertyMedia = asRecord(configuration?.propertyMedia);
  const missing = [...new Set(selected.flatMap(requiredPropertyMediaNames))]
    .filter((name) => typeof propertyMedia?.[name] !== "string")
    .sort(codePointCompare);
  if (missing.length === 0) {
    for (const plan of selected) {
      try { configuredPropertyMedia(plan, context); } catch { throw new InvocationError("ERR_REFUSED"); }
    }
    return null;
  }
  return {
    target: "",
    alternatives: [{ requirements: missing.map((name) => ({
      type: "config.value",
      point: "propertyMedia",
      path: `/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    })) }],
  };
}

function soleConcreteRequestPlan(
  _operation: OpenAPIOperation,
  plans: BodyPlan[],
): BodyPlan | null {
  // Election is over the confinement-filtered USABLE plans, not the authored
  // content-map size. A normalized collision can therefore remove two map
  // entries and leave one ordinary concrete sibling to self-select.
  if (plans.length !== 1) return null;
  const plan = plans[0]!;
  if (plan.range || plan.unsupported) return null;
  try { parseMediaType(plan.mediaKey, true); } catch { return null; }
  return plan;
}

function configRequirement(point: string, path: string): ContextRequiredDetails {
  return {
    target: "",
    alternatives: [{ requirements: [{ type: "config.value", point, path }] }],
  };
}

function inputHasBody(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.hasOwn(value, "body");
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
  model: RuntimeOperationModel,
  prefetched?: PrefetchedInput<I>,
): Promise<void> {
  const mirrorInnerInputClose = execution.inputFinished.then(() => outer.closeInput());
  const input = (async () => {
    try {
      // A body-forbidden method has already consumed one body-free envelope
      // (or EOF) before the carrier started. A no-parameter carrier dispatches
      // immediately and has no input slot to receive that harmless envelope.
      if (prefetched && model.parameters.length === 0 && model.operation.requestBody == null) return;
      const iterator = prefetched?.iterator ?? outer.inputs()[Symbol.asyncIterator]();
      let next = prefetched?.result;
      while (true) {
        const item = next ?? await iterator.next();
        next = undefined;
        if (item.done) break;
        const value = item.value;
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
      if (model.emptyResponse) continue;
      await outer.emitOutput(event.value);
    }
    await execution.completed;
    outer.closeOutput();
  })();

  try {
    await output;
  } catch (error: unknown) {
    outer.fireError(model.transportError ?? toSDKError(error));
  } finally {
    await execution.cancel();
    await Promise.allSettled([input, mirrorInnerInputClose]);
  }
}

interface PrefetchedInput<I> {
  iterator: AsyncIterator<I>;
  result: IteratorResult<I, void>;
}

/** Validates the first 3.2 caller envelope before the carrier can dispatch. */
async function preReadValidatedInput<I, O>(
  outer: InvocationImpl<I, O>,
  mapInput: (input: I) => unknown,
): Promise<PrefetchedInput<I>> {
  const iterator = outer.inputs()[Symbol.asyncIterator]();
  const result = await iterator.next();
  if (!result.done) {
    try {
      mapInput(result.value);
    } catch {
      throw new InvocationError("ERR_REFUSED");
    }
  }
  return { iterator, result };
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
  const raw = (result: OpenAPIHookResult) => {
    const meta = cloneMetadata(result.metadata);
    const actualEntry = Object.entries(meta)
      .find(([name]) => name.toLowerCase() === ACTUAL_CONTENT_TYPE_HEADER.toLowerCase());
    const actual = actualEntry?.[1];
    if (actualEntry) delete meta[actualEntry[0]];
    if (actual) meta["Content-Type"] = [...actual];
    return { status: result.status, body: result.body, meta };
  };
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
    const code = normalizedAdapterErrorCode(error.code);
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


// normalizedAdapterErrorCode maps the standalone client's native error
// vocabulary onto this SDK's invocation surface. Post-dispatch cause
// refinements collapse to generic unsuccessful completion -- codes carry
// dispatch-state and boundary facts, never cause or protocol category
// (error-code ownership ruling, 2026-08-31); every standard engine spelling
// is mapped deliberately, and only authored extension codes pass through.
function normalizedAdapterErrorCode(code: string): string {
  switch (code) {
    case "SOURCE_LOAD_FAILED": case "ERR_SOURCE_LOAD_FAILED": return "ERR_SOURCE_LOAD_FAILED";
    case "INVALID_OPERATION_REF": case "ERR_INVALID_REF": return "ERR_INVALID_SELECTOR";
    case "OPERATION_NOT_FOUND": case "ERR_REF_NOT_FOUND": return "ERR_SELECTOR_NOT_FOUND";
    case "INVALID_DOCUMENT": return "ERR_SOURCE_CONFIG_ERROR";
    case "RUNTIME_ERROR": case "EXECUTION_COMPLETED_BEFORE_READY": return "ERR_RUNTIME";
    case "ERR_RESPONSE_ERROR": case "ERR_PROTOCOL": return "ERR_EXECUTION_FAILED";
    // Owned vocabulary and this SDK's documented conventions pass through.
    case "CONTEXT_REQUIRED": case "ERR_REFUSED": case "ERR_CANCELLED":
    case "ERR_EXECUTION_FAILED":
    case "ERR_SOURCE_CONFIG_ERROR": case "ERR_TIMEOUT": case "ERR_CONNECT_FAILED":
    case "ERR_STREAM_ERROR": case "ERR_VALIDATION_FAILED": case "ERR_RUNTIME":
    case "ERR_MISSING_INPUT": case "ERR_INPUT_CLOSED": case "ERR_INVOCATION_CLOSED":
      return code;
    default:
      // Anything outside the standard engine vocabulary enumerated above is
      // a deliberately authored extension code, which the interfaces
      // registry licenses; it passes through as implementation behavior,
      // never as portable contract meaning. Every standard engine spelling
      // has a deliberate mapping above, so the undecided-passthrough leak
      // is closed without revoking the extension license.
      return code;
  }
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
    if (input.sources?.[0]?.bindingSpec === BINDING_SPEC_OPENAPI_20) {
      return (await synthesizeSwagger20(input, this.fetchFn, false, options)).iface;
    }
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
    if (input.sources?.[0]?.bindingSpec === BINDING_SPEC_OPENAPI_20) {
      const observed = await synthesizeSwagger20(input, this.fetchFn, true, options);
      return finalizeSynthesisCoverage(observed.iface, observed.coverage, true, undefined, { revalidateInterface: false });
    }
    const unrealizable = new Map<string, UnrealizableTarget>();
    const {
      iface,
      document,
      floor,
      responseMediaExclusions,
      inboundDependencies,
    } = await this.synthesizeObserved(
      input,
      options,
      (target) => unrealizable.set(target.selector, target),
    );
    // synthesizeObserved already ran finalizeSynthesis (which validates this
    // same interface value); skip the redundant second validation.
    return finalizeSynthesisCoverage(
      iface,
      openAPISynthesisCoverage(
        document,
        iface,
        unrealizable,
        floor,
        responseMediaExclusions,
        inboundDependencies,
      ),
      true,
      undefined,
      { revalidateInterface: false },
    );
  }

  private async synthesizeObserved(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
    onUnrealizable?: (target: UnrealizableTarget) => void,
  ): Promise<{
    iface: OBInterface;
    document?: OpenAPIDocument;
    floor?: AcceptanceFloor;
    responseMediaExclusions?: ReadonlyMap<string, readonly OpenAPI32ResponseMediaExclusion[]>;
    inboundDependencies?: readonly InboundDependencyDisposition[];
  }> {
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
    let responseMediaExclusions:
      | ReadonlyMap<string, readonly OpenAPI32ResponseMediaExclusion[]>
      | undefined;
    let inboundDependencies: readonly InboundDependencyDisposition[] | undefined;
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
      (observed) => {
        responseMediaExclusions = observed;
      },
      (observed) => {
        inboundDependencies = observed;
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
      responseMediaExclusions,
      inboundDependencies,
    };
  }

  /** Lists all bindable targets (path+method combinations) from an OpenAPI source. */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    if (source.bindingSpec === BINDING_SPEC_OPENAPI_20) {
      const observed = await synthesizeSwagger20({ sources: [source] }, this.fetchFn, true, options);
      const targets = Object.values(observed.iface.bindings ?? {}).map((binding) => ({
        selector: binding.selector ?? "",
        operationKey: binding.operation,
        operation: observed.iface.operations[binding.operation],
      }));
      targets.sort((left, right) => codePointCompare(left.selector, right.selector));
      return { targets, exhaustive: true };
    }
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

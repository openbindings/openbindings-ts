import {
  MultipleSourcesError,
  InvocationError,
  InvocationImpl,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  synthesisSkeleton,
  type BindingInvoker,
  type BindingInvocationArgs,
  type ContextRequiredDetails,
  type SynthesizeInput,
  type BindingSpecInfo,
  type InterfaceSynthesizer,
  type CoverageSynthesizer,
  type SynthesizeResult,
  type Invocation,
  type Metadata,
  type OBInterface,
  type Source,
  type SourceInspection,
  type SourceInspector,
} from "@openbindings/sdk";
import {
  OPENAPI_USE_DEFAULT,
  OpenAPIEngine,
  OpenAPIExecutionError,
  type OpenAPIExecution,
  type OpenAPIExecutionHooks,
  type OpenAPIEngineSecurityHandler,
  type OpenAPIHookResult,
} from "@openbindings/openapi-client/engine";
import type { OpenAPIDocument } from "./types.js";
import {
  DEFAULT_SOURCE_NAME,
  BINDING_SPEC,
  BINDING_SPEC_V2,
  BINDING_SPEC_V3,
  BINDING_SPEC_V4,
  BINDING_SPEC_V5,
  BINDING_SPEC_V6,
  LEGACY_BINDING_SPEC,
  profileForBindingSpec,
} from "./constants.js";
import { convertToInterface, type UnrealizableTarget } from "./synthesize.js";
import { openAPISynthesisCoverage } from "./coverage.js";
import { codePointCompare, validateDocumentAddress } from "./util.js";
import {
  normalizeAuthoringLocation,
  readAuthoringArtifact,
} from "./platform.js";

// ---------------------------------------------------------------------------
// Invoker
// ---------------------------------------------------------------------------

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

  /** Returns the binding specifications this invoker supports, by exact identifier. */
  bindingSpecs(): BindingSpecInfo[] {
    return [
      { bindingSpec: BINDING_SPEC, description: "OpenAPI 3.x HTTP APIs (OAS 3.0 schema-omitted byte-carriage revision)" },
      { bindingSpec: BINDING_SPEC_V6, description: "OpenAPI 3.x HTTP APIs (whole-JSON carriage revision)" },
      { bindingSpec: BINDING_SPEC_V5, description: "OpenAPI 3.x HTTP APIs (dynamic-object carriage revision)" },
      { bindingSpec: BINDING_SPEC_V4, description: "OpenAPI 3.x HTTP APIs (response-carriage fidelity revision)" },
      { bindingSpec: BINDING_SPEC_V3, description: "OpenAPI 3.x HTTP APIs (request-carriage fidelity revision)" },
      { bindingSpec: BINDING_SPEC_V2, description: "OpenAPI 3.x HTTP APIs (collision-preserving revision)" },
      { bindingSpec: LEGACY_BINDING_SPEC, description: "OpenAPI 3.x HTTP APIs (revision-1 compatibility)" },
    ];
  }

  /**
   * Returns the invocation handle synchronously; the HTTP work is scheduled
   * asynchronously. Input messages flow through the handle's `write`
   * channel. All pre-dispatch failures (bad ref, missing server URL,
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
    try {
      const prepared = await this.engine.prepareCached({
        source: { location: args.source.location, content: args.source.content },
        ref: args.ref,
        profile: profileForBindingSpec(args.source.bindingSpec),
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
    const prepared = await this.engine.prepare({
      source: { location: args.source.location, content: args.source.content },
      ref: args.ref,
      profile: profileForBindingSpec(args.source.bindingSpec),
      context: args.context,
      signal: outer.signal,
      fetch: args.fetch,
      hooks: adaptHooks(args),
      maxDeliveryUnitBytes: args.maxDeliveryUnitBytes,
      securityHandlers: this.securityHandlers,
    });
    // start() resolves only after all artifact/configuration checks that do
    // not require application input. Only then does the bridge acquire the
    // SDK input sequence.
    const execution = await prepared.start<I, O>();
    await bridgeExecution(execution, outer);
  }
}

async function bridgeExecution<I, O>(
  execution: OpenAPIExecution<I, O>,
  outer: InvocationImpl<I, O>,
): Promise<void> {
  const mirrorInnerInputClose = execution.inputFinished.then(() => outer.closeInput());
  const input = (async () => {
    try {
      for await (const value of outer.inputs()) {
        await execution.send(value);
      }
      await execution.finishInput();
    } catch (error: unknown) {
      if (!outer.signal.aborted) throw error;
    }
  })();

  const output = (async () => {
    const leading = await execution.diagnostics.leading;
    outer.setHeader(cloneMetadata(leading));
    for await (const event of execution.events) {
      await outer.emitOutput(event.value);
    }
    await execution.completed;
    outer.setTrailer(cloneMetadata(execution.diagnostics.trailing()));
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
      ref: args.ref,
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
  if (error instanceof InvocationError) return error;
  if (error instanceof OpenAPIExecutionError) {
    const code = error.code === "SOURCE_LOAD_FAILED" ? "ERR_SOURCE_LOAD_FAILED"
      : error.code === "INVALID_OPERATION_REF" ? "ERR_INVALID_REF"
      : error.code === "OPERATION_NOT_FOUND" ? "ERR_REF_NOT_FOUND"
      : error.code === "INVALID_DOCUMENT" ? "ERR_SOURCE_CONFIG_ERROR"
      : error.code;
    return new InvocationError(code, error.message, error.details, error.evidence);
  }
  return new InvocationError(
    "ERR_RUNTIME",
    error instanceof Error ? error.message : String(error),
  );
}

function toEngineError(error: unknown): OpenAPIExecutionError {
  if (error instanceof OpenAPIExecutionError) return error;
  if (error instanceof InvocationError) {
    return new OpenAPIExecutionError(error.code, error.message, {
      cause: error,
      details: error.details,
      evidence: error.diagnostics,
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

  /** Returns the binding specifications this synthesizer supports, by exact identifier. */
  bindingSpecs(): BindingSpecInfo[] {
    return [
      { bindingSpec: BINDING_SPEC, description: "OpenAPI 3.x HTTP APIs (OAS 3.0 schema-omitted byte-carriage revision)" },
      { bindingSpec: BINDING_SPEC_V6, description: "OpenAPI 3.x HTTP APIs (whole-JSON carriage revision)" },
      { bindingSpec: BINDING_SPEC_V5, description: "OpenAPI 3.x HTTP APIs (dynamic-object carriage revision)" },
      { bindingSpec: BINDING_SPEC_V4, description: "OpenAPI 3.x HTTP APIs (response-carriage fidelity revision)" },
      { bindingSpec: BINDING_SPEC_V3, description: "OpenAPI 3.x HTTP APIs (request-carriage fidelity revision)" },
      { bindingSpec: BINDING_SPEC_V2, description: "OpenAPI 3.x HTTP APIs (collision-preserving revision)" },
      { bindingSpec: LEGACY_BINDING_SPEC, description: "OpenAPI 3.x HTTP APIs (revision-1 compatibility)" },
    ];
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
   * revision-1 flattened boundary cannot be represented is omitted from the
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
    const { iface, document } = await this.synthesizeObserved(
      input,
      options,
      (target) => unrealizable.set(target.ref, target),
    );
    // synthesizeObserved already ran finalizeSynthesis (which validates this
    // same interface value); skip the redundant second validation.
    return finalizeSynthesisCoverage(
      iface,
      openAPISynthesisCoverage(document, iface, unrealizable),
      true,
      undefined,
      { revalidateInterface: false },
    );
  }

  private async synthesizeObserved(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
    onUnrealizable?: (target: UnrealizableTarget) => void,
  ): Promise<{ iface: OBInterface; document?: OpenAPIDocument }> {
    const sources = input.sources ?? [];
    const src = sources[0];
    if (src === undefined) {
      return { iface: synthesisSkeleton(input) };
    }
    if (sources.length > 1) {
      throw new MultipleSourcesError();
    }
    if (src.bindingSpec !== BINDING_SPEC && src.bindingSpec !== BINDING_SPEC_V6 && src.bindingSpec !== BINDING_SPEC_V5 && src.bindingSpec !== BINDING_SPEC_V4 && src.bindingSpec !== BINDING_SPEC_V3 && src.bindingSpec !== BINDING_SPEC_V2 && src.bindingSpec !== LEGACY_BINDING_SPEC) {
      throw new Error(`synthesizer supports exact binding specifications ${JSON.stringify(BINDING_SPEC)}, ${JSON.stringify(BINDING_SPEC_V6)}, ${JSON.stringify(BINDING_SPEC_V5)}, ${JSON.stringify(BINDING_SPEC_V4)}, ${JSON.stringify(BINDING_SPEC_V3)}, ${JSON.stringify(BINDING_SPEC_V2)}, and ${JSON.stringify(LEGACY_BINDING_SPEC)}, got ${JSON.stringify(src.bindingSpec)}`);
    }
    if (src.outputLocation) validateDocumentAddress(src.outputLocation);
    const location = normalizeAuthoringLocation(src.location);
    const artifactContent = src.content === undefined && src.embed && location
      ? await readAuthoringArtifact(location, options?.signal, this.fetchFn)
      : src.content;
    let document: OpenAPIDocument | undefined;
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
    };
  }

  /** Lists all bindable targets (path+method combinations) from an OpenAPI source. */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    // Inspection and synthesis share the same realizability filter. A ref
    // whose revision-1 flattened boundary cannot be represented is not
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
      source.bindingSpec || BINDING_SPEC,
    );
    const targets: SourceInspection["targets"] = [];
    for (const binding of Object.values(iface.bindings ?? {})) {
      targets.push({
        ref: binding.ref ?? "",
        operationKey: binding.operation,
        operation: iface.operations[binding.operation],
      });
    }
    targets.sort((a, b) => codePointCompare(a.ref, b.ref));
    return { targets, exhaustive: true };
  }
}

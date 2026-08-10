import {
  InvocationError,
  InvocationImpl,
  MultipleSourcesError,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  synthesisSkeleton,
  ERR_RUNTIME,
  ERR_SOURCE_LOAD_FAILED,
  type BindingInvoker,
  type BindingInvocationArgs,
  type ContextRequiredDetails,
  type SynthesizeInput,
  type BindingSpecInfo,
  type InterfaceSynthesizer,
  type CoverageSynthesizer,
  type SynthesizeResult,
  type Invocation,
  type OBInterface,
  type Source,
  type SourceInspection,
  type SourceInspector,
} from "@openbindings/sdk";
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
} from "./constants.js";
import { preflightTarget, requiredContext, requiredRequestMediaContext, runBinding } from "./invoke.js";
import { convertToInterface, type UnrealizableTarget } from "./synthesize.js";
import { openAPISynthesisCoverage } from "./coverage.js";
import { codePointCompare, errorMessage, loadOpenAPIDocument, validateDocumentAddress } from "./util.js";
import {
  normalizeAuthoringLocation,
  readAuthoringArtifact,
} from "./platform.js";

// ---------------------------------------------------------------------------
// Shared doc-cache helper
// ---------------------------------------------------------------------------

// loadDoc loads an OpenAPI doc, caching by location within one Invoker
// instance. A content+location invocation bypasses the cache READ (content
// is authoritative — no fetch happens) but still WRITES the parsed result
// under the location key, so a later location-only prepareBinding is served
// warm (Go parity: cachedLoadDocument primes e.docCache[location] even on
// the content-provided path).
async function loadDoc(
  cache: Map<string, OpenAPIDocument>,
  location?: string,
  content?: unknown,
  options?: { signal?: AbortSignal },
  fetchFn?: typeof globalThis.fetch,
): Promise<OpenAPIDocument> {
  if (content !== undefined) {
    const doc = await loadOpenAPIDocument(location, content, options, fetchFn);
    if (location) cache.set(location, doc);
    return doc;
  }
  if (!location) {
    return loadOpenAPIDocument(location, content, options, fetchFn);
  }
  const cached = cache.get(location);
  if (cached) return cached;
  const doc = await loadOpenAPIDocument(location, undefined, options, fetchFn);
  cache.set(location, doc);
  return doc;
}

// ---------------------------------------------------------------------------
// Invoker
// ---------------------------------------------------------------------------

/** Invokes OpenAPI bindings by performing HTTP requests against the described API. */
export class OpenAPIInvoker implements BindingInvoker {
  private readonly docCache = new Map<string, OpenAPIDocument>();

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
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => {
      this.run(args, inv).catch((err: unknown) => {
        inv.fireError(
          err instanceof InvocationError
            ? err
            : new InvocationError(ERR_RUNTIME, errorMessage(err)),
        );
      });
    });
    return inv as Invocation<I, O>;
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
    let doc: OpenAPIDocument | undefined;
    if (args.source.content !== undefined) {
      try {
        // Side-effect-free preflight: internal $refs still resolve locally,
        // but external $ref fetches are disabled (Go parity: prepareDoc's
        // content path uses a loader with external refs NOT allowed — "no
        // I/O").
        doc = await loadOpenAPIDocument(args.source.location, args.source.content, {
          allowExternalRefs: false,
          signal: args.signal,
        });
      } catch {
        return null;
      }
    } else if (args.source.location) {
      doc = this.docCache.get(args.source.location);
    }
    if (!doc) return null;

    // An unresolvable ref or server means the invocation fails with its own
    // pre-dispatch refusal before auth matters: no context to report.
    const target = preflightTarget(doc, args.ref, args.context, args.source.location);
    if (!target) return null;
    const auth = requiredContext(doc, target.op, args.context, target.baseURL, target.params);
    const requestMedia = requiredRequestMediaContext(
      doc,
      target.op,
      args.source.bindingSpec,
      args.context,
      target.baseURL,
    );
    return composeContextRequirements(auth, requestMedia);
  }

  private async run(
    args: BindingInvocationArgs,
    inv: InvocationImpl<unknown, unknown>,
  ): Promise<void> {
    let doc: OpenAPIDocument;
    try {
      doc = await loadDoc(
        this.docCache,
        args.source.location,
        args.source.content,
        { signal: inv.signal },
        args.fetch,
      );
    } catch (e: unknown) {
      inv.fireError(new InvocationError(ERR_SOURCE_LOAD_FAILED, errorMessage(e)));
      return;
    }
    await runBinding(args, inv, doc);
  }
}

function composeContextRequirements(
  left: ContextRequiredDetails | null,
  right: ContextRequiredDetails | null,
): ContextRequiredDetails | null {
  if (left === null) return right;
  if (right === null) return left;
  return {
    target: left.target || right.target,
    alternatives: left.alternatives.flatMap((leftAlternative) =>
      right.alternatives.map((rightAlternative) => ({
        requirements: [...leftAlternative.requirements, ...rightAlternative.requirements],
      })),
    ),
  };
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

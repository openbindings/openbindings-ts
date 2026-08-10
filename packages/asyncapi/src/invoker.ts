import type {
  BindingInvoker,
  CoverageSynthesizer,
  InterfaceSynthesizer,
  SourceInspector,
  BindingInvocationArgs,
  ContextRequiredDetails,
  SynthesizeInput,
  Invocation,
  OBInterface,
  Source,
  BindingSpecInfo,
  SourceInspection,
  SynthesizeResult,
} from "@openbindings/sdk";
import {
  InvocationError,
  InvocationImpl,
  MultipleSourcesError,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  synthesisSkeleton,
  ERR_RUNTIME,
  ERR_SOURCE_LOAD_FAILED,
} from "@openbindings/sdk";
import type { AsyncAPIDocument } from "./asyncapi-types.js";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME, LEGACY_BINDING_SPEC } from "./constants.js";
import { runBinding, requiredContext } from "./invoke.js";
import { resolveTarget } from "./target.js";
import { bindableOperationEntries, convertToInterface } from "./synthesize.js";
import { synthesisCoverage } from "./coverage.js";
import { operationRef, parseAsyncAPIDocument, parseRef, errorMessage, sanitizeKey, uniqueKey, validateDocumentAddress } from "./util.js";
import { WSPool } from "./ws-pool.js";
import {
  normalizeAuthoringLocation,
  readAuthoringArtifact,
} from "./platform.js";

// ---------------------------------------------------------------------------
// Shared doc-cache helper
// ---------------------------------------------------------------------------

async function loadDoc(
  cache: Map<string, AsyncAPIDocument>,
  location?: string,
  content?: unknown,
  options?: { signal?: AbortSignal },
  fetchFn?: typeof globalThis.fetch,
): Promise<AsyncAPIDocument> {
  if (content !== undefined || !location) {
    return parseAsyncAPIDocument(location, content, options, fetchFn);
  }
  const cached = cache.get(location);
  if (cached) return cached;
  const doc = await parseAsyncAPIDocument(location, undefined, options, fetchFn);
  cache.set(location, doc);
  return doc;
}

// ---------------------------------------------------------------------------
// Invoker
// ---------------------------------------------------------------------------

/**
 * A fetch that always rejects: `prepareBinding` is side-effect-free by
 * contract, so external $refs must never be resolved over the network in
 * the preflight path.
 */
const rejectNetworkFetch: typeof globalThis.fetch = () =>
  Promise.reject(new Error("openbindings: prepareBinding performs no network I/O"));

/** Invokes current and immutable compatibility AsyncAPI cells. */
export class AsyncAPIInvoker implements BindingInvoker {
  private readonly docCache = new Map<string, AsyncAPIDocument>();
  // Connection pooling is an implementation concern (not part of the
  // binding-invoker contract); the pool stays fully private so it never
  // surfaces in the package's public types, matching Go's unexported pool.
  readonly #wsPool = new WSPool();

  /** Returns the binding specifications this invoker supports, by exact identifier. */
  bindingSpecs(): BindingSpecInfo[] {
    return [
      { bindingSpec: BINDING_SPEC, description: "AsyncAPI 3.0 event-driven APIs (reply-preserving revision)" },
      { bindingSpec: LEGACY_BINDING_SPEC, description: "AsyncAPI 3.0 event-driven APIs (revision-1 compatibility)" },
    ];
  }

  /**
   * Shuts down all pooled WebSocket connections. After close returns, the
   * invoker should not be used for new invocations. Mirrors the Go SDK's
   * Close discipline on resource-holding invokers.
   */
  close(): void {
    this.#wsPool.closeAll();
  }

  /**
   * Invokes a single binding, returning the invocation handle synchronously.
   * Construction is inert; the binding's work is scheduled asynchronously
   * and all pre-dispatch failures (including CONTEXT_REQUIRED) are raised
   * before any observable side effect.
   */
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => {
      void this.run(args, inv).catch((err: unknown) => {
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
   * Side-effect-free preflight: reports the context this binding would
   * require, or null when the binding can proceed (or the answer is not
   * knowable without network I/O). Only inline source content and the warm
   * doc cache are consulted; nothing is fetched — including external $refs
   * inside inline content, which parse against a rejecting fetch and
   * collapse to "not knowable" (null).
   */
  async prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
    let doc: AsyncAPIDocument | undefined;
    if (args.source.content !== undefined) {
      try {
        doc = await parseAsyncAPIDocument(
          args.source.location,
          args.source.content,
          { signal: args.signal },
          rejectNetworkFetch,
        );
      } catch {
        return null;
      }
    } else if (args.source.location) {
      doc = this.docCache.get(args.source.location);
    }
    if (!doc) return null;

    try {
      const opID = parseRef(args.ref);
      const asyncOp = (doc.operations ?? {})[opID];
      if (!asyncOp) return null;
      // The selected artifact server whose declared security applies (§9.5),
      // including when configuration replaces only its connection target.
      const target = resolveTarget(doc, asyncOp.channel, args.context);
      return requiredContext(asyncOp, target.securityServer, target.serverURL, args.context);
    } catch {
      return null;
    }
  }

  private async run(
    args: BindingInvocationArgs,
    inv: InvocationImpl<unknown, unknown>,
  ): Promise<void> {
    let doc: AsyncAPIDocument;
    try {
      doc = await loadDoc(
        this.docCache,
        args.source.location,
        args.source.content,
        { signal: inv.signal },
        args.fetch,
      );
    } catch (e: unknown) {
      if (inv.signal.aborted) return;
      inv.fireError(new InvocationError(ERR_SOURCE_LOAD_FAILED, errorMessage(e)));
      return;
    }
    await runBinding(args, inv, doc, this.#wsPool);
  }
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

/** Synthesizes OBInterface definitions from AsyncAPI 3.x documents. */
export class AsyncAPISynthesizer implements InterfaceSynthesizer, CoverageSynthesizer, SourceInspector {
  /** Returns the binding specifications this synthesizer supports, by exact identifier. */
  bindingSpecs(): BindingSpecInfo[] {
    return [
      { bindingSpec: BINDING_SPEC, description: "AsyncAPI 3.0 event-driven APIs (reply-preserving revision)" },
      { bindingSpec: LEGACY_BINDING_SPEC, description: "AsyncAPI 3.0 event-driven APIs (revision-1 compatibility)" },
    ];
  }

  /** Parses an AsyncAPI document and converts it into an OBInterface. */
  async synthesizeInterface(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    return (await this.synthesizeObserved(input, options)).interface;
  }

  async synthesizeInterfaceWithCoverage(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<SynthesizeResult> {
    const observation = await this.synthesizeObserved(input, options);
    return finalizeSynthesisCoverage(
      observation.interface,
      observation.document ? synthesisCoverage(observation.document, observation.interface) : [],
      true,
    );
  }

  private async synthesizeObserved(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<{ interface: OBInterface; document?: AsyncAPIDocument }> {
    const sources = input.sources ?? [];
    const src = sources.at(0);
    if (src === undefined) {
      return { interface: synthesisSkeleton(input) };
    }
    if (sources.length > 1) {
      throw new MultipleSourcesError();
    }
    if (src.bindingSpec !== BINDING_SPEC && src.bindingSpec !== LEGACY_BINDING_SPEC) {
      throw new Error(`synthesizer supports exact binding specifications ${JSON.stringify(BINDING_SPEC)} and ${JSON.stringify(LEGACY_BINDING_SPEC)}, got ${JSON.stringify(src.bindingSpec)}`);
    }
    if (src.outputLocation) validateDocumentAddress(src.outputLocation);
    const location = normalizeAuthoringLocation(src.location);
    const artifactContent = src.content === undefined && src.embed && location
      ? await readAuthoringArtifact(location, options?.signal)
      : src.content;
    const doc = await parseAsyncAPIDocument(location, artifactContent, options);
    const iface = await convertToInterface(location, doc, options, src.bindingSpec);
    // Content-fed synthesis: the emitted source must stay invocable. A
    // source needs location or content; with no location, dropping the
    // provided content would emit neither (mirrors the Go SDK's
    // SynthesizeInterface, spec/binding-specs/asyncapi/openbindings.asyncapi.md: "A synthesized source
    // carries the artifact (location, or embedded content when synthesized
    // from content) so it stays invocable as written.").
    if (artifactContent !== undefined) {
      const entry = iface.sources?.[DEFAULT_SOURCE_NAME];
      if (entry) {
        entry.content = artifactContent;
      }
    }
    return {
      interface: finalizeSynthesis(iface, input, DEFAULT_SOURCE_NAME, src.bindingSpec),
      document: doc,
    };
  }

  /** Lists all bindable targets (operation IDs) from an AsyncAPI source. */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    const location = normalizeAuthoringLocation(source.location);
    const doc = await parseAsyncAPIDocument(location, source.content, options);
    const targets: SourceInspection["targets"] = [];

    if (doc.operations) {
      // Suggest the same operation key convertToInterface assigns (same
      // sorted iteration and sanitizeKey + uniqueKey de-duplication), so an
      // inspection previews exactly what synthesis names.
      const usedKeys = new Set<string>();
      const bindingSpec = source.bindingSpec === LEGACY_BINDING_SPEC
        ? LEGACY_BINDING_SPEC
        : BINDING_SPEC;
      for (const [opID, asyncOp] of bindableOperationEntries(doc, bindingSpec)) {
        const desc = asyncOp?.description || asyncOp?.summary || undefined;
        const operationKey = uniqueKey(sanitizeKey(opID), usedKeys);
        usedKeys.add(operationKey);
        targets.push({
          ref: operationRef(opID),
          operationKey,
          operation: desc ? { description: desc } : undefined,
        });
      }
    }

    return { targets, exhaustive: true };
  }
}

import type {
  BindingInvoker,
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
} from "@openbindings/sdk";
import {
  InvocationError,
  InvocationImpl,
  NoSourcesError,
  MultipleSourcesError,
  ERR_RUNTIME,
  ERR_SOURCE_LOAD_FAILED,
} from "@openbindings/sdk";
import type { AsyncAPIDocument } from "./asyncapi-types.js";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";
import { runBinding, requiredContext } from "./invoke.js";
import { resolveTarget } from "./target.js";
import { convertToInterface } from "./synthesize.js";
import { operationRef, parseAsyncAPIDocument, parseRef, errorMessage, sanitizeKey, uniqueKey } from "./util.js";
import { WSPool } from "./ws-pool.js";

/**
 * Serializes source content for embedding into a synthesized OBI source
 * entry: a string passes through verbatim, anything else is JSON-encoded.
 * Mirrors the Go SDK's ContentToBytes (helpers.go).
 */
function contentToString(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

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

/** Invokes AsyncAPI 3.x bindings over HTTP, SSE, and WebSocket protocols. */
export class AsyncAPIInvoker implements BindingInvoker {
  private readonly docCache = new Map<string, AsyncAPIDocument>();
  // Connection pooling is an implementation concern (not part of the
  // binding-invoker contract); the pool stays fully private so it never
  // surfaces in the package's public types, matching Go's unexported pool.
  readonly #wsPool = new WSPool();

  /** Returns the binding specifications this invoker supports, by exact identifier. */
  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "AsyncAPI 3.x event-driven APIs" }];
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
          undefined,
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
      // The server whose declared security applies (§9.5): resolveTarget's
      // securityServer — the connection's server, or under a full-URL
      // override the server the default selection would have targeted.
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
export class AsyncAPISynthesizer implements InterfaceSynthesizer, SourceInspector {
  /** Returns the binding specifications this synthesizer supports, by exact identifier. */
  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "AsyncAPI 3.x event-driven APIs" }];
  }

  /** Parses an AsyncAPI document and converts it into an OBInterface. */
  async synthesizeInterface(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    if (!input.sources?.length) {
      throw new NoSourcesError();
    }
    if (input.sources.length > 1) {
      throw new MultipleSourcesError();
    }
    const src = input.sources[0];
    const doc = await parseAsyncAPIDocument(src.location, src.content, options);
    const iface = await convertToInterface(src.location, doc, options);
    if (input.name) iface.name = input.name;
    if (input.version) iface.version = input.version;
    if (input.description) iface.description = input.description;
    // Content-fed synthesis: the emitted source must stay invocable. A
    // source needs location or content; with no location, dropping the
    // provided content would emit neither (mirrors the Go SDK's
    // SynthesizeInterface, spec/binding-specs/asyncapi/openbindings.asyncapi.md: "A synthesized source
    // carries the artifact (location, or embedded content when synthesized
    // from content) so it stays invocable as written.").
    if (!src.location && src.content !== undefined) {
      const entry = iface.sources?.[DEFAULT_SOURCE_NAME];
      if (entry) {
        entry.content = contentToString(src.content);
      }
    }
    return iface;
  }

  /** Lists all bindable targets (operation IDs) from an AsyncAPI source. */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    const doc = await parseAsyncAPIDocument(source.location, source.content, options);
    const targets: SourceInspection["targets"] = [];

    if (doc.operations) {
      // Suggest the same operation key convertToInterface assigns (same
      // sorted iteration and sanitizeKey + uniqueKey de-duplication), so an
      // inspection previews exactly what synthesis names.
      const usedKeys = new Set<string>();
      for (const opID of Object.keys(doc.operations).sort()) {
        const asyncOp = doc.operations[opID];
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

import type {
  BindingInvoker,
  InterfaceCreator,
  SourceInspector,
  BindingInvocationArgs,
  ContextRequiredDetails,
  CreateInput,
  Invocation,
  OBInterface,
  Source,
  FormatInfo,
  SourceInspection,
} from "@openbindings/sdk";
import {
  InvocationError,
  InvocationImpl,
  NoSourcesError,
  ERR_RUNTIME,
  ERR_SOURCE_LOAD_FAILED,
} from "@openbindings/sdk";
import type { AsyncAPIDocument } from "./asyncapi-types.js";
import { FORMAT_TOKEN } from "./constants.js";
import { runBinding, requiredContext, resolveServer } from "./invoke.js";
import { convertToInterface } from "./create.js";
import { parseAsyncAPIDocument, parseRef, errorMessage } from "./util.js";
import { WSPool } from "./ws-pool.js";

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
  if (content != null || !location) {
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
  /** @internal */ readonly wsPool = new WSPool();

  /** Returns the format tokens this invoker supports. */
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "AsyncAPI 3.x event-driven APIs" }];
  }

  /**
   * Invokes a single binding, returning the invocation handle synchronously.
   * Construction is inert; the binding's work is scheduled asynchronously
   * and all pre-dispatch failures (including CONTEXT_REQUIRED) are raised
   * before any observable side effect.
   */
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() =>
      this.run(args, inv).catch((err: unknown) => {
        inv.fireError(
          err instanceof InvocationError
            ? err
            : new InvocationError(ERR_RUNTIME, errorMessage(err)),
        );
      }),
    );
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
    if (args.source.content != null) {
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
      const { url: serverURL, server } = resolveServer(doc, args.context);
      return requiredContext(asyncOp, server, serverURL, args.context);
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
    await runBinding(args, inv, doc, this.wsPool);
  }
}

// ---------------------------------------------------------------------------
// Creator
// ---------------------------------------------------------------------------

/** Creates OBInterface definitions from AsyncAPI 3.x documents. */
export class AsyncAPICreator implements InterfaceCreator, SourceInspector {
  /** Returns the format tokens this creator supports. */
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "AsyncAPI 3.x event-driven APIs" }];
  }

  /** Parses an AsyncAPI document and converts it into an OBInterface. */
  async createInterface(
    input: CreateInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    if (!input.sources?.length) {
      throw new NoSourcesError();
    }
    const src = input.sources[0];
    const doc = await parseAsyncAPIDocument(src.location, src.content, options);
    const iface = await convertToInterface(src.location, doc, options);
    if (input.name) iface.name = input.name;
    if (input.version) iface.version = input.version;
    if (input.description) iface.description = input.description;
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
      for (const opID of Object.keys(doc.operations).sort()) {
        const asyncOp = doc.operations[opID];
        const desc = asyncOp?.description || asyncOp?.summary || undefined;
        targets.push({ ref: `#/operations/${opID}`, operation: desc ? { description: desc } : undefined });
      }
    }

    return { targets, exhaustive: true };
  }
}

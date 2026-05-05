import type {
  BindingInvoker,
  InterfaceCreator,
  SourceInspector,
  BindingInvocationInput,
  CreateInput,
  OBInterface,
  Source,
  StreamEvent,
  FormatInfo,
  SourceInspection,
} from "@openbindings/sdk";
import { NoSourcesError, ERR_SOURCE_LOAD_FAILED, ERR_REF_NOT_FOUND, ERR_AUTH_REQUIRED, resolveSecurity } from "@openbindings/sdk";
import type { AsyncAPIDocument } from "./asyncapi-types.js";
import { FORMAT_TOKEN } from "./constants.js";
import { invokeBinding, subscribeBinding, resolveAsyncAPIServerKey } from "./invoke.js";
import { convertToInterface } from "./create.js";
import { parseAsyncAPIDocument, parseRef } from "./util.js";
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
// Driver
// ---------------------------------------------------------------------------

/** Invokes AsyncAPI 3.x bindings over HTTP, SSE, and WebSocket protocols. */
export class AsyncAPIInvoker implements BindingInvoker {
  private readonly docCache = new Map<string, AsyncAPIDocument>();
  /** @internal */ readonly wsPool = new WSPool();

  /** Returns the format tokens this driver supports. */
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "AsyncAPI 3.x event-driven APIs" }];
  }

  /** Invokes a single binding, yielding stream events for the result. */
  async *invokeBinding(
    input: BindingInvocationInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent> {
    let doc: AsyncAPIDocument;
    try {
      doc = await loadDoc(this.docCache, input.source.location, input.source.content, options, input.fetch);
    } catch (e: unknown) {
      yield { error: { code: ERR_SOURCE_LOAD_FAILED, message: e instanceof Error ? e.message : String(e) } };
      return;
    }
    const enriched = await this.resolveStoreContext(input, doc);

    // Determine action and protocol to decide streaming vs unary path
    const opID = parseRef(input.ref);
    const ops = doc.operations ?? {};
    const asyncOp = ops[opID];
    if (!asyncOp) {
      yield { error: { code: ERR_REF_NOT_FOUND, message: `operation "${opID}" not in AsyncAPI doc` } };
      return;
    }

    // Resolve server info for protocol detection
    let protocol = "http";
    try {
      const servers = doc.servers ?? {};
      const sorted = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b));
      for (const [, server] of sorted) {
        const proto = server.protocol.toLowerCase();
        if (["http", "https", "ws", "wss"].includes(proto)) {
          protocol = proto;
          break;
        }
      }
    } catch {
      // fall through to default
    }

    const isStreaming =
      asyncOp.action === "receive" ||
      (asyncOp.action === "send" && (protocol === "ws" || protocol === "wss"));

    if (isStreaming) {
      // Streaming path — delegate to subscribeBinding which returns AsyncIterable<StreamEvent>
      yield* subscribeBinding(enriched, options, doc, this.wsPool);
    } else {
      // Unary path — call invokeBinding which returns Promise<InvocationOutput>
      let result = await invokeBinding(enriched, options, doc);

      if (result.error?.code === ERR_AUTH_REQUIRED && enriched.security?.length && enriched.callbacks) {
        const creds = await resolveSecurity(enriched.security, enriched.callbacks, enriched.fetch);
        if (creds) {
          const retryInput = {
            ...enriched,
            context: { ...enriched.context, ...creds },
          };
          if (retryInput.store) {
            const key = resolveAsyncAPIServerKey(doc);
            if (key) {
              try { await retryInput.store.set(key, retryInput.context!); } catch {}
            }
          }
          result = await invokeBinding(retryInput, options, doc);
        }
      }

      if (result.error) {
        yield { error: result.error, status: result.status, durationMs: result.durationMs };
      } else {
        yield { data: result.output, status: result.status, durationMs: result.durationMs };
      }
    }
  }

  /**
   * Derives the context key from the AsyncAPI doc, looks up stored context,
   * and merges with any developer-supplied context. Dev context wins.
   */
  private async resolveStoreContext(
    input: BindingInvocationInput,
    doc: AsyncAPIDocument,
  ): Promise<BindingInvocationInput> {
    if (!input.store) return input;

    const key = resolveAsyncAPIServerKey(doc);
    if (!key) return input;

    let stored: Record<string, unknown> | null;
    try {
      stored = await input.store.get(key);
    } catch {
      return input;
    }
    if (!stored) return input;

    const merged = input.context && Object.keys(input.context).length > 0
      ? { ...stored, ...input.context }
      : stored;

    return { ...input, context: merged };
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

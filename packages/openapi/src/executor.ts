import {
  NoSourcesError,
  ERR_SOURCE_LOAD_FAILED,
  ERR_AUTH_REQUIRED,
  resolveSecurity,
  type BindingExecutor,
  type InterfaceCreator,
  type BindingExecutionInput,
  type CreateInput,
  type OBInterface,
  type Source,
  type StreamEvent,
  type FormatInfo,
  type ListRefsResult,
} from "@openbindings/sdk";
import type { OpenAPIDocument } from "./types.js";
import { FORMAT_TOKEN } from "./constants.js";
import { executeBinding, resolveServerKey } from "./execute.js";
import { convertToInterface } from "./create.js";
import { loadOpenAPIDocument, buildJsonPointerRef } from "./util.js";

// ---------------------------------------------------------------------------
// Shared doc-cache helper
// ---------------------------------------------------------------------------

async function loadDoc(
  cache: Map<string, OpenAPIDocument>,
  location?: string,
  content?: unknown,
  options?: { signal?: AbortSignal },
  fetchFn?: typeof globalThis.fetch,
): Promise<OpenAPIDocument> {
  if (content != null || !location) {
    return loadOpenAPIDocument(location, content, options, fetchFn);
  }
  const cached = cache.get(location);
  if (cached) return cached;
  const doc = await loadOpenAPIDocument(location, undefined, options, fetchFn);
  cache.set(location, doc);
  return doc;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Executes OpenAPI bindings by performing HTTP requests against the described API. */
export class OpenAPIExecutor implements BindingExecutor {
  private readonly docCache = new Map<string, OpenAPIDocument>();

  /** Returns the format tokens this executor supports. */
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "OpenAPI 3.x HTTP APIs" }];
  }

  /** Executes a single binding by making an HTTP request and yielding the result or error. */
  async *executeBinding(
    input: BindingExecutionInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent> {
    let doc: OpenAPIDocument;
    try {
      doc = await loadDoc(this.docCache, input.source.location, input.source.content, options, input.fetch);
    } catch (e: unknown) {
      yield { error: { code: ERR_SOURCE_LOAD_FAILED, message: e instanceof Error ? e.message : String(e) } };
      return;
    }

    const enriched = await this.resolveStoreContext(input, doc);
    let result = await executeBinding(enriched, options, doc);

    if (result.error?.code === ERR_AUTH_REQUIRED && enriched.security?.length && enriched.callbacks) {
      const creds = await resolveSecurity(enriched.security, enriched.callbacks, enriched.fetch);
      if (creds) {
        const retryInput = {
          ...enriched,
          context: { ...enriched.context, ...creds },
        };
        if (retryInput.store) {
          const key = resolveServerKey(doc, retryInput.source.location);
          if (key) {
            try { await retryInput.store.set(key, retryInput.context!); } catch {}
          }
        }
        result = await executeBinding(retryInput, options, doc);
      }
    }

    if (result.error) {
      yield { error: result.error, status: result.status, durationMs: result.durationMs };
    } else {
      yield { data: result.output, status: result.status, durationMs: result.durationMs };
    }
  }

  /**
   * Derives the context key from the OpenAPI doc, looks up stored context,
   * and merges with any developer-supplied context. Dev context wins.
   */
  private async resolveStoreContext(
    input: BindingExecutionInput,
    doc: OpenAPIDocument,
  ): Promise<BindingExecutionInput> {
    if (!input.store) return input;

    const key = resolveServerKey(doc, input.source.location);
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

/** Creates OBInterface definitions from OpenAPI specification documents. */
export class OpenAPICreator implements InterfaceCreator {
  /** Returns the format tokens this creator supports. */
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "OpenAPI 3.x HTTP APIs" }];
  }

  /** Converts an OpenAPI source into an OBInterface, applying optional name/version/description overrides. */
  async createInterface(
    input: CreateInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    if (!input.sources?.length) {
      throw new NoSourcesError();
    }
    const src = input.sources[0];
    const iface = await convertToInterface(src.location, src.content, options);
    if (input.name) iface.name = input.name;
    if (input.version) iface.version = input.version;
    if (input.description) iface.description = input.description;
    return iface;
  }

  /** Lists all bindable refs (path+method combinations) from an OpenAPI source. */
  async listBindableRefs(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<ListRefsResult> {
    const doc = await loadOpenAPIDocument(source.location, source.content, options) as OpenAPIDocument;
    const refs: ListRefsResult["refs"] = [];

    if (!doc.paths) return { refs, exhaustive: true };

    const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
    for (const [pathStr, pathItemRaw] of Object.entries(doc.paths).sort(([a], [b]) => a.localeCompare(b))) {
      if (pathStr.startsWith("x-") || !pathItemRaw || typeof pathItemRaw !== "object") continue;
      const pathItem = pathItemRaw as Record<string, unknown>;
      for (const method of methods) {
        const op = pathItem[method];
        if (!op || typeof op !== "object") continue;
        const opObj = op as { description?: string; summary?: string };
        refs.push({
          ref: buildJsonPointerRef(pathStr, method),
          description: opObj.description || opObj.summary || undefined,
        });
      }
    }

    return { refs, exhaustive: true };
  }
}

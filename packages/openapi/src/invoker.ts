import {
  InvocationError,
  InvocationImpl,
  NoSourcesError,
  ERR_RUNTIME,
  ERR_SOURCE_LOAD_FAILED,
  type BindingInvoker,
  type BindingInvocationArgs,
  type ContextRequiredDetails,
  type CreateInput,
  type FormatInfo,
  type InterfaceCreator,
  type Invocation,
  type OBInterface,
  type Source,
  type SourceInspection,
  type SourceInspector,
} from "@openbindings/sdk";
import type { OpenAPIDocument, OpenAPIOperation } from "./types.js";
import { FORMAT_TOKEN } from "./constants.js";
import { requiredContext, resolveRequestBaseURL, runBinding } from "./invoke.js";
import { convertToInterface } from "./create.js";
import { buildJsonPointerRef, errorMessage, loadOpenAPIDocument, parseRef } from "./util.js";

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
// Invoker
// ---------------------------------------------------------------------------

/** Invokes OpenAPI bindings by performing HTTP requests against the described API. */
export class OpenAPIInvoker implements BindingInvoker {
  private readonly docCache = new Map<string, OpenAPIDocument>();

  /** Returns the format tokens this invoker supports. */
  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "OpenAPI 3.x HTTP APIs" }];
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
    if (args.source.content != null) {
      try {
        doc = await loadOpenAPIDocument(args.source.location, args.source.content);
      } catch {
        return null;
      }
    } else if (args.source.location) {
      doc = this.docCache.get(args.source.location);
    }
    if (!doc) return null;

    let op: OpenAPIOperation | undefined;
    try {
      const { path, method } = parseRef(args.ref);
      op = doc.paths?.[path]?.[method] as OpenAPIOperation | undefined;
    } catch {
      return null;
    }
    if (!op) return null;

    let baseURL: string;
    try {
      baseURL = resolveRequestBaseURL(doc, args.context, args.source.location);
    } catch {
      // No server URL: the invocation fails with ERR_SOURCE_CONFIG_ERROR
      // before auth matters, so there is no context to report.
      return null;
    }
    return requiredContext(doc, op, args.context, baseURL);
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

// ---------------------------------------------------------------------------
// Creator
// ---------------------------------------------------------------------------

/** Creates OBInterface definitions from OpenAPI specification documents. */
export class OpenAPICreator implements InterfaceCreator, SourceInspector {
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

  /** Lists all bindable targets (path+method combinations) from an OpenAPI source. */
  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    const doc = await loadOpenAPIDocument(source.location, source.content, options) as OpenAPIDocument;
    const targets: SourceInspection["targets"] = [];

    if (!doc.paths) return { targets, exhaustive: true };

    const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
    for (const [pathStr, pathItemRaw] of Object.entries(doc.paths).sort(([a], [b]) => a.localeCompare(b))) {
      if (pathStr.startsWith("x-") || !pathItemRaw || typeof pathItemRaw !== "object") continue;
      const pathItem = pathItemRaw as Record<string, unknown>;
      for (const method of methods) {
        const op = pathItem[method];
        if (!op || typeof op !== "object") continue;
        const opObj = op as { description?: string; summary?: string };
        const desc = opObj.description || opObj.summary || undefined;
        targets.push({
          ref: buildJsonPointerRef(pathStr, method),
          operation: desc ? { description: desc } : undefined,
        });
      }
    }

    return { targets, exhaustive: true };
  }
}

/**
 * BindingInvoker implementation for the openbindings.operation-graph format
 * (the transparency rewrite).
 *
 * Construction takes an OperationInvoker so operation and each nodes can
 * recurse into other operations on the same OBI through it. The recursive
 * dependency is resolved post-construction via
 * OperationInvoker.addBindingInvoker.
 */
import type { BindingSpecInfo } from "@openbindings/core";
import type { BindingInvocationArgs, BindingInvoker, Invocation, OperationInvoker } from "@openbindings/invoke";
import { isHttpUrl } from "@openbindings/core";
import {
  ERR_INVALID_REF,
  ERR_REF_NOT_FOUND,
  ERR_RUNTIME,
  ERR_SOURCE_LOAD_FAILED,
  ERR_UNSUPPORTED_FORMAT_VERSION,
  ERR_VALIDATION_FAILED,
  InvocationError,
  InvocationImpl,
} from "@openbindings/invoke";
import { BINDING_SPEC } from "./constants.js";
import { Engine } from "./engine.js";
import { RefError, resolveRef } from "./jsonpointer.js";
import { SchemaCache } from "./state.js";
import { graphFromValue, type Graph } from "./types.js";
import { SEMVER_RE, checkVersion, validate } from "./validate.js";

/**
 * Bounds a graph document fetched from a remote location. Matches the Go
 * SDK's maxGraphDocBytes (8 MiB). STAYS FIXED under the delivery-unit knob
 * (a named exclusion of the 2026-07-20 ruling): an artifact-fetch guard on
 * the graph DOCUMENT, not a response/delivery-unit bound — this package has
 * no transport reads of its own beyond this; sub-operation responses are
 * read (and bounded) by the format invokers behind the OperationInvoker.
 */
const MAX_GRAPH_DOC_BYTES = 8 << 20; // 8 MiB

/** BindingInvoker for operation-graph source documents. */
export class OperationGraphInvoker implements BindingInvoker {
  private readonly invoker: OperationInvoker;
  private readonly docCache = new Map<string, unknown>();
  private readonly schemas = new SchemaCache();

  constructor(invoker: OperationInvoker) {
    this.invoker = invoker;
  }

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "OpenBindings operation graphs" }];
  }

  /**
   * Invokes an operation graph binding. The handle is returned
   * synchronously; the graph engine runs behind it. Caller writes stream in
   * through the handle's input side (each write becomes one event at the
   * graph's input node, rooting a lineage) and graph events stream out
   * through the output side.
   *
   * Pre-flight failures (source load, ref resolution, version refusal per
   * OG-T-02, validation per OG-T-01) surface as a terminal error without
   * consuming any caller input.
   */
  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const inv = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => {
      this.run(args, inv).catch((err) => {
        inv.fireError(asInvocationError(err));
      });
    });
    return inv as Invocation<I, O>;
  }

  private async run(args: BindingInvocationArgs, inv: InvocationImpl<unknown, unknown>): Promise<void> {
    let doc: unknown;
    try {
      doc = await this.loadDocument(args.source.location, args.source.content, args.fetch, args.signal);
    } catch {
      inv.fireError(new InvocationError(ERR_SOURCE_LOAD_FAILED));
      return;
    }

    // The ref is a REQUIRED JSON Pointer fragment addressing the graph
    // definition within the (otherwise unconstrained) host document.
    let graph: Graph;
    try {
      graph = graphFromValue(resolveRef(doc, args.ref));
    } catch (err) {
      if (err instanceof RefError) {
        inv.fireError(new InvocationError(err.invalid ? ERR_INVALID_REF : ERR_REF_NOT_FOUND));
      } else {
        inv.fireError(new InvocationError(ERR_VALIDATION_FAILED));
      }
      return;
    }

    // OG-T-02: refuse graphs declaring a format version this implementation
    // does not support. The graph's own field governs (the source format
    // token is advisory).
    const version = graph["openbindings.operation-graph"];
    if (typeof version === "string" && SEMVER_RE.test(version)) {
      const refusal = checkVersion(version);
      if (refusal) {
        inv.fireError(new InvocationError(ERR_UNSUPPORTED_FORMAT_VERSION));
        return;
      }
    }

    // OG-T-01 / OG-V-11: validate before acting; fail the binding rather than
    // execute an invalid graph. When `interface` is absent (direct binding
    // invocation) no operations map is supplied, so operation and each nodes
    // — which resolve ONLY against the containing OBI's operations map
    // (OG-V-11, §281) — cannot resolve; validate against an EMPTY set so such
    // a graph is refused pre-execution rather than passing an undefined
    // interface downstream. A graph with no operation/each nodes validates
    // vacuously and runs.
    const opKeys: Set<string> = args.interface
      ? new Set(Object.keys(args.interface.operations))
      : new Set();
    try {
      validate(graph, opKeys);
    } catch {
      inv.fireError(new InvocationError(ERR_VALIDATION_FAILED));
      return;
    }

    const engine = new Engine({
      graph,
      invoker: this.invoker,
      args,
      transform: this.invoker.transformEvaluator,
      schemas: this.schemas,
    });
    await engine.run(inv);
  }

  /**
   * Loads and parses an operation graph source document into a generic JSON
   * value (the host document's shape is unconstrained by the format).
   * Inline `content` wins when present; otherwise the document is fetched from
   * `location` (size-bounded). Parsed documents are cached by location when
   * content is absent. Mirrors the Go SDK's loadDocument/loadLocation.
   */
  private async loadDocument(
    location: string | undefined,
    content: unknown,
    fetchFn: typeof globalThis.fetch | undefined,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (location && content === undefined) {
      const cached = this.docCache.get(location);
      if (cached !== undefined) return cached;
    }

    // Resolve the raw document text: inline content wins; otherwise fetch the
    // location. A non-string/Uint8Array content value is already a parsed JSON
    // value (the host passed an object), so it bypasses JSON parsing entirely.
    let text: string | undefined;
    if (typeof content === "string") {
      text = content;
    } else if (content instanceof Uint8Array) {
      text = new TextDecoder().decode(content);
    } else if (content !== undefined) {
      // Already a structured value: use it directly (Go marshals+unmarshals to
      // the same end state).
      if (location) this.docCache.set(location, content);
      return content;
    } else {
      if (!location) {
        throw new Error("source must have location or content");
      }
      text = await this.loadLocation(location, fetchFn, signal);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`parse operation graph document: ${(err as Error).message}`, { cause: err });
    }

    if (location) this.docCache.set(location, parsed);
    return parsed;
  }

  /**
   * Reads a graph document from an http(s) URL. Mirrors the Go SDK's
   * loadLocation: GET, 2xx-only, and a size bound enforced by reading one byte
   * past the limit and rejecting if it is reached. The injected `fetch`
   * (args.fetch) is used so the host controls the transport; runtimes without
   * a filesystem (browser/worker) cannot read non-HTTP locations.
   */
  private async loadLocation(
    location: string,
    fetchFn: typeof globalThis.fetch | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (!isHttpUrl(location)) {
      throw new Error(`unsupported operation graph location ${JSON.stringify(location)}: only http(s) URLs are supported`);
    }
    const doFetch = fetchFn ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
    if (!doFetch) {
      throw new Error("openbindings: fetch is not available — provide a fetch implementation to load remote operation graphs");
    }

    let resp: Response;
    try {
      resp = await doFetch(location, { signal, headers: { Accept: "application/json" } });
    } catch (err) {
      throw new Error(`fetch operation graph ${JSON.stringify(location)}: ${(err as Error).message}`, { cause: err });
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`fetch operation graph ${JSON.stringify(location)}: HTTP ${resp.status}`);
    }

    const text = await readBoundedText(resp, MAX_GRAPH_DOC_BYTES, location);
    return text;
  }
}

/**
 * Reads a response body as text, rejecting once it exceeds maxBytes. Mirrors
 * Go's io.LimitReader(maxBytes+1) + length check: it reads one byte past the
 * bound to distinguish "exactly at the limit" from "over".
 */
async function readBoundedText(resp: Response, maxBytes: number, location: string): Promise<string> {
  if (!resp.body) {
    const text = await resp.text();
    if (utf8ByteLength(text) > maxBytes) {
      throw new Error(`operation graph ${JSON.stringify(location)} exceeds ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`operation graph ${JSON.stringify(location)} exceeds ${maxBytes} bytes`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return chunks.join("");
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function asInvocationError(err: unknown): InvocationError {
  if (err instanceof InvocationError) return err;
  return new InvocationError(ERR_RUNTIME);
}

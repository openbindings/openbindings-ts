/**
 * BindingInvoker implementation for the openbindings.operation-graph format.
 *
 * Construction takes an OperationInvoker so operation nodes can recurse into
 * other operations on the same OBI through it. The recursive dependency is
 * resolved post-construction via OperationInvoker.addBindingInvoker.
 */
import type {
  BindingInvocationInput,
  BindingInvoker,
  FormatInfo,
  InvocationOutput,
  OperationInvoker,
} from "@openbindings/sdk";
import { ERR_REF_NOT_FOUND, ERR_SOURCE_LOAD_FAILED } from "@openbindings/sdk";
import type { Document, Graph } from "./types.js";
import { parseDocument } from "./types.js";
import { SchemaCache } from "./state.js";
import { Engine } from "./engine.js";
import { FORMAT_TOKEN } from "./constants.js";

/** BindingInvoker for operation-graph source documents. */
export class OperationGraphInvoker implements BindingInvoker {
  private readonly invoker: OperationInvoker;
  private readonly docCache = new Map<string, Document>();
  private readonly schemas = new SchemaCache();

  constructor(invoker: OperationInvoker) {
    this.invoker = invoker;
  }

  formats(): FormatInfo[] {
    return [{ token: FORMAT_TOKEN, description: "OpenBindings operation graphs" }];
  }

  async *invokeBinding(
    input: BindingInvocationInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<InvocationOutput> {
    let doc: Document;
    try {
      doc = this.loadDocument(input.source.location, input.source.content);
    } catch (err) {
      yield { error: { code: ERR_SOURCE_LOAD_FAILED, message: (err as Error).message } };
      return;
    }

    const graph: Graph | undefined = doc.graphs?.[input.ref];
    if (!graph) {
      yield {
        error: {
          code: ERR_REF_NOT_FOUND,
          message: `operation graph "${input.ref}" not found in document`,
        },
      };
      return;
    }

    const engine = new Engine({
      graph,
      invoker: this.invoker,
      bindingIn: input,
      transform: this.invoker.transformEvaluator,
      schemas: this.schemas,
    });
    yield* engine.run(options?.signal);
  }

  private loadDocument(location: string | undefined, content: unknown): Document {
    if (location && content == null) {
      const cached = this.docCache.get(location);
      if (cached) return cached;
    }

    let parsed: unknown;
    if (content == null) {
      throw new Error("no content or location provided");
    }
    if (typeof content === "string") {
      parsed = JSON.parse(content);
    } else if (content instanceof Uint8Array) {
      parsed = JSON.parse(new TextDecoder().decode(content));
    } else if (typeof content === "object") {
      parsed = content;
    } else {
      parsed = structuredClone(content);
    }
    const doc = parseDocument(parsed);

    if (location) this.docCache.set(location, doc);
    return doc;
  }
}
